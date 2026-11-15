/**
 * ThemeStudio: builds a whole palette from two colors and checks that text stays readable (WCAG contrast).
 * Pure functions, used by Settings > Colors. Output is plain colors of the user's own theme, nothing else.
 */
import type { Theme } from './theme';

export type Colors = Theme['colors'];
export type PaletteMode = 'dark' | 'dim' | 'amoled' | 'light';

type Rgb = [number, number, number];

export function parseColor(c: string): Rgb | null {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]!].map((x) => parseInt(x + x, 16)) as Rgb;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x))) as Rgb;
  return null;
}

const hex = (rgb: Rgb) => '#' + rgb.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');

function toHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): string {
  s = Math.min(100, Math.max(0, s)) / 100; l = Math.min(100, Math.max(0, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** WCAG relative luminance and contrast ratio (1 to 21). Unknown colors count as black. */
function luminance(c: string): number {
  const rgb = parseColor(c) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
}

// Lightness of each surface per mode (HSL %), then text.
const LADDER: Record<PaletteMode, Record<Exclude<keyof Colors, 'accent' | 'button' | 'bubble'>, number>> = {
  dark: { background: 7, sidebar: 7, channelList: 9, userPanel: 8, surface1: 11, surface2: 14, popup: 13, modal: 11, input: 14, border: 18, hover: 16, scrollbar: 24, text: 92, textMuted: 62 },
  dim: { background: 13, sidebar: 13, channelList: 15, userPanel: 14, surface1: 17, surface2: 21, popup: 19, modal: 17, input: 21, border: 25, hover: 23, scrollbar: 31, text: 93, textMuted: 67 },
  amoled: { background: 0, sidebar: 0, channelList: 3, userPanel: 2, surface1: 0, surface2: 7, popup: 6, modal: 4, input: 8, border: 13, hover: 10, scrollbar: 20, text: 92, textMuted: 60 },
  light: { background: 91, sidebar: 89, channelList: 95, userPanel: 93, surface1: 99, surface2: 95, popup: 100, modal: 99, input: 94, border: 84, hover: 91, scrollbar: 76, text: 12, textMuted: 38 },
};

/**
 * A full palette: surfaces tinted with the base color's hue (kept subtle), the accent for links and buttons.
 * The result passes `contrastIssues` for text; the bubble color is kept from the current theme.
 */
export function generatePalette(base: string, accent: string, mode: PaletteMode, keep?: Partial<Colors>): Colors {
  const [h, s] = toHsl(parseColor(base) ?? [124, 140, 255]);
  const tint = Math.min(s, mode === 'amoled' ? 12 : mode === 'light' ? 30 : 22);
  const L = LADDER[mode];
  const out = {} as Colors;
  for (const [k, l] of Object.entries(L) as [keyof typeof L, number][]) {
    const sat = k === 'text' ? Math.min(tint, 10) : k === 'textMuted' ? Math.min(tint, 14) : tint;
    out[k] = fromHsl(h, sat, l);
  }
  const acc = parseColor(accent) ? hex(parseColor(accent)!) : '#7c8cff';
  out.accent = acc;
  out.button = acc;
  out.bubble = keep?.bubble ?? 'rgba(0,0,0,0)';
  return fixContrast(out);
}

export interface ContrastIssue { fg: keyof Colors; bg: keyof Colors; ratio: number; min: number; label: string }

const CHECKS: { fg: keyof Colors | 'white'; bg: keyof Colors; min: number; label: string }[] = [
  { fg: 'text', bg: 'surface1', min: 4.5, label: 'Text on the chat background' },
  { fg: 'text', bg: 'channelList', min: 4.5, label: 'Text in the channel list' },
  { fg: 'text', bg: 'popup', min: 4.5, label: 'Text in menus' },
  { fg: 'text', bg: 'input', min: 4.5, label: 'Text in the message box' },
  { fg: 'text', bg: 'modal', min: 4.5, label: 'Text in dialogs' },
  { fg: 'textMuted', bg: 'surface1', min: 3, label: 'Muted text on the chat background' },
  { fg: 'textMuted', bg: 'channelList', min: 3, label: 'Channel names' },
  { fg: 'accent', bg: 'surface1', min: 3, label: 'Links and mentions' },
  { fg: 'white', bg: 'button', min: 3, label: 'Button labels' },
];

export function contrastIssues(c: Colors): ContrastIssue[] {
  const out: ContrastIssue[] = [];
  for (const k of CHECKS) {
    const fg = k.fg === 'white' ? '#ffffff' : c[k.fg];
    const ratio = contrast(fg, c[k.bg]);
    if (ratio < k.min) out.push({ fg: k.fg === 'white' ? 'button' : k.fg, bg: k.bg, ratio, min: k.min, label: k.label });
  }
  return out;
}

/** Moves the lightness of failing text (or the button) until every check passes; surfaces stay as they are. */
export function fixContrast(c: Colors): Colors {
  const out = { ...c };
  for (let pass = 0; pass < 3; pass++) {
    const issues = contrastIssues(out);
    if (!issues.length) break;
    for (const k of CHECKS) {
      if (k.fg === 'white') {
        // the button must be dark enough for white labels
        const [h, s, l0] = toHsl(parseColor(out.button) ?? [88, 101, 242]);
        let l = l0;
        while (contrast('#ffffff', out.button) < k.min && l > 0) { l -= 2; out.button = fromHsl(h, s, l); }
        continue;
      }
      const fgKey = k.fg;
      if (contrast(out[fgKey], out[k.bg]) >= k.min) continue;
      const [h, s, l0] = toHsl(parseColor(out[fgKey]) ?? [255, 255, 255]);
      const up = luminance(out[k.bg]) < 0.18; // dark surface: text gets lighter
      let l = l0;
      while (contrast(out[fgKey], out[k.bg]) < k.min && l >= 0 && l <= 100) { l += up ? 2 : -2; out[fgKey] = fromHsl(h, s, l); }
    }
  }
  return out;
}
