import { clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { isDiscordMediaUrl, originalMediaUrl, saveLabel, type MediaKind } from '../shared/media';

/**
 * Saving what people send, on Windows and Linux.
 *  - Clicking a file, or the download button of an attachment, asks for a new tab on Discord's CDN. ZERO turns that
 *    into a download (session 'will-download': the save dialog, or the Downloads folder with DownloadManager).
 *  - Electron has no right-click menu of its own. Where Discord leaves the menu to the browser (images and videos in
 *    the media viewer, links, text fields), ZERO shows a small native one: save, copy link, open in the browser,
 *    and cut / copy / paste in text fields. Discord's own menus (messages, users, servers) are untouched.
 * Nothing here reads cookies, tokens or page content: only the URL under the pointer, given by Chromium.
 */
export function download(wc: WebContents, url: string): boolean {
  const target = originalMediaUrl(url);
  if (!target || wc.isDestroyed()) return false;
  wc.downloadURL(target);
  return true;
}

function kindOf(mediaType: string): MediaKind {
  return mediaType === 'image' || mediaType === 'video' || mediaType === 'audio' ? mediaType : 'file';
}

export function attachContextMenu(wc: WebContents, isDiscordPage: (url: string) => boolean): void {
  wc.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    const media = (p.mediaType === 'image' || p.mediaType === 'video' || p.mediaType === 'audio') && /^https:/i.test(p.srcURL) ? p.srcURL : '';
    if (media) {
      const kind = kindOf(p.mediaType);
      if (isDiscordMediaUrl(media)) items.push({ label: `${saveLabel(kind)}…`, click: () => download(wc, media) });
      if (kind === 'image') items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
      items.push({ label: `Copy ${kind} link`, click: () => clipboard.writeText(originalMediaUrl(media) ?? media) });
    }
    const link = /^https:/i.test(p.linkURL) && p.linkURL !== media ? p.linkURL : '';
    if (link) {
      if (items.length) items.push({ type: 'separator' });
      if (isDiscordMediaUrl(link)) items.push({ label: `${saveLabel('file')}…`, click: () => download(wc, link) });
      else if (!isDiscordPage(link)) items.push({ label: 'Open link in browser', click: () => void shell.openExternal(link) });
      items.push({ label: 'Copy link', click: () => clipboard.writeText(link) });
    }
    if (p.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll', enabled: p.editFlags.canSelectAll },
      );
    } else if (p.selectionText.trim()) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}
