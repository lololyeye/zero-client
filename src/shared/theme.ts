/**
 * ZERO theme format (versioned, data only; themes never contain executable code).
 * Every value is validated/clamped before it is compiled to CSS.
 *
 * Format history
 *  1: initial
 *  2: per-area backgrounds (one per area, + "dm"), repeat / scale / overlay opacity / transition,
 *     message bubbles opt-in (transparent = off), transparency means "surface opacity over backgrounds".
 */
export const THEME_FORMAT = 2;

export const BG_AREAS = ['global', 'sidebar', 'chat', 'dm', 'settings'] as const;
export type BgArea = (typeof BG_AREAS)[number];

export type BgSize = 'cover' | 'contain' | 'auto' | 'stretch' | 'scale';
export type BgRepeat = 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';

export interface BackgroundLayer {
  id: string;
  area: BgArea;
  kind: 'image' | 'gradient';
  /** id of a locally imported image (served by the zero-asset:// protocol) */
  imageId?: string;
  /** Gradient built from structured fields, never raw strings */
  gradient?: { angle: number; from: string; to: string };
  size: BgSize;
  /** percentage used when size === 'scale' (25..400) */
  scale: number;
  repeat: BgRepeat;
  posX: number; // 0..100
  posY: number; // 0..100
  opacity: number; // 0..1
  blur: number; // px 0..40
  brightness: number; // 0..2
  contrast: number; // 0..2
  overlay: string; // overlay color
  overlayOpacity: number; // 0..1
  transitionMs: number; // 0..2000
  enabled: boolean;
}

export interface Theme {
  format: number;
  id: string;
  name: string;
  colors: {
    background: string; surface1: string; surface2: string; accent: string;
    text: string; textMuted: string; border: string; hover: string;
    bubble: string; sidebar: string; channelList: string; userPanel: string;
    popup: string; modal: string; input: string; button: string; scrollbar: string;
  };
  shape: { radius: number; serverIconRadius: number; spacing: number };
  type: { fontFamily: string; fontSize: number; fontWeight: number; headingWeight: number };
  /** transparency = opacity of Discord surfaces in areas that have a background (lets the image show through) */
  effects: { blur: number; transparency: number; shadow: number; animations: boolean; glass: boolean };
  backgrounds: BackgroundLayer[];
  customCss: string;
}

export const MAX_LAYERS = BG_AREAS.length;
export const MAX_CUSTOM_CSS = 20_000;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
const FONT = /^[\w \-,"']{1,120}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const isColor = (v: unknown): v is string =>
  typeof v === 'string' && (HEX.test(v) || RGBA.test(v));
const num = (v: unknown, min: number, max: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const color = (v: unknown, d: string): string => (isColor(v) ? v : d);

/** True when a color is fully transparent (used for opt-in features such as message bubbles). */
export function isTransparent(c: string): boolean {
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(7).toLowerCase() === '00';
  if (/^#[0-9a-f]{4}$/i.test(c)) return c[4] === '0';
  const m = c.match(/^rgba\(.*,\s*([\d.]+)\s*\)$/i);
  return m ? Number(m[1]) === 0 : false;
}

export const DEFAULT_THEME: Theme = {
  format: THEME_FORMAT, id: 'midnight', name: 'Midnight',
  colors: {
    background: '#14161b', surface1: '#1b1e25', surface2: '#232730', accent: '#7c8cff',
    text: '#e7e9ee', textMuted: '#8d93a1', border: '#2c303b', hover: '#2a2f3a',
    bubble: 'rgba(0,0,0,0)', sidebar: '#14161b', channelList: '#171a20', userPanel: '#15181d',
    popup: '#1e222a', modal: '#1b1e25', input: '#232730', button: '#7c8cff', scrollbar: '#383e4c',
  },
  shape: { radius: 8, serverIconRadius: 16, spacing: 1 },
  type: {
    fontFamily: 'gg sans, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif',
    fontSize: 16, fontWeight: 400, headingWeight: 600,
  },
  effects: { blur: 0, transparency: 0.78, shadow: 0.3, animations: true, glass: false },
  backgrounds: [],
  customCss: '',
};

export class ThemeValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid theme: ${issues.join('; ')}`);
  }
}

const SIZES: BgSize[] = ['cover', 'contain', 'auto', 'stretch', 'scale'];
const REPEATS: BgRepeat[] = ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'];

function validateLayer(l: Record<string, any>, index: number, issues: string[]): BackgroundLayer | null {
  // format-1 layers used area names that still exist; unknown areas are rejected
  if (!BG_AREAS.includes(l.area)) { issues.push(`background ${index + 1} has unknown area`); return null; }
  const kind = l.kind === 'gradient' ? 'gradient' : 'image';
  if (kind === 'image' && !(typeof l.imageId === 'string' && ID.test(l.imageId))) {
    issues.push(`background ${index + 1} needs a valid imageId`);
    return null;
  }
  // format 1 stored overlay as one rgba color; keep it but default overlayOpacity to 1 so it looks the same
  const legacyOverlay = typeof l.overlayOpacity !== 'number' && typeof l.overlay === 'string' && /^rgba/i.test(l.overlay);
  return {
    id: typeof l.id === 'string' && ID.test(l.id) ? l.id : `bg-${l.area}`,
    area: l.area, kind,
    imageId: kind === 'image' ? l.imageId : undefined,
    gradient: kind === 'gradient'
      ? { angle: num(l.gradient?.angle, 0, 360, 135), from: color(l.gradient?.from, '#222222'), to: color(l.gradient?.to, '#000000') }
      : undefined,
    size: SIZES.includes(l.size) ? l.size : 'cover',
    scale: num(l.scale, 25, 400, 100),
    repeat: REPEATS.includes(l.repeat) ? l.repeat : 'no-repeat',
    posX: num(l.posX, 0, 100, 50), posY: num(l.posY, 0, 100, 50),
    opacity: num(l.opacity, 0, 1, 1), blur: num(l.blur, 0, 40, 0),
    brightness: num(l.brightness, 0, 2, 1), contrast: num(l.contrast, 0, 2, 1),
    overlay: color(l.overlay, '#000000'),
    overlayOpacity: legacyOverlay ? 1 : num(l.overlayOpacity, 0, 1, 0),
    transitionMs: num(l.transitionMs, 0, 2000, 250),
    enabled: l.enabled !== false,
  };
}

/** Strict validation of untrusted theme data. Throws ThemeValidationError for problems; clamps ranges. */
export function validateTheme(input: unknown): Theme {
  const issues: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ThemeValidationError(['theme must be an object']);
  }
  const t = input as Record<string, any>;
  if (typeof t.format !== 'number' || t.format > THEME_FORMAT || t.format < 1) {
    issues.push(`unsupported theme format ${String(t.format)} (this build supports 1-${THEME_FORMAT})`);
  }
  if (typeof t.id !== 'string' || !ID.test(t.id)) issues.push('id must be alphanumeric/dash/underscore');
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60) issues.push('name must be 1-60 characters');
  if (issues.length) throw new ThemeValidationError(issues);
  const v1 = t.format === 1;

  const d = DEFAULT_THEME;
  const c = (t.colors ?? {}) as Record<string, unknown>;
  const colors = {} as Theme['colors'];
  for (const k of Object.keys(d.colors) as (keyof Theme['colors'])[]) {
    if (c[k] !== undefined && !isColor(c[k])) issues.push(`colors.${k} is not a valid color`);
    colors[k] = color(c[k], d.colors[k]);
  }
  // format 1 never rendered bubbles; keep that look when upgrading
  if (v1) colors.bubble = 'rgba(0,0,0,0)';

  const s = (t.shape ?? {}) as Record<string, unknown>;
  const ty = (t.type ?? {}) as Record<string, unknown>;
  if (ty.fontFamily !== undefined && !(typeof ty.fontFamily === 'string' && FONT.test(ty.fontFamily))) {
    issues.push('type.fontFamily contains invalid characters');
  }
  const e = (t.effects ?? {}) as Record<string, unknown>;

  const layersIn: unknown[] = Array.isArray(t.backgrounds) ? t.backgrounds : [];
  if (layersIn.length > 8) issues.push('too many background layers');
  const backgrounds: BackgroundLayer[] = [];
  layersIn.slice(0, 8).forEach((raw, i) => {
    const l = validateLayer((raw ?? {}) as Record<string, any>, i, issues);
    if (!l) return;
    // one background per area: the first one wins (format-1 themes could stack several)
    if (backgrounds.some((b) => b.area === l.area)) return;
    backgrounds.push(l);
  });

  const customCss = typeof t.customCss === 'string' ? t.customCss : '';
  if (customCss.length > MAX_CUSTOM_CSS) issues.push(`customCss exceeds ${MAX_CUSTOM_CSS} characters`);
  if (issues.length) throw new ThemeValidationError(issues);

  return {
    format: THEME_FORMAT, id: t.id, name: t.name.trim(), colors,
    shape: {
      radius: num(s.radius, 0, 32, d.shape.radius),
      serverIconRadius: num(s.serverIconRadius, 0, 50, d.shape.serverIconRadius),
      spacing: num(s.spacing, 0.5, 2, d.shape.spacing),
    },
    type: {
      fontFamily: typeof ty.fontFamily === 'string' ? ty.fontFamily : d.type.fontFamily,
      fontSize: num(ty.fontSize, 11, 24, d.type.fontSize),
      fontWeight: num(ty.fontWeight, 300, 700, d.type.fontWeight),
      headingWeight: num(ty.headingWeight, 400, 900, d.type.headingWeight),
    },
    effects: {
      blur: num(e.blur, 0, 40, 0),
      transparency: num(e.transparency, 0.2, 1, d.effects.transparency),
      shadow: num(e.shadow, 0, 1, d.effects.shadow), animations: e.animations !== false, glass: e.glass === true,
    },
    backgrounds, customCss,
  };
}

export interface CssIssue { level: 'error' | 'warning'; message: string }

/** Custom CSS lint: blocks remote loading and legacy script vectors; warns about fragile selectors. */
export function lintCustomCss(css: string): CssIssue[] {
  const out: CssIssue[] = [];
  if (/@import/i.test(css)) out.push({ level: 'error', message: '@import is not allowed (remote stylesheet loading).' });
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const u = (m[2] ?? '').trim();
    if (!/^(zero-asset:\/\/|data:image\/(png|jpe?g|webp|gif);base64,)/i.test(u)) {
      out.push({ level: 'error', message: `url(${u.slice(0, 40)}) is blocked: only local assets and embedded images are allowed.` });
    }
  }
  if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(css)) {
    out.push({ level: 'error', message: 'Script-capable CSS constructs are not allowed.' });
  }
  if (/<\/?style|<script/i.test(css)) out.push({ level: 'error', message: 'HTML tags are not allowed in CSS.' });
  if (/\[class[*^$]?=|\.[a-z]+_[\w-]{5,}/i.test(css)) {
    out.push({ level: 'warning', message: 'Discord class names change between updates; selectors relying on them may break.' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compilation. ONE compiler feeds both the real Discord window and the settings preview.
// ---------------------------------------------------------------------------------------------

/** Visual/perf switches resolved from the performance profile. */
export interface RenderFlags {
  backgrounds: boolean;
  blur: boolean;
  animations: boolean;
  pauseWhenUnfocused: boolean;
}
export const FULL_FLAGS: RenderFlags = { backgrounds: true, blur: true, animations: true, pauseWhenUnfocused: true };

/** Where things live. The Discord defaults are verified against Discord's current (visual-refresh) DOM. */
export interface Anchors {
  /** elements that (re)declare Discord's theme variables */
  themeScopes: string;
  areas: Record<BgArea, string>;
  /**
   * Per area: the anchor's direct children that carry the see-through "surface tint" (child selector, color).
   * Inside an area with a background, Discord's base surfaces become fully transparent and ONLY these children paint
   * the surface color at `effects.transparency`. That gives exactly one tint layer over the image; letting every
   * nested pane stay translucent would compound (two 50% panes leave 25% of the image visible).
   */
  tints: Record<BgArea, ReadonlyArray<readonly [string, keyof Theme['colors']]>>;
  /** channel list container: Discord paints it with the frame variable, so the frame variable is re-scoped there */
  channelList: string;
  serverRail: string;
  userPanel: string;
  channelTextArea: string;
  message: string;
  groupStart: string;
  messageContent: string;
  username: string;
  menus: string;
  serverIcons: string;
  /** prefix for rules that would otherwise target every element ("" for Discord, ".pv " for the preview) */
  scope: string;
}

/** `name_` hashed-class token, matching only at a class boundary (sidebar_ but not sidebarList_). */
export const cls = (name: string) => `:is([class^="${name}_"],[class*=" ${name}_"])`;

export const DISCORD_ANCHORS: Anchors = {
  themeScopes: ':root,.theme-dark,.theme-darker,.theme-light,.theme-midnight,.visual-refresh',
  areas: {
    global: cls('appMount'),
    sidebar: cls('sidebar'),
    chat: `html:not([data-zero-route="dm"]) ${cls('page')}`,
    dm: `html[data-zero-route="dm"] ${cls('page')}`,
    // 2026-11 builds open User Settings as a modal (outerContainer > modal); older builds used a full-screen layer
    settings: `:is(${cls('outerContainer')} > ${cls('modal')}, ${cls('layers')} > ${cls('layer')}:not(${cls('baseLayer')}))`,
  },
  // verified live: appMount > appAsidePanelWrapper, page > main container, sidebar > nav rail + sidebarList (+ panels)
  tints: {
    global: [['> *', 'background']],
    sidebar: [['> nav', 'sidebar'], [`> ${cls('sidebarList')}`, 'channelList']],
    chat: [['> *', 'surface1']],
    dm: [['> *', 'surface1']],
    settings: [['> *', 'surface1']],
  },
  channelList: cls('sidebarList'),
  serverRail: `nav${cls('guilds')}`,
  userPanel: cls('panels'),
  channelTextArea: cls('channelTextArea'),
  message: `${cls('messageListItem')} > ${cls('message')}`,
  groupStart: cls('groupStart'),
  messageContent: cls('messageContent'),
  username: cls('username'),
  menus: `${cls('menu')}, ${cls('popout')}`,
  serverIcons: `nav${cls('guilds')} foreignObject`,
  scope: '',
};

const r3 = (x: number) => String(Math.round(x * 1000) / 1000);
const mix = (c: string, pct: number, other = 'transparent') => `color-mix(in srgb, ${c} ${r3(pct * 100)}%, ${other})`;

/** The single source of truth for theme values, as CSS custom properties. */
export function themeTokens(theme: Theme): Record<string, string> {
  const c = theme.colors;
  const r = theme.shape.radius;
  return {
    '--zero-bg': c.background, '--zero-surface-1': c.surface1, '--zero-surface-2': c.surface2,
    '--zero-accent': c.accent, '--zero-accent-strong': mix(c.accent, 0.85, '#000'), '--zero-accent-soft': mix(c.accent, 0.8, '#fff'),
    '--zero-accent-faint': mix(c.accent, 0.16), '--zero-text': c.text, '--zero-text-muted': c.textMuted,
    '--zero-border': c.border, '--zero-hover': c.hover, '--zero-selected': mix(c.hover, 0.85, c.text),
    '--zero-bubble': c.bubble, '--zero-sidebar': c.sidebar, '--zero-channels': c.channelList,
    '--zero-user-panel': c.userPanel, '--zero-popup': c.popup, '--zero-modal': c.modal, '--zero-input': c.input,
    '--zero-button': c.button, '--zero-button-hover': mix(c.button, 0.88, '#fff'), '--zero-button-active': mix(c.button, 0.85, '#000'),
    '--zero-scrollbar': c.scrollbar,
    '--zero-radius': `${r3(r)}px`, '--zero-radius-xs': `${r3(r / 2)}px`, '--zero-radius-md': `${r3(r * 1.5)}px`,
    '--zero-radius-lg': `${r3(r * 2)}px`, '--zero-radius-xl': `${r3(r * 3)}px`,
    '--zero-server-radius': `${r3(theme.shape.serverIconRadius)}%`, '--zero-space': r3(theme.shape.spacing),
    '--zero-font': theme.type.fontFamily, '--zero-font-size': `${r3(theme.type.fontSize)}px`,
    '--zero-weight': r3(theme.type.fontWeight), '--zero-heading-weight': r3(theme.type.headingWeight),
    '--zero-shadow': `0 8px 24px rgba(0,0,0,${r3(theme.effects.shadow)})`,
    '--zero-shadow-low': `0 1px 3px rgba(0,0,0,${r3(theme.effects.shadow * 0.8)})`,
  };
}

/** Discord variable -> ZERO token. Names verified against Discord's live stylesheet (visual refresh, 2026-11). */
export const DISCORD_VARIABLE_MAP: ReadonlyArray<readonly [string, string]> = [
  // frame / rails / panels
  ['--background-base-lowest', '--zero-bg'], ['--app-frame-background', '--zero-bg'], ['--background-tertiary', '--zero-bg'],
  // visual refresh (measured live): the channel list paints base-lowest (re-scoped to --zero-channels, see
  // channelList rule), the chat/friends pages paint base-lower, cards paint base-low.
  ['--background-secondary', '--zero-channels'],
  ['--background-secondary-alt', '--zero-user-panel'], ['--panel-bg', '--zero-user-panel'],
  // main content
  ['--background-base-lower', '--zero-surface-1'], ['--background-base-low', '--zero-surface-2'], ['--background-primary', '--zero-surface-1'],
  ['--chat-background', '--zero-surface-1'], ['--chat-background-default', '--zero-surface-1'],
  ['--channel-background-default', '--zero-surface-1'], ['--home-background', '--zero-surface-1'],
  ['--background-surface-high', '--zero-surface-2'], ['--bg-surface-raised', '--zero-surface-2'],
  ['--card-background-default', '--zero-surface-2'], ['--card-secondary-bg', '--zero-surface-2'],
  // popups / modals
  ['--background-surface-higher', '--zero-popup'], ['--background-surface-highest', '--zero-popup'], ['--background-floating', '--zero-popup'],
  ['--modal-background', '--zero-modal'], ['--modal-footer-background', '--zero-modal'],
  // inputs
  ['--input-background-default', '--zero-input'], ['--channeltextarea-background', '--zero-input'], ['--input-background', '--zero-input'],
  ['--input-border-default', '--zero-border'], ['--input-border-active', '--zero-accent'], ['--input-text-default', '--zero-text'],
  ['--input-placeholder-text-default', '--zero-text-muted'], ['--channel-text-area-placeholder', '--zero-text-muted'],
  // text
  ['--text-default', '--zero-text'], ['--text-normal', '--zero-text'], ['--text-strong', '--zero-text'], ['--header-primary', '--zero-text'],
  ['--interactive-text-active', '--zero-text'], ['--interactive-text-hover', '--zero-text'], ['--interactive-active', '--zero-text'], ['--interactive-hover', '--zero-text'],
  ['--text-muted', '--zero-text-muted'], ['--text-subtle', '--zero-text-muted'], ['--header-secondary', '--zero-text-muted'],
  ['--channels-default', '--zero-text-muted'], ['--interactive-text-default', '--zero-text-muted'], ['--interactive-normal', '--zero-text-muted'],
  ['--channel-icon', '--zero-text-muted'], ['--icon-default', '--zero-text-muted'], ['--interactive-icon-default', '--zero-text-muted'],
  // borders
  ['--border-subtle', '--zero-border'], ['--border-muted', '--zero-border'], ['--border-normal', '--zero-border'],
  ['--app-frame-border', '--zero-border'], ['--chat-border', '--zero-border'], ['--card-border-default', '--zero-border'],
  // hover / selection
  ['--background-mod-subtle', '--zero-hover'], ['--background-mod-normal', '--zero-hover'], ['--background-modifier-hover', '--zero-hover'],
  ['--interactive-background-hover', '--zero-hover'], ['--message-background-hover', '--zero-hover'],
  ['--interactive-background-selected', '--zero-selected'], ['--interactive-background-active', '--zero-selected'], ['--background-mod-strong', '--zero-selected'],
  // accent
  ['--brand-500', '--zero-accent'], ['--brand-experiment', '--zero-accent'], ['--text-brand', '--zero-accent'], ['--icon-brand', '--zero-accent'],
  ['--background-brand', '--zero-accent'], ['--control-brand-foreground', '--zero-accent'], ['--control-brand-foreground-new', '--zero-accent'],
  ['--text-link', '--zero-accent'], ['--border-focus', '--zero-accent'], ['--mention-foreground', '--zero-accent'],
  ['--brand-560', '--zero-accent-strong'], ['--brand-600', '--zero-accent-strong'], ['--brand-400', '--zero-accent-soft'], ['--brand-360', '--zero-accent-soft'],
  ['--mention-background', '--zero-accent-faint'], ['--message-mentioned-background-default', '--zero-accent-faint'],
  // buttons
  ['--control-primary-background-default', '--zero-button'], ['--control-primary-border-default', '--zero-button'],
  ['--control-primary-background-hover', '--zero-button-hover'], ['--control-primary-border-hover', '--zero-button-hover'],
  ['--control-primary-background-active', '--zero-button-active'], ['--control-primary-border-active', '--zero-button-active'],
  ['--button-filled-brand-background', '--zero-button'],
  // scrollbars
  ['--scrollbar-auto-thumb', '--zero-scrollbar'], ['--scrollbar-thin-thumb', '--zero-scrollbar'], ['--scrollbar-auto-scrollbar-color-thumb', '--zero-scrollbar'],
  // shape / type / depth
  ['--radius-xs', '--zero-radius-xs'], ['--radius-sm', '--zero-radius'], ['--radius-md', '--zero-radius-md'],
  ['--radius-lg', '--zero-radius-lg'], ['--radius-xl', '--zero-radius-xl'],
  ['--font-primary', '--zero-font'], ['--font-display', '--zero-font'],
  ['--shadow-high', '--zero-shadow'], ['--elevation-high', '--zero-shadow'], ['--shadow-medium', '--zero-shadow'],
  ['--elevation-medium', '--zero-shadow'], ['--shadow-low', '--zero-shadow-low'], ['--elevation-low', '--zero-shadow-low'],
];

/** Base surfaces: fully transparent inside an area with a background (the area's tint children paint them once). */
const BASE_SURFACE_TOKENS = ['--zero-bg', '--zero-surface-1', '--zero-channels', '--zero-sidebar'];
/** Raised surfaces (cards, input, user panel) stay distinguishable: translucent at the surface opacity. */
const RAISED_SURFACE_TOKENS: Array<[string, keyof Theme['colors']]> = [
  ['--zero-user-panel', 'userPanel'], ['--zero-input', 'input'], ['--zero-surface-2', 'surface2'],
];

const decl = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v}!important;`).join('');
const discordDecl = () => DISCORD_VARIABLE_MAP.map(([d, z]) => `${d}:var(${z})!important;`).join('');

function surfaceTokens(theme: Theme, alpha: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of BASE_SURFACE_TOKENS) out[tok] = 'transparent';
  for (const [tok, key] of RAISED_SURFACE_TOKENS) out[tok] = mix(theme.colors[key], alpha);
  return out;
}

/** The single tint layer of an area: its direct children paint the surface color at the surface opacity. */
function tintCss(boostedAnchor: string, tints: Anchors['tints'][BgArea], theme: Theme, alpha: number): string {
  return tints.map(([child, key]) => `${boostedAnchor} ${child}{background-color:${mix(theme.colors[key], alpha)}!important;}`).join('\n');
}

export interface CompileOptions {
  assetUrl?: (imageId: string) => string;
  flags?: RenderFlags;
  /** images that are known to be missing on disk: their layers render without the image */
  missingImages?: ReadonlySet<string>;
  anchors?: Anchors;
  /** custom CSS is only placed in Discord, never in the settings preview */
  includeCustomCss?: boolean;
}

export function backgroundSizeCss(l: BackgroundLayer): string {
  switch (l.size) {
    case 'stretch': return '100% 100%';
    case 'scale': return `${r3(l.scale)}%`;
    default: return l.size;
  }
}

/** CSS for one area background, rendered on the anchor's ::before (Discord already uses ::after on some anchors). */
export function backgroundCss(l: BackgroundLayer, anchor: string, theme: Theme, o: Required<Pick<CompileOptions, 'assetUrl' | 'flags'>> & { missing: boolean; tints: Anchors['tints'][BgArea] }): string {
  const blur = o.flags.blur ? l.blur : 0;
  const pad = blur > 0 ? Math.ceil(blur * 2) : 0;
  const images: string[] = [];
  if (l.overlayOpacity > 0) images.push(`linear-gradient(${mix(l.overlay, l.overlayOpacity)}, ${mix(l.overlay, l.overlayOpacity)})`);
  if (l.kind === 'image' && l.imageId && !o.missing) images.push(`url("${o.assetUrl(l.imageId)}")`);
  if (l.kind === 'gradient' && l.gradient) images.push(`linear-gradient(${r3(l.gradient.angle)}deg, ${l.gradient.from}, ${l.gradient.to})`);
  if (!images.length) return '';
  const n = images.length;
  const sizes = images.map((_, i) => (i === n - 1 ? backgroundSizeCss(l) : '100% 100%')).join(',');
  const repeats = images.map((_, i) => (i === n - 1 ? l.repeat : 'no-repeat')).join(',');
  const pos = images.map(() => `${r3(l.posX)}% ${r3(l.posY)}%`).join(',');
  const filters = [blur > 0 ? `blur(${r3(blur)}px)` : '', l.brightness !== 1 ? `brightness(${r3(l.brightness)})` : '', l.contrast !== 1 ? `contrast(${r3(l.contrast)})` : ''].filter(Boolean).join(' ') || 'none';
  const transition = o.flags.animations && l.transitionMs > 0 ? `transition:opacity ${r3(l.transitionMs)}ms ease,filter ${r3(l.transitionMs)}ms ease;` : '';
  let css = `${anchor}{isolation:isolate;}\n`;
  css += `${anchor}::before{content:"";position:absolute;inset:-${pad}px;z-index:-1;pointer-events:none;` +
    `background-image:${images.join(',')};background-size:${sizes};background-repeat:${repeats};background-position:${pos};` +
    `opacity:${r3(l.opacity)};filter:${filters};${pad ? `clip-path:inset(${pad}px);` : ''}${transition}will-change:transform;}\n`;
  // Let the image show through: base surfaces in this area become transparent and one tint layer is painted
  // at the surface opacity (alpha 1 = opaque tint = image hidden, which is what the user asked for).
  const alpha = theme.effects.transparency;
  // "html " raises specificity above the global variable rule; anchors may already start with html[...]
  const boosted = /^html\b/.test(anchor) ? anchor : `html ${anchor}`;
  const scoped = `${boosted}, ${boosted} :is(.theme-dark,.theme-darker,.theme-light,.theme-midnight)`;
  // In Discord's settings the main content pane is painted with the "card" surface; there it is a base surface.
  const tokens = { ...surfaceTokens(theme, alpha), ...(l.area === 'settings' ? { '--zero-surface-2': 'transparent' } : {}) };
  css += `${scoped}{${decl(tokens)}${discordDecl()}}\n`;
  css += tintCss(boosted, o.tints, theme, alpha) + '\n';
  return css;
}

/**
 * Compile a (validated) theme into the single stylesheet ZERO places in Discord.
 * Variables are declared with !important on every element that (re)declares Discord's theme variables,
 * because Discord sets them on nested .theme-* elements at equal specificity and its sheets load after ours.
 */
export function compileThemeCss(theme: Theme, opts: CompileOptions = {}): string {
  const a = opts.anchors ?? DISCORD_ANCHORS;
  const flags = opts.flags ?? FULL_FLAGS;
  const assetUrl = opts.assetUrl ?? ((id) => `zero-asset://bg/${id}`);
  const t = themeTokens(theme);
  const e = theme.effects;
  const out: string[] = [];

  out.push(`${a.themeScopes}{${decl(t)}${discordDecl()}}`);

  // Elements whose backgrounds Discord does not drive through a variable we can reach.
  // "html body" outranks the area-scoped rules (html <anchor> .theme-*), so nested theme elements keep the list color.
  const list = `html body ${a.channelList}`;
  out.push(`${list}, ${list} :is(.theme-dark,.theme-darker,.theme-light,.theme-midnight){--background-base-lowest:var(--zero-channels)!important;}`);
  out.push(`${a.serverRail}{background:var(--zero-sidebar)!important;}`);
  out.push(`${a.userPanel}{background:var(--zero-user-panel)!important;}`);
  out.push(`${a.channelTextArea}{background:var(--zero-input)!important;border-radius:var(--zero-radius-md)!important;}`);
  out.push(`${a.serverIcons}{mask:none!important;}${a.serverIcons} > *, ${a.serverIcons} img{border-radius:var(--zero-server-radius)!important;overflow:hidden;}`);

  // Typography + spacing in chat.
  out.push(`${a.messageContent}{font-size:var(--zero-font-size)!important;font-weight:var(--zero-weight)!important;line-height:1.375;}`);
  out.push(`${a.username},${a.scope}h1,${a.scope}h2,${a.scope}h3{font-weight:var(--zero-heading-weight)!important;}`);
  out.push(`${a.message}{padding-top:calc(2px * var(--zero-space))!important;padding-bottom:calc(2px * var(--zero-space))!important;}`);
  out.push(`${a.groupStart}{margin-top:calc(17px * var(--zero-space))!important;}`);
  if (!isTransparent(theme.colors.bubble)) {
    out.push(`${a.message}{background:var(--zero-bubble)!important;border-radius:var(--zero-radius-md)!important;margin:calc(2px * var(--zero-space)) 12px!important;}`);
  }

  // Popups: blur / glass only make sense on a translucent surface.
  const popupBlur = flags.blur ? (e.glass ? Math.max(e.blur, 12) : e.blur) : 0;
  if (popupBlur > 0) {
    out.push(`${a.menus}{background-color:${mix(theme.colors.popup, e.glass ? 0.62 : 0.8)}!important;backdrop-filter:blur(${r3(popupBlur)}px) saturate(1.2);}`);
  }

  if (!flags.animations || !e.animations) {
    out.push(`${a.scope}*,${a.scope}*::before,${a.scope}*::after{transition-duration:0s!important;animation-duration:0s!important;animation-delay:0s!important;}`);
  }
  if (flags.pauseWhenUnfocused && !a.scope) out.push('html.zero-paused *{animation-play-state:paused!important;}');
  out.push(`@media (prefers-reduced-motion: reduce){${a.scope}*::before{transition:none!important;}}`);

  if (flags.backgrounds) {
    for (const l of theme.backgrounds) {
      if (!l.enabled) continue;
      const missing = l.kind === 'image' && !!l.imageId && !!opts.missingImages?.has(l.imageId);
      const css = backgroundCss(l, a.areas[l.area], theme, { assetUrl, flags, missing, tints: a.tints[l.area] });
      if (css) out.push(css.trimEnd());
    }
  }

  if (opts.includeCustomCss !== false && theme.customCss.trim() && !lintCustomCss(theme.customCss).some((i) => i.level === 'error')) {
    out.push(`/* custom css */\n${theme.customCss}`);
  }
  return out.join('\n') + '\n';
}

function preset(id: string, name: string, colors: Partial<Theme['colors']>, extra: Partial<Theme> = {}): Theme {
  const base = structuredClone(DEFAULT_THEME);
  return { ...base, id, name, colors: { ...base.colors, ...colors }, ...extra };
}

export const PRESETS: Theme[] = [
  DEFAULT_THEME,
  preset('graphite', 'Graphite', { background: '#151618', surface1: '#1f2022', surface2: '#27292c', accent: '#9aa4b2', text: '#e6e7e9', textMuted: '#8a8d93', border: '#303236', hover: '#2d2f33', sidebar: '#151618', channelList: '#1a1b1d', userPanel: '#171819', popup: '#242528', modal: '#1f2022', input: '#27292c', button: '#5d6673', scrollbar: '#3d4045' }),
  preset('obsidian', 'Obsidian', { background: '#0b0b0e', surface1: '#131318', surface2: '#1a1a21', accent: '#b07cff', text: '#ececf3', textMuted: '#85859a', border: '#23232d', hover: '#1f1f28', sidebar: '#0b0b0e', channelList: '#0f0f13', userPanel: '#0c0c0f', popup: '#16161c', modal: '#131318', input: '#1a1a21', button: '#8b5cf6', scrollbar: '#2c2c38' }),
  preset('frost', 'Frost', { background: '#dfe6ef', surface1: '#f4f7fb', surface2: '#ffffff', accent: '#2563eb', text: '#1c2430', textMuted: '#5d6b7d', border: '#cfd8e3', hover: '#e3e9f2', sidebar: '#dfe6ef', channelList: '#e8edf5', userPanel: '#e1e8f1', popup: '#ffffff', modal: '#f4f7fb', input: '#e8edf5', button: '#2563eb', scrollbar: '#b9c4d3' }),
  preset('amoled', 'AMOLED', { background: '#000000', surface1: '#000000', surface2: '#0c0c0c', accent: '#4fd1c5', text: '#f0f0f0', textMuted: '#7a7a7a', border: '#1a1a1a', hover: '#121212', sidebar: '#000000', channelList: '#030303', userPanel: '#050505', popup: '#0a0a0a', modal: '#050505', input: '#0d0d0d', button: '#14b8a6', scrollbar: '#242424' }, { effects: { ...DEFAULT_THEME.effects, shadow: 0 } }),
  preset('aurora', 'Aurora', { background: '#0f1720', surface1: '#142029', surface2: '#1a2a35', accent: '#5eead4', text: '#e6f1f2', textMuted: '#86a0a8', border: '#223541', hover: '#1d2e3a', sidebar: '#0f1720', channelList: '#13202a', userPanel: '#0e161d', popup: '#172631', modal: '#142029', input: '#1a2a35', button: '#0d9488', scrollbar: '#2d4655' }, {
    effects: { ...DEFAULT_THEME.effects, transparency: 0.72 },
    backgrounds: [{ id: 'aurora-glow', area: 'global', kind: 'gradient', gradient: { angle: 160, from: '#0f3a4a', to: '#2a1145' }, size: 'cover', scale: 100, repeat: 'no-repeat', posX: 50, posY: 50, opacity: 1, blur: 0, brightness: 1, contrast: 1, overlay: '#000000', overlayOpacity: 0, transitionMs: 250, enabled: true }],
  }),
  preset('minimal', 'Minimal', { background: '#1c1c1c', surface1: '#222222', surface2: '#2a2a2a', accent: '#d0d0d0', text: '#dcdcdc', textMuted: '#8a8a8a', border: '#2e2e2e', hover: '#2e2e2e', sidebar: '#1c1c1c', channelList: '#1f1f1f', userPanel: '#1b1b1b', popup: '#262626', modal: '#222222', input: '#2a2a2a', button: '#4a4a4a', scrollbar: '#404040' }, { shape: { radius: 4, serverIconRadius: 20, spacing: 0.85 }, effects: { ...DEFAULT_THEME.effects, shadow: 0, animations: false } }),
  preset('custom', 'Custom', {}),
];
export const PRESET_IDS: ReadonlySet<string> = new Set(PRESETS.map((p) => p.id));
