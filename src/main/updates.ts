/**
 * Pure helpers for ZERO's in-app updater (src/main/updater.ts). No Electron imports: unit-tested in Node.
 */
import { compareVersions, type FullTarget, type ReleaseNotes, type UpdateKind } from '../shared/hotUpdate';

export { compareVersions, REPO } from '../shared/hotUpdate';
export const RELEASES_PAGE = 'https://github.com/lololyeye/zero-client/releases/latest';

/** handoff: a verified Linux package was opened in the system's package installer; the user finishes there. */
export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'verifying' | 'installing' | 'handoff' | 'error' | 'unsupported';
export interface UpdateProgress { percent: number; transferred: number; total: number; bytesPerSecond: number; etaSeconds: number | null }
export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  latest: string | null;
  releaseDate: string | null;
  notes: ReleaseNotes | null;
  /** quick: only ZERO's code is downloaded and ZERO restarts on it. full: the Electron runtime changed, the installer runs silently. */
  kind: UpdateKind | null;
  /** How a full update is applied (installer, AppImage swap, .deb or .rpm through the system installer). */
  via: FullTarget | null;
  /** Download size in bytes. */
  size: number | null;
  progress: UpdateProgress | null;
  /** Human-readable problem, shown with a Retry button. */
  error: string | null;
  /** Transient note while the updater recovers on its own (e.g. reconnecting). */
  notice: string | null;
  checkedAt: number | null;
  /** Set on the first launch after a successful update. */
  justUpdated: string | null;
  /** The notes of that update, for the "What's new" screen. */
  whatsNew: ReleaseNotes | null;
  /** Set on the first launch after an update that did not take effect. */
  failedTo: string | null;
}

export const initialState = (current: string): UpdateState => ({
  phase: 'idle', current, latest: null, releaseDate: null, notes: null, kind: null, via: null, size: null, progress: null, error: null, notice: null,
  checkedAt: null, justUpdated: null, whatsNew: null, failedTo: null,
});

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
  return /net::|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|aborted|premature close|timed? ?out|fetch failed/i.test(message);
}

export function friendlyError(message: string): string {
  if (/sha512|checksum|integrity|size mismatch/i.test(message)) return 'The download did not match the signed release, so it was discarded. Nothing was changed.';
  if (/signature|manifest/i.test(message)) return 'The update information could not be verified, so it was ignored. Nothing was changed.';
  if (isNetworkError(message)) return 'The connection was lost. Check your internet connection, then retry.';
  if (/ENOSPC/i.test(message)) return 'There is not enough disk space to download the update.';
  if (/HTTP 404/i.test(message)) return 'No update package was found for this release.';
  return 'The update could not be completed. Your current version is untouched.';
}

/** What the next launch should report, given the update the previous run started. */
export function resolvePending(pending: { target: string } | null, current: string): { justUpdated: string | null; failedTo: string | null } {
  if (!pending) return { justUpdated: null, failedTo: null };
  return compareVersions(current, pending.target) >= 0 ? { justUpdated: current, failedTo: null } : { justUpdated: null, failedTo: pending.target };
}

/** Human size: "640 KB", "1.4 MB", "116 MB". */
export function formatBytes(b: number): string {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  const mb = b / 1048576;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Files in the updates folder that can go: everything except the package in use and the one boot.json names. */
export function staleFiles(files: string[], keep: (string | null)[]): string[] {
  const k = new Set(keep.filter(Boolean));
  return files.filter((f) => f !== 'boot.json' && !k.has(f) && /^ZERO-(?:(?:app|Setup)-[\d.]+\.(?:asar|exe)|[\d.]+-(?:x86_64\.AppImage|amd64\.deb|x86_64\.rpm))(?:\.part)?$/.test(f));
}
