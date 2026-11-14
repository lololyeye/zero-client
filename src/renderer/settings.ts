import {
  BG_AREAS, compileThemeCss, isTransparent, lintCustomCss, PRESET_IDS,
  type Anchors, type BackgroundLayer, type BgArea, type Theme,
} from '../shared/theme';
import { type Config, type LayoutProfile, type PerfOptions, type PerfProfile } from '../shared/config';
import { PERMISSIONS, type PluginInfo } from '../shared/plugin';
import type { Channel } from '../shared/ipc';
import type { PerfSnapshot } from '../main/perf';
import type { CompatReport } from '../main/inject';

interface AppState {
  config: Config; plugins: PluginInfo[]; notes: string[]; compat: CompatReport | null; startupMs: number | null;
  safeMode: boolean; version: string; electron: string; chrome: string; pluginsDir: string; perf: PerfOptions; missingImages: string[];
  update: { current: string; latest: string; newer: boolean; url: string; installerUrl: string | null; notes: string } | null;
}
declare global { interface Window { zero: { invoke(c: Channel, ...a: unknown[]): Promise<{ ok: boolean; data?: any; error?: string }>; onState(cb: (s: AppState) => void): () => void } } }

let state: AppState;
/** Working copy of the ACTIVE theme. Every edit is sent to main, which validates, applies to Discord and persists. */
let draft: Theme;
let current = 'themes';
let shown: string | null = null;
let perfTimer: number | undefined;
let previewRoute: 'guild' | 'dm' = 'guild';
let bgArea: BgArea = 'chat';
const perfHistory: number[] = [];
const scrollPos = new Map<string, number>();
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const scroller = () => $('#scroller');

async function call(ch: Channel, ...args: unknown[]) {
  const r = await window.zero.invoke(ch, ...args);
  if (!r.ok) { toast(r.error ?? 'Something went wrong', true); throw new Error(r.error); }
  return r.data;
}
let toastTimer: number | undefined;
function toast(msg: string, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = err ? 'err' : ''), 2800);
}

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

const ICONS: Record<string, string> = {
  themes: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><circle cx="17" cy="17" r="4"/>',
  colors: '<path d="M12 3s6 6.2 6 11a6 6 0 0 1-12 0c0-4.8 6-11 6-11Z"/>',
  appearance: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  backgrounds: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M9 10h12"/>',
  performance: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>',
  general: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  plugins: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  shortcuts: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  backups: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  advanced: '<path d="M12 3 5 6v5c0 4.4 3 8.4 7 10 4-1.6 7-5.6 7-10V6l-7-3Z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
};
function icon(name: string, size = 18): Element {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return t.content.firstElementChild!;
}

// ---- controls ----
const row = (title: string, desc: string, ctl: Child) =>
  h('div', { class: 'row' }, h('div', { class: 'txt' }, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null), ctl ? h('div', { class: 'c' }, ctl) : null);
const rows = (...r: Child[]) => h('div', { class: 'rows' }, ...r);
const btn = (label: Child, onclick: () => unknown, cls = '', extra: Record<string, any> = {}) => h('button', { class: 'btn ' + cls, onclick, ...extra }, label);
const toggle = (on: boolean, fn: (v: boolean) => void, label?: string) => {
  const i = h('input', { type: 'checkbox', checked: on, 'aria-label': label, onchange: () => fn(i.checked) });
  return h('label', { class: 'switch' }, i, h('i'));
};
function range(v: number, min: number, max: number, step: number, fn: (v: number) => void, fmt: (v: number) => string = String) {
  const out = h('span', { class: 'val' }, fmt(v));
  const i = h('input', { type: 'range', min, max, step, value: v });
  const paint = () => { i.style.setProperty('--p', `${((+i.value - min) / (max - min)) * 100}%`); i.setAttribute('aria-valuetext', fmt(+i.value)); };
  i.addEventListener('input', () => { out.textContent = fmt(+i.value); paint(); fn(+i.value); });
  paint();
  return h('span', { class: 'range' }, i, out);
}
function knob(label: string, v: number, min: number, max: number, step: number, fn: (v: number) => void, fmt: (v: number) => string = String) {
  const val = h('span', {}, fmt(v));
  return h('div', { class: 'knob' }, h('div', { class: 'kl' }, label, val), range(v, min, max, step, (x) => { val.textContent = fmt(x); fn(x); }, fmt));
}
const knobWith = (label: string, ctl: Node) => h('div', { class: 'knob' }, h('div', { class: 'kl' }, label), ctl);
function select<T extends string>(value: T, options: [T, string][], fn: (v: T) => void) {
  const s = h('select', { class: 'select', onchange: () => fn(s.value as T) }, ...options.map(([v, n]) => h('option', { value: v, selected: value === v }, n)));
  return s;
}
function seg<T extends string>(value: T, opts: [T, string, Child?][], fn: (v: T) => void, wide = false) {
  const wrap = h('div', { class: 'seg' + (wide ? ' wide' : ''), role: 'group' });
  for (const [v, label, extra] of opts) {
    const b = h('button', { 'aria-pressed': String(v === value), onclick: () => {
      Array.from(wrap.children).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      fn(v);
    } }, extra, label);
    wrap.append(b);
  }
  return wrap;
}
const toHex = (c: string) => {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : '#000000';
};
function colorInput(v: string, fn: (v: string) => void, label: string, showHex = true) {
  const code = h('code', {}, toHex(v));
  const i = h('input', { type: 'color', value: toHex(v), 'aria-label': label, oninput: () => { code.textContent = i.value; fn(i.value); } });
  return h('label', { class: 'color' }, i, showHex ? code : null);
}
const keys = (...k: string[]) => h('span', { class: 'keys' }, ...k.flatMap((x, n) => (n ? ['+', h('kbd', {}, x)] : [h('kbd', {}, x)])));

// ---- in-page dialogs (window.prompt is not available in Electron) ----
function modal<T>(build: (close: (v: T | null) => void) => { body: Child[]; foot: Child[]; focus?: HTMLElement }, wide = false): Promise<T | null> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: wide ? 'wide' : '' });
    let done = false;
    const close = (v: T | null) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    const { body, foot, focus } = build(close);
    dlg.append(h('div', { class: 'dlg-body' }, ...body), h('div', { class: 'dlg-foot' }, ...foot));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(null); });
    document.body.append(dlg);
    dlg.showModal();
    focus?.focus();
  });
}
function askText(title: string, label: string, initial = '', ok = 'Save') {
  return modal<string>((close) => {
    const input = h('input', { class: 'text full', value: initial, spellcheck: false, maxLength: 60, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && input.value.trim()) close(input.value.trim()); } });
    queueMicrotask(() => input.select());
    return { body: [h('h3', {}, title), h('label', {}, label), input], foot: [btn('Cancel', () => close(null), 'ghost'), btn(ok, () => input.value.trim() && close(input.value.trim()), 'primary')], focus: input };
  });
}
function askConfirm(title: string, text: string, ok: string, danger = false) {
  return modal<boolean>((close) => {
    const yes = btn(ok, () => close(true), danger ? 'danger' : 'primary');
    return { body: [h('h3', {}, title), h('p', {}, text)], foot: [btn('Cancel', () => close(null), 'ghost'), yes], focus: yes };
  }).then((v) => v === true);
}

// ---------------------------------------------------------------------------------------------
// Live editing: one path. Edit draft -> preview (same compiler as Discord) -> main validates, applies, persists.
// The page is never rebuilt for the user's own edits: only the preview repaints (once per frame).
// ---------------------------------------------------------------------------------------------
let sendTimer: number | undefined;
let sending = 0;
let inflight: Promise<unknown> = Promise.resolve();
function edit(fn: () => void) {
  fn();
  schedulePreview();
  setSaved(true);
  window.clearTimeout(sendTimer);
  sendTimer = window.setTimeout(() => {
    sendTimer = undefined;
    sending++;
    const snapshot = structuredClone(draft);
    inflight = inflight.then(async () => {
      try {
        const r = await window.zero.invoke('theme:update', snapshot);
        if (!r.ok) {
          toast(`Not applied: ${r.error}`, true);
          draft = structuredClone(state.config.themes[state.config.activeThemeId]!); // back to last good theme
          renderSoon();
          return;
        }
        state.config.themes[r.data.id] = { ...snapshot, id: r.data.id, name: r.data.name };
        state.config.activeThemeId = r.data.id;
        if (r.data.forked) {
          draft.id = r.data.id; draft.name = r.data.name;
          toast(`Presets stay untouched, so your changes are saved as “${r.data.name}”.`);
          updateFoot();
          if (current === 'themes') renderSoon();
        }
      } finally {
        sending--;
        if (!sending && sendTimer === undefined) setSaved(false);
      }
    });
  }, 70);
}
let savedTimer: number | undefined;
function setSaved(busy: boolean) {
  const s = document.querySelector('.saved');
  if (!s) return;
  window.clearTimeout(savedTimer);
  s.className = 'saved on' + (busy ? ' busy' : '');
  s.textContent = busy ? 'Saving…' : 'Saved';
  if (!busy) savedTimer = window.setTimeout(() => s.classList.remove('on'), 1600);
}

const PREVIEW_ANCHORS: Anchors = {
  themeScopes: '.pv', areas: { global: '.pv', sidebar: '.pv-sidebar', chat: '.pv[data-route="guild"] .pv-page', dm: '.pv[data-route="dm"] .pv-page', settings: '.pv-none' },
  tints: { global: [['> *', 'background']], sidebar: [['> .pv-rail', 'sidebar'], ['> .pv-channels', 'channelList']], chat: [['> .pv-pagein', 'surface1']], dm: [['> .pv-pagein', 'surface1']], settings: [] },
  channelList: '.pv-channels', serverRail: '.pv-rail', userPanel: '.pv-panel', channelTextArea: '.pv-input', message: '.pv-msg', groupStart: '.pv-group',
  messageContent: '.pv-content', username: '.pv-user', menus: '.pv-menu', serverIcons: '.pv-icon', scope: '.pv ',
};

function previewMarkup() {
  const msg = (user: string, text: Child, group = false) => h('div', { class: 'pv-msg' + (group ? ' pv-group' : '') }, h('span', { class: 'pv-av' }), h('div', {}, h('span', { class: 'pv-user' }, user), h('div', { class: 'pv-content' }, text)));
  return h('div', { class: 'pv', 'data-route': previewRoute, role: 'img', 'aria-label': 'Live preview of the theme' },
    h('div', { class: 'pv-sidebar' },
      h('nav', { class: 'pv-rail' }, h('div', { class: 'pv-icon pv-icon-active' }), h('div', { class: 'pv-icon' }), h('div', { class: 'pv-icon' })),
      h('div', { class: 'pv-channels' },
        h('div', { class: 'pv-ch-title' }, previewRoute === 'dm' ? 'Direct Messages' : 'ZERO Lounge'),
        h('div', { class: 'pv-ch' }, '# general'), h('div', { class: 'pv-ch pv-ch-sel' }, '# design'), h('div', { class: 'pv-ch' }, '# releases'),
        h('div', { class: 'pv-panel' }, h('span', { class: 'pv-av' }), 'you'))),
    h('div', { class: 'pv-page' }, h('div', { class: 'pv-pagein' },
      h('div', { class: 'pv-head' }, previewRoute === 'dm' ? '@ friend' : '# design'),
      h('div', { class: 'pv-msgs' },
        msg('Mara', 'The new background really works.', true),
        h('div', { class: 'pv-msg pv-hover' }, h('span', { class: 'pv-av', style: 'visibility:hidden' }), h('div', { class: 'pv-content' }, 'Hover state looks like this.')),
        msg('you', h('span', {}, 'Ping ', h('span', { class: 'pv-mention' }, '@Mara'), ', see ', h('span', { class: 'pv-link' }, 'the changelog')), true)),
      h('div', { class: 'pv-input' }, previewRoute === 'dm' ? 'Message @friend' : 'Message #design'),
      h('div', { class: 'pv-menu' }, h('div', {}, 'Mark as read'), h('div', { class: 'pv-btn' }, 'Join')))));
}

/** Preview uses compileThemeCss with preview anchors: the exact same variables and rules as Discord. */
function paintPreview() {
  if (!document.querySelector('.pv')) return;
  let style = document.getElementById('pv-style') as HTMLStyleElement | null;
  if (!style) { style = h('style', { id: 'pv-style' }); document.head.append(style); }
  style.textContent = compileThemeCss(draft, { anchors: PREVIEW_ANCHORS, flags: state.perf, includeCustomCss: false, assetUrl: (id) => `zero-asset://bg/${id}`, missingImages: new Set(state.missingImages) });
}
let pvFrame = 0;
function schedulePreview() { if (!pvFrame) pvFrame = requestAnimationFrame(() => { pvFrame = 0; paintPreview(); }); }
function previewBlock() {
  const host = h('div', {}, previewMarkup());
  return h('div', { class: 'pv-wrap' }, host, h('div', { class: 'pv-bar' },
    h('span', { class: 'muted small' }, 'Live preview'),
    seg(previewRoute, [['guild', 'Server'], ['dm', 'Direct messages']], (v) => { previewRoute = v; host.replaceChildren(previewMarkup()); })));
}

// ---- sections ----
interface Section { id: string; title: string; group: string; terms: string; render: () => HTMLElement }
const sections: Section[] = [];
const sect = (id: string, title: string, group: string, terms: string, render: () => HTMLElement) => sections.push({ id, title, group, terms, render });

function notices(): Child {
  const msgs = [...(state.safeMode ? ['Safe Mode is on: Discord is shown without any customization.'] : []), ...state.notes.filter((n) => /Safe Mode|unreadable|Restored|migrated|safe-mode/.test(n) && !(state.safeMode && n.startsWith("Safe Mode")))];
  if (!msgs.length) return null;
  return h('div', {}, ...msgs.map((m, i) => h('div', { class: 'notice' }, h('span', { class: 'grow' }, m),
    state.safeMode && i === 0 ? btn('Turn off', () => call('recovery:safeMode', false), 'sm') : null)));
}
function page(title: string, lede: string, ...kids: Child[]) {
  return h('section', { class: 'page' }, notices(), h('div', { class: 'pagehead' }, h('h1', {}, title), h('span', { class: 'saved', 'aria-live': 'polite' })), lede ? h('p', { class: 'lede' }, lede) : null, ...kids);
}

// ---- Themes ----
function themeCard(t: Theme, on: boolean) {
  const c = t.colors;
  const line = (bg: string, w: string) => h('span', { class: 'm-line', style: { background: bg, width: w } });
  return h('button', { class: 'tcard', 'aria-pressed': String(on), title: t.name, onclick: () => { if (!on) void select_(t.id); } },
    h('div', { class: 'tmini' },
      h('span', { style: { background: c.sidebar } }),
      h('span', { style: { background: c.channelList } }),
      h('span', { class: 'm-chat', style: { background: c.surface1 } }, line(c.text, '72%'), line(c.textMuted, '48%'), line(c.accent, '30%'), h('span', { class: 'm-in', style: { background: c.input } }))),
    h('div', { class: 'tname' }, t.name),
    h('div', { class: 'tkind' }, PRESET_IDS.has(t.id) ? 'Preset' : 'Custom'),
    h('span', { class: 'check' }, icon('check', 13)));
}

sect('themes', 'Themes', 'Appearance', 'preset import export duplicate rename delete midnight graphite obsidian frost amoled aurora minimal custom css', () => {
  const cfg = state.config;
  const lintOut = h('div');
  const showLint = (css: string) => lintOut.replaceChildren(...lintCustomCss(css).map((i) => h('div', { class: 'issue ' + i.level }, (i.level === 'error' ? 'Blocked (not applied): ' : 'Warning: ') + i.message)));
  const css = h('textarea', { class: 'code', value: draft.customCss, spellcheck: false, placeholder: '/* Applied after the theme. @import and remote url() are blocked. */', oninput: () => { showLint(css.value); edit(() => (draft.customCss = css.value)); } });
  showLint(draft.customCss);
  const isPreset = PRESET_IDS.has(draft.id);
  return page('Themes', 'Pick a look, then fine-tune it in Colors and Appearance. Presets are never overwritten: your first change makes your own copy.',
    h('div', { class: 'tgrid' }, ...Object.values(cfg.themes).map((t) => themeCard(t, t.id === cfg.activeThemeId))),
    h('div', { class: 'actions' },
      btn('Duplicate', () => call('theme:duplicate', cfg.activeThemeId).then(() => toast('Theme duplicated'))),
      btn('Rename', async () => { const n = await askText('Rename theme', 'Theme name', draft.name); if (n) await call('theme:rename', draft.id, n).then(() => toast('Renamed')); }, '', { disabled: isPreset, title: isPreset ? 'Presets cannot be renamed. Duplicate it first.' : '' }),
      btn('Export', () => call('theme:export', draft.id).then((ok) => ok && toast('Theme exported'))),
      btn('Import', () => call('theme:import').then((n) => n && toast(`Imported “${n}”`))),
      btn('Delete', async () => { if (await askConfirm('Delete theme', `“${draft.name}” will be removed. Automatic backups keep your last 8 snapshots.`, 'Delete theme', true)) await call('theme:delete', draft.id).then(() => toast('Theme deleted')); }, 'ghost danger', { disabled: isPreset })),
    h('h2', {}, 'Custom CSS'),
    h('p', { class: 'muted small', style: 'margin:0 0 10px' }, 'Discord renames its classes in updates, so selectors can break. If something looks wrong, Ctrl + Shift + Z turns every customization off.'),
    css, lintOut);
});

async function select_(id: string) {
  window.clearTimeout(sendTimer); sendTimer = undefined;
  await inflight;
  await call('theme:select', id);
}

// ---- Colors ----
const COLOR_HELP: Record<keyof Theme['colors'], [string, string]> = {
  background: ['App frame', 'Window frame and title bar area.'],
  sidebar: ['Server list', 'The vertical rail of server icons.'],
  channelList: ['Channel & DM list', 'Channel list, DM list and member list.'],
  userPanel: ['User panel', 'Your avatar and status, bottom left.'],
  surface1: ['Chat background', 'Main chat, DMs and home.'],
  surface2: ['Cards', 'Embeds and other raised surfaces.'],
  popup: ['Menus & popouts', 'Context menus, profile popouts, tooltips.'],
  modal: ['Modals', 'Dialogs and their footers.'],
  input: ['Inputs', 'Message box and text fields.'],
  text: ['Text', 'Normal and strong text, active items.'],
  textMuted: ['Muted text', 'Channel names, placeholders, icons.'],
  border: ['Borders', 'Dividers and outlines.'],
  hover: ['Hover', 'Hovered rows and messages.'],
  accent: ['Accent', 'Links, mentions, focus and highlights.'],
  button: ['Buttons', 'Primary buttons.'],
  scrollbar: ['Scrollbars', 'Scrollbar thumbs.'],
  bubble: ['Message bubbles', 'Card behind each message.'],
};

sect('colors', 'Colors', 'Appearance', 'color palette accent text sidebar chat background button border hover scrollbar input modal menu', () => {
  const colorKeys = (Object.keys(COLOR_HELP) as (keyof Theme['colors'])[]).filter((k) => k !== 'bubble');
  return page('Colors', 'Every color of the active theme. Changes show up in Discord as you pick them.',
    previewBlock(),
    h('h2', {}, 'Palette'),
    h('div', { class: 'colors' }, ...colorKeys.map((k) => h('div', { class: 'ctile' },
      colorInput(draft.colors[k], (v) => edit(() => { draft.colors[k] = v; }), COLOR_HELP[k][0], false),
      h('div', { class: 'txt' }, h('div', { class: 't' }, COLOR_HELP[k][0]), h('div', { class: 'd', title: COLOR_HELP[k][1] }, COLOR_HELP[k][1]))))));
});

// ---- Appearance ----
sect('appearance', 'Appearance', 'Appearance', 'quick accent typography font size weight radius corners shadow blur glass animations spacing bubbles icons', () => {
  const t = draft;
  return page('Appearance', 'Shape, type and effects of the active theme.',
    previewBlock(),
    h('h2', {}, 'Shape'),
    rows(
      row('Accent color', 'Links, mentions, focus rings and unread pills.', colorInput(t.colors.accent, (v) => edit(() => { t.colors.accent = v; }), 'Accent color')),
      row('Corner radius', 'Inputs, cards, menus and modals.', range(t.shape.radius, 0, 24, 1, (v) => edit(() => (t.shape.radius = v)), (v) => v + 'px')),
      row('Server icon shape', '0% is square, 50% is a circle.', range(t.shape.serverIconRadius, 0, 50, 1, (v) => edit(() => (t.shape.serverIconRadius = v)), (v) => v + '%')),
      row('Message bubbles', 'Draw each message on its own rounded card.', toggle(!isTransparent(t.colors.bubble), (on) => edit(() => { t.colors.bubble = on ? t.colors.surface2 : 'rgba(0,0,0,0)'; }), 'Message bubbles')),
      row('Message spacing', 'Space between messages and groups.', range(t.shape.spacing, 0.5, 2, 0.05, (v) => edit(() => (t.shape.spacing = v)), (v) => v.toFixed(2) + '×'))),
    h('h2', {}, 'Text'),
    rows(
      row('Font', 'Any font installed on Windows. Separate fallbacks with commas.', h('input', { class: 'text', value: t.type.fontFamily, spellcheck: false, onchange: (e: Event) => edit(() => (t.type.fontFamily = (e.target as HTMLInputElement).value)) })),
      row('Message size', '', range(t.type.fontSize, 11, 24, 1, (v) => edit(() => (t.type.fontSize = v)), (v) => v + 'px')),
      row('Message weight', '', range(t.type.fontWeight, 300, 700, 100, (v) => edit(() => (t.type.fontWeight = v)))),
      row('Names & headings weight', '', range(t.type.headingWeight, 400, 900, 100, (v) => edit(() => (t.type.headingWeight = v))))),
    h('h2', {}, 'Effects'),
    rows(
      row('Shadows', 'Under menus, popouts and modals.', range(t.effects.shadow, 0, 1, 0.05, (v) => edit(() => (t.effects.shadow = v)), (v) => Math.round(v * 100) + '%')),
      row('Menu blur', state.perf.blur ? 'Frosted menus and popouts. Uses the GPU.' : 'Your performance profile turns blur off.', range(t.effects.blur, 0, 40, 1, (v) => edit(() => (t.effects.blur = v)), (v) => (v ? v + 'px' : 'Off'))),
      row('Glass menus', 'Stronger see-through menus, at least 12px blur.', toggle(t.effects.glass, (v) => edit(() => (t.effects.glass = v)), 'Glass menus')),
      row('Animations', 'Turn off to make every transition in Discord instant.', toggle(t.effects.animations, (v) => edit(() => (t.effects.animations = v)), 'Animations'))));
});

// ---- Backgrounds ----
const AREA_INFO: Record<BgArea, [string, string, string]> = {
  global: ['Window', 'Whole window', 'Behind everything. Every surface becomes see-through.'],
  sidebar: ['Sidebar', 'Server & channel list', 'Behind the server rail, channel list and user panel.'],
  chat: ['Server chat', 'Server chat', 'Behind messages in server channels.'],
  dm: ['DMs', 'Direct messages', 'Behind conversations and the friends page.'],
  settings: ['Settings', 'Discord settings', 'Behind Discord’s own settings pages.'],
};

let library: { id: string; bytes: number }[] | null = null;
const DEFAULT_GRADIENT = { angle: 140, from: '#1c2740', to: '#2a1840' };

sect('backgrounds', 'Backgrounds', 'Appearance', 'image wallpaper gradient blur opacity overlay brightness contrast position cover repeat scale transition chat sidebar dm direct messages settings global surface transparency', () => {
  const editor = h('div', {}, areaEditor(bgArea));
  const isSet = (a: BgArea) => draft.backgrounds.some((l) => l.area === a && l.enabled);
  const root = page('Backgrounds', 'An image or gradient for each part of Discord. Big images are downscaled to 2560px when imported.',
    !state.perf.backgrounds ? h('div', { class: 'notice' }, h('span', { class: 'grow' }, 'Your performance profile hides backgrounds in Discord.'), btn('Open Performance', () => go('performance'), 'sm')) : null,
    state.missingImages.length ? h('div', { class: 'notice err' }, `${state.missingImages.length} image(s) used by your themes are missing on disk. Those areas only show their overlay.`) : null,
    previewBlock(),
    rows(row('Panel opacity', 'How solid Discord’s panels are over a background. Lower shows more of the image.',
      range(draft.effects.transparency, 0.2, 1, 0.01, (v) => edit(() => (draft.effects.transparency = v)), (v) => Math.round(v * 100) + '%'))),
    h('h2', {}, 'Area'),
    seg(bgArea, BG_AREAS.map((a): [BgArea, string, Child] => [a, AREA_INFO[a][0], isSet(a) ? h('span', { class: 'pip' }) : null]), (v) => { bgArea = v; editor.replaceChildren(areaEditor(v)); }, true),
    editor);
  if (library === null) void call('bg:list').then((l) => { library = l; if (editor.isConnected) editor.replaceChildren(areaEditor(bgArea)); });
  return root;
});

function newLayer(area: BgArea, kind: 'image' | 'gradient', imageId?: string): BackgroundLayer {
  return {
    id: `bg-${area}`, area, kind, imageId, gradient: kind === 'gradient' ? { ...DEFAULT_GRADIENT } : undefined,
    size: 'cover', scale: 100, repeat: 'no-repeat', posX: 50, posY: 50, opacity: 1, blur: 0, brightness: 1, contrast: 1,
    overlay: '#000000', overlayOpacity: 0.25, transitionMs: 250, enabled: true,
  };
}

function setLayer(area: BgArea, layer: BackgroundLayer | null) {
  edit(() => {
    draft.backgrounds = draft.backgrounds.filter((l) => l.area !== area);
    if (layer) draft.backgrounds.push(layer);
  });
  render();
}

async function importInto(area: BgArea) {
  const img = await call('bg:import');
  if (!img) return;
  library = null;
  const prev = draft.backgrounds.find((l) => l.area === area);
  setLayer(area, prev ? { ...prev, kind: 'image', imageId: img.id, gradient: undefined, enabled: true } : newLayer(area, 'image', img.id));
  toast(`Image ready: ${img.width}×${img.height}, ${Math.round(img.bytes / 1024)} KB`);
}

function pickFromLibrary(area: BgArea) {
  void modal<string>((close) => ({
    body: [h('h3', {}, 'Your images'), h('p', {}, 'Images you imported before. Pick one for this area.'),
      h('div', { class: 'lib-grid' }, ...(library ?? []).map((i) => h('button', { class: 'lib-item', title: `${Math.round(i.bytes / 1024)} KB`, 'aria-label': `Image, ${Math.round(i.bytes / 1024)} KB`, style: { backgroundImage: `url("zero-asset://bg/${i.id}")` }, onclick: () => close(i.id) })))],
    foot: [btn('Cancel', () => close(null), 'ghost')],
  }), true).then((id) => {
    if (!id) return;
    const prev = draft.backgrounds.find((l) => l.area === area);
    setLayer(area, prev ? { ...prev, kind: 'image', imageId: id, gradient: undefined, enabled: true } : newLayer(area, 'image', id));
  });
}

function areaEditor(area: BgArea) {
  const l = draft.backgrounds.find((x) => x.area === area);
  const [, title, desc] = AREA_INFO[area];
  const gradientCss = (g: NonNullable<BackgroundLayer['gradient']>) => `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`;
  const thumb = h('div', { class: 'bg-thumb', style: l ? { backgroundImage: l.kind === 'image' ? `url("zero-asset://bg/${l.imageId}")` : gradientCss(l.gradient ?? DEFAULT_GRADIENT) } : {} }, l ? null : 'No background');
  const missing = l?.kind === 'image' && l.imageId && state.missingImages.includes(l.imageId);
  const head = h('div', { class: 'bg-head' }, thumb,
    h('div', { class: 'bg-meta' },
      h('div', { class: 't' }, title, l ? toggle(l.enabled, (v) => edit(() => { l.enabled = v; }), `${title} background`) : null),
      h('div', { class: 'd' }, desc),
      missing ? h('div', { class: 'issue error', style: 'margin:0 0 10px' }, 'This image is missing on disk. Import it again or pick another.') : null,
      h('div', { class: 'actions' },
        btn(h('span', { style: 'display:contents' }, icon('upload', 16), l?.kind === 'image' ? 'Replace image' : 'Import image'), () => importInto(area), 'primary sm'),
        library && library.length ? btn(`Your images (${library.length})`, () => pickFromLibrary(area), 'sm') : null,
        l?.kind !== 'gradient' ? btn('Gradient', () => setLayer(area, l ? { ...l, kind: 'gradient', imageId: undefined, gradient: l.gradient ?? { ...DEFAULT_GRADIENT } } : newLayer(area, 'gradient')), 'sm') : null,
        l ? btn('Remove', () => setLayer(area, null), 'ghost danger sm') : null)));
  if (!l) return head;
  const u = (fn: () => void) => edit(fn);
  const pct = (v: number) => Math.round(v * 100) + '%';
  const g = l.gradient;
  const repaintThumb = () => { if (l.kind === 'gradient' && l.gradient) thumb.style.backgroundImage = gradientCss(l.gradient); };
  return h('div', {}, head,
    h('h2', {}, 'Adjust'),
    h('div', { class: 'knobs' },
      l.kind === 'gradient' && g ? knobWith('From', colorInput(g.from, (v) => { u(() => (g.from = v)); repaintThumb(); }, 'Gradient start')) : null,
      l.kind === 'gradient' && g ? knobWith('To', colorInput(g.to, (v) => { u(() => (g.to = v)); repaintThumb(); }, 'Gradient end')) : null,
      l.kind === 'gradient' && g ? knob('Angle', g.angle, 0, 360, 1, (v) => { u(() => (g.angle = v)); repaintThumb(); }, (v) => v + '°') : null,
      l.kind === 'image' ? knobWith('Size', select(l.size, [['cover', 'Fill (crop)'], ['contain', 'Fit inside'], ['stretch', 'Stretch'], ['auto', 'Original size'], ['scale', 'Custom scale']], (v) => { u(() => (l.size = v)); render(); })) : null,
      l.kind === 'image' ? knobWith('Repeat', select(l.repeat, [['no-repeat', 'No repeat'], ['repeat', 'Tile'], ['repeat-x', 'Tile horizontally'], ['repeat-y', 'Tile vertically']], (v) => u(() => (l.repeat = v)))) : null,
      l.kind === 'image' && l.size === 'scale' ? knob('Scale', l.scale, 25, 400, 5, (v) => u(() => (l.scale = v)), (v) => v + '%') : null,
      l.kind === 'image' ? knob('Horizontal position', l.posX, 0, 100, 1, (v) => u(() => (l.posX = v)), (v) => v + '%') : null,
      l.kind === 'image' ? knob('Vertical position', l.posY, 0, 100, 1, (v) => u(() => (l.posY = v)), (v) => v + '%') : null,
      knob('Opacity', l.opacity, 0, 1, 0.01, (v) => u(() => (l.opacity = v)), pct),
      knob(state.perf.blur ? 'Blur' : 'Blur (off in this profile)', l.blur, 0, 40, 1, (v) => u(() => (l.blur = v)), (v) => (v ? v + 'px' : 'Off')),
      knob('Brightness', l.brightness, 0, 2, 0.05, (v) => u(() => (l.brightness = v)), pct),
      knob('Contrast', l.contrast, 0, 2, 0.05, (v) => u(() => (l.contrast = v)), pct),
      knobWith('Overlay color', colorInput(l.overlay, (v) => u(() => (l.overlay = v)), `${title} overlay color`)),
      knob('Overlay strength', l.overlayOpacity, 0, 1, 0.01, (v) => u(() => (l.overlayOpacity = v)), pct),
      knob('Fade when switching', l.transitionMs, 0, 2000, 50, (v) => u(() => (l.transitionMs = v)), (v) => (v ? v + ' ms' : 'Instant'))));
}

// ---- Layout ----
let layoutTimer: number | undefined;
sect('layout', 'Layout', 'Appearance', 'density compact comfortable width sidebar channel list chat avatar timestamp profile daily gaming focus minimal', () => {
  const cfg = state.config;
  const l = cfg.layouts[cfg.activeLayoutId]!;
  const save = (p: Partial<LayoutProfile>) => {
    Object.assign(l, p);
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(() => void call('layout:save', { ...l }), 60);
  };
  const newProfile = async () => {
    const n = await askText('New layout profile', 'Profile name', '', 'Create');
    if (!n) return;
    await call('layout:save', { ...l, id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile', name: n });
    state = await call('state:get'); render();
  };
  const del = async () => { if (await askConfirm('Delete layout profile', `“${l.name}” will be removed.`, 'Delete', true)) await call('layout:delete', l.id); };
  return page('Layout', 'Profiles switch instantly. Changes are saved to the selected profile.',
    h('div', { class: 'actions' },
      seg(l.id, Object.values(cfg.layouts).map((p): [string, string] => [p.id, p.name]), (id) => void call('layout:select', id)),
      btn('New profile', newProfile, 'sm'),
      btn('Delete', del, 'ghost danger sm')),
    rows(
      row('Message density', 'Compact fits more messages on screen.', seg(l.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']], (v) => save({ density: v }))),
      row('Server list width', 'Width of the server icon rail.', range(l.sidebarWidth, 0, 120, 4, (v) => save({ sidebarWidth: v }), (v) => (v ? v + 'px' : 'Default'))),
      row('Channel list width', '', range(l.channelListWidth, 0, 420, 10, (v) => save({ channelListWidth: v }), (v) => (v ? v + 'px' : 'Default'))),
      row('Chat max width', 'Shorter lines are easier to read.', range(l.chatMaxWidth, 0, 1400, 20, (v) => save({ chatMaxWidth: v }), (v) => (v ? v + 'px' : 'Full'))),
      row('Avatar shape', '', seg(l.avatarShape, [['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square']], (v) => save({ avatarShape: v }))),
      row('Timestamps', 'Hide them for a cleaner chat.', toggle(l.timestampFormat !== 'hidden', (v) => save({ timestampFormat: v ? 'default' : 'hidden' }), 'Show timestamps'))));
});

// ---- Performance ----
const PERF_INFO: Record<keyof PerfOptions, [string, string]> = {
  backgrounds: ['Background images', 'Show area backgrounds in Discord.'],
  blur: ['Blur effects', 'Menu blur, glass and background blur. The most GPU-hungry effect.'],
  animations: ['Animations', 'Discord’s and ZERO’s transitions.'],
  pauseWhenUnfocused: ['Pause when unfocused', 'Stops animated emoji and avatars while you are in another app.'],
  spellcheck: ['Spellcheck', 'Dictionaries for the message box.'],
  backgroundThrottle: ['Throttle when hidden', 'Lets Chromium slow Discord while minimized. Voice and notifications keep working. Applies after restart.'],
};

sect('performance', 'Performance', 'Client', 'ram cpu gpu memory startup profile lightweight balanced custom throttle dashboard modules spellcheck blur', () => {
  const cfg = state.config;
  const stat = (id: string, label: string) => h('div', {}, h('b', { id }, '–'), h('span', {}, label));
  const prof = (p: PerfProfile, name: string, desc: string) => h('button', { class: 'prof', 'aria-pressed': String(cfg.performance.profile === p), onclick: () => call('perf:set', { profile: p }) }, h('b', {}, name), h('span', {}, desc));
  const opts = state.perf;
  const custom = cfg.performance.profile === 'custom';
  const root = page('Performance', 'Live numbers from this app. Sampling only runs while this page is open.',
    h('div', { class: 'stats' }, stat('s-ram', 'Memory'), stat('s-cpu', 'CPU'), stat('s-start', 'Startup'), stat('s-prof', 'Profile')),
    h('div', { class: 'chart' }, h('canvas', { class: 'spark', id: 'spark', 'aria-label': 'Memory over the last two minutes' }), h('div', { class: 'muted small', id: 's-grow' }, 'Collecting samples…')),
    h('div', { class: 'procs', id: 's-procs' }),
    h('h2', {}, 'Profile'),
    h('div', { class: 'profiles' },
      prof('balanced', 'Balanced', 'Everything on: full theme, backgrounds, blur and animations.'),
      prof('lightweight', 'Lightweight', 'Keeps colors and backgrounds. No blur, animations or spellcheck.'),
      prof('custom', 'Custom', 'Choose each option yourself.')),
    h('h2', {}, 'Options'),
    rows(...(Object.keys(PERF_INFO) as (keyof PerfOptions)[]).map((k) => row(PERF_INFO[k][0], PERF_INFO[k][1],
      custom ? toggle(cfg.performance.custom[k], (v) => call('perf:set', { custom: { [k]: v } }), PERF_INFO[k][0])
        : h('span', { class: 'pill ' + (opts[k] ? 'ok' : ''), title: 'Switch to Custom to change it' }, opts[k] ? 'On' : 'Off')))),
    h('h2', {}, 'Details'),
    h('div', { class: 'muted small', id: 's-gpu' }), h('div', { class: 'muted small', id: 's-mod', style: 'margin-top:4px' }), h('ul', { class: 'plain', id: 's-bg' }));
  queueMicrotask(startPerf);
  return root;
});

async function samplePerf() {
  const r = await window.zero.invoke('perf:snapshot'); if (!r.ok) return;
  const s = r.data as PerfSnapshot;
  const set = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('s-ram', s.ramMb.toFixed(0) + ' MB'); set('s-cpu', s.cpuPercent.toFixed(1) + '%');
  set('s-start', s.startupMs ? s.startupMs + ' ms' : 'n/a'); set('s-prof', s.profile[0]!.toUpperCase() + s.profile.slice(1));
  set('s-gpu', 'GPU: ' + s.gpu); set('s-mod', 'Active modules: ' + s.activeModules.join(', '));
  const bg = document.getElementById('s-bg'); if (bg) bg.replaceChildren(...s.background.map((b) => h('li', {}, b)));
  const pr = document.getElementById('s-procs');
  if (pr) pr.replaceChildren(...s.processes.sort((a, b) => b.ramMb - a.ramMb).map((p) => h('span', { class: 'pill' }, `${p.type} · ${p.ramMb.toFixed(0)} MB`)));
  perfHistory.push(s.ramMb); if (perfHistory.length > 60) perfHistory.shift();
  const c = document.getElementById('spark') as HTMLCanvasElement | null; if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
  const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
  const max = Math.max(...perfHistory) * 1.05, min = Math.min(...perfHistory) * 0.95;
  const pts = perfHistory.map((v, i) => [(i / 59) * w, hh - 2 - ((v - min) / Math.max(1, max - min)) * (hh - 4)] as const);
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = '#8e9bff'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  const last = pts[pts.length - 1]!;
  g.lineTo(last[0], hh); g.lineTo(0, hh); g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, hh); fill.addColorStop(0, 'rgba(91,107,240,.28)'); fill.addColorStop(1, 'rgba(91,107,240,0)');
  g.fillStyle = fill; g.fill();
  if (perfHistory.length >= 20) {
    const n = perfHistory.length; const slope = (perfHistory[n - 1]! - perfHistory[0]!) / n;
    set('s-grow', slope > 1 ? `Memory is rising by about ${slope.toFixed(1)} MB per sample.` : 'Memory is stable.');
  } else set('s-grow', 'Memory over the last two minutes.');
}
function startPerf() { stopPerf(); void samplePerf(); perfTimer = window.setInterval(() => { if (!document.hidden) void samplePerf(); }, 2000); }
function stopPerf() { if (perfTimer) { window.clearInterval(perfTimer); perfTimer = undefined; } }

// ---- General ----
sect('general', 'General', 'Client', 'tray minimize startup hardware acceleration branch canary ptb reload updates', () => {
  const g = state.config.general;
  const set = (p: Partial<Config['general']>) => call('general:set', p);
  return page('General', 'How ZERO starts and behaves on Windows.',
    rows(
      row('Minimize to tray', 'Closing the window keeps ZERO running in the tray. Applies after restart.', toggle(g.minimizeToTray, (v) => set({ minimizeToTray: v }), 'Minimize to tray')),
      row('Start minimized', 'Open without showing the window.', toggle(g.startMinimized, (v) => set({ startMinimized: v }), 'Start minimized')),
      row('Hardware acceleration', 'Uses the GPU for rendering, video and screen share. Turn off only if you see glitches. Applies after restart.', toggle(g.hardwareAcceleration, (v) => set({ hardwareAcceleration: v }), 'Hardware acceleration')),
      row('Discord version', 'Which Discord web release to load. Applies after restart.', seg(g.discordBranch, [['stable', 'Stable'], ['ptb', 'PTB'], ['canary', 'Canary']], (v) => void set({ discordBranch: v }))),
      row('Check for updates', 'Asks GitHub once at startup whether a newer ZERO exists. Nothing about you is sent.', toggle(g.checkUpdates, (v) => set({ checkUpdates: v }), 'Check for updates')),
      row('Reload Discord', 'Reloads the Discord page. You stay signed in.', btn('Reload', () => call('discord:reload'), 'sm'))));
});

// ---- Plugins ----
sect('plugins', 'Plugins', 'Client', 'extension addon permission enable disable', () => {
  const ps = state.plugins;
  return page('Plugins', 'Plugins are style add-ons. They run no scripts and can never access your account.',
    h('div', { class: 'actions' },
      btn('Open plugins folder', () => call('plugins:openFolder'), 'sm'),
      btn('Reload plugins', () => call('plugins:reload').then(() => toast('Plugins reloaded')), 'ghost sm')),
    ps.length ? h('div', {}, ...ps.map((p) => {
      const m = p.manifest;
      const badge = { enabled: ['ok', 'Enabled'], disabled: ['', 'Disabled'], error: ['err', 'Error'], incompatible: ['err', 'Incompatible'], 'needs-permission': ['warn', 'Needs permission'] }[p.status];
      const canToggle = p.status !== 'error' && p.status !== 'incompatible';
      return h('div', { class: 'card' },
        h('div', { class: 'plug-head' }, h('b', {}, m.name), h('span', { class: 'pill' }, 'v' + m.version), h('span', { class: 'pill ' + badge[0] }, badge[1]),
          h('span', { class: 'muted small' }, 'by ' + m.author), h('span', { style: 'margin-left:auto' }), canToggle ? toggle(state.config.plugins.enabled[m.id] === true, (v) => call('plugins:setEnabled', m.id, v), `Enable ${m.name}`) : null),
        h('p', { class: 'plug-desc' }, m.description),
        p.error && h('div', { class: 'issue error' }, p.error),
        m.permissions.length ? h('div', { class: 'muted small', style: 'margin-top:8px' }, 'Asks for: ' + m.permissions.map((x) => PERMISSIONS[x]).join('; ')) : null,
        canToggle && p.missingPermissions.length ? h('div', { class: 'actions' }, btn('Allow requested permissions', () => call('plugins:grant', m.id, m.permissions), 'primary sm')) : null);
    })) : h('div', { class: 'empty' }, 'No plugins yet. Put a plugin folder (with a plugin.json) in the plugins folder, then press Reload plugins.'));
});

// ---- Shortcuts ----
sect('shortcuts', 'Shortcuts', 'Client', 'hotkey keybind keys keyboard escape', () => page('Shortcuts', 'These work while the Discord window is focused.',
  rows(
    row('Open or close ZERO settings', 'Or click the ZERO button next to your settings gear, bottom left.', keys('Ctrl', ',')),
    row('Close this page', '', keys('Esc')),
    row('Search settings', '', keys('Ctrl', 'F')),
    row('Safe Mode', 'Turns every customization off at once if something looks broken. Press again to restore.', keys('Ctrl', 'Shift', 'Z'))),
  h('p', { class: 'muted small', style: 'margin-top:16px' }, 'Discord’s own shortcuts are in Discord’s Keybinds settings.')));

// ---- Backups ----
sect('profiles', 'Backups', 'Recovery', 'backup restore configuration snapshot', () => {
  const list = h('div', { class: 'rows' }, h('div', { class: 'muted small' }, 'Loading…'));
  const label = (n: string) => n.replace('.json', '').replace(/T(\d\d)-(\d\d)-(\d\d).*?-/, ' $1:$2:$3 · ');
  void call('backups:list').then((b: string[]) => list.replaceChildren(...(b.length
    ? b.map((n) => row(label(n), 'All settings at that moment.', btn('Restore', async () => { if (await askConfirm('Restore backup', 'Your current settings are backed up first, so you can come back to them.', 'Restore')) await call('backups:restore', n).then(() => toast('Backup restored')); }, 'sm')))
    : [h('div', { class: 'empty' }, 'No backups yet. ZERO takes one at most every 10 minutes while you edit, and before every update of the settings format.')])));
  return page('Backups', 'Automatic snapshots of all your settings.', list);
});

// ---- Advanced ----
sect('advanced', 'Advanced', 'Recovery', 'safe mode recovery compatibility diagnostics logs crash reset', () => {
  const c = state.compat;
  return page('Advanced', 'Recovery tools and diagnostics.',
    rows(
      row('Safe Mode', 'Removes all themes, backgrounds, layouts and plugins from Discord right away. ZERO also turns it on after repeated failed starts.', toggle(state.safeMode, (v) => call('recovery:safeMode', v), 'Safe Mode')),
      row('Log file', 'Errors and diagnostics. Tokens, cookies and user paths are redacted.', btn('Open', () => call('logs:open'), 'sm'))),
    h('h2', {}, 'Theme check'),
    h('p', { class: 'muted small', style: 'margin:0 0 12px' }, 'Checks that ZERO’s styles reach Discord. It only looks at which interface parts exist and which colors apply, never at messages.'),
    c ? h('div', { class: 'card' },
      h('div', { class: 'plug-head' }, h('span', { class: 'pill ' + (c.verdict === 'ok' ? 'ok' : c.verdict === 'degraded' ? 'warn' : 'err') }, c.verdict), h('span', { class: 'muted small' }, new Date(c.checkedAt).toLocaleTimeString())),
      h('p', { class: 'plug-desc', style: 'color:var(--text-2)' }, c.summary),
      c.style ? h('div', { class: 'muted small' }, `ZERO stylesheet: ${c.style.present ? `present (${(c.style.bytes / 1024).toFixed(1)} KB, ${c.style.count} element)` : 'absent'} · overrides Discord: ${c.winning === null ? 'n/a' : c.winning ? 'yes' : 'NO'} · route: ${c.route ?? 'n/a'}`) : null,
      h('ul', { class: 'plain' },
        ...c.selectors.map((s) => h('li', {}, `${s.name}: ${s.matches ? 'found' : 'not found'}`)),
        ...c.variables.filter((v) => !v.present).map((v) => h('li', {}, `variable ${v.name}: missing`))))
      : h('div', { class: 'empty' }, 'Not run yet.'),
    h('div', { class: 'actions' }, btn('Run check', () => call('compat:check').then(() => toast('Check complete')), 'primary sm')));
});

// ---- About ----
sect('about', 'About', '', 'version electron license update', () => {
  const u = state.update;
  return page('About', '',
    h('div', { class: 'hero' },
      h('div', { class: 'logo' }, document.querySelector('.brand svg')!.cloneNode(true)),
      h('div', {}, h('b', {}, 'ZERO'), h('span', {}, `Version ${state.version}`))),
    rows(
      row('Updates', !u ? 'Not checked yet.' : u.newer ? `Version ${u.latest} is available.` : 'You have the latest version.',
        h('span', { style: 'display:flex;gap:8px' },
          btn('Check now', async () => { const r = await call('update:check'); if (r) render(); }, 'sm'),
          u?.newer ? btn(`Download ${u.latest}`, () => call('update:open'), 'primary sm') : null)),
      row('Electron / Chromium', `${state.electron} / ${state.chrome}`, null),
      row('Plugins folder', state.pluginsDir, null)),
    h('p', { class: 'muted small', style: 'margin-top:16px' }, 'ZERO loads Discord’s official web app. It never reads, stores or sends your login token or password, and it does not automate your account. Not affiliated with Discord Inc.'));
});

// ---- shell ----
const match = (s: Section, q: string) => !q || (s.title + ' ' + s.group + ' ' + s.terms).toLowerCase().includes(q);

function buildNav() {
  const nav = $('#nav'); nav.replaceChildren();
  let group: string | null = null;
  for (const s of sections) {
    if (s.group !== group) {
      group = s.group;
      nav.append(group ? h('div', { class: 'nav-head', 'data-group': group }, group) : h('div', { class: 'nav-sep', 'data-group': '' }));
    }
    nav.append(h('button', { class: 'nav-item', 'data-id': s.id, onclick: () => go(s.id) }, icon(s.id === 'profiles' ? 'backups' : s.id), s.title));
  }
  nav.append(h('div', { class: 'nav-empty', hidden: true }, 'No results'));
}

function filterNav(): Section[] {
  const q = ($('#search') as HTMLInputElement).value.trim().toLowerCase();
  const visible = sections.filter((s) => match(s, q));
  document.querySelectorAll<HTMLElement>('#nav .nav-item').forEach((el) => { el.hidden = !visible.some((s) => s.id === el.dataset.id); });
  document.querySelectorAll<HTMLElement>('#nav [data-group]').forEach((el) => { el.hidden = !!q || !visible.some((s) => s.group === el.dataset.group); });
  $('#nav .nav-empty').hidden = visible.length > 0;
  return visible;
}

function markNav() {
  document.querySelectorAll<HTMLElement>('#nav .nav-item').forEach((el) => el.setAttribute('aria-current', String(el.dataset.id === current)));
}

function updateFoot() {
  const t = state.config.themes[state.config.activeThemeId];
  $('#sidefoot').replaceChildren(h('b', {}, `ZERO ${state.version}`), h('br'), `${t?.name ?? ''} · ${state.config.performance.profile}`);
}

function go(id: string) {
  if (id === current && shown === id) return;
  scrollPos.set(current, scroller().scrollTop);
  current = id;
  render(true);
}

/** Rebuilds the current page only (the sidebar is built once). `animate` is for page switches, never for state updates. */
function render(animate = false) {
  stopPerf();
  renderPending = false;
  const visible = filterNav();
  const main = $('#content');
  if (!visible.length) {
    const q = ($('#search') as HTMLInputElement).value.trim();
    main.replaceChildren(h('section', { class: 'page enter' }, h('div', { class: 'empty' }, `Nothing matches “${q}”.`)));
    shown = null;
    return;
  }
  if (!visible.some((s) => s.id === current)) current = visible[0]!.id;
  markNav(); updateFoot();
  const sec = sections.find((s) => s.id === current)!;
  const top = animate ? (scrollPos.get(current) ?? 0) : scroller().scrollTop;
  const el = sec.render();
  if (animate) el.classList.add('enter');
  main.replaceChildren(el);
  scroller().scrollTop = top;
  shown = current;
  paintPreview();
}

// State pushed by main can arrive mid-gesture. Rebuilding the page then would steal focus or cut a drag,
// so the rebuild waits until the pointer is up and no text field / slider / color picker is focused.
let renderPending = false;
let pointerDown = false;
let flushTimer: number | undefined;
function renderSoon() { renderPending = true; flushSoon(); }
function flushSoon() {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    if (!renderPending) return;
    const a = document.activeElement;
    if (pointerDown || a?.matches('input:not([type=checkbox]),select,textarea') || document.querySelector('dialog[open]')) return;
    render();
  }, 180);
}
window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
window.addEventListener('pointerup', () => { pointerDown = false; if (renderPending) flushSoon(); }, true);
document.addEventListener('focusout', () => { if (renderPending) flushSoon(); });

/** Everything in the state except theme bodies: a change here means the page must be rebuilt. */
const signature = (s: AppState) => JSON.stringify({ ...s, config: { ...s.config, themes: Object.values(s.config.themes).map((t) => [t.id, t.name]) } });

let closing = false;
function closeLayer() {
  if (closing) return;
  closing = true;
  stopPerf();
  $('#layer').classList.add('closing');
  window.setTimeout(() => void window.zero.invoke('settings:close'), 130);
}

async function boot() {
  state = (await call('state:get')) as AppState;
  draft = structuredClone(state.config.themes[state.config.activeThemeId]!);
  window.zero.onState((s) => {
    const before = signature(state);
    const busy = sendTimer !== undefined || sending > 0; // our own edit is on its way: the draft is newer than s
    state = s;
    let changed = signature(s) !== before;
    if (!busy) {
      const t = s.config.themes[s.config.activeThemeId];
      if (t && (t.id !== draft.id || JSON.stringify(t) !== JSON.stringify(draft))) { draft = structuredClone(t); changed = true; }
    }
    if (changed) renderSoon();
  });
  const search = $('#search') as HTMLInputElement;
  search.addEventListener('input', () => {
    const v = filterNav();
    const target = v.some((s) => s.id === current) ? current : v[0]?.id;
    if (!target) { render(); return; }
    if (target !== shown) { scrollPos.set(current, scroller().scrollTop); current = target; render(true); }
  });
  $('#close').addEventListener('click', closeLayer);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (document.activeElement === search && search.value) { search.value = ''; search.dispatchEvent(new Event('input')); return; }
    e.preventDefault();
    closeLayer();
  });
  buildNav();
  render(true);
}
void boot();
