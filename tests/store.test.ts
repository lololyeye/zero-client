import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/main/store';
import { CONFIG_VERSION, ConfigTooNewError, defaultConfig, migrateConfig, sanitizeConfig, compileLayoutCss } from '../src/shared/config';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'zero-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('settings persistence', () => {
  it('creates defaults on first run and persists changes', async () => {
    const s = new ConfigStore(dir);
    const r = await s.load();
    expect(r.config.version).toBe(CONFIG_VERSION);
    await s.save({ ...r.config, activeThemeId: 'graphite' });
    const again = await new ConfigStore(dir).load();
    expect(again.config.activeThemeId).toBe('graphite');
  });
  it('migrates an old config, keeping a backup of the original', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, theme: 'obsidian', tray: true }));
    const r = await new ConfigStore(dir).load();
    expect(r.config.activeThemeId).toBe('obsidian');
    expect(r.config.general.minimizeToTray).toBe(true);
    expect(r.notes.join()).toMatch(/migrated/);
    const backups = await readdir(path.join(dir, 'backups'));
    expect(backups.some((b) => b.includes('pre-migration-v1'))).toBe(true);
  });
  it('preserves a corrupt file and restores the latest backup', async () => {
    const s = new ConfigStore(dir, 0); // no backup throttle
    const { config } = await s.load();
    await s.save({ ...config, activeThemeId: 'frost' });
    await s.save({ ...config, activeThemeId: 'frost', activeLayoutId: 'focus' }); // rotates a backup of the frost one
    await writeFile(path.join(dir, 'config.json'), '{ broken json');
    const r = await new ConfigStore(dir).load();
    expect(r.notes.join()).toMatch(/preserved/);
    expect(r.config.activeThemeId).toBe('frost');
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
  it('falls back to defaults when corrupt and no backup is usable', async () => {
    await writeFile(path.join(dir, 'config.json'), 'nope');
    const r = await new ConfigStore(dir).load();
    expect(r.config).toEqual(defaultConfig());
  });
  it('refuses to load (and never overwrites) a config from a newer version', async () => {
    const file = path.join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ version: CONFIG_VERSION + 5 }));
    await expect(new ConfigStore(dir).load()).rejects.toBeInstanceOf(ConfigTooNewError);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(CONFIG_VERSION + 5);
  });
  it('serialises concurrent saves without corrupting the file', async () => {
    const s = new ConfigStore(dir); const { config } = await s.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.save({ ...config, activeLayoutId: i % 2 ? 'focus' : 'daily' })));
    const r = await new ConfigStore(dir).load();
    expect(['focus', 'daily']).toContain(r.config.activeLayoutId);
  });
  it('throttles automatic backups during live editing', async () => {
    const s = new ConfigStore(dir); const { config } = await s.load();
    for (let i = 0; i < 30; i++) await s.save({ ...config, recovery: { crashStreak: i, safeMode: false } });
    expect((await s.listBackups()).length).toBe(1);
  });
  it('limits the number of rolling backups', async () => {
    const s = new ConfigStore(dir, 0); const { config } = await s.load();
    for (let i = 0; i < 15; i++) await s.save({ ...config, recovery: { crashStreak: i, safeMode: false } });
    expect((await s.listBackups()).length).toBeLessThanOrEqual(8);
  });
  it('restores a named backup and rejects path traversal', async () => {
    const s = new ConfigStore(dir, 0); const { config } = await s.load();
    await s.save({ ...config, activeThemeId: 'aurora' }); await s.save({ ...config, activeThemeId: 'amoled' });
    const [newest] = await s.listBackups();
    expect((await s.restoreBackup(newest!)).activeThemeId).toBe('aurora');
    await expect(s.restoreBackup('../../etc/passwd')).rejects.toThrow();
  });
});


describe('config sanitisation', () => {
  it('drops invalid themes and unknown ids instead of crashing', () => {
    const c = sanitizeConfig({ activeThemeId: 'ghost', themes: { bad: { id: 'bad' } }, activeLayoutId: 'nope' });
    expect(c.themes['bad']).toBeUndefined();
    expect(c.activeThemeId).toBe('midnight'); expect(c.activeLayoutId).toBe('daily');
  });
  it('migrateConfig tolerates garbage input', () => {
    expect(migrateConfig(undefined).config).toEqual(defaultConfig());
    expect(migrateConfig('x').config.version).toBe(CONFIG_VERSION);
  });
});

describe('layout css', () => {
  it('applies widths, density and hidden timestamps', () => {
    const css = compileLayoutCss({ ...defaultConfig().layouts['daily']!, density: 'compact', chatMaxWidth: 700, timestampFormat: 'hidden' });
    expect(css).toContain('max-width:700px!important'); expect(css).toContain('display:none!important'); expect(css).toContain('padding-top:1px!important');
    expect(compileLayoutCss(defaultConfig().layouts['daily']!)).not.toContain('max-width');
  });
  it('ships the five required layout profiles', () => {
    expect(Object.values(defaultConfig().layouts).map((l) => l.name)).toEqual(['Daily', 'Minimal', 'Gaming', 'Focus', 'Ultra Lightweight']);
  });
});
