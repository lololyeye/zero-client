/**
 * Files people send in Discord (attachments, images, videos, emojis, stickers) are served from Discord's CDN and
 * media proxy. In a browser, their links open a new tab that shows or downloads the file. ZERO has no tabs, so these
 * URLs are downloaded instead (main/media.ts). Pure functions, shared with the tests.
 */
const MEDIA_HOSTS = /^(?:cdn\.discordapp\.com|media\.discordapp\.net|cdn\.discord\.com|media\.discord\.com|images-ext-\d+\.discordapp\.net)$/i;

/** True for an https URL on Discord's CDN or media proxy. */
export function isDiscordMediaUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && MEDIA_HOSTS.test(u.hostname); } catch { return false; }
}

/** Query keys the media proxy uses to resize or convert a preview. Signed CDN keys (ex, is, hm) are kept. */
const PREVIEW_KEYS = ['width', 'height', 'format', 'quality', 'size', 'animated'];

/**
 * The URL to save: previews from media.discordapp.net are resized and often converted to WebP, so attachments are
 * fetched from cdn.discordapp.com in their original size and format. The signature parameters stay as they are.
 * Anything that is not a Discord media URL returns null.
 */
export function originalMediaUrl(url: string): string | null {
  if (!isDiscordMediaUrl(url)) return null;
  const u = new URL(url);
  if (/^media\.discord(app)?\.(net|com)$/i.test(u.hostname) && /^\/(ephemeral-)?attachments\//.test(u.pathname)) {
    u.hostname = 'cdn.discordapp.com';
    for (const k of PREVIEW_KEYS) u.searchParams.delete(k);
  }
  return u.toString();
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/** Label for the save item of the right-click menu. */
export function saveLabel(kind: MediaKind): string {
  return kind === 'image' ? 'Save image' : kind === 'video' ? 'Save video' : kind === 'audio' ? 'Save audio' : 'Save file';
}
