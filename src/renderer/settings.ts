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
let current = 'appearance';
let perfTimer: number | undefined;
let previewRoute: 'guild' | 'dm' = 'guild';
const perfHistory: number[] = [];
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function call(ch: Channel, ...args: unknown[]) {
  const r = await window.zero.invoke(ch, ...args);
  if (!r.ok) { toast(r.error ?? 'Something went wrong', true); throw new Error(r.error); }
  return r.data;
}
function toast(msg: string, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  window.setTimeout(() => (t.className = ''), 2600);
}

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

const field = (label: string, desc: string, ctl: Node) => h('div', { class: 'field' }, h('div', { class: 'label' }, label), h('div', { class: 'desc' }, desc), h('div', { class: 'ctl' }, ctl));
const group = (...f: Child[]) => h('div', { class: 'group' }, ...f);
const toggle = (on: boolean, fn: (v: boolean) => void, label?: string) => {
  const i = h('input', { type: 'checkbox', checked: on, 'aria-label': label, onchange: () => fn(i.checked) });
  return h('label', { class: 'switch' }, i, h('i'));
};
function slider(v: number, min: number, max: number, step: number, fn: (v: number) => void, fmt: (v: number) => string = String) {
  const out = h('span', { class: 'val' }, fmt(v));
  const i = h('input', { type: 'range', min, max, step, value: v, oninput: () => { out.textContent = fmt(+i.value); fn(+i.value); } });
  return h('span', { class: 'ctl' }, i, out);
}
function select<T extends string>(value: T, options: [T, string][], fn: (v: T) => void) {
  const s = h('select', { onchange: () => fn(s.value as T) }, ...options.map(([v, n]) => h('option', { value: v, selected: value === v }, n)));
  return s;
}
const toHex = (c: string) => {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : '#000000';
};
const colorInput = (v: string, fn: (v: string) => void, label: string) =>
  h('input', { type: 'color', value: toHex(v), 'aria-label': label, oninput: (e: Event) => fn((e.target as HTMLInputElement).value) });

// ---------------------------------------------------------------------------------------------
// Live editing: one path. Edit draft -> preview (same compiler as Discord) -> main validates, applies, persists.
// ---------------------------------------------------------------------------------------------
let sendTimer: number | undefined;
let inflight: Promise<unknown> = Promise.resolve();
function edit(fn: () => void) {
  fn();
  paintPreview();
  window.clearTimeout(sendTimer);
  sendTimer = window.setTimeout(() => {
    const snapshot = structuredClone(draft);
    inflight = inflight.then(async () => {
      const r = await window.zero.invoke('theme:update', snapshot);
      if (!r.ok) {
        toast(`Not applied: ${r.error}`, true);
        draft = structuredClone(state.config.themes[state.config.activeThemeId]!); // back to last good theme
        render();
        return;
      }
      state.config.themes[r.data.id] = { ...snapshot, id: r.data.id, name: r.data.name };
      state.config.activeThemeId = r.data.id;
      if (r.data.forked) {
        draft.id = r.data.id; draft.name = r.data.name;
        toast(`Built-in presets stay untouched: your changes are saved as “${r.data.name}”.`);
        renderNav();
      }
      const s = document.getElementById('savestate'); if (s) s.textContent = 'All changes saved';
    });
  }, 70);
  const s = document.getElementById('savestate'); if (s) s.textContent = 'Saving…';
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
  let style = document.getElementById('pv-style') as HTMLStyleElement | null;
  if (!style) { style = h('style', { id: 'pv-style' }); document.head.append(style); }
  style.textContent = compileThemeCss(draft, { anchors: PREVIEW_ANCHORS, flags: state.perf, includeCustomCss: false, assetUrl: (id) => `zero-asset://bg/${id}`, missingImages: new Set(state.missingImages) });
}
function previewBlock() {
  const wrap = h('div', { class: 'pv-wrap' });
  const draw = () => { wrap.replaceChildren(previewMarkup(), h('div', { class: 'pv-switch' },
    h('button', { class: 'chip sm', 'aria-pressed': String(previewRoute === 'guild'), onclick: () => { previewRoute = 'guild'; draw(); } }, 'Server'),
    h('button', { class: 'chip sm', 'aria-pressed': String(previewRoute === 'dm'), onclick: () => { previewRoute = 'dm'; draw(); } }, 'Direct messages'))); };
  draw();
  return wrap;
}

// ---- sections ----
interface Section { id: string; title: string; terms: string; render: () => HTMLElement }
const sections: Section[] = [];
const sect = (id: string, title: string, terms: string, render: () => HTMLElement) => sections.push({ id, title, terms, render });
function page(title: string, lede: string, ...kids: Child[]) {
  return h('section', {}, h('div', { class: 'pagehead' }, h('h1', {}, title), h('span', { class: 'desc', id: 'savestate' })), h('p', { class: 'lede' }, lede), ...kids);
}

sect('appearance', 'Appearance', 'quick accent typography font size weight radius corners shadow blur glass animations spacing bubbles icons', () => {
  const t = draft;
  return page('Appearance', 'Changes apply to Discord instantly and are saved automatically.',
    previewBlock(),
    h('h2', {}, 'Color & shape'),
    group(
      field('Accent color', 'Links, mentions, focus rings, unread pills and brand highlights.', colorInput(t.colors.accent, (v) => edit(() => { t.colors.accent = v; }), 'Accent color')),
      field('Corner radius', 'Roundness of inputs, cards, menus and modals (drives Discord’s radius scale).', slider(t.shape.radius, 0, 24, 1, (v) => edit(() => (t.shape.radius = v)), (v) => v + 'px')),
      field('Server icon shape', '0% square · 50% circle.', slider(t.shape.serverIconRadius, 0, 50, 1, (v) => edit(() => (t.shape.serverIconRadius = v)), (v) => v + '%')),
      field('Message bubbles', 'Draw each message on its own rounded card.', toggle(!isTransparent(t.colors.bubble), (on) => edit(() => { t.colors.bubble = on ? t.colors.surface2 : 'rgba(0,0,0,0)'; }), 'Message bubbles')),
      field('Message spacing', 'Space between messages and message groups.', slider(t.shape.spacing, 0.5, 2, 0.05, (v) => edit(() => (t.shape.spacing = v)), (v) => v.toFixed(2) + '×'))),
    h('h2', {}, 'Typography'),
    group(
      field('Font family', 'Any font installed on Windows, comma-separated fallbacks.', h('input', { type: 'text', value: t.type.fontFamily, spellcheck: false, onchange: (e: Event) => edit(() => (t.type.fontFamily = (e.target as HTMLInputElement).value)) })),
      field('Message text size', 'Size of message text in chat.', slider(t.type.fontSize, 11, 24, 1, (v) => edit(() => (t.type.fontSize = v)), (v) => v + 'px')),
      field('Message text weight', '', slider(t.type.fontWeight, 300, 700, 100, (v) => edit(() => (t.type.fontWeight = v)))),
      field('Name & heading weight', 'Usernames and titles.', slider(t.type.headingWeight, 400, 900, 100, (v) => edit(() => (t.type.headingWeight = v))))),
    h('h2', {}, 'Depth & effects'),
    group(
      field('Shadow strength', 'Shadows under menus, popouts and modals.', slider(t.effects.shadow, 0, 1, 0.05, (v) => edit(() => (t.effects.shadow = v)), (v) => v.toFixed(2))),
      field('Menu blur', 'Frosted, slightly translucent menus and popouts. Uses the GPU; off in the Lightweight profile.', slider(t.effects.blur, 0, 40, 1, (v) => edit(() => (t.effects.blur = v)), (v) => (v ? v + 'px' : 'off'))),
      field('Glass menus', 'Stronger translucency with at least 12px blur.', toggle(t.effects.glass, (v) => edit(() => (t.effects.glass = v)), 'Glass menus')),
      field('Animations & transitions', 'Off makes every transition instant (Discord-wide).', toggle(t.effects.animations, (v) => edit(() => (t.effects.animations = v)), 'Animations'))),
    !state.perf.blur ? h('p', { class: 'desc' }, 'Note: your performance profile currently disables blur.') : null);
});

const COLOR_HELP: Record<keyof Theme['colors'], [string, string]> = {
  background: ['App frame', 'Window frame and title bar area.'],
  sidebar: ['Server list', 'The vertical rail of server icons.'],
  channelList: ['Channel & DM list', 'Channel list, DM list and member list.'],
  userPanel: ['User panel', 'Your avatar/status panel at the bottom left.'],
  surface1: ['Chat background', 'Main chat, DMs and home.'],
  surface2: ['Cards', 'Raised surfaces such as embeds and cards.'],
  popup: ['Menus & popouts', 'Context menus, profile popouts, tooltips.'],
  modal: ['Modals', 'Dialogs and their footers.'],
  input: ['Inputs', 'Message box and text fields.'],
  text: ['Text', 'Normal and strong text, active items.'],
  textMuted: ['Muted text', 'Channel names, placeholders, secondary text and icons.'],
  border: ['Borders', 'Dividers and outlines.'],
  hover: ['Hover', 'Hovered rows and messages (selection is derived from it).'],
  accent: ['Accent', 'Links, mentions, focus and brand highlights.'],
  button: ['Buttons', 'Primary buttons (hover and pressed shades are derived).'],
  scrollbar: ['Scrollbars', 'Scrollbar thumbs.'],
  bubble: ['Message bubbles', 'Card behind each message (turn on in Appearance).'],
};

sect('themes', 'Themes', 'preset import export duplicate rename delete midnight graphite obsidian frost amoled aurora minimal color palette custom css', () => {
  const cfg = state.config;
  const lintOut = h('div');
  const showLint = (css: string) => lintOut.replaceChildren(...lintCustomCss(css).map((i) => h('div', { class: 'issue ' + i.level }, (i.level === 'error' ? 'Blocked (not applied): ' : 'Warning: ') + i.message)));
  const css = h('textarea', { value: draft.customCss, spellcheck: false, placeholder: '/* Custom CSS, applied after the theme. @import and remote url() are blocked. */', oninput: () => { showLint(css.value); edit(() => (draft.customCss = css.value)); } });
  showLint(draft.customCss);
  const isPreset = PRESET_IDS.has(draft.id);
  const colorKeys = Object.keys(COLOR_HELP) as (keyof Theme['colors'])[];
  return page('Themes', 'Pick a starting point, then make it yours. Built-in presets are never overwritten: your first change creates a custom copy.',
    h('div', { class: 'chips' }, ...Object.values(cfg.themes).map((t) => h('button', { class: 'chip', 'aria-pressed': String(t.id === cfg.activeThemeId), onclick: () => select_(t.id) },
      h('span', { class: 'sw', style: `background:${t.colors.accent}` }), h('span', { class: 'sw', style: `background:${t.colors.surface1}` }), t.name))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => call('theme:duplicate', cfg.activeThemeId).then(() => toast('Duplicated')) }, 'Duplicate'),
      h('button', { class: 'btn', disabled: isPreset, title: isPreset ? 'Presets cannot be renamed; duplicate first' : '', onclick: () => { const n = prompt('New name', draft.name); if (n) void call('theme:rename', draft.id, n).then(() => toast('Renamed')); } }, 'Rename'),
      h('button', { class: 'btn', onclick: () => call('theme:export', draft.id).then((ok) => ok && toast('Exported')) }, 'Export'),
      h('button', { class: 'btn', onclick: () => call('theme:import').then((n) => n && toast(`Imported ${n}`)) }, 'Import'),
      h('button', { class: 'btn danger', disabled: isPreset, onclick: () => { if (confirm(`Delete theme "${draft.name}"? This cannot be undone (backups are kept for 8 snapshots).`)) void call('theme:delete', draft.id).then(() => toast('Deleted')); } }, 'Delete')),
    previewBlock(),
    h('h2', {}, 'Colors'),
    group(...colorKeys.filter((k) => k !== 'bubble').map((k) => field(COLOR_HELP[k][0], COLOR_HELP[k][1], colorInput(draft.colors[k], (v) => edit(() => { draft.colors[k] = v; }), COLOR_HELP[k][0])))),
    h('h2', {}, 'Custom CSS'),
    h('p', { class: 'desc' }, 'Advanced. Discord renames its classes in updates, so CSS that targets them can break. If the interface looks wrong, press Ctrl+Shift+Z (Safe Mode).'),
    css, lintOut);
});

async function select_(id: string) {
  window.clearTimeout(sendTimer);
  await inflight;
  await call('theme:select', id);
}

const AREA_INFO: Record<BgArea, [string, string]> = {
  global: ['Whole window', 'Behind everything. All surfaces become see-through.'],
  sidebar: ['Server & channel list', 'Behind the server rail, channel list and user panel.'],
  chat: ['Server chat', 'Behind messages in server channels.'],
  dm: ['Direct messages', 'Behind conversations and the friends page.'],
  settings: ['Discord settings', 'Behind Discord’s full-screen settings pages.'],
};

let library: { id: string; bytes: number }[] | null = null;

sect('backgrounds', 'Backgrounds', 'image wallpaper gradient blur opacity overlay brightness contrast position cover repeat scale transition chat sidebar dm direct messages settings global surface transparency', () => {
  const root = page('Backgrounds', 'One background per area, applied live to Discord. Large images are downscaled to 2560px on import.');
  const notice = h('div');
  if (!state.perf.backgrounds) notice.append(h('div', { class: 'issue warning' }, 'Your performance profile has backgrounds turned off. Switch profile in Performance to see them in Discord.'));
  if (state.missingImages.length) notice.append(h('div', { class: 'issue error' }, `${state.missingImages.length} image(s) used by your themes are missing from disk; those backgrounds show only their overlay. Re-import the image or pick another.`));
  root.append(notice, previewBlock(),
    group(field('Surface opacity over backgrounds', 'How opaque Discord’s panels are where a background is set. Lower shows more of the image.',
      slider(draft.effects.transparency, 0.2, 1, 0.01, (v) => edit(() => (draft.effects.transparency = v)), (v) => Math.round(v * 100) + '%'))));
  for (const area of BG_AREAS) root.append(areaCard(area));
  if (library === null) void call('bg:list').then((l) => { library = l; render(); });
  return root;
});

function newLayer(area: BgArea, kind: 'image' | 'gradient', imageId?: string): BackgroundLayer {
  return {
    id: `bg-${area}`, area, kind, imageId, gradient: kind === 'gradient' ? { angle: 140, from: '#1c2740', to: '#2a1840' } : undefined,
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
  const dlg = h('dialog', { class: 'lib' },
    h('h2', {}, 'Your imported images'),
    h('div', { class: 'lib-grid' }, ...(library ?? []).map((i) => h('button', { class: 'lib-item', title: `${Math.round(i.bytes / 1024)} KB`, style: `background-image:url("zero-asset://bg/${i.id}")`, onclick: () => {
      dlg.close(); dlg.remove();
      const prev = draft.backgrounds.find((l) => l.area === area);
      setLayer(area, prev ? { ...prev, kind: 'image', imageId: i.id, gradient: undefined, enabled: true } : newLayer(area, 'image', i.id));
    } }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')));
  document.body.append(dlg); dlg.showModal();
}

function areaCard(area: BgArea) {
  const l = draft.backgrounds.find((x) => x.area === area);
  const [title, desc] = AREA_INFO[area];
  const actions = h('div', { class: 'row', style: 'margin:0' },
    h('button', { class: 'btn primary', onclick: () => importInto(area) }, l?.kind === 'image' ? 'Replace image' : 'Import image'),
    library && library.length ? h('button', { class: 'btn', onclick: () => pickFromLibrary(area) }, `Choose imported (${library.length})`) : null,
    h('button', { class: 'btn', onclick: () => setLayer(area, l ? { ...l, kind: 'gradient', imageId: undefined, gradient: l.gradient ?? { angle: 140, from: '#1c2740', to: '#2a1840' } } : newLayer(area, 'gradient')) }, 'Use gradient'),
    l ? h('button', { class: 'btn danger', onclick: () => setLayer(area, null) }, 'Remove') : null);
  const head = h('div', { class: 'area-head' },
    l ? toggle(l.enabled, (v) => edit(() => { l.enabled = v; }), `${title} background`) : h('span', { class: 'area-dot' }),
    h('div', {}, h('b', {}, title), h('div', { class: 'desc' }, desc)),
    l ? h('div', { class: 'area-thumb', style: l.kind === 'image' ? `background-image:url("zero-asset://bg/${l.imageId}")` : `background-image:linear-gradient(${l.gradient?.angle}deg, ${l.gradient?.from}, ${l.gradient?.to})` }) : null);
  if (!l) return h('div', { class: 'group area' }, h('div', { class: 'layer' }, head, actions));
  const u = (fn: () => void) => edit(fn);
  const missing = l.kind === 'image' && l.imageId && state.missingImages.includes(l.imageId);
  return h('div', { class: 'group area' }, h('div', { class: 'layer' }, head,
    missing ? h('div', { class: 'issue error' }, 'This image is missing on disk. Import it again or choose another.') : null,
    h('div', { class: 'layer-grid' },
      h('label', {}, 'Size', select(l.size, [['cover', 'Fill (crop)'], ['contain', 'Fit inside'], ['stretch', 'Stretch'], ['auto', 'Original size'], ['scale', 'Custom scale']], (v) => { u(() => (l.size = v)); render(); })),
      l.size === 'scale' ? h('label', {}, 'Scale', slider(l.scale, 25, 400, 5, (v) => u(() => (l.scale = v)), (v) => v + '%')) : null,
      h('label', {}, 'Repeat', select(l.repeat, [['no-repeat', 'No repeat'], ['repeat', 'Tile'], ['repeat-x', 'Tile horizontally'], ['repeat-y', 'Tile vertically']], (v) => u(() => (l.repeat = v)))),
      h('label', {}, 'Horizontal position', slider(l.posX, 0, 100, 1, (v) => u(() => (l.posX = v)), (v) => v + '%')),
      h('label', {}, 'Vertical position', slider(l.posY, 0, 100, 1, (v) => u(() => (l.posY = v)), (v) => v + '%')),
      h('label', {}, 'Opacity', slider(l.opacity, 0, 1, 0.01, (v) => u(() => (l.opacity = v)), (v) => Math.round(v * 100) + '%')),
      h('label', {}, 'Blur' + (state.perf.blur ? '' : ' (off in this profile)'), slider(l.blur, 0, 40, 1, (v) => u(() => (l.blur = v)), (v) => v + 'px')),
      h('label', {}, 'Brightness', slider(l.brightness, 0, 2, 0.05, (v) => u(() => (l.brightness = v)), (v) => Math.round(v * 100) + '%')),
      h('label', {}, 'Contrast', slider(l.contrast, 0, 2, 0.05, (v) => u(() => (l.contrast = v)), (v) => Math.round(v * 100) + '%')),
      h('label', {}, 'Overlay color', colorInput(l.overlay, (v) => u(() => (l.overlay = v)), `${title} overlay color`)),
      h('label', {}, 'Overlay opacity', slider(l.overlayOpacity, 0, 1, 0.01, (v) => u(() => (l.overlayOpacity = v)), (v) => Math.round(v * 100) + '%')),
      h('label', {}, 'Transition', slider(l.transitionMs, 0, 2000, 50, (v) => u(() => (l.transitionMs = v)), (v) => (v ? v + 'ms' : 'instant'))),
      l.kind === 'gradient' && l.gradient ? h('label', {}, 'Gradient from', colorInput(l.gradient.from, (v) => u(() => (l.gradient!.from = v)), 'Gradient start')) : null,
      l.kind === 'gradient' && l.gradient ? h('label', {}, 'Gradient to', colorInput(l.gradient.to, (v) => u(() => (l.gradient!.to = v)), 'Gradient end')) : null,
      l.kind === 'gradient' && l.gradient ? h('label', {}, 'Angle', slider(l.gradient.angle, 0, 360, 1, (v) => u(() => (l.gradient!.angle = v)), (v) => v + '°')) : null),
    actions));
}

sect('layout', 'Layout', 'density compact comfortable width sidebar channel list chat avatar timestamp profile daily gaming focus minimal', () => {
  const cfg = state.config;
  const l = cfg.layouts[cfg.activeLayoutId]!;
  const save = (p: Partial<LayoutProfile>) => { Object.assign(l, p); return call('layout:save', { ...l }); };
  return page('Layout', 'Layout profiles switch instantly. Edits apply to the selected profile and are saved automatically.',
    h('div', { class: 'chips' }, ...Object.values(cfg.layouts).map((p) => h('button', { class: 'chip', 'aria-pressed': String(p.id === l.id), onclick: () => call('layout:select', p.id) }, p.name))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { const n = prompt('Profile name'); if (n) void call('layout:save', { ...l, id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile', name: n }).then(() => call('state:get').then((s) => { state = s; render(); })); } }, 'Save as new profile'),
      h('button', { class: 'btn danger', onclick: () => call('layout:delete', l.id) }, 'Delete profile')),
    group(
      field('Message density', 'Compact fits more messages on screen.', select(l.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']], (v) => void save({ density: v }))),
      field('Server list width', 'Width of the server icon rail. 0 keeps Discord’s default.', slider(l.sidebarWidth, 0, 120, 4, (v) => void save({ sidebarWidth: v }), (v) => (v ? v + 'px' : 'default'))),
      field('Channel list width', '0 keeps Discord’s default.', slider(l.channelListWidth, 0, 420, 10, (v) => void save({ channelListWidth: v }), (v) => (v ? v + 'px' : 'default'))),
      field('Chat max width', 'Limit line length for easier reading. 0 is unlimited.', slider(l.chatMaxWidth, 0, 1400, 20, (v) => void save({ chatMaxWidth: v }), (v) => (v ? v + 'px' : 'unlimited'))),
      field('Avatar shape', 'Avatars next to messages.', select(l.avatarShape, [['circle', 'Circle'], ['rounded', 'Rounded square'], ['square', 'Square']], (v) => void save({ avatarShape: v }))),
      field('Timestamps', 'Hide message timestamps for a cleaner look.', select(l.timestampFormat, [['default', 'Show'], ['hidden', 'Hide']], (v) => void save({ timestampFormat: v })))));
});

const PERF_INFO: Record<keyof PerfOptions, [string, string]> = {
  backgrounds: ['Background images', 'Show area backgrounds in Discord.'],
  blur: ['Blur effects', 'Menu blur, glass and background blur. The most GPU-expensive effect.'],
  animations: ['Animations & transitions', 'Discord’s and ZERO’s transitions. Off makes every change instant.'],
  pauseWhenUnfocused: ['Pause animations when unfocused', 'Stops animated emoji/avatars from using CPU while you are in another app.'],
  spellcheck: ['Spellcheck', 'Spellchecker dictionaries in the message box.'],
  backgroundThrottle: ['Throttle when hidden', 'Lets Chromium slow Discord while minimized or in the tray. Voice and notifications keep working. Applies after restart.'],
};

sect('performance', 'Performance', 'ram cpu gpu memory startup profile lightweight balanced custom throttle dashboard modules spellcheck blur', () => {
  const cfg = state.config;
  const stat = (id: string, label: string) => h('div', {}, h('b', { id }, '–'), h('span', {}, label));
  const prof = (p: PerfProfile, name: string) => h('button', { class: 'chip', 'aria-pressed': String(cfg.performance.profile === p), onclick: () => call('perf:set', { profile: p }) }, name);
  const opts = state.perf;
  const root = page('Performance', 'Measured from this running app. Sampling runs only while this page is open.',
    h('div', { class: 'stat' }, stat('s-ram', 'Memory (all processes)'), stat('s-cpu', 'CPU'), stat('s-start', 'Startup to window'), stat('s-prof', 'Profile')),
    h('canvas', { class: 'spark', id: 'spark', width: 800, height: 112, 'aria-label': 'Memory over time' }),
    h('div', { class: 'desc', id: 's-grow' }), h('div', { class: 'proc', id: 's-procs' }),
    h('div', { class: 'desc', id: 's-gpu' }), h('div', { class: 'desc', id: 's-mod' }), h('ul', { class: 'desc', id: 's-bg' }),
    h('h2', {}, 'Profile'),
    h('div', { class: 'chips' }, prof('balanced', 'Balanced'), prof('lightweight', 'Lightweight'), prof('custom', 'Custom')),
    h('p', { class: 'desc' }, cfg.performance.profile === 'balanced' ? 'Balanced: everything on. Your full theme, backgrounds, blur and animations.'
      : cfg.performance.profile === 'lightweight' ? 'Lightweight: keeps your colors and backgrounds, removes blur and animations, turns spellcheck off. Discord features keep working.'
        : 'Custom: choose each option below.'),
    group(...(Object.keys(PERF_INFO) as (keyof PerfOptions)[]).map((k) => field(PERF_INFO[k][0], PERF_INFO[k][1],
      cfg.performance.profile === 'custom'
        ? toggle(cfg.performance.custom[k], (v) => call('perf:set', { custom: { [k]: v } }), PERF_INFO[k][0])
        : h('span', { class: 'badge ' + (opts[k] ? 'ok' : '') }, opts[k] ? 'On' : 'Off')))));
  queueMicrotask(startPerf);
  return root;
});

async function samplePerf() {
  const r = await window.zero.invoke('perf:snapshot'); if (!r.ok) return;
  const s = r.data as PerfSnapshot;
  const set = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('s-ram', s.ramMb.toFixed(0) + ' MB'); set('s-cpu', s.cpuPercent.toFixed(1) + '%');
  set('s-start', s.startupMs ? s.startupMs + ' ms' : 'n/a'); set('s-prof', s.profile);
  set('s-gpu', 'GPU: ' + s.gpu); set('s-mod', 'Active modules: ' + s.activeModules.join(', '));
  const bg = document.getElementById('s-bg'); if (bg) bg.replaceChildren(...s.background.map((b) => h('li', {}, b)));
  const pr = document.getElementById('s-procs');
  if (pr) pr.replaceChildren(...s.processes.sort((a, b) => b.ramMb - a.ramMb).map((p) => h('span', { class: 'badge' }, `${p.type}: ${p.ramMb.toFixed(0)} MB`)));
  perfHistory.push(s.ramMb); if (perfHistory.length > 60) perfHistory.shift();
  const c = document.getElementById('spark') as HTMLCanvasElement | null; if (!c) return;
  const g = c.getContext('2d')!; g.clearRect(0, 0, c.width, c.height);
  const max = Math.max(...perfHistory) * 1.05, min = Math.min(...perfHistory) * 0.95;
  g.strokeStyle = '#7c8cff'; g.lineWidth = 2; g.beginPath();
  perfHistory.forEach((v, i) => { const x = (i / 59) * c.width, y = c.height - ((v - min) / Math.max(1, max - min)) * c.height; if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
  if (perfHistory.length >= 20) {
    const n = perfHistory.length; const slope = (perfHistory[n - 1]! - perfHistory[0]!) / n;
    set('s-grow', slope > 1 ? `Memory is trending up by about ${slope.toFixed(1)} MB per sample.` : 'Memory is stable over the sampled window.');
  }
}
function startPerf() { stopPerf(); void samplePerf(); perfTimer = window.setInterval(() => { if (!document.hidden) void samplePerf(); }, 2000); }
function stopPerf() { if (perfTimer) { window.clearInterval(perfTimer); perfTimer = undefined; } }

sect('general', 'General', 'tray minimize startup hardware acceleration branch canary ptb reload', () => {
  const g = state.config.general;
  const set = (p: Partial<Config['general']>) => call('general:set', p);
  return page('General', 'How ZERO starts and behaves on your desktop.',
    group(
      field('Minimize to tray', 'Closing the window keeps ZERO running in the system tray. Applies after restart.', toggle(g.minimizeToTray, (v) => set({ minimizeToTray: v }), 'Minimize to tray')),
      field('Start minimized', 'Open without showing the window.', toggle(g.startMinimized, (v) => set({ startMinimized: v }), 'Start minimized')),
      field('Hardware acceleration', 'Uses the GPU for rendering, video and screen share. Disable only if you see graphical glitches. Applies after restart.', toggle(g.hardwareAcceleration, (v) => set({ hardwareAcceleration: v }), 'Hardware acceleration')),
      field('Discord release', 'Which Discord web release to load. Applies after restart.', select(g.discordBranch, [['stable', 'Stable'], ['ptb', 'PTB'], ['canary', 'Canary']], (v) => void set({ discordBranch: v }))),
      field('Check for updates', 'At startup, asks GitHub once whether a newer ZERO release exists and offers to download it. Nothing about you is sent.', toggle(g.checkUpdates, (v) => set({ checkUpdates: v }), 'Check for updates'))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => call('discord:reload') }, 'Reload Discord')));
});

sect('plugins', 'Plugins', 'extension addon permission enable disable', () => {
  const ps = state.plugins;
  return page('Plugins', 'Plugins are declarative style add-ons in v1. They run no scripts and can never access your account or credentials.',
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => call('plugins:openFolder') }, 'Open plugins folder'),
      h('button', { class: 'btn', onclick: () => call('plugins:reload').then(() => toast('Plugins reloaded')) }, 'Reload')),
    ps.length ? group(...ps.map((p) => {
      const m = p.manifest;
      const badge = { enabled: ['ok', 'Enabled'], disabled: ['', 'Disabled'], error: ['err', 'Error'], incompatible: ['err', 'Incompatible'], 'needs-permission': ['warn', 'Needs permission'] }[p.status];
      return h('div', { class: 'layer' },
        h('div', { class: 'row', style: 'margin:0' }, h('b', {}, m.name), h('span', { class: 'badge' }, 'v' + m.version), h('span', { class: 'badge ' + badge[0] }, badge[1]), h('span', { class: 'desc' }, 'by ' + m.author)),
        h('div', { class: 'desc' }, m.description),
        p.error && h('div', { class: 'issue error' }, p.error),
        m.permissions.length ? h('div', { class: 'desc' }, 'Requests: ' + m.permissions.map((x) => PERMISSIONS[x]).join('; ')) : null,
        p.status !== 'error' && p.status !== 'incompatible' ? h('div', { class: 'row', style: 'margin:0' },
          toggle(state.config.plugins.enabled[m.id] === true, (v) => call('plugins:setEnabled', m.id, v), `Enable ${m.name}`),
          p.missingPermissions.length ? h('button', { class: 'btn', onclick: () => call('plugins:grant', m.id, m.permissions) }, 'Grant requested permissions') : null) : null);
    })) : h('div', { class: 'empty' }, 'No plugins installed. Drop a plugin folder (with a plugin.json) into the plugins folder, then press Reload.'));
});

sect('shortcuts', 'Keyboard shortcuts', 'hotkey keybind keys', () => page('Keyboard shortcuts', 'Shortcuts that work while the Discord window is focused.',
  group(field('Open ZERO settings', '', h('kbd', {}, 'Ctrl + ,')), field('Toggle Safe Mode', 'Instantly removes every customization if something looks broken. Press again to restore.', h('kbd', {}, 'Ctrl + Shift + Z'))),
  h('p', { class: 'desc' }, 'Rebinding is not available yet. Discord’s own shortcuts are configured in Discord’s Keybinds settings.')));

sect('profiles', 'Backups', 'backup restore configuration snapshot', () => {
  const list = h('div', { class: 'group' });
  void call('backups:list').then((b: string[]) => list.replaceChildren(...(b.length ? b.map((n) => h('div', { class: 'field' }, h('div', { class: 'label' }, n.replace('.json', '').replace(/T(\d\d)-(\d\d)-(\d\d).*?-/, ' $1:$2:$3 · ')), h('div', { class: 'desc' }, 'Snapshot of all settings'), h('div', { class: 'ctl' }, h('button', { class: 'btn', onclick: () => { if (confirm('Restore this backup? Your current settings are backed up first.')) void call('backups:restore', n).then(() => toast('Restored')); } }, 'Restore')))) : [h('div', { class: 'empty' }, 'No backups yet. Snapshots are taken automatically (at most every 10 minutes while you edit, and before every migration).')])));
  return page('Backups', 'Automatic snapshots of all your settings. Layout profiles live under Layout.', list);
});

sect('advanced', 'Advanced', 'safe mode recovery compatibility diagnostics logs crash reset', () => {
  const c = state.compat;
  return page('Advanced', 'Recovery tools and diagnostics.',
    group(
      field('Safe Mode', 'Removes all themes, backgrounds, layout rules and plugins from Discord right away (shortcut Ctrl+Shift+Z). ZERO also turns it on after repeated failed starts, or when started with --safe-mode.', toggle(state.safeMode, (v) => call('recovery:safeMode', v), 'Safe Mode')),
      field('Logs', 'Errors and diagnostics with tokens, cookies and user paths redacted.', h('button', { class: 'btn', onclick: () => call('logs:open') }, 'Show log file'))),
    h('h2', {}, 'Theme diagnostics'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => call('compat:check').then(() => toast('Check complete')) }, 'Run check on the Discord window')),
    c ? h('div', { class: 'group' }, h('div', { class: 'layer' },
      h('div', { class: 'row', style: 'margin:0' }, h('span', { class: 'badge ' + (c.verdict === 'ok' ? 'ok' : c.verdict === 'degraded' ? 'warn' : '') }, c.verdict), h('span', { class: 'desc' }, new Date(c.checkedAt).toLocaleTimeString())),
      h('div', {}, c.summary),
      c.style ? h('div', { class: 'desc' }, `ZERO stylesheet: ${c.style.present ? `present (${(c.style.bytes / 1024).toFixed(1)} KB, ${c.style.count} element)` : 'absent'} · overrides Discord: ${c.winning === null ? 'n/a' : c.winning ? 'yes' : 'NO'} · route: ${c.route ?? 'n/a'}`) : null,
      ...c.selectors.map((s) => h('div', { class: 'desc' }, `${s.name}: ${s.matches ? 'found' : 'NOT FOUND'}`)),
      ...c.variables.filter((v) => !v.present).map((v) => h('div', { class: 'desc' }, `variable ${v.name}: missing`))))
      : h('div', { class: 'empty' }, 'Not checked yet. Sign in to Discord, then run the check.'),
    h('p', { class: 'desc' }, 'The check reads only which interface elements exist and which colors are in effect. It never reads messages.'));
});

sect('about', 'About', 'version electron license', () => page('About', 'ZERO, an independent, themeable desktop client for the Discord web app.',
  group(field('Version', '', h('span', {}, state.version)), field('Updates', updateText(), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const r = await call('update:check'); if (r) render(); } }, 'Check now'), ...(state.update?.newer ? [h('button', { class: 'btn primary', onclick: () => call('update:open') }, 'Download ' + state.update.latest)] : []))), field('Electron / Chromium', '', h('span', {}, `${state.electron} / ${state.chrome}`)), field('Plugins folder', '', h('span', { class: 'desc' }, state.pluginsDir))),
  h('p', { class: 'desc' }, 'ZERO loads Discord’s official web client. It never reads, stores or transmits your login token or credentials, and it does not automate your account. Not affiliated with Discord Inc.')));

function updateText() {
  const u = state.update;
  if (!u) return 'Not checked yet this session.';
  return u.newer ? `Version ${u.latest} is available (you have ${u.current}).` : `You have the latest version (${u.current}).`;
}

// ---- shell ----
function renderNav() {
  const q = ($('#search') as HTMLInputElement).value.trim().toLowerCase();
  const nav = $('#nav'); nav.replaceChildren();
  const visible = sections.filter((s) => !q || (s.title + ' ' + s.terms).toLowerCase().includes(q));
  for (const s of visible) nav.append(h('button', { 'aria-current': String(s.id === current), onclick: () => { current = s.id; render(); } }, s.title));
  $('#railfoot').textContent = `v${state.version} · ${state.config.performance.profile} · ${state.config.themes[state.config.activeThemeId]?.name ?? ''}`;
  return { q, visible };
}

function render() {
  stopPerf();
  const { q, visible } = renderNav();
  const main = $('#content');
  if (q && !visible.length) { main.replaceChildren(h('section', {}, h('div', { class: 'empty' }, `Nothing matches “${q}”.`))); return; }
  const sec = visible.find((s) => s.id === current) ?? visible[0]!;
  if (sec.id !== current) { current = sec.id; renderNav(); }
  const scroll = main.scrollTop;
  main.replaceChildren(sec.render());
  main.scrollTop = scroll;
  paintPreview();
  const banner = $('#banner');
  const msgs = [...(state.safeMode ? ['Safe Mode is on: Discord is shown without any customization. Turn it off in Advanced or press Ctrl+Shift+Z.'] : []), ...state.notes.filter((n) => /Safe Mode|unreadable|Restored|migrated|safe-mode/.test(n))];
  banner.hidden = !msgs.length; banner.textContent = msgs.join('  ·  ');
}

async function boot() {
  state = (await call('state:get')) as AppState;
  draft = structuredClone(state.config.themes[state.config.activeThemeId]!);
  window.zero.onState((s) => {
    const themeChanged = s.config.activeThemeId !== state.config.activeThemeId;
    state = s;
    if (themeChanged || !s.config.themes[draft.id]) draft = structuredClone(s.config.themes[s.config.activeThemeId]!);
    // don't rebuild the page under the user's pointer while they are dragging/typing
    if (!document.activeElement?.matches('input,select,textarea')) render();
  });
  $('#search').addEventListener('input', render);
  render();
}
void boot();
