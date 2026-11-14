import type { UpdateState } from '../main/updates';

type Action = 'install' | 'later' | 'retry' | 'hide' | 'done';
declare global { interface Window { zeroUpdate: { get(): Promise<UpdateState>; act(a: Action): void; onState(cb: (s: UpdateState) => void): void } } }

const $ = (id: string) => document.getElementById(id)!;
let leaving = false;

const mb = (b: number) => (b / 1048576).toFixed(b >= 100 * 1048576 ? 0 : 1) + ' MB';
const eta = (s: number | null) => (s === null ? '' : s < 60 ? `${s} s left` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`);
const date = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : 'Released ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };

function act(a: Action) {
  if (a === 'later' || a === 'hide' || a === 'done') {
    if (leaving) return;
    leaving = true;
    document.body.classList.add('leaving');
    window.setTimeout(() => window.zeroUpdate.act(a), 120);
  } else window.zeroUpdate.act(a);
}

function button(label: string, a: Action, primary = false) {
  const b = document.createElement('button');
  b.className = 'btn ' + (primary ? 'primary' : 'ghost');
  b.textContent = label;
  b.addEventListener('click', () => act(a));
  return b;
}

const ORDER = ['downloading', 'verifying', 'installing', 'restart'];
let lastKey = '';

function render(s: UpdateState) {
  const working = s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing';
  const done = !!s.justUpdated && !working;
  const failed = !!s.failedTo && !working && s.phase !== 'available';

  const eyebrow = $('eyebrow');
  eyebrow.className = 'eyebrow' + (done ? ' ok' : s.phase === 'error' || failed ? ' err' : '');
  eyebrow.textContent = done ? 'Update complete' : failed ? 'Update not applied' : s.phase === 'error' ? 'Update failed'
    : s.phase === 'downloading' ? 'Downloading update' : s.phase === 'verifying' ? 'Verifying files' : s.phase === 'installing' ? 'Installing update' : 'Update available';
  $('title').textContent = done ? `You're on ZERO ${s.justUpdated}` : `ZERO ${s.latest ?? s.failedTo ?? s.current}`;

  $('versions').hidden = done || failed || !s.latest;
  $('from').textContent = s.current;
  $('to').textContent = s.latest ?? '';
  $('date').textContent = date(s.releaseDate);
  $('sub').textContent = done ? 'ZERO restarted on the new version. Your settings, themes and backgrounds were kept.'
    : failed ? `The update to ${s.failedTo} did not finish, so ZERO kept running ${s.current}. Nothing was lost.`
      : s.phase === 'installing' ? 'ZERO will close, update itself in place and open again in a moment.'
        : working ? 'You can keep using Discord. ZERO restarts by itself once the update is ready.'
          : 'Updates install in place. Your settings, themes and backgrounds stay as they are.';

  const notes = s.notes ?? [];
  $('notes-wrap').hidden = !notes.length || failed;
  $('notes').replaceChildren(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));

  // progress (real values only)
  const prog = $('progress');
  prog.hidden = !working;
  prog.classList.toggle('busy', s.phase === 'downloading');
  const cur = ORDER.indexOf(s.phase);
  document.querySelectorAll<HTMLElement>('#steps span').forEach((el, i) => {
    el.className = i < cur ? 'done' : i === cur ? 'now' : '';
  });
  const p = s.progress;
  const pct = s.phase === 'downloading' ? Math.floor(p?.percent ?? 0) : 100;
  ($('fill') as HTMLElement).style.width = (working ? pct : 0) + '%';
  $('bar').setAttribute('aria-valuenow', String(pct));
  $('pct').textContent = pct + '%';
  $('size').textContent = p && p.total ? `${mb(p.transferred)} of ${mb(p.total)}` : '';
  $('speed').textContent = s.phase === 'downloading' && p && p.bytesPerSecond ? `${mb(p.bytesPerSecond)}/s` : '';
  $('eta').textContent = s.phase === 'downloading' && p ? eta(p.etaSeconds) : s.phase === 'verifying' ? 'Checking SHA-512' : '';

  const err = $('error');
  err.hidden = s.phase !== 'error';
  err.textContent = s.error ?? '';

  const status = $('status');
  status.replaceChildren();
  const statusText = s.notice ?? (s.phase === 'checking' ? 'Checking for updates' : s.phase === 'verifying' ? 'Verifying files' : s.phase === 'installing' ? 'Preparing installation' : s.phase === 'downloading' ? 'Downloading update' : '');
  if (statusText) {
    if (s.phase === 'checking' || s.phase === 'verifying' || s.phase === 'installing' || s.notice) status.append(Object.assign(document.createElement('span'), { className: 'spin' }));
    status.append(statusText);
  }

  // buttons only change when the phase does (no flicker during progress updates)
  const key = `${s.phase}|${done}|${failed}`;
  if (key !== lastKey) {
    lastKey = key;
    const btns = $('btns');
    if (done) btns.replaceChildren(button('Done', 'done', true));
    else if (failed) btns.replaceChildren(button('Close', 'done'), button('Try again', 'retry', true));
    else if (s.phase === 'available') btns.replaceChildren(button('Remind me later', 'later'), button('Update now', 'install', true));
    else if (s.phase === 'error') btns.replaceChildren(button('Close', 'hide'), button('Retry', 'retry', true));
    else if (s.phase === 'downloading' || s.phase === 'verifying') btns.replaceChildren(button('Continue in background', 'hide'));
    else btns.replaceChildren();
    (btns.querySelector('.primary') as HTMLElement | null)?.focus();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const s = lastKey.split('|')[0];
  if (s === 'installing') return;
  act(s === 'available' ? 'later' : s === 'downloading' || s === 'verifying' || s === 'error' ? 'hide' : 'done');
});

window.zeroUpdate.onState(render);
void window.zeroUpdate.get().then(render);

export {};
