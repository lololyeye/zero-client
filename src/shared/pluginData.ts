/**
 * Data kept by built-in plugins across restarts (reminders, saved messages, notes, text snippets).
 *
 * The Discord page can only write the PAGE_DATA_PLUGINS documents (stream presets are written by ZERO's own screen
 * picker only), and every write goes through the sanitizers below:
 * fixed fields, plain strings with length limits, ids made of digits, Discord CDN links only, and a cap on the
 * number of entries. Nothing here is code, and nothing here is ever account data (no tokens, no cookies).
 */

export const DATA_PLUGINS = ['messageReminder', 'smartBookmarks', 'quickNotes', 'smartText', 'voiceAnalytics', 'micStudio', 'streamPresets'] as const;
export type DataPlugin = (typeof DATA_PLUGINS)[number];
/** What the Discord page may write. streamPresets is written only by ZERO's screen picker. */
export const PAGE_DATA_PLUGINS = ['messageReminder', 'smartBookmarks', 'quickNotes', 'smartText', 'voiceAnalytics', 'micStudio'] as const;
export type PageDataPlugin = (typeof PAGE_DATA_PLUGINS)[number];
export const isDataPlugin = (id: unknown): id is PageDataPlugin => typeof id === 'string' && (PAGE_DATA_PLUGINS as readonly string[]).includes(id);

/** Largest document the page may send (characters of JSON). */
export const MAX_DOC_CHARS = 1_500_000;

export interface MessageRef {
  channelId: string;
  guildId: string | null;
  messageId: string;
  author: string;
  authorId: string | null;
  content: string;
  /** message creation time (ms) */
  at: number;
}
export interface Attachment { name: string; url: string; kind: 'image' | 'video' | 'file' }

export interface Reminder extends MessageRef { id: string; due: number; note: string; created: number; done: boolean }
export interface Bookmark extends MessageRef { id: string; collection: string; saved: number; attachments: Attachment[]; links: string[] }
export interface Note { id: string; text: string; pinned: boolean; updated: number }
export interface Snippet { id: string; name: string; category: string; text: string; favorite: boolean; uses: number }

/** One finished call, summarized (VoiceAnalytics). No audio, no participants. */
export interface CallSummary {
  id: string; start: number; end: number; place: string;
  pingAvg: number | null; pingMax: number | null; lossAvg: number | null; lossMax: number | null;
  /** voice server regions used, in order (e.g. "rotterdam") */
  servers: string[]; disconnects: number; reconnects: number;
}
/** A saved copy of Discord's voice settings (MicStudio). */
export interface MicProfile {
  id: string; name: string; inputDeviceId: string; inputDeviceName: string; inputVolume: number;
  mode: 'VOICE_ACTIVITY' | 'PUSH_TO_TALK'; threshold: number; autoThreshold: boolean;
  echoCancellation: boolean; noiseSuppression: boolean; automaticGainControl: boolean; noiseCancellation: boolean;
}
/** ZERO's screen picker: a source remembered by kind and name, and whether sound is shared. */
export interface StreamSource { kind: 'screen' | 'window'; source: string; audio: boolean }
export interface StreamPreset extends StreamSource { id: string; name: string }

export interface PluginData {
  messageReminder: { reminders: Reminder[] };
  smartBookmarks: { collections: string[]; items: Bookmark[] };
  quickNotes: { notes: Note[] };
  smartText: { snippets: Snippet[] };
  voiceAnalytics: { calls: CallSummary[] };
  micStudio: { profiles: MicProfile[] };
  streamPresets: { presets: StreamPreset[]; last: StreamSource | null };
}

const SNOWFLAKE = /^\d{15,22}$/;
const ID = /^[\w-]{1,40}$/;
const CDN = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s"'<>\\]{1,1500}$/;
const LINK = /^https?:\/\/[^\s"'<>\\]{1,1500}$/;

// Control characters are stripped on purpose (tabs and newlines kept).
const str = (v: unknown, max: number, fallback = ''): string =>
  // oxlint-disable-next-line no-control-regex
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : fallback;
const line = (v: unknown, max: number, fallback = ''): string => str(v, max, fallback).replace(/[\r\n\t]+/g, ' ').trim() || fallback;
const time = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : fallback;
const snow = (v: unknown): string | null => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const list = <T>(v: unknown, max: number, fn: (x: any) => T | null): T[] => {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (out.length >= max) break;
    const y = fn(x);
    const key = (y as any)?.id;
    if (y === null || (typeof key === 'string' && seen.has(key))) continue;
    if (typeof key === 'string') seen.add(key);
    out.push(y);
  }
  return out;
};

function messageRef(x: any): MessageRef | null {
  const channelId = snow(x?.channelId), messageId = snow(x?.messageId);
  if (!channelId || !messageId) return null;
  return {
    channelId, messageId,
    guildId: snow(x?.guildId),
    author: line(x?.author, 100, 'Unknown'),
    authorId: snow(x?.authorId),
    content: str(x?.content, 4000),
    at: time(x?.at),
  };
}

function reminder(x: any): Reminder | null {
  const ref = messageRef(x); const rid = id(x?.id); const due = time(x?.due);
  if (!ref || !rid || !due) return null;
  return { ...ref, id: rid, due, note: line(x?.note, 300), created: time(x?.created, due), done: x?.done === true };
}

function attachment(x: any): Attachment | null {
  const url = typeof x?.url === 'string' && CDN.test(x.url) ? x.url : null;
  if (!url) return null;
  const kind = x?.kind === 'image' || x?.kind === 'video' ? x.kind : 'file';
  return { name: line(x?.name, 200, 'file'), url, kind };
}

const collectionName = (v: unknown): string => line(v, 40);

function bookmark(x: any): Bookmark | null {
  const ref = messageRef(x); const bid = id(x?.id);
  if (!ref || !bid) return null;
  return {
    ...ref, id: bid,
    collection: collectionName(x?.collection) || 'Saved',
    saved: time(x?.saved, Date.now()),
    attachments: list(x?.attachments, 10, attachment),
    links: list(x?.links, 10, (l) => (typeof l === 'string' && LINK.test(l) ? l : null)),
  };
}

function note(x: any): Note | null {
  const nid = id(x?.id);
  if (!nid) return null;
  return { id: nid, text: str(x?.text, 20_000), pinned: x?.pinned === true, updated: time(x?.updated, Date.now()) };
}

function snippet(x: any): Snippet | null {
  const sid = id(x?.id); const name = line(x?.name, 32).toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!sid || !name) return null;
  const uses = typeof x?.uses === 'number' && Number.isFinite(x.uses) && x.uses > 0 ? Math.min(1e9, Math.floor(x.uses)) : 0;
  return { id: sid, name, category: line(x?.category, 40), text: str(x?.text, 4000), favorite: x?.favorite === true, uses };
}

const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100_000 ? Math.round(v) : null);
const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 100) / 100 : null);
const clampNum = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function call(x: any): CallSummary | null {
  const cid = id(x?.id); const start = time(x?.start); const end = time(x?.end);
  if (!cid || !start || !end || end < start) return null;
  return {
    id: cid, start, end, place: line(x?.place, 100),
    pingAvg: ms(x?.pingAvg), pingMax: ms(x?.pingMax), lossAvg: pct(x?.lossAvg), lossMax: pct(x?.lossMax),
    servers: list(x?.servers, 10, (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : null)),
    disconnects: Math.round(clampNum(x?.disconnects, 0, 10_000, 0)), reconnects: Math.round(clampNum(x?.reconnects, 0, 10_000, 0)),
  };
}

function micProfile(x: any): MicProfile | null {
  const pid = id(x?.id); const name = line(x?.name, 40);
  if (!pid || !name) return null;
  return {
    id: pid, name,
    inputDeviceId: line(x?.inputDeviceId, 200, 'default'), inputDeviceName: line(x?.inputDeviceName, 120),
    inputVolume: clampNum(x?.inputVolume, 0, 200, 100),
    mode: x?.mode === 'PUSH_TO_TALK' ? 'PUSH_TO_TALK' : 'VOICE_ACTIVITY',
    threshold: clampNum(x?.threshold, -100, 0, -60), autoThreshold: x?.autoThreshold !== false,
    echoCancellation: x?.echoCancellation !== false, noiseSuppression: x?.noiseSuppression === true,
    automaticGainControl: x?.automaticGainControl !== false, noiseCancellation: x?.noiseCancellation === true,
  };
}

function streamSource(x: any): StreamSource | null {
  const kind = x?.kind === 'window' ? 'window' : x?.kind === 'screen' ? 'screen' : null;
  const source = line(x?.source, 200);
  return kind && source ? { kind, source, audio: x?.audio === true } : null;
}
function streamPreset(x: any): StreamPreset | null {
  const s = streamSource(x); const pid = id(x?.id); const name = line(x?.name, 40);
  return s && pid && name ? { ...s, id: pid, name } : null;
}

export function emptyData<K extends DataPlugin>(k: K): PluginData[K] {
  const e: PluginData = {
    messageReminder: { reminders: [] },
    smartBookmarks: { collections: ['Saved'], items: [] },
    quickNotes: { notes: [] },
    smartText: { snippets: [] },
    voiceAnalytics: { calls: [] },
    micStudio: { profiles: [] },
    streamPresets: { presets: [], last: null },
  };
  return e[k];
}

/** Validates one plugin document. Anything not matching the schema is dropped, never kept as-is. */
export function sanitizeData<K extends DataPlugin>(k: K, raw: unknown): PluginData[K] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  switch (k) {
    case 'messageReminder': {
      // pending first, then the most recent done ones
      const all = list(r.reminders, 1000, reminder);
      const pending = all.filter((x) => !x.done).slice(0, 500);
      const done = all.filter((x) => x.done).sort((a, b) => b.due - a.due).slice(0, 50);
      return { reminders: [...pending, ...done] } as PluginData[K];
    }
    case 'smartBookmarks': {
      const collections = [...new Set(['Saved', ...(Array.isArray(r.collections) ? r.collections.map(collectionName).filter(Boolean) : [])])].slice(0, 50);
      const items = list(r.items, 2000, bookmark).map((b) => (collections.includes(b.collection) ? b : { ...b, collection: 'Saved' }));
      return { collections, items } as PluginData[K];
    }
    case 'quickNotes': return { notes: list(r.notes, 200, note) } as PluginData[K];
    case 'smartText': return { snippets: list(r.snippets, 300, snippet) } as PluginData[K];
    case 'voiceAnalytics': return { calls: list(r.calls, 200, call) } as PluginData[K];
    case 'micStudio': return { profiles: list(r.profiles, 20, micProfile) } as PluginData[K];
    case 'streamPresets': return { presets: list(r.presets, 20, streamPreset), last: streamSource(r.last) } as PluginData[K];
  }
  return emptyData(k);
}

export function sanitizeAllData(raw: unknown): PluginData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return Object.fromEntries(DATA_PLUGINS.map((k) => [k, sanitizeData(k, r[k])])) as unknown as PluginData;
}

/**
 * SmartText variables. Unknown {names} are left as typed. Values come from the page (who you are talking to,
 * where), never from ZERO's storage.
 */
export function expandSnippet(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w{1,20})\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k.toLowerCase()) ? vars[k.toLowerCase()]! : m));
}

/** Reminder presets → due time. "tomorrow" and "monday" land at 9:00 local time. */
export function reminderDue(preset: string, now = new Date()): number | null {
  const m = /^(\d{1,4})(m|h|d)$/.exec(preset);
  if (m) {
    const n = Number(m[1]); const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    return n > 0 ? now.getTime() + n * unit : null;
  }
  const at9 = (d: Date) => { d.setHours(9, 0, 0, 0); return d.getTime(); };
  if (preset === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); return at9(d); }
  if (preset === 'monday') { const d = new Date(now); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return at9(d); }
  return null;
}
