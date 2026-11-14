/**
 * The ZERO button in Discord's user panel (next to mute / deafen / settings), plus a one-time hint that points at it.
 * Runs in the preload's isolated world: it only adds and removes its own nodes and never reads page content.
 *
 * Cost: one MutationObserver on the small user-panel subtree (re-inserts the button if Discord re-renders it) and a
 * 3 s visibility-gated check that re-finds the panel after navigation/login. No observer on the app tree.
 */
const BTN_ID = 'zero-launcher';
const STYLE_ID = 'zero-launcher-style';
const HINT_ID = 'zero-launcher-hint';

const LOGO = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.2 3h7.6A5.2 5.2 0 0 1 21 8.2v5.1a5.2 5.2 0 0 1-5.2 5.2h-4.6l-3.6 2.7c-.6.4-1.4 0-1.4-.7v-2.2A5.2 5.2 0 0 1 3 13.3V8.2A5.2 5.2 0 0 1 8.2 3Zm.6 4.3v1.6h4.4L8.6 13v1.6h6.6V13h-4.3l4.5-4.1V7.3H8.8Z"/></svg>';

const CSS = `
#${BTN_ID} svg{display:block;margin:auto;width:20px;height:20px}
#${BTN_ID}{position:relative}
#${BTN_ID}:hover{color:var(--interactive-text-hover,var(--interactive-hover,#dbdee1))}
.zero-tip{position:fixed;z-index:10000;pointer-events:none;padding:6px 10px;border-radius:8px;font:600 14px/18px var(--font-primary,system-ui);
  color:var(--text-default,#dbdee1);background:var(--background-surface-highest,var(--background-floating,#111214));box-shadow:0 8px 16px rgba(0,0,0,.24);
  transform:translate(-50%,-100%);white-space:nowrap;opacity:0;transition:opacity .1s}
.zero-tip.on{opacity:1}
.zero-tip::after{content:"";position:absolute;left:50%;bottom:-5px;margin-left:-5px;border:5px solid transparent;border-bottom:0;border-top-color:var(--background-surface-highest,var(--background-floating,#111214))}
#${HINT_ID}{position:fixed;z-index:10001;width:264px;padding:14px 16px 12px;border-radius:12px;font:14px/20px var(--font-primary,system-ui);
  color:var(--text-default,#dbdee1);background:var(--background-surface-highest,var(--background-floating,#111214));
  box-shadow:0 12px 32px rgba(0,0,0,.4);border:1px solid var(--border-subtle,rgba(255,255,255,.06));transform:translate(-50%,-100%);animation:zero-hint-in .18s ease-out}
#${HINT_ID} b{display:block;font-size:15px;margin-bottom:4px;color:var(--header-primary,var(--text-strong,#f2f3f5))}
#${HINT_ID} p{margin:0 0 12px;color:var(--text-muted,#b5bac1)}
#${HINT_ID} kbd{font:600 12px var(--font-code,monospace);padding:1px 5px;border-radius:4px;background:var(--background-mod-normal,rgba(255,255,255,.08))}
#${HINT_ID} .row{display:flex;gap:8px;justify-content:flex-end}
#${HINT_ID} button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;font-weight:600;font-size:14px}
#${HINT_ID} .open{background:var(--brand-500,#5865f2);color:#fff}
#${HINT_ID} .later{color:var(--text-default,#dbdee1)}
#${HINT_ID} .later:hover{text-decoration:underline}
#${HINT_ID}::after{content:"";position:absolute;left:var(--arrow,50%);bottom:-6px;margin-left:-6px;border:6px solid transparent;border-bottom:0;border-top-color:var(--background-surface-highest,var(--background-floating,#111214))}
@keyframes zero-hint-in{from{opacity:0;transform:translate(-50%,calc(-100% + 6px))}}
`;

export interface Launcher { setHint(show: boolean): void; dispose(): void }

export function createLauncher(doc: Document, opts: { open(): void; hintDone(): void }): Launcher {
  let panel: Element | null = null;
  let observer: MutationObserver | null = null;
  let wantHint = false;
  let tip: HTMLElement | null = null;

  const button = doc.createElement('button');
  button.type = 'button';
  button.id = BTN_ID;
  button.setAttribute('aria-label', 'ZERO settings');
  const inner = doc.createElement('div');
  inner.innerHTML = LOGO;
  button.append(inner);
  const activate = () => { removeHint(true); hideTip(); opts.open(); };
  button.addEventListener('click', activate);
  button.addEventListener('mouseenter', showTip);
  button.addEventListener('mouseleave', hideTip);

  function showTip() {
    if (doc.getElementById(HINT_ID)) return;
    tip ??= Object.assign(doc.createElement('div'), { className: 'zero-tip', textContent: 'ZERO settings' });
    const r = button.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`; tip.style.top = `${r.top - 8}px`;
    doc.body.append(tip);
    requestAnimationFrame(() => tip?.classList.add('on'));
  }
  function hideTip() { tip?.classList.remove('on'); tip?.remove(); }

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID) || !doc.head) return;
    const s = doc.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s);
  }

  /** Discord's buttons row in the user panel: the gear is its last button. */
  function findRow(): Element | null {
    const p = doc.querySelector('section[class*="panels_"]');
    if (!p) return null;
    const all = p.querySelectorAll('[class*="buttons_"] > button'); const gear = all[all.length - 1];
    return gear?.parentElement ?? null;
  }

  function place() {
    const row = findRow();
    if (!row) return false;
    const gear = row.lastElementChild;
    if (gear && gear !== button) {
      // borrow Discord's own button classes so hover/focus/size match natively
      const cls = gear.getAttribute('class') ?? '';
      if (button.getAttribute('class') !== cls) button.setAttribute('class', cls);
      const innerCls = gear.firstElementChild?.getAttribute('class') ?? '';
      if (inner.getAttribute('class') !== innerCls) inner.setAttribute('class', innerCls);
      if (button.nextElementSibling !== gear) row.insertBefore(button, gear);
    }
    const p = row.closest('section[class*="panels_"]');
    if (p && p !== panel) {
      panel = p;
      observer?.disconnect();
      observer = new MutationObserver(() => { if (!button.isConnected) requestAnimationFrame(place); });
      observer.observe(p, { childList: true, subtree: true });
    }
    if (wantHint) showHint();
    return true;
  }

  function showHint() {
    if (doc.getElementById(HINT_ID) || !button.isConnected) return;
    const r = button.getBoundingClientRect();
    if (!r.width) return;
    const hint = doc.createElement('div');
    hint.id = HINT_ID; hint.setAttribute('role', 'dialog'); hint.setAttribute('aria-label', 'ZERO settings');
    hint.innerHTML = '<b>Customize ZERO</b><p>Themes, backgrounds and layouts live behind this button. Shortcut: <kbd>Ctrl</kbd> + <kbd>,</kbd></p><div class="row"><button class="later">Got it</button><button class="open">Open settings</button></div>';
    const left = Math.max(148, Math.min(r.left + r.width / 2, innerWidth - 148));
    hint.style.left = `${left}px`; hint.style.top = `${r.top - 12}px`;
    hint.style.setProperty('--arrow', `${132 + (r.left + r.width / 2 - left)}px`);
    hint.querySelector('.later')!.addEventListener('click', () => removeHint(true));
    hint.querySelector('.open')!.addEventListener('click', activate);
    doc.body.append(hint);
  }
  function removeHint(done: boolean) {
    doc.getElementById(HINT_ID)?.remove();
    if (done && wantHint) { wantHint = false; opts.hintDone(); }
  }

  const tick = () => {
    if (doc.hidden) return;
    if (!button.isConnected || (panel && !panel.isConnected)) place();
  };
  const timer = setInterval(tick, 3000);
  const start = () => { ensureStyle(); place(); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();

  return {
    setHint(show) { wantHint = show; if (show) place(); else removeHint(false); },
    dispose() { clearInterval(timer); observer?.disconnect(); button.remove(); removeHint(false); hideTip(); doc.getElementById(STYLE_ID)?.remove(); },
  };
}
