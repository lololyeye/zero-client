import { sanitizeBuiltins, type BuiltinState } from './builtins';
import { cls, DEFAULT_THEME, PRESET_IDS, PRESETS, validateTheme, type RenderFlags, type Theme } from './theme';

export const CONFIG_VERSION = 3;

export interface LayoutProfile {
  id: string;
  name: string;
  density: 'compact' | 'comfortable';
  sidebarWidth: number; // server rail px, 0 = Discord default
  channelListWidth: number; // px, 0 = Discord default
  chatMaxWidth: number; // 0 = unlimited
  avatarShape: 'circle' | 'rounded' | 'square';
  timestampFormat: 'default' | 'hidden';
}

export type PerfProfile = 'balanced' | 'lightweight' | 'custom';

/** Every switch here has a real implementation (see resolvePerf and its call sites). */
export interface PerfOptions extends RenderFlags {
  /** Chromium may slow timers/rendering of the Discord page while the window is hidden or minimized (restart). */
  backgroundThrottle: boolean;
  /** Spellchecker dictionaries in the renderer (live). */
  spellcheck: boolean;
}

export const PERF_PRESETS: Record<Exclude<PerfProfile, 'custom'>, PerfOptions> = {
  balanced: { backgrounds: true, blur: true, animations: true, pauseWhenUnfocused: true, backgroundThrottle: true, spellcheck: true },
  lightweight: { backgrounds: true, blur: false, animations: false, pauseWhenUnfocused: true, backgroundThrottle: true, spellcheck: false },
};

export interface Config {
  version: number;
  general: { minimizeToTray: boolean; startMinimized: boolean; hardwareAcceleration: boolean; discordBranch: 'stable' | 'ptb' | 'canary'; checkUpdates: boolean; updateIntervalHours: 0 | 1 | 6 | 24; introSeen: boolean };
  activeThemeId: string;
  themes: Record<string, Theme>;
  activeLayoutId: string;
  layouts: Record<string, LayoutProfile>;
  performance: { profile: PerfProfile; custom: PerfOptions };
  plugins: { enabled: Record<string, boolean>; granted: Record<string, string[]> };
  /** built-in plugins (see shared/builtins.ts), all off by default */
  builtins: Record<string, BuiltinState>;
  recovery: { crashStreak: number; safeMode: boolean };
}

export function resolvePerf(c: Pick<Config, 'performance'>): PerfOptions {
  return c.performance.profile === 'custom' ? c.performance.custom : PERF_PRESETS[c.performance.profile];
}

const layout = (id: string, name: string, o: Partial<LayoutProfile>): LayoutProfile => ({
  id, name, density: 'comfortable', sidebarWidth: 0, channelListWidth: 0, chatMaxWidth: 0,
  avatarShape: 'circle', timestampFormat: 'default', ...o,
});

export const DEFAULT_LAYOUTS: LayoutProfile[] = [
  layout('daily', 'Daily', {}),
  layout('minimal', 'Minimal', { density: 'compact', avatarShape: 'square', timestampFormat: 'hidden' }),
  layout('gaming', 'Gaming', { density: 'compact', chatMaxWidth: 760 }),
  layout('focus', 'Focus', { channelListWidth: 200, chatMaxWidth: 880 }),
  layout('ultra-light', 'Ultra Lightweight', { density: 'compact', avatarShape: 'rounded' }),
];

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    general: { minimizeToTray: false, startMinimized: false, hardwareAcceleration: true, discordBranch: 'stable', checkUpdates: true, updateIntervalHours: 6, introSeen: false },
    activeThemeId: DEFAULT_THEME.id,
    themes: Object.fromEntries(PRESETS.map((t) => [t.id, t])),
    activeLayoutId: 'daily',
    layouts: Object.fromEntries(DEFAULT_LAYOUTS.map((l) => [l.id, l])),
    performance: { profile: 'balanced', custom: { ...PERF_PRESETS.balanced } },
    plugins: { enabled: {}, granted: {} },
    builtins: sanitizeBuiltins({}),
    recovery: { crashStreak: 0, safeMode: false },
  };
}

/** Versioned migrations. Each takes the previous shape and returns the next; never mutates input. */
export const MIGRATIONS: Record<number, (c: any) => any> = {
  // v0/v1 -> v2: flat `theme` string became themes map; tray flag moved under general
  1: (c) => {
    const d = defaultConfig();
    return {
      ...c, version: 2,
      general: { ...d.general, ...(c.general ?? {}), minimizeToTray: c.tray ?? c.general?.minimizeToTray ?? false },
      activeThemeId: c.activeThemeId ?? c.theme ?? d.activeThemeId,
      themes: c.themes ?? d.themes,
    };
  },
  // v2 -> v3: performance profiles (normal -> balanced, custom options); layouts lose their own "lightweight" switch
  2: (c) => {
    const wasLight = c.performance?.profile === 'lightweight' || Object.values(c.layouts ?? {}).some((l: any) => l?.id === c.activeLayoutId && l?.profile === 'lightweight');
    const custom = { ...PERF_PRESETS.balanced, backgroundThrottle: c.performance?.backgroundThrottle !== false };
    const layouts = Object.fromEntries(Object.entries(c.layouts ?? {}).map(([k, l]: [string, any]) => {
      const { profile: _p, serverLabels: _s, ...rest } = l ?? {};
      return [k, { ...rest, timestampFormat: rest.timestampFormat === 'hidden' ? 'hidden' : 'default' }];
    }));
    return { ...c, version: 3, layouts, performance: { profile: wasLight ? 'lightweight' : 'balanced', custom } };
  },
};

export class ConfigTooNewError extends Error {}

export function migrateConfig(raw: unknown): { config: Config; migratedFrom: number | null } {
  if (typeof raw !== 'object' || raw === null) return { config: defaultConfig(), migratedFrom: null };
  let c: any = structuredClone(raw);
  const from = typeof c.version === 'number' ? c.version : 1;
  if (from > CONFIG_VERSION) throw new ConfigTooNewError(`Config version ${from} is newer than supported ${CONFIG_VERSION}`);
  for (let v = from; v < CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`Missing migration for config version ${v}`);
    c = step(c);
  }
  return { config: sanitizeConfig(c), migratedFrom: from < CONFIG_VERSION ? from : null };
}

const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const int = (v: unknown, min: number, max: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : d;

export function sanitizeLayout(id: string, l: any): LayoutProfile {
  const d = layout(id, id, {});
  return {
    id, name: typeof l?.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 40) : id,
    density: l?.density === 'compact' ? 'compact' : 'comfortable',
    sidebarWidth: int(l?.sidebarWidth, 0, 160, d.sidebarWidth),
    channelListWidth: int(l?.channelListWidth, 0, 480, d.channelListWidth),
    chatMaxWidth: int(l?.chatMaxWidth, 0, 2000, d.chatMaxWidth),
    avatarShape: ['circle', 'rounded', 'square'].includes(l?.avatarShape) ? l.avatarShape : 'circle',
    timestampFormat: l?.timestampFormat === 'hidden' ? 'hidden' : 'default',
  };
}

export function sanitizePerfOptions(p: any): PerfOptions {
  const d = PERF_PRESETS.balanced;
  return {
    backgrounds: bool(p?.backgrounds, d.backgrounds), blur: bool(p?.blur, d.blur), animations: bool(p?.animations, d.animations),
    pauseWhenUnfocused: bool(p?.pauseWhenUnfocused, d.pauseWhenUnfocused), backgroundThrottle: bool(p?.backgroundThrottle, d.backgroundThrottle),
    spellcheck: bool(p?.spellcheck, d.spellcheck),
  };
}

/**
 * Merge with defaults and drop invalid data. Built-in presets always come from code (a stored copy of a preset is
 * never authoritative; edits are saved as separate custom themes), so preset improvements reach existing users.
 */
export function sanitizeConfig(c: any): Config {
  const d = defaultConfig();
  const themes: Record<string, Theme> = { ...d.themes };
  for (const [id, t] of Object.entries(c.themes ?? {})) {
    if (PRESET_IDS.has(id)) continue;
    try { const v = validateTheme(t); themes[v.id] = v; } catch { /* invalid custom theme dropped */ }
  }
  const layouts: Record<string, LayoutProfile> = { ...d.layouts };
  for (const [id, l] of Object.entries(c.layouts ?? {})) if (/^[a-z0-9-]{1,40}$/.test(id)) layouts[id] = sanitizeLayout(id, l);
  const profile: PerfProfile = ['balanced', 'lightweight', 'custom'].includes(c.performance?.profile) ? c.performance.profile : 'balanced';
  return {
    version: CONFIG_VERSION,
    general: {
      minimizeToTray: bool(c.general?.minimizeToTray, d.general.minimizeToTray),
      startMinimized: bool(c.general?.startMinimized, d.general.startMinimized),
      hardwareAcceleration: bool(c.general?.hardwareAcceleration, true),
      discordBranch: ['stable', 'ptb', 'canary'].includes(c.general?.discordBranch) ? c.general.discordBranch : 'stable',
      checkUpdates: bool(c.general?.checkUpdates, true),
      updateIntervalHours: [0, 1, 6, 24].includes(c.general?.updateIntervalHours) ? c.general.updateIntervalHours : 6,
      introSeen: bool(c.general?.introSeen, false),
    },
    themes,
    activeThemeId: typeof c.activeThemeId === 'string' && themes[c.activeThemeId] ? c.activeThemeId : d.activeThemeId,
    layouts,
    activeLayoutId: typeof c.activeLayoutId === 'string' && layouts[c.activeLayoutId] ? c.activeLayoutId : d.activeLayoutId,
    performance: { profile, custom: sanitizePerfOptions(c.performance?.custom) },
    plugins: {
      enabled: typeof c.plugins?.enabled === 'object' && c.plugins.enabled ? c.plugins.enabled : {},
      granted: typeof c.plugins?.granted === 'object' && c.plugins.granted ? c.plugins.granted : {},
    },
    builtins: sanitizeBuiltins(c.builtins),
    recovery: {
      crashStreak: Number.isInteger(c.recovery?.crashStreak) ? c.recovery.crashStreak : 0,
      safeMode: bool(c.recovery?.safeMode, false),
    },
  };
}

/** CSS for the structural (non-color) part of a layout profile. Selectors verified against Discord's current DOM. */
export function compileLayoutCss(l: LayoutProfile): string {
  let css = '';
  if (l.density === 'compact') {
    css += `${cls('messageListItem')} > ${cls('message')}{padding-top:1px!important;padding-bottom:1px!important;}\n`;
    css += `${cls('groupStart')}{margin-top:8px!important;}\n`;
  }
  if (l.sidebarWidth > 0) css += `nav${cls('guilds')}{width:${l.sidebarWidth}px!important;}\n`;
  if (l.channelListWidth > 0) css += `${cls('sidebarList')}{width:${l.channelListWidth}px!important;flex:0 0 ${l.channelListWidth}px!important;}\n`;
  if (l.chatMaxWidth > 0) css += `${cls('messagesWrapper')} ${cls('scrollerInner')}, ${cls('channelBottomBarArea')}{max-width:${l.chatMaxWidth}px!important;margin-inline:auto!important;width:100%;}\n`;
  const r = l.avatarShape === 'circle' ? '50%' : l.avatarShape === 'rounded' ? '28%' : '3px';
  css += `${cls('messageListItem')} img${cls('avatar')}{border-radius:${r}!important;}\n`;
  if (l.timestampFormat === 'hidden') css += `${cls('messageListItem')} ${cls('timestamp')}{display:none!important;}\n`;
  return css;
}
