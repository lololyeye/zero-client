import type { UpdateState } from '../main/updates';
import type { ReleaseNotes } from '../shared/hotUpdate';

type Action = 'install' | 'later' | 'retry' | 'hide' | 'done';
declare global { interface Window { zeroUpdate: { get(): Promise<UpdateState>; act(a: Action): void; onState(cb: (s: UpdateState) => void): void } } }

const $ = (id: string) => document.getElementById(id)!;
let leaving = false;

const svg = (d: string, size = 15, extra = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', String(size)); s.setAttribute('height', String(size)); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`; // static icon paths only
  return s;
};
const ICON = {
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8Zm-18 0 9 5 9-5M12 13v8',
  shield: 'M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Zm-3.2 9.2 2.2 2.2 4.4-4.6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  alert: 'M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  restart: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
};

const size = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(b >= 100 * 1048576 ? 0 : 1)} MB`);
const eta = (s: number | null) => (s === null ? '' : s < 1 ? 'almost done' : s < 60 ? `${s} s left` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`);
const released = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}

const nodes = (...k: (Node | null | false)[]) => k.filter((x): x is Node => !!x);

function act(a: Action) {
  if (a === 'later' || a === 'hide' || a === 'done') {
    if (leaving) return;
    leaving = true;
    document.body.classList.add('leaving');
    window.setTimeout(() => window.zeroUpdate.act(a), 140);
  } else window.zeroUpdate.act(a);
}

function button(label: string, a: Action, kind: 'primary' | 'ghost' = 'ghost', icon?: string) {
  const b = el('button', `btn ${kind}`, icon ? svg(icon, 16) : null, label);
  b.type = 'button';
  b.addEventListener('click', () => act(a));
  return b;
}

/** Release notes as text only, grouped New / Improved / Fixed; empty groups are left out. */
function renderNotes(n: ReleaseNotes | null) {
  const box = $('notes');
  const groups = n ? ([['changes', 'New'], ['improvements', 'Improved'], ['fixes', 'Fixed']] as const).filter(([k]) => n[k].length) : [];
  box.hidden = !n || (!n.summary && !groups.length);
  if (box.hidden || !n) { box.replaceChildren(); return; }
  box.replaceChildren(...nodes(
    n.summary ? el('p', 'summary', svg(ICON.spark), el('span', '', n.summary)) : null,
    ...groups.map(([k, title]) => el('section', `group ${k}`, el('h3', '', title), el('ul', '', ...n[k].map((t) => el('li', '', t))))),
  ));
}

type View = 'available' | 'progress' | 'error' | 'done' | 'failed' | 'idle';
let lastKey = '';
let view: View = 'idle';

function render(s: UpdateState) {
  const working = s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing';
  const done = !!s.justUpdated && !working;
  const failed = !!s.failedTo && !working && s.phase !== 'available';
  view = done ? 'done' : failed ? 'failed' : working ? 'progress' : s.phase === 'error' ? 'error' : s.phase === 'available' ? 'available' : 'idle';
  const quick = s.kind === 'quick';

  $('card').className = 'card' + (done ? ' ok' : view === 'error' || failed ? ' err' : '');
  $('eyebrow').textContent = done ? 'Updated' : failed ? 'Update not applied' : view === 'error' ? 'Update failed'
    : s.phase === 'installing' ? (quick ? 'Restarting' : 'Installing') : working ? 'Updating' : s.phase === 'checking' ? 'Checking' : 'Update available';
  $('title').textContent = done ? `What's new in ZERO ${s.justUpdated}` : `ZERO ${s.latest ?? s.failedTo ?? s.current}`;
  const date = released(s.releaseDate);
  $('meta').textContent = done ? 'Your settings, themes and backgrounds were kept.'
    : failed ? `Still on ${s.current}` : s.latest ? `You have ${s.current}${date ? ` · released ${date}` : ''}` : '';
  $('close').hidden = s.phase === 'installing';

  const chips = $('chips');
  const chipKey = `${view}|${s.kind}|${s.size}`;
  if (chips.dataset.key !== chipKey) {
    chips.dataset.key = chipKey;
    chips.replaceChildren(...(view === 'available' || view === 'progress' || view === 'error') && s.kind ? [
      el('span', `chip ${s.kind}`, svg(quick ? ICON.bolt : ICON.box, 13), quick ? 'Quick update' : 'Full update'),
      s.size ? el('span', 'chip', svg(ICON.download, 13), size(s.size)) : null,
      el('span', 'chip', svg(ICON.shield, 13), 'Signed'),
    ].filter((x): x is HTMLSpanElement => !!x) : []);
  }
  $('lead').textContent = view === 'available' ? (quick ? 'Only ZERO’s own code is downloaded. Nothing is reinstalled: ZERO restarts on the new version in a few seconds.'
    : 'This version also updates the Chromium engine, so the full package is needed. It installs silently in the background and ZERO opens again by itself.')
    : failed ? `The update to ${s.failedTo} did not finish, so ZERO kept running ${s.current}. Nothing was lost.` : '';

  renderNotes(done ? s.whatsNew : failed ? null : s.notes);
  renderStage(s, quick);
}

function renderStage(s: UpdateState, quick: boolean) {
  const stage = $('stage');
  // Live progress: patch the numbers in place, rebuild only when the phase changes (no flicker).
  const key = `${view}|${s.phase}|${!!s.notice}`;
  if (key === lastKey && view === 'progress') { patchProgress(s); return; }
  lastKey = key;

  if (view === 'available') {
    stage.replaceChildren(el('div', 'row',
      el('span', 'hint', svg(ICON.shield, 14), 'Settings and themes are kept'),
      el('div', 'btns', button('Later', 'later'), button('Update now', 'install', 'primary', quick ? ICON.bolt : ICON.download))));
  } else if (view === 'progress') {
    const steps = quick ? [['downloading', 'Download'], ['verifying', 'Verify'], ['installing', 'Restart']] : [['downloading', 'Download'], ['verifying', 'Verify'], ['installing', 'Install']];
    const cur = steps.findIndex(([k]) => k === s.phase);
    stage.replaceChildren(...nodes(el('div', 'progress',
      el('div', 'p-head', el('span', '', label(s, quick)), el('span', 'pct', '')),
      el('div', 'bar' + (s.phase === 'downloading' ? '' : ' indeterminate'), el('div', 'fill')),
      el('div', 'p-foot', el('span', 'p-size', ''), el('span', 'p-eta', '')),
      el('div', 'steps', ...steps.map(([, t], i) => el('span', i < cur ? 'done' : i === cur ? 'now' : '', t!)))),
    s.phase === 'downloading' ? el('div', 'row', el('span', 'hint', ''), el('div', 'btns', button('Continue in background', 'hide', 'ghost'))) : null));
    stage.querySelector<HTMLElement>('.row')?.style.setProperty('margin-top', '12px');
    patchProgress(s);
  } else if (view === 'error') {
    stage.replaceChildren(el('div', 'message error', svg(ICON.alert), el('span', '', s.error ?? 'The update failed.')),
      el('div', 'row', el('span', 'hint', ''), el('div', 'btns', button('Close', 'hide'), button('Retry', 'retry', 'primary', ICON.restart))));
  } else if (view === 'done') {
    stage.replaceChildren(el('div', 'row', el('span', 'hint', svg(ICON.shield, 14), `Now running ZERO ${s.justUpdated}`),
      el('div', 'btns', button('Got it', 'done', 'primary'))));
    if (!s.whatsNew) $('lead').textContent = 'ZERO restarted on the new version.';
  } else if (view === 'failed') {
    stage.replaceChildren(el('div', 'row', el('span', 'hint', ''), el('div', 'btns', button('Close', 'done'), button('Try again', 'retry', 'primary', ICON.restart))));
  } else {
    stage.replaceChildren(el('div', 'row', el('span', 'hint', s.phase === 'checking' ? el('span', 'spin') : null, s.phase === 'checking' ? 'Checking for updates' : ''),
      el('div', 'btns', button('Close', 'hide'))));
  }
  (stage.querySelector('.btn.primary') as HTMLElement | null)?.focus();
}

function label(s: UpdateState, quick: boolean) {
  if (s.notice) return s.notice;
  if (s.phase === 'downloading') return quick ? 'Downloading ZERO’s code' : 'Downloading the installer';
  if (s.phase === 'verifying') return 'Checking the signature and SHA-512';
  return quick ? 'Restarting on the new version' : 'Installing silently, ZERO opens again by itself';
}

function patchProgress(s: UpdateState) {
  const stage = $('stage');
  const p = s.progress;
  const pct = s.phase === 'downloading' ? Math.floor(p?.percent ?? 0) : 100;
  const fill = stage.querySelector<HTMLElement>('.fill');
  if (fill) fill.style.width = pct + '%';
  const q = (sel: string) => stage.querySelector<HTMLElement>(sel);
  const head = q('.p-head span');
  if (head) head.textContent = label(s, s.kind === 'quick');
  const pctEl = q('.pct');
  if (pctEl) pctEl.textContent = s.phase === 'downloading' ? `${pct}%` : '';
  const sz = q('.p-size');
  if (sz) sz.textContent = p && p.total ? (s.phase === 'downloading' ? `${size(p.transferred)} of ${size(p.total)}` : size(p.total)) : '';
  const e = q('.p-eta');
  if (e) e.textContent = s.phase === 'downloading' && p ? [p.bytesPerSecond ? `${size(p.bytesPerSecond)}/s` : '', eta(p.etaSeconds)].filter(Boolean).join(' · ') : '';
}

$('close').addEventListener('click', () => act(view === 'available' ? 'later' : view === 'done' || view === 'failed' ? 'done' : 'hide'));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || lastKey.includes('|installing|')) return;
  act(view === 'available' ? 'later' : view === 'done' || view === 'failed' ? 'done' : 'hide');
});

window.zeroUpdate.onState(render);
void window.zeroUpdate.get().then(render);

export {};
