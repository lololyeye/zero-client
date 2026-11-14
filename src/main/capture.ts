import { WebContentsView, desktopCapturer, ipcMain, type BrowserWindow, type WebContents } from 'electron';

/**
 * Discord's web app decides from the user agent whether the browser may Go Live and watch streams.
 * Electron's default UA adds "Electron/x" and the app name, which Discord treats as an unknown browser
 * ("download the app"). This is the plain UA of the Chromium version ZERO actually runs, in Chrome's
 * reduced format (minor/build/patch are always 0.0.0 in real Chrome too).
 */
export function chromeUserAgent(chromeVersion: string, platform = 'Windows NT 10.0; Win64; x64'): string {
  const major = /^\d+/.exec(chromeVersion)?.[0] ?? '0';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export interface PickerSource { id: string; name: string; kind: 'screen' | 'window'; thumb: string; icon: string | null }
export interface PickerChoice { id: string; name: string; audio: boolean }

/** Only sources the picker actually listed can be chosen; everything else is rejected. */
export function resolveChoice(listed: ReadonlyMap<string, string>, id: unknown, audio: unknown, audioRequested: boolean): PickerChoice | null {
  if (typeof id !== 'string' || !listed.has(id)) return null;
  return { id, name: listed.get(id)!, audio: audio === true && audioRequested };
}

interface PickerDeps {
  window(): BrowserWindow | null;
  preload: string;
  page: string;
  guard(wc: WebContents): void;
}

/**
 * Screen-share source picker, shown as a layer inside the Discord window (like ZERO settings).
 * It replaces Chrome's picker, which Electron does not provide. Its page can only list sources and answer once.
 */
export function createPicker(deps: PickerDeps) {
  let view: WebContentsView | null = null;
  let pending: ((c: PickerChoice | null) => void) | null = null;
  let audioRequested = false;
  let listed = new Map<string, string>();

  const fromView = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => !!view && e.sender === view.webContents;

  ipcMain.handle('picker:load', async (e) => {
    if (!fromView(e)) throw new Error('Unauthorized sender');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true });
    const out: PickerSource[] = sources
      .filter((s) => s.id.startsWith('screen:') || !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
    listed = new Map(out.map((s) => [s.id, s.name]));
    return { audioRequested, sources: out };
  });
  ipcMain.on('picker:choose', (e, id: unknown, audio: unknown) => {
    if (!fromView(e)) return;
    finish(id === null ? null : resolveChoice(listed, id, audio, audioRequested));
  });

  function fit() {
    const win = deps.window();
    if (!view || !win) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: width!, height: height! });
  }

  function finish(choice: PickerChoice | null) {
    const done = pending; pending = null;
    const v = view; view = null; listed = new Map();
    const win = deps.window();
    if (v) {
      if (win && !win.isDestroyed()) { win.contentView.removeChildView(v); win.webContents.focus(); }
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    done?.(choice);
  }

  function pick(withAudio: boolean): Promise<PickerChoice | null> {
    if (pending) finish(null); // a new request replaces an unanswered one
    const win = deps.window();
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    audioRequested = withAudio;
    const v = new WebContentsView({ webPreferences: { preload: deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    view = v;
    v.setBackgroundColor('#00000000');
    deps.guard(v.webContents);
    v.webContents.on('render-process-gone', () => { if (view === v) finish(null); });
    win.contentView.addChildView(v);
    fit();
    void v.webContents.loadFile(deps.page).then(() => v.webContents.focus());
    return new Promise((resolve) => { pending = resolve; });
  }

  return { pick, fit, cancel: () => finish(null) };
}
