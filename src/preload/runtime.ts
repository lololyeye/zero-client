/**
 * ZERO's built-in plugin runtime. It runs in Discord's page world (it has to read Discord's own data: presences,
 * messages, voice state) and is serialized as one self-contained function: it must not reference anything outside
 * its own body. It has no access to ZERO's IPC, files or settings storage: it only receives the list of enabled
 * plugins (and the detected game) as a JSON string event from ZERO's isolated preload, and can only ask for a page
 * reload. It never reads tokens, cookies or credentials. While no plugin is enabled it does nothing at all.
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
  function runDom(): void {
    pending = 0;
    for (const t of domTasks) { try { t(); } catch { /* ignore */ } }
  }
  function schedule(): void { if (!pending) pending = window.setTimeout(runDom, 250); }
  function addDom(task: () => void): void {
    domTasks.add(task);
    if (!observer) {
      observer = new MutationObserver(schedule);
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
      let el = document.querySelector<HTMLElement>('.zero-calltimer');
      const status = document.querySelector('[class*="rtcConnectionStatus_"]');
      if (!ch || !status) { el?.remove(); return; }
      if (!el) {
        let host: Element | null = status;
        for (let i = 0; i < 5 && host && !host.querySelector('a[href^="/channels/"]'); i++) host = host.parentElement;
        el = h('div', 'zero-calltimer');
        (host ?? status.parentElement)?.appendChild(el);
      }
      el.textContent = text(Date.now() - since);
    };
    plugins.callTimer = {
      start(s) {
        fmt = s.format;
        setCss('callTimer', '.zero-calltimer{font-size:12px;line-height:16px;color:var(--text-muted,#949ba4);font-variant-numeric:tabular-nums;margin-top:2px}');
        tick(); timer = window.setInterval(tick, 1000);
      },
      stop() { clearInterval(timer); ch = null; document.querySelector('.zero-calltimer')?.remove(); setCss('callTimer', null); },
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
    const g = data.game;
    const nextGame = g && typeof g.id === 'string' && typeof g.name === 'string' ? { id: g.id, name: g.name, start: Number(g.start) || Date.now() } : null;
    const changed = JSON.stringify(nextGame) !== JSON.stringify(game);
    game = nextGame;
    whenReady();
    if (changed) for (const fn of gameListeners) { try { fn(); } catch { /* ignore */ } }
  });
}
