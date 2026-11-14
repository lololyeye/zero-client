import { DEFAULT_THEME, PRESETS, THEME_FORMAT, validateTheme, type Theme } from '../shared/theme';
import type { Config } from '../shared/config';

export const MAX_IMPORT_BYTES = 1_000_000;
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

export function isPreset(id: string): boolean { return PRESET_IDS.has(id); }

function uniqueId(base: string, taken: Record<string, unknown>): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
  let id = clean, i = 2;
  while (taken[id]) id = `${clean}-${i++}`;
  return id;
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify({ zeroTheme: THEME_FORMAT, theme }, null, 2);
}

/**
 * Parse + validate an imported theme file. Themes are data only: nothing is ever evaluated.
 * Image layers whose image is not present locally are disabled rather than dropped.
 */
export function parseImportedTheme(text: string, hasImage: (id: string) => boolean = () => false): Theme {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('Theme file is too large (max 1 MB).');
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('Theme file is not valid JSON.'); }
  const raw = data && typeof data === 'object' && 'theme' in data ? data.theme : data;
  const theme = validateTheme(raw);
  theme.backgrounds = theme.backgrounds.map((l) => (l.kind === 'image' && l.imageId && !hasImage(l.imageId) ? { ...l, enabled: false } : l));
  return theme;
}

export function addTheme(cfg: Config, theme: Theme, activate = true): Config {
  const id = uniqueId(theme.id, cfg.themes);
  const t = { ...theme, id };
  return { ...cfg, themes: { ...cfg.themes, [id]: t }, activeThemeId: activate ? id : cfg.activeThemeId };
}

export function duplicateTheme(cfg: Config, id: string): Config {
  const src = cfg.themes[id];
  if (!src) throw new Error('Theme not found');
  return addTheme(cfg, { ...structuredClone(src), id: `${src.id}-copy`, name: `${src.name} copy` });
}

export function renameTheme(cfg: Config, id: string, name: string): Config {
  const src = cfg.themes[id];
  if (!src) throw new Error('Theme not found');
  if (isPreset(id)) throw new Error('Built-in presets cannot be renamed; duplicate it first.');
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('Name cannot be empty');
  return { ...cfg, themes: { ...cfg.themes, [id]: { ...src, name: clean } } };
}

export function deleteTheme(cfg: Config, id: string): Config {
  if (isPreset(id)) throw new Error('Built-in presets cannot be deleted. Use "Restore defaults" to reset one.');
  if (!cfg.themes[id]) throw new Error('Theme not found');
  const { [id]: _removed, ...rest } = cfg.themes;
  return { ...cfg, themes: rest, activeThemeId: cfg.activeThemeId === id ? DEFAULT_THEME.id : cfg.activeThemeId };
}

export function restorePreset(cfg: Config, id: string): Config {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error('Only built-in presets can be restored');
  return { ...cfg, themes: { ...cfg.themes, [id]: structuredClone(p) } };
}

/** Save an edited theme; presets are never overwritten in place (a copy is created instead). */
export function saveTheme(cfg: Config, theme: Theme): Config {
  const valid = validateTheme(theme);
  if (isPreset(valid.id)) {
    return addTheme(cfg, { ...valid, id: `${valid.id}-custom`, name: `${valid.name} (edited)` });
  }
  return { ...cfg, themes: { ...cfg.themes, [valid.id]: valid }, activeThemeId: valid.id };
}
