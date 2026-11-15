/**
 * ZERO's built-in plugin runtime. It runs in Discord's page world (it has to read Discord's own data: presences,
 * messages, voice state) and is serialized as one self-contained function: it must not reference anything outside
 * its own body. It has no access to ZERO's IPC, files or settings storage: it only receives the list of enabled
 * plugins (and the detected game, and the saved data of the plugins that keep some) as a JSON string event from
 * ZERO's isolated preload. It can only ask for a page reload, bring the window to the front, or hand back its own
 * plugin data (validated and size-capped by ZERO). It never reads tokens, cookies or credentials. While no plugin is enabled it does nothing at all.
 */
export function zeroRuntime(): void {
  const W = window as any;
  type Settings = Record<string, any>;
  type Plugin = { start(s: Settings): void; stop(): void };

  // ------------------------------------------------------------------ Discord internals (looked up lazily)
  let req: any = null;
  const stores = new Map<string, any>();
  let storesComplete = false;
  let D: any = null;
  const hooks = new Set<(a: any) => any>();

  function wreq(): any {
    if (req) return req;
    const arr = W.webpackChunkdiscord_app;
    if (!Array.isArray(arr)) return null;
    const found: any[] = [];
    try { arr.push([[Symbol('zero')], {}, (r: any) => { found.push(r); }]); } catch { return null; }
    req = found.filter((r) => r && r.c).sort((a, b) => Object.keys(b.c).length - Object.keys(a.c).length)[0] ?? null;
    return req;
  }
  function eachExport(fn: (v: any, key: string) => boolean | void): void {
    const r = wreq();
    if (!r) return;
    for (const id in r.c) {
      const e = r.c[id]?.exports;
      if (!e || (typeof e !== 'object' && typeof e !== 'function')) continue;
      let keys: string[];
      try { keys = Object.keys(e); } catch { continue; }
      for (const k of keys) {
        let v: any;
        try { v = e[k]; } catch { continue; }
        if (v && fn(v, k)) return;
      }
    }
  }
  function store(name: string): any {
    if (!stores.has(name) && !storesComplete) {
      eachExport((v) => {
        if (typeof v === 'object' && typeof v.getName === 'function' && v._dispatchToken) {
          try { const n = v.getName(); if (!stores.has(n)) stores.set(n, v); } catch { /* not a store */ }
        }
      });
      if (stores.size > 200) storesComplete = true;
    }
    return stores.get(name) ?? null;
  }
  function byKey(key: string): any {
    let out: any = null;
    eachExport((v, k) => { if (k === key && typeof v === 'function') { out = v; return true; } });
    return out;
  }
  /** exports of an already-loaded module whose source contains every string */
  function bySource(...parts: string[]): { exports: any; source: string } | null {
    const r = wreq();
    if (!r) return null;
    for (const id in r.m) {
      if (!r.c[id]) continue;
      let s: string;
      try { s = String(r.m[id]); } catch { continue; }
      if (parts.every((p) => s.includes(p))) return { exports: r.c[id].exports, source: s };
    }
    return null;
  }
  const esc = (s: string) => s.replace(/[$]/g, '\\$');
  /** Discord's own accessor for a user setting (getSetting/updateSetting), as used by its settings pages */
  function setting(group: string, key: string): any {
    const m = bySource(`("${group}","${key}"`);
    if (!m) return null;
    const v = new RegExp(`([\\w$]+)=\\(0,[\\w$]+\\.[\\w$]+\\)\\("${group}","${key}"`).exec(m.source)?.[1];
    if (!v) return null;
    // export maps look like {KEY:()=>var} or {KEY:var}; take the first match that really is a setting accessor
    const re = new RegExp(`([\\w$]+):(?:\\(\\)=>)?${esc(v)}(?=[,}])`, 'g');
    for (let m2 = re.exec(m.source); m2; m2 = re.exec(m.source)) {
      const acc = m.exports[m2[1]!];
      if (acc && typeof acc.getSetting === 'function' && typeof acc.updateSetting === 'function') return acc;
    }
    return null;
  }
  function dispatcher(): any {
    if (D) return D;
    // The real Flux dispatcher is the one every store is registered with. (Several modules export look-alike
    // wrappers; events from Discord's servers never pass through those.)
    const d = (store('UserStore') ?? store('MessageStore'))?._dispatcher;
    if (!d || typeof d.dispatch !== 'function' || typeof d.subscribe !== 'function' || typeof d.addInterceptor !== 'function') return null;
    D = d;
    // Discord's own interceptor hook: runs before any store sees an action; returning true swallows it.
    // Hooks may adjust the action in place, or return null to swallow it.
    D.addInterceptor((action: any) => {
      if (!hooks.size || !action || typeof action.type !== 'string') return false;
      for (const h of hooks) {
        let out: any = action;
        try { out = h(action); } catch { /* a plugin error never blocks Discord */ }
        if (out === null) return true;
      }
      return false;
    });
    return D;
  }
  function on(type: string, fn: (a: any) => void): () => void {
    const d = dispatcher();
    if (!d) return () => {};
    const safe = (a: any) => { try { fn(a); } catch { /* ignore */ } };
    d.subscribe(type, safe);
    return () => { try { d.unsubscribe(type, safe); } catch { /* ignore */ } };
  }
  const me = (): string | null => store('UserStore')?.getCurrentUser?.()?.id ?? null;
  function setActivity(socketId: string, activity: any): void {
    try { dispatcher()?.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', socketId, pid: 0, activity }); } catch { /* ignore */ }
  }
  const h = (tag: string, cls: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ------------------------------------------------------------------ shared DOM pass (throttled)
  const domTasks = new Set<() => void>();
  let observer: MutationObserver | null = null;
  let pending = 0;
  // While the window is hidden (minimized, or covered by a fullscreen game) nobody sees the DOM: the pass waits
  // and runs once when it is shown again.
  let deferred = false;
  function runDom(): void {
    pending = 0;
    if (document.hidden) { deferred = true; return; }
    for (const t of domTasks) { try { t(); } catch { /* ignore */ } }
  }
  function schedule(): void { if (!pending && !deferred) pending = window.setTimeout(runDom, 250); }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !deferred) return;
    deferred = false; schedule();
  });
  // Changes inside ZERO's own elements (the call timer ticking every second...) must not re-run every DOM task.
  const OWN = '.zero-calltimer,.zero-pi,.zero-edit,.zero-menu,.zero-gat,.zero-ui,.zero-hubbtn';
  const own = (n: Node): boolean => !!(n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(OWN);
  function onMutations(records: MutationRecord[]): void {
    for (const r of records) if (!own(r.target)) { schedule(); return; }
  }
  function addDom(task: () => void): void {
    domTasks.add(task);
    if (!observer) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    }
    schedule();
  }
  function removeDom(task: () => void): void {
    domTasks.delete(task);
    if (!domTasks.size && observer) { observer.disconnect(); observer = null; }
  }

  let styleEl: HTMLStyleElement | null = null;
  const css = new Map<string, string>();
  function setCss(id: string, text: string | null): void {
    if (text) css.set(id, text); else css.delete(id);
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'zero-plugins'; }
    styleEl.textContent = [...css.values()].join('\n');
    if (css.size && !styleEl.isConnected) (document.head ?? document.documentElement).appendChild(styleEl);
    if (!css.size) styleEl.remove();
  }

  // ------------------------------------------------------------------ plugins
  let game: { id: string; name: string; start: number } | null = null;
  const gameListeners = new Set<() => void>();

  const plugins: Record<string, Plugin> = {};

  // CallTimer
  {
    let timer = 0; let ch: string | null = null; let since = 0; let fmt = 'stopwatch';
    const pad = (n: number) => String(n).padStart(2, '0');
    const text = (ms: number) => {
      const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      return fmt === 'human' ? (hh ? `${hh}h ${mm}m ${ss}s` : mm ? `${mm}m ${ss}s` : `${ss}s`) : `${hh ? pad(hh) + ':' : ''}${pad(mm)}:${pad(ss)}`;
    };
    const tick = () => {
      const id = store('SelectedChannelStore')?.getVoiceChannelId?.() ?? null;
      if (id !== ch) { ch = id; since = Date.now(); }
      if (document.hidden) return; // nothing to show; the next visible tick catches up
      let el = document.querySelector<HTMLElement>('.zero-calltimer');
      const status = document.querySelector('[class*="rtcConnectionStatus_"]');
      if (!ch || !status) { el?.remove(); return; }
      if (!el) {
        let host: Element | null = status;
        for (let i = 0; i < 5 && host && !host.querySelector('a[href^="/channels/"]'); i++) host = host.parentElement;
        el = h('div', 'zero-calltimer');
        (host ?? status.parentElement)?.appendChild(el);
      }
      const t = text(Date.now() - since);
      if (el.textContent !== t) el.textContent = t;
    };
    plugins.callTimer = {
      start(s) {
        fmt = s.format;
        setCss('callTimer', '.zero-calltimer{font-size:12px;line-height:16px;color:var(--text-muted,#949ba4);font-variant-numeric:tabular-nums;margin-top:2px}');
        tick(); timer = window.setInterval(tick, 1000);
        document.addEventListener('visibilitychange', tick);
      },
      stop() { clearInterval(timer); document.removeEventListener('visibilitychange', tick); ch = null; document.querySelector('.zero-calltimer')?.remove(); setCss('callTimer', null); },
    };
  }

  // PlatformIndicators
  {
    let s: Settings = {}; let off: (() => void) | null = null;
    const COLORS: Record<string, string> = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43' };
    const PATHS: Record<string, string> = {
      desktop: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h3v2H7v-2h3v-2H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v8h14V6H5Z',
      mobile: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 3v13h8V5H8Zm3 14v1h2v-1h-2Z',
      web: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1.9 2.2A8 8 0 0 0 4.1 11H8c.1-2.5.8-4.9 2.1-6.8ZM13.9 4.2c1.3 1.9 2 4.3 2.1 6.8h3.9a8 8 0 0 0-6-6.8ZM14 11c-.1-2.4-.8-4.6-2-6.3-1.2 1.7-1.9 3.9-2 6.3h4Zm-4 2c.1 2.4.8 4.6 2 6.3 1.2-1.7 1.9-3.9 2-6.3h-4Zm-5.9 0a8 8 0 0 0 6 6.8C8.8 17.9 8.1 15.5 8 13H4.1Zm11.9 0c-.1 2.5-.8 4.9-2.1 6.8a8 8 0 0 0 6-6.8H16Z',
      embedded: 'M7 7h10a5 5 0 0 1 0 10c-1.5 0-2.4-.8-3.2-1.6L13 14.6h-2l-.8.8C9.4 16.2 8.5 17 7 17A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1H7V14h1v-1.5h1.5v-1H8V10H7Zm8.5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
    };
    const NAMES: Record<string, string> = { desktop: 'Desktop', mobile: 'Mobile', web: 'Web', embedded: 'Console' };
    const statusOf = (uid: string): Record<string, string> => {
      const P = store('PresenceStore');
      return (P?.getClientStatus?.(uid) ?? P?.getState?.()?.clientStatuses?.[uid] ?? {}) as Record<string, string>;
    };
    function indicator(host: Element, uid: string | null, cls: string): void {
      let el = host.querySelector<HTMLElement>(':scope > .zero-pi');
      const cs = uid ? statusOf(uid) : {};
      const entries = Object.entries(cs).filter(([p, v]) => PATHS[p] && COLORS[v]);
      const sig = uid + JSON.stringify(entries);
      if (!entries.length) { el?.remove(); return; }
      if (el && el.dataset.sig === sig) return;
      if (!el) { el = h('span', 'zero-pi ' + cls); host.appendChild(el); }
      el.dataset.sig = sig;
      el.replaceChildren(...entries.map(([p, v]) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = `${NAMES[p]}: ${v === 'dnd' ? 'Do Not Disturb' : v[0]!.toUpperCase() + v.slice(1)}`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', PATHS[p]!); path.setAttribute('fill', COLORS[v]!);
        svg.append(t, path);
        return svg;
      }));
    }
    function fiberUser(el: Element): string | null {
      const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
      let f = k ? (el as any)[k] : null;
      for (let i = 0; i < 30 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        const u = p?.user ?? p?.member?.user;
        if (typeof u?.id === 'string') return u.id;
        if (typeof p?.userId === 'string') return p.userId;
      }
      return null;
    }
    const pass = () => {
      if (s.messages) {
        const M = store('MessageStore');
        for (const name of document.querySelectorAll('[id^="message-username-"]')) {
          const li = name.closest('li[id^="chat-messages-"]');
          const m = li && /^chat-messages-(\d+)-(\d+)$/.exec(li.id);
          const uid = m ? M?.getMessage?.(m[1], m[2])?.author?.id ?? null : null;
          indicator(name.parentElement ?? name, uid, 'zero-pi-msg');
        }
      }
      if (s.memberList) {
        for (const row of document.querySelectorAll('[class*="member_"] [class*="nameAndDecorators_"]')) indicator(row, fiberUser(row), 'zero-pi-member');
      }
      if (s.dms) {
        const C = store('ChannelStore');
        for (const a of document.querySelectorAll('a[href^="/channels/@me/"]')) {
          const ch = C?.getChannel?.(a.getAttribute('href')!.split('/')[3]);
          const name = a.querySelector('[class*="nameAndDecorators_"]') ?? a.querySelector('[class*="name_"]');
          if (!name) continue;
          indicator(name, ch?.type === 1 ? ch.recipients?.[0] ?? ch.getRecipientId?.() ?? null : null, 'zero-pi-dm');
        }
      }
    };
    plugins.platformIndicators = {
      start(next) {
        s = next;
        setCss('platformIndicators', '.zero-pi{display:inline-flex;gap:2px;align-items:center;vertical-align:middle;margin-left:4px;flex:none}.zero-pi svg{display:block}.zero-pi-msg{margin-right:4px}');
        addDom(pass);
        off = on('PRESENCE_UPDATES', schedule);
      },
      stop() { removeDom(pass); off?.(); off = null; document.querySelectorAll('.zero-pi').forEach((e) => e.remove()); setCss('platformIndicators', null); },
    };
  }

  // MessageLogger (memory only): deleted messages stay on screen with a red background; right click to clear them
  {
    let s: Settings = {};
    const deleted = new Map<string, { channelId: string; guildId?: string }>();
    const edits = new Map<string, string[]>();
    const bypass = new Set<string>();
    let menu: HTMLElement | null = null;
    const trim = () => {
      while (deleted.size > 2000) deleted.delete(deleted.keys().next().value!);
      while (edits.size > 2000) edits.delete(edits.keys().next().value!);
    };
    const ignored = (msg: any) => !msg || (s.ignoreSelf && msg.author?.id === me()) || (s.ignoreBots && msg.author?.bot);
    const hook = (a: any) => {
      const M = store('MessageStore');
      if (a.type === 'MESSAGE_DELETE') {
        if (bypass.delete(a.id)) return a; // "Remove logged message": let Discord really remove it
        const msg = M?.getMessage?.(a.channelId, a.id);
        if (ignored(msg)) return a;
        deleted.set(a.id, { channelId: a.channelId, guildId: a.guildId }); trim(); schedule();
        return null;
      }
      if (a.type === 'MESSAGE_DELETE_BULK' && Array.isArray(a.ids)) {
        const keep = a.ids.filter((id: string) => bypass.delete(id) || ignored(M?.getMessage?.(a.channelId, id)));
        for (const id of a.ids) if (!keep.includes(id)) deleted.set(id, { channelId: a.channelId, guildId: a.guildId });
        trim(); schedule();
        if (!keep.length) return null;
        a.ids = keep;
        return a;
      }
      if (a.type === 'MESSAGE_UPDATE' && s.logEdits && a.message && typeof a.message.content === 'string') {
        const old = M?.getMessage?.(a.message.channel_id, a.message.id);
        if (!ignored(old) && typeof old.content === 'string' && old.content !== a.message.content) {
          const list = edits.get(a.message.id) ?? [];
          list.push(old.content); edits.set(a.message.id, list.slice(-10)); trim(); schedule();
        }
      }
      return a;
    };
    /** Really removes logged messages from the chat, as Discord would have done */
    function purge(ids: string[]): void {
      const d = dispatcher();
      for (const id of ids) {
        const info = deleted.get(id);
        deleted.delete(id);
        edits.delete(id);
        if (!info || !d) continue;
        bypass.add(id);
        try { d.dispatch({ type: 'MESSAGE_DELETE', id, channelId: info.channelId, guildId: info.guildId }); } catch { bypass.delete(id); }
      }
      schedule();
    }
    const idsIn = (channelId: string | null) => (channelId ? [...deleted].filter(([, v]) => v.channelId === channelId).map(([id]) => id) : []);
    const pass = () => {
      if (!deleted.size && !edits.size) return;
      for (const li of document.querySelectorAll<HTMLElement>('li[id^="chat-messages-"]')) {
        const mid = li.id.split('-').pop()!;
        if (deleted.has(mid)) { if (!li.hasAttribute('data-zero-deleted')) li.setAttribute('data-zero-deleted', ''); }
        else if (li.hasAttribute('data-zero-deleted')) li.removeAttribute('data-zero-deleted');
        const list = edits.get(mid);
        const content = li.querySelector(`#message-content-${mid}`);
        let box = li.querySelector<HTMLElement>('.zero-edits');
        if (!list || !content) { box?.remove(); continue; }
        if (box && box.dataset.n === String(list.length) && box.nextElementSibling === content) continue;
        box?.remove();
        box = h('div', 'zero-edits');
        box.dataset.n = String(list.length);
        for (const t of list) box.append(h('div', 'zero-edit', t || ' '));
        content.before(box);
      }
    };

    // right-click menu
    const closeMenu = () => {
      if (!menu) return;
      menu.remove(); menu = null;
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      document.removeEventListener('wheel', closeMenu, true);
    };
    const outside = (e: MouseEvent) => { if (!menu?.contains(e.target as Node)) closeMenu(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
    function openMenu(x: number, y: number, items: { label: string; run: () => void }[]): void {
      closeMenu();
      const m = h('div', 'zero-menu');
      menu = m;
      m.setAttribute('role', 'menu');
      m.append(h('div', 'zero-menu-head', 'MessageLogger'));
      for (const it of items) {
        const b = h('button', 'zero-menu-item', it.label) as HTMLButtonElement;
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { closeMenu(); it.run(); });
        m.append(b);
      }
      document.body.append(m);
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
      m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', closeMenu);
      window.addEventListener('resize', closeMenu);
      document.addEventListener('wheel', closeMenu, true);
    }
    const onContext = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest || t.closest('.zero-menu')) return;
      const li = t.closest('li[id^="chat-messages-"]');
      const here = store('SelectedChannelStore')?.getChannelId?.() ?? null;
      if (li?.hasAttribute('data-zero-deleted')) {
        const mid = li.id.split('-').pop()!;
        const all = idsIn(deleted.get(mid)?.channelId ?? here);
        e.preventDefault(); e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: 'Remove logged message', run: () => purge([mid]) },
          ...(all.length > 1 ? [{ label: `Remove all logged deleted messages (${all.length})`, run: () => purge(all) }] : []),
        ]);
        return;
      }
      if (li || t.closest('form, [class*="channelTextArea_"], [role="menu"], a, img, video')) return;
      if (!t.closest('[data-list-id="chat-messages"], [class*="messagesWrapper_"], [class*="chatContent_"]')) return;
      const all = idsIn(here);
      if (!all.length) return;
      e.preventDefault(); e.stopPropagation();
      openMenu(e.clientX, e.clientY, [{ label: `Remove all logged deleted messages (${all.length})`, run: () => purge(all) }]);
    };

    plugins.messageLogger = {
      start(next) {
        s = next;
        dispatcher(); hooks.add(hook); addDom(pass);
        document.addEventListener('contextmenu', onContext, true);
        setCss('messageLogger', [
          'li[data-zero-deleted]>div{background:rgba(242,63,67,.13)!important;box-shadow:inset 3px 0 0 #f23f43}',
          'li[data-zero-deleted]>div:hover{background:rgba(242,63,67,.19)!important}',
          'li[data-zero-deleted] [id^="message-content-"]::after{content:"deleted";display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;background:#f23f43;color:#fff;font-size:10px;font-weight:700;line-height:15px;text-transform:uppercase;vertical-align:1px}',
          '.zero-edit{font-size:.92em;color:var(--text-muted,#949ba4);white-space:pre-wrap;word-break:break-word}',
          '.zero-edit::after{content:" (edited)";font-size:11px;opacity:.7}',
          '.zero-menu{position:fixed;z-index:100000;min-width:230px;padding:6px 8px;border-radius:8px;background:var(--background-floating,#111214);box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);font-family:var(--font-primary,"gg sans","Segoe UI",sans-serif)}',
          '.zero-menu-head{padding:4px 8px 6px;font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--text-muted,#949ba4)}',
          '.zero-menu-item{display:block;width:100%;margin:2px 0;padding:8px;border:0;border-radius:4px;background:none;color:#f23f43;font-family:inherit;font-size:14px;font-weight:500;line-height:18px;text-align:left;cursor:pointer}',
          '.zero-menu-item:hover,.zero-menu-item:focus-visible{background:#da373c;color:#fff;outline:none}',
        ].join(''));
      },
      stop() {
        hooks.delete(hook); removeDom(pass); closeMenu();
        document.removeEventListener('contextmenu', onContext, true);
        purge([...deleted.keys()]); // turning the logger off removes the messages it kept
        edits.clear();
        document.querySelectorAll('.zero-edits').forEach((e) => e.remove());
        document.querySelectorAll('[data-zero-deleted]').forEach((e) => e.removeAttribute('data-zero-deleted'));
        setCss('messageLogger', null);
      },
    };
  }

  // AccountPanelServerProfile
  {
    let open: any = null;
    const onMenu = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const panels = t?.closest?.('section[class*="panels_"]');
      if (!panels || !t!.closest('[class*="avatar_"],[class*="nameTag_"]') || t!.closest('[class*="rtcConnectionStatus_"]')) return;
      const uid = me();
      open ??= byKey('openUserProfileModal');
      if (!uid || !open) return;
      e.preventDefault(); e.stopPropagation();
      const guildId = store('SelectedGuildStore')?.getGuildId?.() ?? undefined;
      try { open({ userId: uid, guildId: guildId ?? undefined }); } catch { /* ignore */ }
    };
    plugins.accountPanelServerProfile = {
      start() { document.addEventListener('contextmenu', onMenu, true); },
      stop() { document.removeEventListener('contextmenu', onMenu, true); },
    };
  }

  // GameActivityToggle: Discord's own "Share your detected activities" setting, as a button by mic/deafen
  {
    let acc: any = null;
    const ICON = 'M7 7h10a5 5 0 0 1 0 10c-1.5 0-2.4-.8-3.2-1.6L13 14.6h-2l-.8.8C9.4 16.2 8.5 17 7 17A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1H7V14h1v-1.5h1.5v-1H8V10H7Zm8.5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
    const get = () => { acc ??= setting('status', 'showCurrentGame'); return acc; };
    const pass = () => {
      const a = get();
      if (!a) return;
      const panels = document.querySelector('section[class*="panels_"]');
      const account = panels && [...panels.children].find((c) => c.querySelector('[class*="nameTag_"]'));
      const mic = account?.querySelector('button');
      const row = mic?.closest('[class*="buttons_"]') ?? mic?.parentElement?.parentElement;
      if (!row) return;
      let b = row.querySelector<HTMLButtonElement>(':scope > .zero-gat');
      const onState = a.getSetting() !== false;
      if (!b) {
        b = document.createElement('button');
        b.className = 'zero-gat';
        b.type = 'button';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICON); p.setAttribute('fill', 'currentColor');
        const slash = document.createElementNS('http://www.w3.org/2000/svg', 'path'); slash.setAttribute('d', 'M3.7 2.3 21.7 20.3 20.3 21.7 2.3 3.7Z'); slash.setAttribute('class', 'zero-gat-slash');
        svg.append(p, slash); b.append(svg);
        b.addEventListener('click', () => { const x = get(); if (x) { x.updateSetting(x.getSetting() === false); window.setTimeout(pass, 50); } });
        row.prepend(b);
      }
      b.classList.toggle('off', !onState);
      b.title = onState ? 'Hide game activity' : 'Show game activity';
      b.setAttribute('aria-label', b.title);
    };
    plugins.gameActivityToggle = {
      start() {
        setCss('gameActivityToggle', '.zero-gat{width:32px;height:32px;display:inline-grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer;flex:none}.zero-gat:hover{background:var(--background-modifier-hover,rgba(255,255,255,.06));color:var(--interactive-hover,#dbdee1)}.zero-gat .zero-gat-slash{fill:#f23f43;display:none}.zero-gat.off{color:#f23f43}.zero-gat.off .zero-gat-slash{display:block}');
        addDom(pass);
      },
      stop() { removeDom(pass); document.querySelectorAll('.zero-gat').forEach((e) => e.remove()); setCss('gameActivityToggle', null); },
    };
  }

  // CrashHandler: Discord's "something went wrong" screen → ask ZERO to reload the page (rate limited by ZERO)
  {
    let sent = false;
    const pass = () => {
      if (sent || !document.querySelector('[class*="errorPage_"]')) return;
      sent = true;
      document.dispatchEvent(new CustomEvent('zero:crash'));
    };
    plugins.crashHandler = { start() { addDom(pass); }, stop() { removeDom(pass); } };
  }

  // CustomRPC: the activity object is built and validated by ZERO's preload
  {
    let offConn: (() => void) | null = null; let current: any = null;
    const push = () => setActivity('zero-custom-rpc', current);
    plugins.customRpc = {
      start(s) { current = s.activity ?? null; push(); offConn = on('CONNECTION_OPEN', () => window.setTimeout(push, 1000)); },
      stop() { offConn?.(); offConn = null; current = null; push(); },
    };
  }

  // GameDetection: games found by ZERO (main process) shown like the desktop app's detected games
  {
    let offConn: (() => void) | null = null;
    const push = () => setActivity('zero-game', game ? { application_id: game.id, name: game.name, type: 0, timestamps: { start: game.start } } : null);
    plugins.gameDetection = {
      start() { push(); gameListeners.add(push); offConn = on('CONNECTION_OPEN', () => window.setTimeout(push, 1000)); },
      stop() { gameListeners.delete(push); offConn?.(); offConn = null; setActivity('zero-game', null); },
    };
  }

  // AutoDNDWhilePlaying: uses Discord's own status setting, like picking a status by hand
  {
    let target = 'dnd'; let applied: string | null = null; let previous: string | null = null;
    let statusAcc: any = null; let setStatus: any = null;
    const current = () => { statusAcc ??= setting('status', 'status'); return statusAcc?.getSetting?.() ?? null; };
    const set = (next: string) => {
      setStatus ??= (() => { const m = bySource('nextStatus', 'USER_STATUS_UPDATED'); return m && Object.values(m.exports).find((v) => typeof v === 'function'); })();
      if (typeof setStatus === 'function') { try { setStatus({ nextStatus: next }); } catch { /* ignore */ } }
    };
    const react = () => {
      if (game && !applied) {
        const now = current();
        if (now === 'online') { previous = now; applied = target; set(target); }
      } else if (!game && applied) {
        if (current() === applied && previous) set(previous);
        applied = null; previous = null;
      }
    };
    plugins.autoDndWhilePlaying = {
      start(s) { target = s.status; gameListeners.add(react); react(); },
      stop() { gameListeners.delete(react); if (applied && current() === applied && previous) set(previous); applied = null; previous = null; },
    };
  }

  // IgnoreActivities is applied by ZERO's game detection (ignored games are never reported); nothing runs here.
  plugins.ignoreActivities = { start() {}, stop() {} };

  // ================================================================== shared by the "daily" plugins
  // (MessageReminder, SmartBookmarks, QuickNotes, SmartText, PrivacyMode)

  // ---- saved data: comes with the config event, goes back through ZERO's preload (validated by ZERO, size capped)
  const pdata: Record<string, any> = {};
  const saveTimers: Record<string, number> = {};
  function saveData(id: string): void {
    clearTimeout(saveTimers[id]);
    saveTimers[id] = window.setTimeout(() => {
      try { document.dispatchEvent(new CustomEvent('zero:data-save', { detail: id + '\n' + JSON.stringify(pdata[id]) })); } catch { /* ignore */ }
    }, 500);
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k in e && k !== 'list') (e as any)[k] = v;
      else e.setAttribute(k, String(v));
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  };
  const when = (t: number): string => {
    const d = new Date(t); const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return tm;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow ' + tm;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + tm;
  };

  // ---- reading a message (only what the user picked: author name, text, attachments, links)
  function readMessage(channelId: string, messageId: string): any | null {
    const msg = store('MessageStore')?.getMessage?.(channelId, messageId);
    if (!msg) return null;
    const ch = store('ChannelStore')?.getChannel?.(channelId);
    const a = msg.author ?? {};
    const atts: any[] = [];
    for (const x of msg.attachments ?? []) {
      const t = String(x.content_type ?? '');
      atts.push({ name: x.filename ?? 'file', url: x.url ?? x.proxy_url, kind: t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : 'file' });
    }
    for (const e of msg.embeds ?? []) {
      const img = e.image?.url ?? e.thumbnail?.url;
      if (img && /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(e.image?.proxyURL ?? e.thumbnail?.proxyURL ?? '')) atts.push({ name: e.title ?? 'image', url: e.image?.proxyURL ?? e.thumbnail?.proxyURL, kind: 'image' });
      else if (img && /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(img)) atts.push({ name: e.title ?? 'image', url: img, kind: 'image' });
    }
    let content = String(msg.content ?? '');
    if (!content.trim()) content = (msg.embeds ?? []).map((e: any) => [e.rawTitle ?? e.title, e.rawDescription ?? e.description].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
    const links = [...new Set((content.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []))].slice(0, 10);
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
    return {
      channelId, messageId, guildId: ch?.guild_id ?? null,
      author: a.globalName ?? a.global_name ?? a.username ?? 'Unknown', authorId: a.id ?? null,
      content: content.slice(0, 4000), at: Number.isFinite(ts) ? ts : 0, attachments: atts.slice(0, 10), links,
    };
  }
  function placeName(r: { guildId: string | null; channelId: string }): string {
    const ch = store('ChannelStore')?.getChannel?.(r.channelId);
    if (!ch) return 'Unknown channel';
    if (ch.type === 1) { const u = store('UserStore')?.getUser?.(ch.recipients?.[0] ?? ch.getRecipientId?.()); return '@' + (u?.globalName ?? u?.username ?? 'DM'); }
    const g = r.guildId ? store('GuildStore')?.getGuild?.(r.guildId) : null;
    return (g ? g.name + ' › ' : '') + (ch.name ? (ch.type === 3 ? ch.name : '#' + ch.name) : 'Group DM');
  }
  let router: any = undefined;
  function jump(r: { guildId: string | null; channelId: string; messageId: string }): void {
    const path = `/channels/${r.guildId ?? '@me'}/${r.channelId}/${r.messageId}`;
    if (router === undefined) {
      router = null;
      eachExport((v) => { if (typeof v === 'function' && v.length >= 1) { try { if (String(v).includes('transitionTo - Transitioning to')) { router = v; return true; } } catch { /* ignore */ } } return false; });
    }
    try { if (router) { router(path); return; } } catch { /* fall back below */ }
    history.pushState(history.state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }

  // ---- toasts (bottom right)
  let toastBox: HTMLElement | null = null;
  function toast(text: string, actions: { label: string; run: () => void }[] = [], ms = 6000): void {
    if (!toastBox || !toastBox.isConnected) { toastBox = el('div', { class: 'zero-ui zero-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
    const t = el('div', { class: 'zero-toast' }, el('span', { text }));
    const close = () => { t.remove(); if (toastBox && !toastBox.children.length) { toastBox.remove(); toastBox = null; } };
    for (const a of actions) t.append(el('button', { type: 'button', class: 'zero-btn small', text: a.label, onclick: () => { close(); a.run(); } }));
    t.append(el('button', { type: 'button', class: 'zero-x', 'aria-label': 'Dismiss', text: '×', onclick: close }));
    toastBox.append(t);
    if (ms) window.setTimeout(close, ms);
  }

  // ---- small popup near the pointer (Escape or a click outside closes it)
  let popupEl: HTMLElement | null = null; let popupOff: (() => void) | null = null;
  function closePopup(): void { popupOff?.(); popupOff = null; popupEl?.remove(); popupEl = null; }
  function popup(x: number, y: number, title: string, body: HTMLElement): HTMLElement {
    closePopup();
    const p = el('div', { class: 'zero-ui zero-pop', role: 'dialog', 'aria-label': title }, el('div', { class: 'zero-pop-head', text: title }), body);
    document.body.append(p);
    const r = p.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    p.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    const outside = (e: MouseEvent) => { if (!p.contains(e.target as Node)) closePopup(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(); } };
    window.setTimeout(() => document.addEventListener('mousedown', outside, true));
    document.addEventListener('keydown', key, true);
    popupOff = () => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); };
    popupEl = p;
    (p.querySelector('input,button,textarea') as HTMLElement | null)?.focus();
    return p;
  }

  // ---- items in Discord's own message right-click menu
  type MenuItem = { label: string; run: (ref: { channelId: string; messageId: string }, x: number, y: number) => void };
  const menuItems = new Map<string, MenuItem[]>();
  let menuWatch = 0;
  function onMessageMenu(e: MouseEvent): void {
    if (!menuItems.size) return;
    const t = e.target as Element | null;
    const li = t?.closest?.('li[id^="chat-messages-"]');
    const m = li && /^chat-messages-(\d+)-(\d+)$/.exec(li.id);
    if (!m || li!.hasAttribute('data-zero-deleted')) return;
    const ref = { channelId: m[1]!, messageId: m[2]! };
    const x = e.clientX, y = e.clientY;
    cancelAnimationFrame(menuWatch);
    let tries = 0;
    const look = () => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      if (!menu || menu.querySelector('.zero-mi')) { if (++tries < 30) menuWatch = requestAnimationFrame(look); return; }
      const sample = menu.querySelector<HTMLElement>('[role="menuitem"]');
      const scroller = sample?.closest('[role="group"]')?.parentElement ?? menu;
      const sep = menu.querySelector('[class*="separator_"]');
      const group = el('div', { role: 'group', class: 'zero-mgroup' });
      for (const items of menuItems.values()) for (const it of items) {
        const b = el('div', { role: 'menuitem', tabindex: '-1', class: (sample?.className ?? '').replace(/\bfocused_\S*/g, '') + ' zero-mi' },
          el('div', { class: sample?.querySelector('[class*="label_"]')?.className ?? '', text: it.label }));
        b.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          window.setTimeout(() => it.run(ref, x, y), 30);
        });
        group.append(b);
      }
      if (sep) scroller.append(sep.cloneNode(true) as HTMLElement);
      scroller.append(group);
    };
    menuWatch = requestAnimationFrame(look);
  }
  function addMenu(id: string, items: MenuItem[]): void {
    if (!menuItems.size) document.addEventListener('contextmenu', onMessageMenu, true);
    menuItems.set(id, items);
  }
  function removeMenu(id: string): void {
    menuItems.delete(id);
    if (!menuItems.size) document.removeEventListener('contextmenu', onMessageMenu, true);
  }

  // ---- the ZERO panel (Ctrl+Shift+L or the button in the channel header): one tab per plugin
  type Tab = { label: string; render: (host: HTMLElement) => void };
  const tabs = new Map<string, Tab>();
  let hub: HTMLElement | null = null; let hubTab = '';
  const HUB_CSS = [
    '.zero-ui{font-family:var(--font-primary,"gg sans","Segoe UI",sans-serif);color:var(--text-normal,#dbdee1);font-size:14px;line-height:1.35}',
    '.zero-ui input,.zero-ui textarea,.zero-ui select{font:inherit;color:inherit;background:var(--input-background,#1e1f22);border:1px solid var(--border-subtle,rgba(255,255,255,.08));border-radius:6px;padding:7px 9px;outline:none;min-width:0}',
    '.zero-ui input:focus,.zero-ui textarea:focus,.zero-ui select:focus{border-color:var(--brand-500,#5865f2)}',
    '.zero-btn{font:inherit;font-weight:500;border:0;border-radius:6px;padding:6px 11px;background:var(--button-secondary-background,#4e5058);color:#fff;cursor:pointer;white-space:nowrap}',
    '.zero-btn:hover{filter:brightness(1.12)}.zero-btn.primary{background:var(--brand-500,#5865f2)}.zero-btn.danger{background:#da373c}.zero-btn.ghost{background:transparent;color:var(--interactive-normal,#b5bac1)}.zero-btn.ghost:hover{background:var(--background-modifier-hover,rgba(255,255,255,.06));color:var(--interactive-hover,#dbdee1)}',
    '.zero-btn.small{padding:3px 8px;font-size:13px}.zero-btn[aria-pressed="true"]{background:var(--brand-500,#5865f2);color:#fff}',
    '.zero-x{border:0;background:none;color:var(--interactive-normal,#b5bac1);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px}.zero-x:hover{color:var(--interactive-hover,#fff);background:var(--background-modifier-hover,rgba(255,255,255,.06))}',
    'html[data-zero-hub] .zero-toasts{right:432px}',
    '.zero-toasts{position:fixed;right:16px;bottom:16px;z-index:100002;display:flex;flex-direction:column;gap:8px;max-width:380px}',
    '.zero-toast{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 14px;border-radius:8px;background:var(--background-floating,#111214);box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06)}.zero-toast>span{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.zero-pop{position:fixed;z-index:100001;width:300px;padding:12px;border-radius:8px;background:var(--background-floating,#111214);box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06);display:flex;flex-direction:column;gap:8px}',
    '.zero-pop-head{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--text-muted,#949ba4)}',
    '.zero-chips{display:flex;flex-wrap:wrap;gap:6px}.zero-row{display:flex;gap:6px;align-items:center}.zero-row>input,.zero-row>select{flex:1}',
    '.zero-muted{color:var(--text-muted,#949ba4);font-size:12px}',
    '.zero-mi:hover{background:var(--menu-item-default-hover-bg,var(--brand-560,#4752c4))!important;color:#fff!important}',
    '.zero-hub{position:fixed;z-index:100000;top:56px;right:16px;bottom:16px;width:400px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;border-radius:10px;background:var(--background-floating,#111214);box-shadow:0 12px 32px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);overflow:hidden}',
    '.zero-hub-head{display:flex;align-items:center;gap:4px;padding:8px 8px 0 12px}.zero-hub-head b{margin-right:auto;font-size:15px}',
    '.zero-tabs{display:flex;gap:2px;padding:8px 8px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.08))}',
    '.zero-tab{border:0;background:none;color:var(--interactive-normal,#b5bac1);font:inherit;font-weight:500;padding:6px 10px;border-radius:6px 6px 0 0;cursor:pointer;border-bottom:2px solid transparent}.zero-tab:hover{color:var(--interactive-hover,#dbdee1)}.zero-tab[aria-selected="true"]{color:var(--interactive-active,#fff);border-bottom-color:var(--brand-500,#5865f2)}',
    '.zero-hub-body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}',
    '.zero-card{padding:10px;border-radius:8px;background:var(--background-secondary,#2b2d31);display:flex;flex-direction:column;gap:6px}',
    '.zero-card-head{display:flex;gap:6px;align-items:baseline;font-size:12px;color:var(--text-muted,#949ba4)}.zero-card-head b{color:var(--header-primary,#f2f3f5);font-size:14px}.zero-card-head .zero-sp{margin-left:auto}',
    '.zero-text{white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}',
    '.zero-actions{display:flex;gap:6px;flex-wrap:wrap}',
    '.zero-thumbs{display:flex;gap:6px;flex-wrap:wrap}.zero-thumbs img{width:64px;height:64px;object-fit:cover;border-radius:6px;background:#0003}',
    '.zero-tag{display:inline-block;padding:1px 7px;border-radius:10px;background:var(--background-modifier-accent,rgba(255,255,255,.08));font-size:12px}',
    '.zero-empty{color:var(--text-muted,#949ba4);text-align:center;padding:24px 8px}',
    '.zero-hubbtn{width:24px;height:24px;margin:0 8px;display:inline-grid;place-items:center;border:0;padding:0;background:none;color:var(--interactive-normal,#b5bac1);cursor:pointer;flex:none}.zero-hubbtn:hover,.zero-hubbtn[aria-pressed="true"]{color:var(--interactive-hover,#dbdee1)}',
  ].join('');
  function renderHub(): void {
    if (!hub) return;
    if (!tabs.has(hubTab)) hubTab = ['messageReminder', 'smartBookmarks', 'quickNotes', 'smartText'].find((k) => tabs.has(k)) ?? '';
    const bar = hub.querySelector('.zero-tabs')!;
    const ORDER = ['messageReminder', 'smartBookmarks', 'quickNotes', 'smartText'];
    bar.replaceChildren(...[...tabs].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([id, t]) => el('button', { type: 'button', role: 'tab', class: 'zero-tab', 'aria-selected': String(id === hubTab), text: t.label, onclick: () => { hubTab = id; renderHub(); } })));
    const body = hub.querySelector<HTMLElement>('.zero-hub-body')!;
    body.replaceChildren();
    try { tabs.get(hubTab)?.render(body); } catch { body.append(el('div', { class: 'zero-empty', text: 'Something went wrong in this tab.' })); }
  }
  function openHub(tab?: string): void {
    if (!tabs.size) return;
    if (tab && tabs.has(tab)) hubTab = tab;
    if (!hub) {
      hub = el('div', { class: 'zero-ui zero-hub', role: 'dialog', 'aria-label': 'ZERO panel' },
        el('div', { class: 'zero-hub-head' }, el('b', { text: 'ZERO' }), el('span', { class: 'zero-muted', text: 'Ctrl+Shift+L' }), el('button', { type: 'button', class: 'zero-x', 'aria-label': 'Close', text: '×', onclick: () => closeHub() })),
        el('div', { class: 'zero-tabs', role: 'tablist' }),
        el('div', { class: 'zero-hub-body' }));
      // Keys typed in the panel stay in the panel (Discord would otherwise move them to its message box).
      for (const t of ['keydown', 'keypress', 'keyup']) hub.addEventListener(t, (e) => { const k = e as KeyboardEvent; if (k.key === 'Escape') { if (t === 'keydown') closeHub(); } e.stopPropagation(); });
      document.body.append(hub);
      document.documentElement.setAttribute('data-zero-hub', '');
    }
    renderHub();
    syncHubButtons();
  }
  function closeHub(): void { hub?.remove(); hub = null; document.documentElement.removeAttribute('data-zero-hub'); syncHubButtons(); }
  const refreshHub = (id: string) => { if (hub && hubTab === id) renderHub(); };
  const HUB_ICON = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h4V5H5Zm6 0v14h8V5h-8Zm2 2h4v2h-4V7Zm0 4h4v2h-4v-2Z';
  function syncHubButtons(): void { for (const b of document.querySelectorAll('.zero-hubbtn')) b.setAttribute('aria-pressed', String(!!hub)); }
  const hubButtonPass = () => {
    const bar = document.querySelector('section[class*="title_"] [class*="toolbar_"]');
    if (!bar || bar.querySelector(':scope > .zero-hubbtn')) return;
    const b = el('button', { type: 'button', class: 'zero-hubbtn', title: 'ZERO panel (Ctrl+Shift+L)', 'aria-label': 'ZERO panel', onclick: () => (hub ? closeHub() : openHub()) });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', HUB_ICON); p.setAttribute('fill', 'currentColor'); svg.append(p); b.append(svg);
    const search = bar.querySelector(':scope > [class*="search_"]');
    if (search) search.before(b); else bar.append(b);
    syncHubButtons();
  };
  const hubKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyL') { e.preventDefault(); e.stopPropagation(); if (hub) closeHub(); else openHub(); }
  };
  function addTab(id: string, tab: Tab): void {
    if (!tabs.size) { setCss('zeroHub', HUB_CSS); addDom(hubButtonPass); document.addEventListener('keydown', hubKey, true); }
    tabs.set(id, tab);
    if (hub) renderHub();
  }
  function removeTab(id: string): void {
    tabs.delete(id);
    if (tabs.size) { if (hub) renderHub(); return; }
    closeHub(); closePopup(); removeDom(hubButtonPass); document.removeEventListener('keydown', hubKey, true);
    document.querySelectorAll('.zero-hubbtn').forEach((e) => e.remove());
    if (!menuItems.size) setCss('zeroHub', null);
  }
  const ensureUiCss = () => setCss('zeroHub', HUB_CSS);
  function messageCard(r: any, extra: Node[], actions: Node[]): HTMLElement {
    return el('div', { class: 'zero-card' },
      el('div', { class: 'zero-card-head' }, el('b', { text: r.author }), el('span', { text: placeName(r) }), el('span', { class: 'zero-sp', text: r.at ? when(r.at) : '' })),
      r.content ? el('div', { class: 'zero-text', text: r.content }) : null,
      ...extra,
      el('div', { class: 'zero-actions' }, ...actions));
  }

  // ================================================================== MessageReminder
  {
    let timer = 0;
    const D = () => (pdata.messageReminder ??= { reminders: [] }) as { reminders: any[] };
    const at9 = (d: Date) => { d.setHours(9, 0, 0, 0); return d.getTime(); };
    // same presets as shared/pluginData.ts reminderDue (this function cannot import it)
    const due = (p: string): number | null => {
      const m = /^(\d{1,4})(m|h|d)$/.exec(p); const now = new Date();
      if (m) return now.getTime() + Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
      if (p === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); return at9(d); }
      if (p === 'monday') { const d = new Date(now); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return at9(d); }
      return null;
    };
    const PRESETS: [string, string][] = [['10m', 'In 10 minutes'], ['1h', 'In 1 hour'], ['3h', 'In 3 hours'], ['tomorrow', 'Tomorrow 9:00'], ['monday', 'Monday 9:00'], ['7d', 'In a week']];
    function add(ref: any, at: number, note: string): void {
      D().reminders.push({ ...ref, id: newId(), due: at, note: note.slice(0, 300), created: Date.now(), done: false });
      saveData('messageReminder'); refreshHub('messageReminder');
      toast('Reminder set for ' + when(at) + '.');
    }
    function ask(ref: { channelId: string; messageId: string }, x: number, y: number): void {
      const msg = readMessage(ref.channelId, ref.messageId);
      if (!msg) { toast('This message is not loaded any more.'); return; }
      const note = el('input', { type: 'text', placeholder: 'Note (optional)', maxLength: 300 });
      const custom = el('input', { type: 'datetime-local' });
      const d = new Date(Date.now() + 3_600_000); d.setSeconds(0, 0);
      custom.value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      const body = el('div', { class: 'zero-ui', style: 'display:flex;flex-direction:column;gap:8px' },
        el('div', { class: 'zero-chips' }, ...PRESETS.map(([p, label]) => el('button', { type: 'button', class: 'zero-btn small', text: label, onclick: () => { closePopup(); add(msg, due(p)!, note.value.trim()); } }))),
        el('div', { class: 'zero-row' }, custom, el('button', { type: 'button', class: 'zero-btn small primary', text: 'Set', onclick: () => {
          const t = new Date(custom.value).getTime();
          if (!Number.isFinite(t) || t < Date.now() + 30_000) { toast('Pick a time in the future.'); return; }
          closePopup(); add(msg, t, note.value.trim());
        } })),
        note);
      popup(x, y, 'Remind me', body);
      note.focus();
    }
    function fire(r: any, late: boolean): void {
      r.done = true; saveData('messageReminder'); refreshHub('messageReminder');
      const text = (r.note ? r.note + ' · ' : '') + r.author + ': ' + (r.content || '(attachment)').slice(0, 140);
      const go = () => { document.dispatchEvent(new CustomEvent('zero:focus')); jump(r); };
      try {
        if ((window as any).Notification?.permission === 'granted') {
          const n = new Notification(late ? 'Reminder (while ZERO was closed)' : 'Reminder', { body: text, tag: 'zero-rem-' + r.id, silent: false });
          n.onclick = () => { go(); n.close(); };
        }
      } catch { /* the in-app toast below is enough */ }
      toast('⏰ ' + text, [
        { label: 'Go to message', run: go },
        { label: 'Snooze 10 min', run: () => { r.done = false; r.due = Date.now() + 600_000; saveData('messageReminder'); refreshHub('messageReminder'); } },
      ], 0);
    }
    let started = 0;
    const check = () => {
      const now = Date.now();
      for (const r of D().reminders) if (!r.done && r.due <= now) fire(r, r.due < started - 60_000);
    };
    const render = (host: HTMLElement) => {
      const list = D().reminders;
      const pending = list.filter((r) => !r.done).sort((a, b) => a.due - b.due);
      const done = list.filter((r) => r.done).sort((a, b) => b.due - a.due).slice(0, 20);
      host.append(el('div', { class: 'zero-muted', text: 'Right-click a message › Remind me. Reminders ring while ZERO is running; one that was due while ZERO was closed rings at the next start.' }));
      if (!pending.length) host.append(el('div', { class: 'zero-empty', text: 'No upcoming reminders.' }));
      for (const r of pending) host.append(messageCard(r, [el('div', {}, el('span', { class: 'zero-tag', text: '⏰ ' + when(r.due) }), r.note ? el('span', { text: '  ' + r.note }) : null)], [
        el('button', { type: 'button', class: 'zero-btn small', text: 'Go to message', onclick: () => jump(r) }),
        el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Delete', onclick: () => { D().reminders = D().reminders.filter((x) => x.id !== r.id); saveData('messageReminder'); renderHub(); } }),
      ]));
      if (done.length) {
        host.append(el('div', { class: 'zero-row' }, el('span', { class: 'zero-muted', style: 'flex:1', text: 'Done' }),
          el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Clear', onclick: () => { D().reminders = D().reminders.filter((x) => !x.done); saveData('messageReminder'); renderHub(); } })));
        for (const r of done) host.append(messageCard(r, [el('span', { class: 'zero-muted', text: 'Rang ' + when(r.due) + (r.note ? ' · ' + r.note : '') })], [el('button', { type: 'button', class: 'zero-btn small', text: 'Go to message', onclick: () => jump(r) })]));
      }
    };
    plugins.messageReminder = {
      start() {
        started = Date.now();
        ensureUiCss();
        addMenu('messageReminder', [{ label: 'Remind me…', run: ask }]);
        addTab('messageReminder', { label: 'Reminders', render });
        window.setTimeout(check, 4000);
        timer = window.setInterval(check, 15_000);
      },
      stop() { clearInterval(timer); removeMenu('messageReminder'); removeTab('messageReminder'); },
    };
  }

  // ================================================================== SmartBookmarks
  {
    const D = () => (pdata.smartBookmarks ??= { collections: ['Saved'], items: [] }) as { collections: string[]; items: any[] };
    let last = 'Saved'; let filter = ''; let query = '';
    function save(ref: { channelId: string; messageId: string }, collection: string): void {
      const msg = readMessage(ref.channelId, ref.messageId);
      if (!msg) { toast('This message is not loaded any more.'); return; }
      const d = D();
      if (!d.collections.includes(collection)) d.collections.push(collection);
      const existing = d.items.find((b) => b.messageId === msg.messageId);
      if (existing) Object.assign(existing, msg, { id: existing.id, saved: existing.saved, collection });
      else d.items.unshift({ ...msg, id: newId(), collection, saved: Date.now() });
      last = collection;
      saveData('smartBookmarks'); refreshHub('smartBookmarks');
      toast(collection === 'Saved' && !existing ? 'Message saved.' : (existing ? 'Moved to ' : 'Saved to ') + collection + '.', [{ label: 'Open', run: () => openHub('smartBookmarks') }]);
    }
    function ask(ref: { channelId: string; messageId: string }, x: number, y: number): void {
      const d = D();
      const name = el('input', { type: 'text', placeholder: 'New collection', maxLength: 40 });
      const create = () => { const n = name.value.trim().replace(/\s+/g, ' ').slice(0, 40); if (!n) return; closePopup(); save(ref, n); };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
      const body = el('div', { class: 'zero-ui', style: 'display:flex;flex-direction:column;gap:8px' },
        el('div', { class: 'zero-chips' }, ...d.collections.map((c) => el('button', { type: 'button', class: 'zero-btn small' + (c === last ? ' primary' : ''), text: c, onclick: () => { closePopup(); save(ref, c); } }))),
        el('div', { class: 'zero-row' }, name, el('button', { type: 'button', class: 'zero-btn small', text: 'Create', onclick: create })));
      popup(x, y, 'Save message to', body);
      (body.querySelector('.primary') as HTMLElement | null)?.focus();
    }
    const matches = (b: any, q: string) => !q || [b.content, b.author, b.collection, placeName(b), ...b.links, ...b.attachments.map((a: any) => a.name)].some((s) => String(s).toLowerCase().includes(q));
    const render = (host: HTMLElement) => {
      const d = D();
      if (filter && !d.collections.includes(filter)) filter = '';
      const search = el('input', { type: 'search', placeholder: 'Search saved messages', value: query });
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
      const draw = () => {
        const q = query.toLowerCase();
        const items = d.items.filter((b) => (!filter || b.collection === filter) && matches(b, q));
        list.replaceChildren();
        if (!items.length) list.append(el('div', { class: 'zero-empty', text: d.items.length ? 'Nothing matches.' : 'Nothing saved yet. Right-click a message › Save message.' }));
        for (const b of items.slice(0, 200)) {
          const move = el('select', { 'aria-label': 'Collection' }, ...d.collections.map((c) => el('option', { value: c, text: c, selected: c === b.collection })));
          move.addEventListener('change', () => { b.collection = move.value; saveData('smartBookmarks'); draw(); });
          const thumbs = b.attachments.filter((a: any) => a.kind === 'image').slice(0, 4).map((a: any) => { const i = el('img', { src: a.url, alt: a.name, loading: 'lazy', referrerPolicy: 'no-referrer' }); i.addEventListener('error', () => i.remove()); return i; });
          const files = b.attachments.filter((a: any) => a.kind !== 'image').map((a: any) => el('span', { class: 'zero-tag', text: (a.kind === 'video' ? '🎞 ' : '📎 ') + a.name }));
          const links = b.links.map((l: string) => el('span', { class: 'zero-tag', title: l, text: '🔗 ' + l.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) }));
          list.append(messageCard(b, [
            thumbs.length ? el('div', { class: 'zero-thumbs' }, ...thumbs) : null,
            files.length || links.length ? el('div', { class: 'zero-chips' }, ...files, ...links) : null,
          ].filter(Boolean) as Node[], [
            el('button', { type: 'button', class: 'zero-btn small', text: 'Go to message', onclick: () => jump(b) }),
            b.content ? el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Copy text', onclick: () => { void navigator.clipboard.writeText(b.content).then(() => toast('Copied.'), () => toast('Could not copy.')); } }) : null,
            move,
            el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Remove', onclick: () => { d.items = d.items.filter((x) => x.id !== b.id); saveData('smartBookmarks'); draw(); } }),
          ].filter(Boolean) as Node[]));
        }
      };
      search.addEventListener('input', () => { query = search.value; draw(); });
      const chips = el('div', { class: 'zero-chips' },
        el('button', { type: 'button', class: 'zero-btn small', 'aria-pressed': String(!filter), text: `All (${d.items.length})`, onclick: () => { filter = ''; renderHub(); } }),
        ...d.collections.map((c) => el('button', { type: 'button', class: 'zero-btn small', 'aria-pressed': String(filter === c), text: `${c} (${d.items.filter((b) => b.collection === c).length})`, onclick: () => { filter = c; renderHub(); } })));
      host.append(search, chips);
      if (filter && filter !== 'Saved') {
        host.append(el('div', { class: 'zero-row' },
          el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Rename collection', onclick: () => {
            const n = (prompt('New name for ' + filter, filter) ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
            if (!n || n === filter || d.collections.includes(n)) return;
            d.collections = d.collections.map((c) => (c === filter ? n : c));
            for (const b of d.items) if (b.collection === filter) b.collection = n;
            filter = n; saveData('smartBookmarks'); renderHub();
          } }),
          el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Delete collection', onclick: () => {
            for (const b of d.items) if (b.collection === filter) b.collection = 'Saved';
            d.collections = d.collections.filter((c) => c !== filter); filter = ''; saveData('smartBookmarks'); renderHub();
            toast('Collection deleted. Its messages moved to Saved.');
          } })));
      }
      host.append(list);
      draw();
      if (query) search.focus();
    };
    plugins.smartBookmarks = {
      start() {
        ensureUiCss();
        addMenu('smartBookmarks', [{ label: 'Save message…', run: ask }]);
        addTab('smartBookmarks', { label: 'Saved', render });
      },
      stop() { removeMenu('smartBookmarks'); removeTab('smartBookmarks'); },
    };
  }

  // ================================================================== QuickNotes
  {
    const D = () => (pdata.quickNotes ??= { notes: [] }) as { notes: any[] };
    let editing: string | null = null; let query = '';
    const title = (n: any) => (String(n.text).split('\n').find((l: string) => l.trim()) ?? '').trim().slice(0, 80) || 'Empty note';
    const render = (host: HTMLElement) => {
      const d = D();
      const cur = editing ? d.notes.find((n) => n.id === editing) : null;
      if (cur) {
        const ta = el('textarea', { value: cur.text, placeholder: 'Write anything: a list, a link, a snippet…', maxLength: 20000, style: 'flex:1;min-height:260px;resize:none' });
        const status = el('span', { class: 'zero-muted', text: 'Saved automatically' });
        ta.addEventListener('input', () => { cur.text = ta.value; cur.updated = Date.now(); saveData('quickNotes'); });
        host.append(
          el('div', { class: 'zero-row' },
            el('button', { type: 'button', class: 'zero-btn small ghost', text: '‹ All notes', onclick: () => { editing = null; if (!cur.text.trim()) d.notes = d.notes.filter((n) => n.id !== cur.id); saveData('quickNotes'); renderHub(); } }),
            el('span', { style: 'flex:1' }),
            el('button', { type: 'button', class: 'zero-btn small', 'aria-pressed': String(cur.pinned), text: cur.pinned ? 'Pinned' : 'Pin', onclick: () => { cur.pinned = !cur.pinned; saveData('quickNotes'); renderHub(); } }),
            el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Copy', onclick: () => { void navigator.clipboard.writeText(cur.text).then(() => toast('Copied.'), () => toast('Could not copy.')); } }),
            el('button', { type: 'button', class: 'zero-btn small danger', text: 'Delete', onclick: () => { d.notes = d.notes.filter((n) => n.id !== cur.id); editing = null; saveData('quickNotes'); renderHub(); } })),
          ta, status);
        ta.focus();
        return;
      }
      editing = null;
      const search = el('input', { type: 'search', placeholder: 'Search notes', value: query });
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      const draw = () => {
        const q = query.toLowerCase();
        const notes = d.notes.filter((n) => !q || n.text.toLowerCase().includes(q)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
        list.replaceChildren();
        if (!notes.length) list.append(el('div', { class: 'zero-empty', text: d.notes.length ? 'Nothing matches.' : 'No notes yet.' }));
        for (const n of notes) {
          const body = String(n.text).split('\n').filter((l: string) => l.trim()).slice(1).join('\n');
          const card = el('div', { class: 'zero-card', role: 'button', tabindex: '0', style: 'cursor:pointer' },
            el('div', { class: 'zero-card-head' }, el('b', { text: (n.pinned ? '📌 ' : '') + title(n) }), el('span', { class: 'zero-sp', text: when(n.updated) })),
            body ? el('div', { class: 'zero-text', style: '-webkit-line-clamp:3', text: body }) : null);
          const open = () => { editing = n.id; renderHub(); };
          card.addEventListener('click', open);
          card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
          list.append(card);
        }
      };
      search.addEventListener('input', () => { query = search.value; draw(); });
      host.append(el('div', { class: 'zero-row' }, search, el('button', { type: 'button', class: 'zero-btn small primary', text: 'New note', onclick: () => {
        if (d.notes.length >= 200) { toast('200 notes is the limit. Delete a few first.'); return; }
        const n = { id: newId(), text: '', pinned: false, updated: Date.now() }; d.notes.unshift(n); editing = n.id; renderHub();
      } })), list);
      draw();
      if (query) search.focus();
    };
    plugins.quickNotes = {
      start() { ensureUiCss(); addTab('quickNotes', { label: 'Notes', render }); },
      stop() { editing = null; removeTab('quickNotes'); },
    };
  }

  // ================================================================== SmartText
  {
    const D = () => (pdata.smartText ??= { snippets: [] }) as { snippets: any[] };
    let editing: string | null = null; let picker: HTMLElement | null = null;
    const composer = (): HTMLElement | null => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.matches?.('[role="textbox"][contenteditable="true"]')) return a;
      return document.querySelector<HTMLElement>('main [role="textbox"][contenteditable="true"], [class*="channelTextArea_"] [role="textbox"][contenteditable="true"]');
    };
    function vars(): Record<string, string> {
      const U = store('UserStore'); const meU = U?.getCurrentUser?.();
      const chId = store('SelectedChannelStore')?.getChannelId?.();
      const ch = chId ? store('ChannelStore')?.getChannel?.(chId) : null;
      const g = ch?.guild_id ? store('GuildStore')?.getGuild?.(ch.guild_id) : null;
      // {user}: the other person in a DM, otherwise the author of the message you are replying to
      const reply = chId ? store('PendingReplyStore')?.getPendingReply?.(chId)?.message?.author : null;
      const other = ch?.type === 1 ? U?.getUser?.(ch.recipients?.[0] ?? ch.getRecipientId?.()) : reply ?? null;
      const now = new Date();
      return {
        me: meU?.globalName ?? meU?.username ?? '',
        user: other ? other.globalName ?? other.username ?? '' : '',
        channel: ch?.name ?? '', server: g?.name ?? '',
        date: now.toLocaleDateString(), time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }
    // same rule as shared/pluginData.ts expandSnippet (this function cannot import it)
    const expand = (text: string, v: Record<string, string>) => text.replace(/\{(\w{1,20})\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(v, k.toLowerCase()) ? v[k.toLowerCase()]! : m));
    function insert(s: any, box: HTMLElement | null): void {
      const target = box ?? composer();
      if (!target) { toast('Click in a message box first.'); return; }
      target.focus();
      const text = expand(s.text, vars());
      // Discord's editor takes pasted text (newlines included) like typed text. Nothing is sent: you press Enter.
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      const ok = target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (ok) document.execCommand('insertText', false, text); // the editor did not take the paste event
      s.uses = (s.uses ?? 0) + 1; saveData('smartText');
    }
    const sorted = () => [...D().snippets].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.uses - a.uses || a.name.localeCompare(b.name));
    function closePicker(): void { picker?.remove(); picker = null; }
    function openPicker(box: HTMLElement | null): void {
      closePicker();
      const all = sorted();
      if (!all.length) { toast('No snippets yet.', [{ label: 'Create one', run: () => openHub('smartText') }]); return; }
      const r = (box ?? document.body).getBoundingClientRect();
      const q = el('input', { type: 'text', placeholder: 'Type to filter, Enter to insert', 'aria-label': 'Filter snippets' });
      const list = el('div', { role: 'listbox', style: 'display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto' });
      let sel = 0; let shown: any[] = [];
      const draw = () => {
        const f = q.value.trim().toLowerCase();
        shown = all.filter((s) => !f || s.name.includes(f) || s.category.toLowerCase().includes(f) || s.text.toLowerCase().includes(f));
        sel = Math.min(sel, Math.max(0, shown.length - 1));
        list.replaceChildren(...shown.map((s, i) => {
          const row = el('div', { role: 'option', 'aria-selected': String(i === sel), class: 'zero-card', style: 'padding:6px 8px;cursor:pointer;gap:2px' + (i === sel ? ';outline:2px solid var(--brand-500,#5865f2)' : '') },
            el('div', { class: 'zero-card-head' }, el('b', { text: (s.favorite ? '★ ' : '') + ';' + s.name }), s.category ? el('span', { class: 'zero-tag', text: s.category }) : null),
            el('div', { class: 'zero-text', style: '-webkit-line-clamp:2;font-size:13px', text: s.text }));
          row.addEventListener('mousedown', (e) => { e.preventDefault(); closePicker(); insert(s, box); });
          return row;
        }));
        if (!shown.length) list.append(el('div', { class: 'zero-muted', text: 'No snippet matches.' }));
      };
      q.addEventListener('input', () => { sel = 0; draw(); });
      q.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); const s = shown[sel]; closePicker(); if (s) insert(s, box); else box?.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); closePicker(); box?.focus(); }
      });
      q.addEventListener('blur', () => window.setTimeout(() => { if (picker && !picker.contains(document.activeElement)) closePicker(); }, 100));
      picker = el('div', { class: 'zero-ui zero-pop', role: 'dialog', 'aria-label': 'Snippets', style: 'width:360px' }, el('div', { class: 'zero-pop-head', text: 'SmartText' }), q, list);
      document.body.append(picker);
      const ph = picker.getBoundingClientRect().height;
      picker.style.left = Math.max(8, Math.min(r.left, innerWidth - 368)) + 'px';
      picker.style.top = Math.max(8, r.top - ph - 8) + 'px';
      draw(); q.focus();
    }
    /** Discord's editor object for a message box (found on the React component that renders it). */
    function editorOf(box: Element): any {
      const k = Object.keys(box).find((x) => x.startsWith('__reactFiber$'));
      let f = k ? (box as any)[k] : null;
      for (let i = 0; i < 20 && f; i++, f = f.return) { const e = f.memoizedProps?.editor; if (e && typeof e.deleteBackward === 'function') return e; }
      return null;
    }
    // ";;" in a message box opens the picker; Ctrl+Shift+Space too.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.matches?.('[role="textbox"][contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); openPicker(t); return; }
      if (e.key !== ';' || e.ctrlKey || e.altKey || e.metaKey) return;
      const s = getSelection();
      if (!s || !s.isCollapsed || !s.anchorNode) return;
      const before = s.anchorNode.nodeType === 3 ? String(s.anchorNode.textContent).slice(0, s.anchorOffset) : '';
      if (!before.endsWith(';')) return;
      e.preventDefault(); e.stopPropagation();
      // Remove the first ";" through Discord's editor itself (a plain DOM edit would be undone by it).
      const ed = editorOf(t);
      if (ed) { try { ed.deleteBackward('character'); } catch { document.execCommand('delete'); } } else document.execCommand('delete');
      openPicker(t);
    };
    const render = (host: HTMLElement) => {
      const d = D();
      const cur = editing === 'new' ? { id: newId(), name: '', category: '', text: '', favorite: false, uses: 0, fresh: true } : d.snippets.find((s) => s.id === editing);
      if (cur) {
        const name = el('input', { type: 'text', value: cur.name, placeholder: 'name (letters, digits, - and _)', maxLength: 32 });
        const cat = el('input', { type: 'text', value: cur.category, placeholder: 'Category (optional)', maxLength: 40, list: 'zero-st-cats' } as any);
        const cats = el('datalist', { id: 'zero-st-cats' }, ...[...new Set(d.snippets.map((s) => s.category).filter(Boolean))].map((c) => el('option', { value: c })));
        const text = el('textarea', { value: cur.text, maxLength: 4000, placeholder: 'Text to insert. Variables: {me} {user} {channel} {server} {date} {time}', style: 'min-height:160px;resize:vertical' });
        const fav = el('input', { type: 'checkbox', checked: cur.favorite, id: 'zero-st-fav' });
        const saveIt = () => {
          const n = name.value.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 32);
          if (!n) { toast('Give the snippet a name.'); name.focus(); return; }
          if (d.snippets.some((s) => s.name === n && s.id !== cur.id)) { toast('Another snippet already uses ;' + n + '.'); return; }
          if (!text.value.trim()) { toast('The snippet is empty.'); text.focus(); return; }
          const next = { id: cur.id, name: n, category: cat.value.trim().slice(0, 40), text: text.value.slice(0, 4000), favorite: fav.checked, uses: cur.uses ?? 0 };
          if ((cur as any).fresh) { if (d.snippets.length >= 300) { toast('300 snippets is the limit.'); return; } d.snippets.push(next); }
          else Object.assign(cur, next);
          editing = null; saveData('smartText'); renderHub();
        };
        host.append(
          el('div', { class: 'zero-row' }, el('button', { type: 'button', class: 'zero-btn small ghost', text: '‹ All snippets', onclick: () => { editing = null; renderHub(); } })),
          name, cat, cats, text,
          el('label', { class: 'zero-row', style: 'gap:8px' }, fav, el('span', { text: 'Favorite (shown first)' })),
          el('div', { class: 'zero-actions' },
            el('button', { type: 'button', class: 'zero-btn primary', text: 'Save', onclick: saveIt }),
            (cur as any).fresh ? null : el('button', { type: 'button', class: 'zero-btn danger', text: 'Delete', onclick: () => { d.snippets = d.snippets.filter((s) => s.id !== cur.id); editing = null; saveData('smartText'); renderHub(); } })));
        name.focus();
        return;
      }
      editing = null;
      host.append(
        el('div', { class: 'zero-muted', text: 'In a message box, type ;; (or Ctrl+Shift+Space) to pick a snippet. It is inserted, never sent: you still press Enter.' }),
        el('div', { class: 'zero-row' }, el('span', { style: 'flex:1' }), el('button', { type: 'button', class: 'zero-btn small primary', text: 'New snippet', onclick: () => { editing = 'new'; renderHub(); } })));
      const all = sorted();
      if (!all.length) host.append(el('div', { class: 'zero-empty', text: 'No snippets yet.' }));
      const groups = new Map<string, any[]>();
      for (const s of all) { const k = s.favorite ? '★ Favorites' : s.category || 'Other'; groups.set(k, [...(groups.get(k) ?? []), s]); }
      for (const [g, items] of groups) {
        host.append(el('div', { class: 'zero-muted', style: 'font-weight:700;text-transform:uppercase', text: g }));
        for (const s of items) {
          const card = el('div', { class: 'zero-card' },
            el('div', { class: 'zero-card-head' }, el('b', { text: ';' + s.name }), s.category && s.favorite ? el('span', { class: 'zero-tag', text: s.category }) : null, el('span', { class: 'zero-sp', text: s.uses ? s.uses + ' uses' : '' })),
            el('div', { class: 'zero-text', style: '-webkit-line-clamp:3', text: s.text }),
            el('div', { class: 'zero-actions' },
              el('button', { type: 'button', class: 'zero-btn small', text: 'Insert', onclick: () => { closeHub(); insert(s, null); } }),
              el('button', { type: 'button', class: 'zero-btn small ghost', text: 'Edit', onclick: () => { editing = s.id; renderHub(); } }),
              el('button', { type: 'button', class: 'zero-btn small ghost', text: s.favorite ? '★ Unfavorite' : '☆ Favorite', onclick: () => { s.favorite = !s.favorite; saveData('smartText'); renderHub(); } })));
          host.append(card);
        }
      }
    };
    plugins.smartText = {
      start() { ensureUiCss(); addTab('smartText', { label: 'Snippets', render }); document.addEventListener('keydown', onKey, true); },
      stop() { editing = null; closePicker(); document.removeEventListener('keydown', onKey, true); removeTab('smartText'); },
    };
  }

  // ================================================================== PrivacyMode
  {
    let s: Settings = {}; let on = false; let badge: HTMLElement | null = null; let watch = 0; let auto = false;
    const NativeN: any = (window as any).Notification;
    function css(): string {
      const blur = 'filter:blur(7px)!important;';
      const sel: string[] = [];
      if (s.names) sel.push('[class*="username_"]', '[class*="nameAndDecorators_"]', '[class*="nameTag_"]', '[class*="repliedMessage_"] [class*="username_"]', '[class*="typing_"]', '[class*="userTag_"]', '[class*="headerText_"] [class*="userTagUsername_"]', '[class*="mention"]', 'a[href^="/channels/@me/"] [class*="name_"]', '[class*="voiceUser_"] [class*="username_"]');
      if (s.avatars) sel.push('img[src*="/avatars/"]', 'img[src*="/guild-avatars/"]', 'img[src*="/embed/avatars/"]', '[class*="avatar_"] img', '[class*="avatarDecoration_"]');
      if (s.messages) sel.push('[id^="message-content-"]', '[class*="repliedTextPreview_"]', '[class*="embedWrapper_"]', '[class*="messageAttachment_"]', '[class*="imageWrapper_"]', '[class*="visualMediaItemContainer_"]', '[class*="threadMessageAccessory_"]');
      if (s.previews) sel.push('[class*="subText_"]', '[class*="activity_"]', '[class*="interactiveSelected_"] [class*="subtext_"]', '[class*="notice_"]');
      const root = 'html[data-zero-privacy] ';
      const reveal = s.hover ? sel.map((x) => root + x + ':hover').join(',') + '{filter:none!important}' : '';
      return (sel.length ? sel.map((x) => root + x).join(',') + '{' + blur + 'transition:filter .1s}' : '') + reveal
        + '.zero-privacy{position:fixed;z-index:100003;top:4px;left:50%;transform:translateX(-50%);padding:3px 10px;border-radius:12px;background:#da373c;color:#fff;font:600 12px var(--font-primary,"gg sans","Segoe UI",sans-serif);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}';
    }
    function set(next: boolean, why: 'key' | 'stream'): void {
      if (next === on) return;
      on = next; auto = next && why === 'stream';
      document.documentElement.toggleAttribute('data-zero-privacy', on);
      badge?.remove(); badge = null;
      if (on) {
        badge = el('div', { class: 'zero-ui zero-privacy', role: 'status', title: 'Click or press Ctrl+Shift+H to turn off', text: '● Privacy mode' + (auto ? ' (sharing your screen)' : '') + ' · Ctrl+Shift+H' });
        badge.addEventListener('click', () => set(false, 'key'));
        document.body.append(badge);
      }
    }
    // While privacy mode is on, desktop notifications show no name and no text.
    function Wrapped(this: any, title: string, opts?: NotificationOptions) {
      if (on && s.notifications) return new NativeN('Discord', { ...opts, body: 'New notification', icon: undefined, image: undefined } as any);
      return new NativeN(title, opts);
    }
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyH') { e.preventDefault(); e.stopPropagation(); set(!on, 'key'); }
    };
    const streamCheck = () => {
      const streaming = !!store('ApplicationStreamingStore')?.getCurrentUserActiveStream?.();
      if (streaming && !on) set(true, 'stream');
      else if (!streaming && on && auto) set(false, 'stream');
    };
    plugins.privacyMode = {
      start(next) {
        s = next;
        setCss('privacyMode', css());
        document.addEventListener('keydown', key, true);
        if (NativeN && s.notifications) {
          Object.setPrototypeOf(Wrapped, NativeN); (Wrapped as any).prototype = NativeN.prototype;
          (window as any).Notification = Wrapped;
        }
        if (s.autoStream) { streamCheck(); watch = window.setInterval(streamCheck, 2000); }
      },
      stop() {
        clearInterval(watch);
        document.removeEventListener('keydown', key, true);
        if ((window as any).Notification === Wrapped) (window as any).Notification = NativeN;
        set(false, 'key'); setCss('privacyMode', null);
      },
    };
  }

  // ------------------------------------------------------------------ lifecycle
  const running = new Map<string, string>(); // id -> settings json
  let wanted: Record<string, Settings> = {};
  let readyTimer = 0;

  function apply(): void {
    for (const [id, sig] of running) {
      if (!wanted[id] || JSON.stringify(wanted[id]) !== sig) {
        try { plugins[id]?.stop(); } catch { /* ignore */ }
        running.delete(id);
      }
    }
    for (const [id, s] of Object.entries(wanted)) {
      if (running.has(id) || !plugins[id]) continue;
      try { plugins[id].start(s); running.set(id, JSON.stringify(s)); } catch { /* broken plugin stays off */ }
    }
  }
  function whenReady(): void {
    clearTimeout(readyTimer);
    if (!Object.keys(wanted).length && !running.size) return;
    const ok = wreq() && store('UserStore')?.getCurrentUser?.() && dispatcher();
    if (ok) { apply(); return; }
    readyTimer = window.setTimeout(whenReady, 1000);
  }

  document.addEventListener('zero:cfg', (e) => {
    let data: any;
    try { data = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
    if (!data || typeof data !== 'object') return;
    wanted = data.plugins && typeof data.plugins === 'object' ? data.plugins : {};
    // Saved data (reminders, notes...) is taken only for a plugin that is not running: a running plugin's own
    // copy is the newer one.
    if (data.data && typeof data.data === 'object') for (const [k, v] of Object.entries(data.data)) if (!running.has(k) && v && typeof v === 'object') pdata[k] = v;
    const g = data.game;
    const nextGame = g && typeof g.id === 'string' && typeof g.name === 'string' ? { id: g.id, name: g.name, start: Number(g.start) || Date.now() } : null;
    const changed = JSON.stringify(nextGame) !== JSON.stringify(game);
    game = nextGame;
    whenReady();
    if (changed) for (const fn of gameListeners) { try { fn(); } catch { /* ignore */ } }
  });
}
