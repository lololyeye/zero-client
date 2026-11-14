/**
 * Pure helpers for ZERO's in-app updater (src/main/updater.ts). No Electron imports: unit-tested in Node.
 */
export const REPO = 'lololyeye/zero-client';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'verifying' | 'installing' | 'error' | 'unsupported';
export interface UpdateProgress { percent: number; transferred: number; total: number; bytesPerSecond: number; etaSeconds: number | null }
export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  latest: string | null;
  releaseDate: string | null;
  notes: string[];
  progress: UpdateProgress | null;
  /** Human-readable problem, shown with a Retry button. */
  error: string | null;
  /** Transient note while the updater recovers on its own (e.g. reconnecting). */
  notice: string | null;
  checkedAt: number | null;
  /** Set on the first launch after a successful update. */
  justUpdated: string | null;
  /** Set on the first launch after an update that did not take effect. */
  failedTo: string | null;
}

export const initialState = (current: string): UpdateState => ({
  phase: 'idle', current, latest: null, releaseDate: null, notes: [], progress: null, error: null, notice: null, checkedAt: null, justUpdated: null, failedTo: null,
});

/** Compare dotted versions ("v0.10.1" > "0.9.9"); pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/**
 * Release notes arrive as HTML (GitHub feed), Markdown or a list of per-version notes. They become a few plain text
 * lines: no markup is ever rendered, so a release body cannot inject anything into ZERO's UI.
 */
export function notesToLines(notes: unknown, max = 8): string[] {
  let text = '';
  if (typeof notes === 'string') text = notes;
  else if (Array.isArray(notes)) text = notes.map((n) => (typeof n?.note === 'string' ? n.note : '')).join('\n');
  const lines = text
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim())
    .filter((l) => l && !/^#+\s*$/.test(l) && !/download .*setup.*\.exe/i.test(l));
  return lines.map((l) => l.replace(/^#+\s*/, '')).slice(0, max).map((l) => (l.length > 160 ? l.slice(0, 157) + '…' : l));
}

/** Seconds left at the current speed, or null while the speed is unknown. */
export function etaSeconds(transferred: number, total: number, bytesPerSecond: number): number | null {
  if (!(bytesPerSecond > 0) || !(total > 0)) return null;
  return Math.max(0, Math.round((total - transferred) / bytesPerSecond));
}

export interface Snooze { version: string; until: number }

/** Automatic prompts skip a version the user postponed until the snooze ends. Manual checks always show it. */
export function shouldPrompt(latest: string | null, current: string, snooze: Snooze | null, now: number): boolean {
  if (!latest || compareVersions(latest, current) <= 0) return false;
  return !(snooze && snooze.version === latest && now < snooze.until);
}

/** Network problems are retried automatically; anything else (e.g. a checksum mismatch) waits for the user. */
export function isNetworkError(message: string): boolean {
  return /net::|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|aborted|premature close|timed? ?out/i.test(message);
}

export function friendlyError(message: string): string {
  if (/sha512|checksum|integrity/i.test(message)) return 'The download did not match the published checksum, so it was discarded. Nothing was installed.';
  if (isNetworkError(message)) return 'The connection was lost. Check your internet connection, then retry.';
  if (/ENOSPC/i.test(message)) return 'There is not enough disk space to download the update.';
  if (/404|Cannot find .*latest\.yml|No published versions/i.test(message)) return 'No update package was found for this release.';
  return 'The update could not be completed. Your current version is untouched.';
}

/** What the next launch should report, given the update the previous run started. */
export function resolvePending(pending: { target: string } | null, current: string): { justUpdated: string | null; failedTo: string | null } {
  if (!pending) return { justUpdated: null, failedTo: null };
  return compareVersions(current, pending.target) >= 0 ? { justUpdated: current, failedTo: null } : { justUpdated: null, failedTo: pending.target };
}
