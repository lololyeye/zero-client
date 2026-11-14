import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';

/**
 * A sandboxed page layered over the Discord window (same pattern as ZERO settings and the screen picker).
 * Created on open, destroyed on close: it costs nothing while hidden.
 */
export function createOverlay(o: { window(): BrowserWindow | null; preload: string; page: string; guard(wc: WebContents): void; onClosed?(): void }) {
  let view: WebContentsView | null = null;

  function fit() {
    const win = o.window();
    if (!view || !win) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: width!, height: height! });
  }

  function open() {
    const win = o.window();
    if (!win || win.isDestroyed()) return;
    if (view) { win.contentView.addChildView(view); view.webContents.focus(); return; } // already open: bring to front
    const v = new WebContentsView({ webPreferences: { preload: o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    view = v;
    v.setBackgroundColor('#00000000');
    o.guard(v.webContents);
    v.webContents.on('render-process-gone', () => { if (view === v) close(); });
    win.contentView.addChildView(v);
    fit();
    void v.webContents.loadFile(o.page).then(() => v.webContents.focus());
  }

  function close() {
    const v = view;
    if (!v) return;
    view = null;
    const win = o.window();
    if (win && !win.isDestroyed()) { win.contentView.removeChildView(v); win.webContents.focus(); }
    if (!v.webContents.isDestroyed()) v.webContents.close();
    o.onClosed?.();
  }

  return { open, close, fit, get webContents() { return view && !view.webContents.isDestroyed() ? view.webContents : null; } };
}
