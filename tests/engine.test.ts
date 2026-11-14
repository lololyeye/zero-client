/**
 * Regression tests for the theme engine repair. Each block pins a root cause that was found on the real Discord
 * client (see docs/ARCHITECTURE.md, "Theme engine"), so it cannot silently come back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileThemeCss, DEFAULT_THEME, DISCORD_ANCHORS, DISCORD_VARIABLE_MAP, PRESETS, validateTheme, type Anchors, type Theme } from '../src/shared/theme';
import { defaultConfig, migrateConfig, PERF_PRESETS, resolvePerf, sanitizeConfig, toPerfProfile } from '../src/shared/config';
import { applyThemeEdit, composeDiscordCss, referencedImages } from '../src/main/compose';
import { createThemeController, routeKind } from '../src/preload/controller';
import { ImageStore } from '../src/main/images';

const layer = (o: object) => validateTheme({ ...DEFAULT_THEME, id: 't', backgrounds: [{ id: 'l1', kind: 'image', imageId: 'abc123', enabled: true, ...o }] });

describe('cascade: ZERO wins over Discord sheets', () => {
  const css = compileThemeCss(DEFAULT_THEME);
  it('declares every variable with !important on every theme scope', () => {
    const rootRule = css.split('\n')[0]!;
    expect(rootRule.startsWith(DISCORD_ANCHORS.themeScopes + '{')).toBe(true);
    for (const scope of ['.theme-dark', '.theme-darker', '.theme-light', '.theme-midnight', '.visual-refresh']) expect(DISCORD_ANCHORS.themeScopes).toContain(scope);
    const decls = rootRule.slice(rootRule.indexOf('{') + 1, -1).split(';').filter(Boolean);
    expect(decls.length).toBeGreaterThan(100);
    for (const d of decls) expect(d.endsWith('!important')).toBe(true);
  });
  it('maps the visual-refresh surfaces measured on the live client', () => {
    const map = new Map(DISCORD_VARIABLE_MAP);
    expect(map.get('--background-base-lowest')).toBe('--zero-bg'); // frame + server rail
    expect(map.get('--background-base-lower')).toBe('--zero-surface-1'); // chat / friends page
    expect(map.get('--background-base-low')).toBe('--zero-surface-2'); // cards
    expect(map.get('--brand-500')).toBe('--zero-accent');
    expect(map.get('--text-default')).toBe('--zero-text');
  });
  it('re-scopes the frame variable inside the channel list so "Channel list" color is real', () => {
    expect(css).toContain(`html body ${DISCORD_ANCHORS.channelList}, html body ${DISCORD_ANCHORS.channelList} :is(.theme-dark`);
    expect(css).toContain('--background-base-lowest:var(--zero-channels)!important');
  });
  it('every color setting reaches at least one Discord variable or element rule', () => {
    const tokens = Object.keys(DEFAULT_THEME.colors);
    const tokenOf: Record<string, string> = { background: 'bg', surface1: 'surface-1', surface2: 'surface-2', textMuted: 'text-muted', channelList: 'channels', userPanel: 'user-panel' };
    for (const k of tokens) {
      const tok = `--zero-${tokenOf[k] ?? k}`;
      if (k === 'bubble') continue; // opt-in, covered below
      expect(css, k).toMatch(new RegExp(`var\\(${tok}\\)`));
    }
  });
  it('message bubbles are opt-in (transparent = no rule)', () => {
    expect(compileThemeCss(DEFAULT_THEME)).not.toContain('background:var(--zero-bubble)');
    const t = validateTheme({ ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, bubble: '#223344' } });
    expect(compileThemeCss(t)).toContain('background:var(--zero-bubble)!important');
  });
});

describe('backgrounds', () => {
  it('renders each area on its anchor ::before (Discord owns ::after on the sidebar)', () => {
    for (const area of ['global', 'sidebar', 'chat', 'dm', 'settings'] as const) {
      const css = compileThemeCss(layer({ area }));
      expect(css).toContain(`${DISCORD_ANCHORS.areas[area]}::before{content:""`);
      expect(css).toContain('url("zero-asset://bg/abc123")');
      expect(css).not.toContain('::after{content');
    }
  });
  it('paints exactly one tint layer: base surfaces transparent, area children tinted at the surface opacity', () => {
    const t = layer({ area: 'chat' }); t.effects.transparency = 0.5;
    const css = compileThemeCss(t);
    expect(css).toContain('--zero-surface-1:transparent!important');
    expect(css).toContain('--zero-bg:transparent!important');
    expect(css).toMatch(/> \*\{background-color:color-mix\(in srgb, #1b1e25 50%, transparent\)!important;\}/);
    // raised surfaces stay translucent (not transparent) so cards/inputs stay readable
    expect(css).toMatch(/--zero-input:color-mix\(in srgb, [^,]+, 50%, transparent\)|--zero-input:color-mix\(in srgb, #[0-9a-f]+ 50%, transparent\)/);
  });
  it('settings area targets the settings modal (2026-11) and treats its card surface as base', () => {
    expect(DISCORD_ANCHORS.areas.settings).toContain('[class*=" outerContainer_"]');
    expect(DISCORD_ANCHORS.areas.settings).toContain('[class*=" modal_"]');
    expect(compileThemeCss(layer({ area: 'settings' }))).toContain('--zero-surface-2:transparent!important');
    expect(compileThemeCss(layer({ area: 'chat' }))).not.toContain('--zero-surface-2:transparent');
  });
  it('the scoped re-declaration outranks the global variable rule (specificity boost)', () => {
    const css = compileThemeCss(layer({ area: 'sidebar' }));
    expect(css).toContain(`html ${DISCORD_ANCHORS.areas.sidebar}, html ${DISCORD_ANCHORS.areas.sidebar} :is(.theme-dark`);
    // anchors that already start with html are not double-prefixed
    expect(compileThemeCss(layer({ area: 'dm' }))).not.toContain('html html');
  });
  it('applies position, size, repeat, opacity, filters, overlay and transition', () => {
    const css = compileThemeCss(layer({ area: 'chat', size: 'stretch', posX: 10, posY: 90, repeat: 'repeat', opacity: 0.4, blur: 6, brightness: 0.8, contrast: 1.2, overlay: '#00ff00', overlayOpacity: 0.3, transitionMs: 250 }));
    expect(css).toContain('background-size:100% 100%,100% 100%');
    expect(css).toContain('background-repeat:no-repeat,repeat');
    expect(css).toContain('10% 90%');
    expect(css).toContain('opacity:0.4');
    expect(css).toContain('filter:blur(6px) brightness(0.8) contrast(1.2)');
    expect(css).toContain('linear-gradient(color-mix(in srgb, #00ff00 30%, transparent)');
    expect(css).toContain('transition:opacity 250ms');
    expect(css).toContain('clip-path:inset(12px)'); // blur edge bleed is clipped
  });
  it('a missing image renders no layer and no translucency (Discord keeps its plain surfaces)', () => {
    const css = compileThemeCss(layer({ area: 'chat' }), { missingImages: new Set(['abc123']) });
    expect(css).not.toContain('::before{content');
    expect(css).not.toContain('transparent!important');
  });
  it('performance flags: backgrounds off removes layers, blur off removes filters', () => {
    const t = layer({ area: 'chat', blur: 8 });
    expect(compileThemeCss(t, { flags: { backgrounds: false, blur: true, animations: true, pauseWhenUnfocused: true } })).not.toContain('::before{content');
    expect(compileThemeCss(t, { flags: { backgrounds: true, blur: false, animations: true, pauseWhenUnfocused: true } })).not.toContain('blur(');
  });
  it('limits one layer per area', () => {
    const t = validateTheme({ ...DEFAULT_THEME, id: 't', backgrounds: [{ area: 'chat', kind: 'image', imageId: 'a' }, { area: 'chat', kind: 'image', imageId: 'b' }] });
    expect(t.backgrounds.filter((l) => l.area === 'chat')).toHaveLength(1);
  });
  it('the preview compiles with the same compiler but cannot leak rules onto the settings page', () => {
    const PV: Anchors = { ...DISCORD_ANCHORS, scope: '.pv ', themeScopes: '.pv', channelList: '.pv-channels' };
    const t = validateTheme({ ...DEFAULT_THEME, effects: { ...DEFAULT_THEME.effects, animations: false }, customCss: 'body{display:none}' });
    const css = compileThemeCss(t, { anchors: PV, includeCustomCss: false });
    expect(css).not.toContain('display:none');
    expect(css).not.toMatch(/(^|[},])\*,/m); // no unscoped universal selector
    expect(css).not.toContain('html.zero-paused');
  });
});

describe('presets', () => {
  it('switching presets yields completely self-contained output (no residue from the previous one)', () => {
    for (const p of PRESETS) {
      const css = compileThemeCss(p);
      expect(css).toContain(`--zero-bg:${p.colors.background}!important`);
      if (!p.backgrounds.some((l) => l.enabled)) expect(css).not.toContain('::before{content');
    }
  });
  it('built-in presets always come from code, a stored copy is ignored', () => {
    const c = defaultConfig();
    const tampered = { ...c, themes: { ...c.themes, midnight: { ...c.themes['midnight']!, colors: { ...c.themes['midnight']!.colors, accent: '#000001' } } } };
    expect(sanitizeConfig(tampered).themes['midnight']!.colors.accent).toBe(PRESETS[0]!.colors.accent);
  });
  it('editing a preset forks it into an active custom theme; editing the fork updates it in place', () => {
    const c = defaultConfig();
    const edited: Theme = { ...c.themes['midnight']!, colors: { ...c.themes['midnight']!.colors, accent: '#ff3355' } };
    const a = applyThemeEdit(c, edited);
    expect(a.id).toBe('midnight-custom');
    expect(a.config.activeThemeId).toBe('midnight-custom');
    expect(a.config.themes['midnight']!.colors.accent).toBe(PRESETS[0]!.colors.accent);
    expect(a.config.themes['midnight-custom']!.name).toBe('Midnight (custom)');
    const b = applyThemeEdit(a.config, { ...a.config.themes['midnight-custom']!, colors: { ...edited.colors, accent: '#00ff00' } });
    expect(b.id).toBe('midnight-custom');
    expect(Object.keys(b.config.themes).filter((k) => k.startsWith('midnight-custom'))).toHaveLength(1);
    // a second fork of the same preset gets a new id
    expect(applyThemeEdit(b.config, edited).id).toBe('midnight-custom-2');
  });
});

describe('composition (main process single source of truth)', () => {
  it('safe mode produces no CSS at all', () => {
    const c = defaultConfig(); c.recovery.safeMode = true;
    expect(composeDiscordCss(c, ['a{color:red}'], new Set())).toBe('');
  });
  it('includes theme, layout and plugin css and follows the performance profile', () => {
    const c = defaultConfig();
    c.themes['t'] = { ...layer({ area: 'chat', blur: 5 }), id: 't' }; c.activeThemeId = 't';
    const css = composeDiscordCss(c, ['.x{--p:1}'], new Set());
    expect(css).toContain('--zero-bg'); expect(css).toContain('/* layout */'); expect(css).toContain('.x{--p:1}'); expect(css).toContain('blur(5px)');
    c.performance.profile = 'performance';
    expect(composeDiscordCss(c, [], new Set())).not.toContain('blur(');
    expect(resolvePerf(c).spellcheck).toBe(true);
    c.performance.profile = 'lowResource';
    expect(composeDiscordCss(c, [], new Set())).not.toContain('abc123'); // no background image at all
    expect(resolvePerf(c)).toMatchObject({ backgrounds: false, blur: false, animations: false, spellcheck: false, backgroundThrottle: true });
  });
  it('lists referenced images for the missing-image check', () => {
    const c = defaultConfig(); c.themes['t'] = { ...layer({ area: 'chat' }), id: 't' };
    expect(referencedImages(c)).toContain('abc123');
  });
});

describe('performance profiles', () => {
  it('accepts the new names and the pre-0.4 lightweight name', () => {
    expect(toPerfProfile('lightweight')).toBe('performance');
    expect(toPerfProfile('lowResource')).toBe('lowResource');
    expect(toPerfProfile('turbo')).toBe('balanced');
    expect(sanitizeConfig({ performance: { profile: 'lightweight' } }).performance.profile).toBe('performance');
  });
  it('never trades away what calls need: every preset keeps throttling for hidden windows only', () => {
    for (const p of ['balanced', 'performance', 'lowResource'] as const) expect(PERF_PRESETS[p].backgroundThrottle).toBe(true);
  });
});

describe('config migration v2 -> v3', () => {
  it('maps the old lightweight switches onto the Performance profile and drops removed layout fields', () => {
    const { config, migratedFrom } = migrateConfig({
      version: 2, activeLayoutId: 'daily', performance: { profile: 'normal', backgroundThrottle: false },
      layouts: { daily: { id: 'daily', name: 'Daily', profile: 'lightweight', serverLabels: true, timestampFormat: '24h' } },
    });
    expect(migratedFrom).toBe(2);
    expect(config.performance.profile).toBe('performance');
    expect(config.performance.custom.backgroundThrottle).toBe(false);
    expect(config.layouts['daily']).not.toHaveProperty('profile');
    expect(config.layouts['daily']).not.toHaveProperty('serverLabels');
    expect(config.layouts['daily']!.timestampFormat).toBe('default');
  });
});

describe('renderer theme controller (fake DOM)', () => {
  /** Minimal DOM: enough for the controller, no dependency. */
  function fakeDoc(withHead = true) {
    const listeners: Record<string, () => void> = {};
    const observers: Array<() => void> = [];
    class El {
      id = ''; textContent = ''; parentNode: El | null = null; children: El[] = []; tag: string;
      dataset: Record<string, string> = {}; private cls = new Set<string>();
      classList = { toggle: (c: string, on: boolean) => { if (on) this.cls.add(c); else this.cls.delete(c); }, remove: (c: string) => this.cls.delete(c), contains: (c: string) => this.cls.has(c) };
      constructor(tag: string) { this.tag = tag; }
      get isConnected(): boolean { let e: El | null = this; while (e) { if (e === doc.documentElement) return true; e = e.parentNode; } return false; }
      appendChild(c: El) { c.remove(); c.parentNode = this; this.children.push(c); observers.forEach((o) => o()); return c; }
      remove() { if (this.parentNode) { const p = this.parentNode; p.children = p.children.filter((x) => x !== this); this.parentNode = null; observers.forEach((o) => o()); } }
      all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
    }
    const doc: any = {
      documentElement: null as El | null, head: null as El | null,
      createElement: (t: string) => new El(t),
      querySelectorAll: (sel: string) => (doc.documentElement ? doc.documentElement.all() : []).filter((e: El) => e.tag === 'style' && `style#${e.id}` === sel),
      addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
      fire: (ev: string) => listeners[ev]?.(),
      build() { doc.documentElement = new El('html'); doc.head = new El('head'); doc.documentElement.appendChild(doc.head); },
    };
    if (withHead) doc.build();
    class MO { constructor(private cb: () => void) {} observe() { observers.push(() => this.cb()); } disconnect() { /* keep simple */ } }
    return { doc, MO: MO as any };
  }

  it('keeps exactly one style element across many updates and only writes on change', () => {
    const { doc, MO } = fakeDoc();
    const c = createThemeController(doc, MO);
    for (let i = 0; i < 200; i++) c.apply({ css: `a{--i:${i % 3}}`, pauseWhenUnfocused: false });
    c.apply({ css: 'a{--i:1}', pauseWhenUnfocused: false }); // same as the last one (199 % 3) -> no write
    const s = c.state();
    expect(s.styles).toBe(1); expect(s.attached).toBe(true); expect(s.textWrites).toBe(200);
  });
  it('adopts and de-duplicates leftovers from an earlier instance', () => {
    const { doc, MO } = fakeDoc();
    for (let i = 0; i < 3; i++) { const e = doc.createElement('style'); e.id = 'zero-theme'; doc.head.appendChild(e); }
    const c = createThemeController(doc, MO);
    c.apply({ css: 'a{}', pauseWhenUnfocused: false });
    expect(c.state().styles).toBe(1);
  });
  it('re-attaches the style if the page removes it, and removes it when css is empty (safe mode)', () => {
    const { doc, MO } = fakeDoc();
    const c = createThemeController(doc, MO);
    c.apply({ css: 'a{}', pauseWhenUnfocused: false });
    doc.head.children[0].remove();
    expect(c.state().attached).toBe(true);
    c.apply({ css: '', pauseWhenUnfocused: false });
    expect(c.state().styles).toBe(0);
  });
  it('waits for the document when the preload runs before <head> exists', () => {
    const { doc, MO } = fakeDoc(false);
    const c = createThemeController(doc, MO);
    c.apply({ css: 'a{}', pauseWhenUnfocused: false });
    expect(c.state().styles).toBe(0);
    doc.build(); doc.fire('DOMContentLoaded');
    expect(c.state().styles).toBe(1);
  });
  it('tracks the route and the paused (unfocused) state', () => {
    const { doc, MO } = fakeDoc();
    const c = createThemeController(doc, MO);
    c.apply({ css: 'a{}', pauseWhenUnfocused: true });
    c.setRoute('dm'); c.setFocused(false);
    expect(c.state().route).toBe('dm'); expect(c.state().paused).toBe(true);
    c.setFocused(true); expect(c.state().paused).toBe(false);
    expect(routeKind('/channels/@me')).toBe('dm'); expect(routeKind('/channels/@me/123')).toBe('dm');
    expect(routeKind('/channels/123/456')).toBe('guild'); expect(routeKind('/login')).toBe('other');
  });
});

describe('image store', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'zero-img-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);
  const codec = (ok = true) => ({ decode: () => (ok ? { width: 100, height: 50, resize: () => null, toJPEG: () => Buffer.from('j'), toPNG: () => Buffer.from('p') } : null) });

  it('content-addressed ids: importing the same file twice stores it once', async () => {
    const store = new ImageStore(path.join(dir, 'bg'), codec() as any);
    await writeFile(path.join(dir, 'a.png'), png); await writeFile(path.join(dir, 'copy.png'), png);
    const a = await store.import(path.join(dir, 'a.png'));
    const b = await store.import(path.join(dir, 'copy.png'));
    expect(a.id).toBe(b.id); expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.list()).toHaveLength(1);
  });
  it('rejects a corrupted image with a clear message', async () => {
    const store = new ImageStore(path.join(dir, 'bg'), codec(false) as any);
    await writeFile(path.join(dir, 'bad.png'), png);
    await expect(store.import(path.join(dir, 'bad.png'))).rejects.toThrow(/corrupted/);
    expect(await store.list()).toHaveLength(0);
  });
});
