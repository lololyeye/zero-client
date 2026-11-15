import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';

/**
 * MultiPanel: a second Discord page docked on the right of the window, showing one channel. It is Discord's own web
 * app, like a second browser tab: no ZERO preload runs in it and it gets no IPC. ZERO only adds CSS (the theme, and
 * hiding the server and channel lists) and narrows the main page so both fit side by side.
 */
export const SIDE_PATH = /^\/channels\/(@me|\d{15,22})\/\d{15,22}$/;

const SIDE_CSS = 'nav[class*="guilds_"],[class*="sidebarList_"],[class*="sidebar_"]>[class*="panels_"],section[class*="panels_"]{display:none!important}'
  + '[class*="sidebar_"]:has(>[class*="sidebarList_"]){display:none!important}';

export const mainPageCss = (pct: number) => `#app-mount{position:fixed!important;inset:0 auto 0 0!important;width:${100 - pct}vw!important;transform:translateZ(0)}`;

interface Deps {
  window(): BrowserWindow | null;
  origin(): string;
  percent(): number;
  themeCss(): string;
  guard(wc: WebContents): void;
  onState(path: string): void;
}

export function createSidePanel(deps: Deps) {
  let view: WebContentsView | null = null;
  let path = '';
  let mainKey: string | null = null;
  let mainPct = 0;
  let themeKey: string | null = null;

  function fit(): void {
    const win = deps.window();
    if (!view || !win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize() as [number, number];
    const pct = deps.percent();
    const width = Math.round((w * pct) / 100);
    view.setBounds({ x: w - width, y: 0, width, height: h });
    if (pct !== mainPct) void narrowMain(win, pct);
  }

  async function narrowMain(win: BrowserWindow, pct: number): Promise<void> {
    const wc = win.webContents;
    const old = mainKey; mainKey = null; mainPct = pct;
    if (old) await wc.removeInsertedCSS(old).catch(() => undefined);
    if (view && pct) mainKey = await wc.insertCSS(mainPageCss(pct)).catch(() => null);
  }

  async function styleSide(): Promise<void> {
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const old = themeKey; themeKey = null;
    if (old) await wc.removeInsertedCSS(old).catch(() => undefined);
    themeKey = await wc.insertCSS(SIDE_CSS + '\n' + deps.themeCss()).catch(() => null);
  }

  function open(next: string): void {
    const win = deps.window();
    if (!win || win.isDestroyed() || !SIDE_PATH.test(next)) return;
    if (!view) {
      view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true } });
      view.setBackgroundColor('#1b1e25');
      deps.guard(view.webContents);
      view.webContents.on('dom-ready', () => { themeKey = null; void styleSide(); });
      view.webContents.on('render-process-gone', () => close());
      win.contentView.addChildView(view);
    }
    path = next;
    fit();
    void view.webContents.loadURL(deps.origin() + next);
    deps.onState(path);
  }

  function close(): void {
    const v = view; view = null; path = ''; themeKey = null;
    const win = deps.window();
    if (v) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(v);
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    if (win && !win.isDestroyed() && mainKey) { const k = mainKey; void win.webContents.removeInsertedCSS(k).catch(() => undefined); }
    mainKey = null; mainPct = 0;
    deps.onState('');
  }

  return {
    open, close, fit,
    get path() { return path; },
    owns: (wc: WebContents) => !!view && view.webContents === wc,
    /** the theme changed */
    restyle: () => { if (view) void styleSide(); },
    /** the Discord page reloaded: its inserted CSS is gone */
    reattach: () => { mainKey = null; mainPct = 0; fit(); },
  };
}
