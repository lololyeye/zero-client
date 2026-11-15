import { BrowserWindow, screen } from 'electron';

/**
 * VoiceOverlay: a small always-on-top window listing who is in the call. It never takes focus or clicks, loads only
 * ZERO's own page, and gets plain data (names and flags) checked here first.
 */
export interface VoiceUser { name: string; speaking: boolean; mute: boolean; deaf: boolean; me: boolean }
export interface VoiceView { channel: string; users: VoiceUser[] }
export interface OverlaySettings { corner: string; show: string; size: string }

// oxlint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');

/** The page's JSON → a checked view; null when not in a call. */
export function parseVoice(detail: unknown): VoiceView | null {
  if (typeof detail !== 'string' || !detail || detail.length > 8000) return null;
  let r: any; try { r = JSON.parse(detail); } catch { return null; }
  if (!r || !Array.isArray(r.users)) return null;
  const users = r.users.slice(0, 25).map((u: any) => ({ name: clean(u?.name, 32) || 'Someone', speaking: u?.speaking === true, mute: u?.mute === true, deaf: u?.deaf === true, me: u?.me === true }));
  return { channel: clean(r.channel, 60) || 'Voice', users };
}

export const ROW = { small: 22, normal: 28, large: 36 } as const;
const WIDTH = { small: 190, normal: 240, large: 300 } as const;

export function overlayBounds(area: { x: number; y: number; width: number; height: number }, s: OverlaySettings, rows: number) {
  const size = (s.size in ROW ? s.size : 'normal') as keyof typeof ROW;
  const width = WIDTH[size]; const height = ROW[size] * (rows + 1) + 16;
  const m = 12;
  const x = s.corner === 'tr' || s.corner === 'br' ? area.x + area.width - width - m : area.x + m;
  const y = s.corner === 'bl' || s.corner === 'br' ? area.y + area.height - height - m : area.y + m;
  return { x: Math.round(x), y: Math.round(y), width, height };
}

export function createVoiceOverlay(opts: { preload: string; page: string; settings: () => OverlaySettings | null }) {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let view: VoiceView | null = null;

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 240, height: 100, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'ZERO voice overlay',
      webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => { win = null; ready = null; });
    ready = win.loadFile(opts.page).catch(() => undefined);
    return win;
  }

  function render(): void {
    const s = opts.settings();
    const users = view && s ? (s.show === 'speaking' ? view.users.filter((u) => u.speaking) : view.users) : [];
    if (!s || !view || !users.length) { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); return; }
    const w = ensure();
    const area = screen.getPrimaryDisplay().workArea;
    w.setBounds(overlayBounds(area, s, users.length));
    void ready?.then(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('overlay:data', { channel: view?.channel ?? '', users, size: s.size });
      if (!win.isVisible()) win.showInactive();
    });
  }

  return {
    update(detail: unknown) { view = parseVoice(detail); render(); },
    /** settings changed or the plugin was turned off */
    refresh() { render(); },
    destroy() { view = null; if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}
