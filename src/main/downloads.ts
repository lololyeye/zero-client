import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Download } from '../shared/pluginData';

/**
 * DownloadManager: files downloaded from the Discord window. The page sees names, sizes and states only, never a
 * path. It can ask to cancel, show a file in its folder, or open it, and only pictures, video, sound, PDF and text
 * open directly (never a program or script). Removing an entry never deletes the file.
 */
export const OPENABLE = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|mkv|mp3|ogg|wav|flac|m4a|opus|pdf|txt|md|log|csv)$/i;

/** "photo.png" → "photo (1).png" when the name is taken. */
export function uniqueName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) { const n = `${stem} (${i})${ext}`; if (!taken(n)) return n; }
  return `${stem} (${Date.now()})${ext}`;
}

/** Windows-safe file name from a server-provided one. */
export function safeFileName(name: string): string {
  // oxlint-disable-next-line no-control-regex
  const n = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 200);
  return !n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n) ? 'download' : n;
}

export interface PageDownload { id: string; name: string; bytes: number; received: number; state: string; at: number; canOpen: boolean }

interface Deps {
  enabled(): boolean;
  folder(): 'ask' | 'downloads';
  data: { get(): { items: Download[] }; set(d: { items: Download[] }): void };
  send(list: PageDownload[]): void;
  warn(msg: string, err?: unknown): void;
}

export function createDownloads(deps: Deps) {
  const live = new Map<string, { item: DownloadItem; name: string; at: number }>();
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function list(): PageDownload[] {
    const out: PageDownload[] = [...live].map(([id, l]) => ({ id, name: l.name, bytes: l.item.getTotalBytes(), received: l.item.getReceivedBytes(), state: l.item.getState() === 'interrupted' ? 'interrupted' : 'progressing', at: l.at, canOpen: false }));
    for (const d of deps.data.get().items) {
      const there = d.state === 'done' && existsSync(d.path);
      out.push({ id: d.id, name: d.name, bytes: d.bytes, received: d.bytes, state: d.state === 'done' && !there ? 'missing' : d.state, at: d.at, canOpen: there && OPENABLE.test(d.path) });
    }
    return out;
  }
  const push = () => { if (deps.enabled()) deps.send(list()); };

  function attach(ses: Session, ours: (wc: WebContents) => boolean): void {
    ses.on('will-download', (_e, item, wc) => {
      if (!deps.enabled() || !wc || !ours(wc)) return;
      const id = newId();
      const name = safeFileName(item.getFilename());
      if (deps.folder() === 'downloads') {
        const dir = app.getPath('downloads');
        item.setSavePath(path.join(dir, uniqueName(name, (n) => existsSync(path.join(dir, n)))));
      }
      live.set(id, { item, name, at: Date.now() });
      push();
      let last = 0;
      item.on('updated', () => { if (Date.now() - last > 500) { last = Date.now(); push(); } });
      item.once('done', (_ev, state) => {
        live.delete(id);
        const p = item.getSavePath();
        if (p) { // empty when the save dialog was cancelled
          const d = deps.data.get();
          const entry: Download = { id, name: path.basename(p) || name, bytes: item.getTotalBytes() || item.getReceivedBytes(), state: state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed', at: Date.now(), path: p };
          deps.data.set({ items: [entry, ...d.items.filter((x) => x.id !== id)].slice(0, 100) });
        }
        push();
      });
    });
  }

  async function act(action: string, id: string): Promise<void> {
    const find = () => deps.data.get().items.find((x) => x.id === id);
    try {
      if (action === 'folder') await shell.openPath(app.getPath('downloads'));
      else if (action === 'cancel') live.get(id)?.item.cancel();
      else if (action === 'show') { const d = find(); if (d && existsSync(d.path)) shell.showItemInFolder(d.path); }
      else if (action === 'open') { const d = find(); if (d && d.state === 'done' && OPENABLE.test(d.path) && existsSync(d.path)) await shell.openPath(d.path); }
      else if (action === 'remove') deps.data.set({ items: deps.data.get().items.filter((x) => x.id !== id) });
      else if (action === 'clear') deps.data.set({ items: [] });
    } catch (err) { deps.warn(`download action ${action} failed`, err); }
    push();
  }

  return { attach, act, push };
}
