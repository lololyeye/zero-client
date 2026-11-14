import { compileLayoutCss, resolvePerf, type Config } from '../shared/config';
import { compileThemeCss, type Theme } from '../shared/theme';
import { PRESET_IDS } from '../shared/theme';

export function activeTheme(c: Config): Theme {
  return c.themes[c.activeThemeId] ?? Object.values(c.themes)[0]!;
}

/**
 * The complete stylesheet ZERO places in Discord (theme + layout + plugins), or '' in Safe Mode.
 * Pure function of its inputs: main caches the result and only recompiles when one of them changes.
 */
export function composeDiscordCss(c: Config, pluginCss: Iterable<string>, missingImages: ReadonlySet<string>): string {
  if (c.recovery.safeMode) return '';
  const perf = resolvePerf(c);
  const layout = c.layouts[c.activeLayoutId] ?? Object.values(c.layouts)[0]!;
  return [
    compileThemeCss(activeTheme(c), { flags: perf, missingImages }),
    '/* layout */',
    compileLayoutCss(layout),
    ...[...pluginCss].map((css, i) => `/* plugin ${i + 1} */\n${css}`),
  ].join('\n');
}

/** Image ids referenced by any theme (used to report missing images). */
export function referencedImages(c: Config): string[] {
  const ids = new Set<string>();
  for (const t of Object.values(c.themes)) for (const l of t.backgrounds) if (l.kind === 'image' && l.imageId) ids.add(l.imageId);
  return [...ids];
}

/**
 * Apply an edit coming from the settings UI. Built-in presets are never modified: the first edit of a preset
 * creates "<Preset> (custom)" and activates it, so the user's change is persisted instead of silently dropped.
 */
export function applyThemeEdit(c: Config, edited: Theme): { config: Config; id: string } {
  if (!PRESET_IDS.has(edited.id)) {
    return { config: { ...c, themes: { ...c.themes, [edited.id]: edited }, activeThemeId: edited.id }, id: edited.id };
  }
  let id = `${edited.id}-custom`, i = 2;
  while (c.themes[id]) id = `${edited.id}-custom-${i++}`;
  const forked: Theme = { ...edited, id, name: `${edited.name} (custom)`.slice(0, 60) };
  return { config: { ...c, themes: { ...c.themes, [id]: forked }, activeThemeId: id }, id };
}
