import { describe, expect, it } from 'vitest';
import { compileThemeCss, DEFAULT_THEME, lintCustomCss, PRESETS, validateTheme, ThemeValidationError } from '../src/shared/theme';
import * as T from '../src/main/themeOps';
import { defaultConfig } from '../src/shared/config';

describe('theme validation', () => {
  it('accepts every built-in preset', () => {
    for (const p of PRESETS) expect(() => validateTheme(p)).not.toThrow();
    expect(PRESETS.map((p) => p.id)).toEqual(['midnight', 'graphite', 'obsidian', 'frost', 'amoled', 'aurora', 'minimal', 'custom']);
  });
  it('rejects non-objects, bad ids, future formats and bad colors', () => {
    expect(() => validateTheme(null)).toThrow(ThemeValidationError);
    expect(() => validateTheme({ ...DEFAULT_THEME, id: '../evil' })).toThrow();
    expect(() => validateTheme({ ...DEFAULT_THEME, format: 99 })).toThrow(/format/);
    expect(() => validateTheme({ ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, accent: 'red; } body{display:none' } })).toThrow(/accent/);
  });
  it('clamps numeric ranges', () => {
    const t = validateTheme({ ...DEFAULT_THEME, shape: { radius: 9999, serverIconRadius: -5, spacing: 50 }, effects: { blur: 1e9 } });
    expect(t.shape.radius).toBe(32); expect(t.shape.serverIconRadius).toBe(0); expect(t.shape.spacing).toBe(2); expect(t.effects.blur).toBe(40);
  });
  it('rejects font families that could break out of a declaration', () => {
    expect(() => validateTheme({ ...DEFAULT_THEME, type: { fontFamily: 'x; } *{display:none' } })).toThrow(/fontFamily/);
  });
  it('limits background layers and requires valid image ids', () => {
    const layer = { area: 'global', kind: 'image', imageId: 'abc123' };
    expect(() => validateTheme({ ...DEFAULT_THEME, backgrounds: Array(9).fill(layer) })).toThrow(/layers/);
    expect(() => validateTheme({ ...DEFAULT_THEME, backgrounds: [{ area: 'global', kind: 'image', imageId: '../../x' }] })).toThrow();
  });
});

describe('css compilation', () => {
  it('maps theme colors onto Discord variables', () => {
    const css = compileThemeCss(DEFAULT_THEME);
    expect(css).toContain('--zero-surface-1:#1b1e25!important');
    expect(css).toContain('--background-base-lower:var(--zero-surface-1)!important');
    expect(css).toContain('--brand-500:var(--zero-accent)!important');
    expect(css).toContain('--zero-accent:#7c8cff!important');
  });
  it('performance flags drop animations and blur but keep colors', () => {
    const t = validateTheme({ ...DEFAULT_THEME, effects: { ...DEFAULT_THEME.effects, blur: 20, glass: true } });
    expect(compileThemeCss(t)).toContain('backdrop-filter');
    const css = compileThemeCss(t, { flags: { backgrounds: true, blur: false, animations: false, pauseWhenUnfocused: false } });
    expect(css).toContain('animation-duration:0s');
    expect(css).not.toContain('backdrop-filter');
    expect(css).toContain('--zero-accent:#7c8cff');
  });
  it('emits layer css only for enabled layers', () => {
    const aurora = PRESETS.find((p) => p.id === 'aurora')!;
    expect(compileThemeCss(aurora)).toContain('::before{content:""');
    expect(compileThemeCss(DEFAULT_THEME)).not.toContain('::before{content:""');
    const off = { ...aurora, backgrounds: aurora.backgrounds.map((l) => ({ ...l, enabled: false })) };
    expect(compileThemeCss(off)).not.toContain('::before{content:""');
  });
  it('omits custom css containing blocked constructs', () => {
    const t = validateTheme({ ...DEFAULT_THEME, customCss: '@import url(https://evil.example/x.css); body{color:red}' });
    expect(compileThemeCss(t)).not.toContain('evil.example');
  });
  it('is deterministic (stable output for identical input)', () => {
    expect(compileThemeCss(DEFAULT_THEME)).toBe(compileThemeCss(structuredClone(DEFAULT_THEME)));
  });
});

describe('custom css lint', () => {
  it('blocks remote loading', () => {
    expect(lintCustomCss('@import "x.css";').some((i) => i.level === 'error')).toBe(true);
    expect(lintCustomCss('a{background:url(https://x.test/a.png)}').some((i) => i.level === 'error')).toBe(true);
    expect(lintCustomCss('a{background:url(zero-asset://bg/abc)}')).toEqual([]);
  });
  it('warns about hashed class names', () => {
    expect(lintCustomCss('[class*="sidebar_"]{color:red}').some((i) => i.level === 'warning')).toBe(true);
  });
});

describe('theme operations (import/export/duplicate/rename/delete)', () => {
  it('round-trips export -> import', () => {
    const exported = T.exportTheme(DEFAULT_THEME);
    expect(T.parseImportedTheme(exported)).toEqual(DEFAULT_THEME);
  });
  it('rejects invalid JSON, oversize and invalid themes without side effects', () => {
    expect(() => T.parseImportedTheme('{nope')).toThrow(/JSON/);
    expect(() => T.parseImportedTheme('x'.repeat(T.MAX_IMPORT_BYTES + 1))).toThrow(/large/);
    expect(() => T.parseImportedTheme('{"format":1,"id":"a b","name":"x"}')).toThrow();
  });
  it('disables imported image layers whose image is missing', () => {
    const t = { ...DEFAULT_THEME, id: 'x', backgrounds: [{ id: 'l', area: 'global', kind: 'image', imageId: 'missing', size: 'cover', posX: 50, posY: 50, opacity: 1, blur: 0, brightness: 1, contrast: 1, overlay: 'rgba(0,0,0,0)', enabled: true }] };
    expect(T.parseImportedTheme(JSON.stringify(t)).backgrounds[0]!.enabled).toBe(false);
  });
  it('duplicates, renames and deletes custom themes but protects presets', () => {
    let c = defaultConfig();
    c = T.duplicateTheme(c, 'midnight');
    const id = c.activeThemeId; expect(id).toBe('midnight-copy');
    c = T.renameTheme(c, id, 'Mine'); expect(c.themes[id]!.name).toBe('Mine');
    expect(() => T.renameTheme(c, 'midnight', 'X')).toThrow();
    expect(() => T.deleteTheme(c, 'midnight')).toThrow();
    c = T.deleteTheme(c, id); expect(c.themes[id]).toBeUndefined(); expect(c.activeThemeId).toBe('midnight');
  });
  it('generates unique ids on repeated import', () => {
    let c = defaultConfig();
    c = T.addTheme(c, { ...DEFAULT_THEME, id: 'mine' }); c = T.addTheme(c, { ...DEFAULT_THEME, id: 'mine' });
    expect(Object.keys(c.themes)).toContain('mine'); expect(Object.keys(c.themes)).toContain('mine-2');
  });
  it('saving an edited preset creates a copy and leaves the preset intact', () => {
    const c = T.saveTheme(defaultConfig(), { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, accent: '#ff0000' } });
    expect(c.themes['midnight']!.colors.accent).toBe('#7c8cff');
    expect(c.themes[c.activeThemeId]!.colors.accent).toBe('#ff0000');
  });
  it('restores a modified preset', () => {
    let c = defaultConfig();
    c = { ...c, themes: { ...c.themes, graphite: { ...c.themes['graphite']!, name: 'Hacked' } } };
    expect(T.restorePreset(c, 'graphite').themes['graphite']!.name).toBe('Graphite');
  });
});
