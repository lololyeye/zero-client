import { promises as fs } from 'node:fs';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { Logger } from './logger';
import {
  etaSeconds, friendlyError, initialState, isNetworkError, notesToLines, resolvePending, shouldPrompt,
  type Snooze, type UpdateState,
} from './updates';

/**
 * In-app updater built on electron-updater (the updater made for electron-builder's NSIS installer):
 *  - reads the release's latest.yml from GitHub over HTTPS,
 *  - downloads the installer in the background (differential when a blockmap allows it),
 *  - verifies its SHA-512 against latest.yml before it may run (a mismatch deletes it),
 *  - runs it silently in place (same install folder, user data untouched) and relaunches ZERO,
 *  - on the next launch, checks that the new version is the one running.
 * Progress shown to the user comes only from these real events.
 */
interface Persisted { pending: { target: string; from: string; at: number } | null; snooze: Snooze | null }

export interface UpdaterOptions {
  current: string;
  /** Only packaged builds can update (a dev run has no installer to replace). */
  enabled: boolean;
  log: Logger;
  stateFile: string;
  onState(s: UpdateState): void;
  /** A version worth showing the user is available (respects "Remind me later"). */
  onPrompt(s: UpdateState): void;
  /** Called right before ZERO quits for the installer: flush settings, let windows close. */
  beforeInstall(): Promise<void>;
}

const SNOOZE_MS = 24 * 3600_000;
const RETRY_DELAYS = [3000, 8000, 20000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createUpdater(o: UpdaterOptions) {
  let state = initialState(o.current);
  let persisted: Persisted = { pending: null, snooze: null };
  let busy = false; // one check/download/install at a time
  let downloadedVersion: string | null = null;

  const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; o.onState(state); };
  const save = () => fs.writeFile(o.stateFile, JSON.stringify(persisted), 'utf8').catch((e) => o.log.warn('updater state not saved', e));

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.disableWebInstaller = true; // full installer only
  autoUpdater.logger = {
    info: (m: unknown) => o.log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => o.log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => o.log.error(`updater: ${String(m)}`),
    debug: () => undefined,
  };

  const describe = (info: UpdateInfo) => ({ latest: info.version, releaseDate: info.releaseDate ?? null, notes: notesToLines(info.releaseNotes) });
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const done = p.total > 0 && p.transferred >= p.total;
    set({
      phase: done ? 'verifying' : 'downloading', notice: null,
      progress: { percent: Math.min(100, p.percent), transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond, etaSeconds: etaSeconds(p.transferred, p.total, p.bytesPerSecond) },
    });
  });

  /** Reads what the previous run left: a started update (to verify) and a snoozed version. */
  async function init() {
    try { persisted = { ...persisted, ...JSON.parse(await fs.readFile(o.stateFile, 'utf8')) }; } catch { /* first run */ }
    const r = resolvePending(persisted.pending, o.current);
    if (persisted.pending) {
      if (r.justUpdated) o.log.info(`update verified: now running ${o.current} (was ${persisted.pending.from})`);
      else o.log.warn(`update to ${persisted.pending.target} did not take effect; still running ${o.current}`);
      persisted.pending = null;
      await save();
    }
    set({ ...r, phase: o.enabled ? 'idle' : 'unsupported' });
  }

  async function check(manual: boolean): Promise<UpdateState> {
    if (!o.enabled) { set({ phase: 'unsupported' }); return state; }
    if (busy) return state;
    busy = true;
    set({ phase: 'checking', error: null, notice: null });
    try {
      const r = await autoUpdater.checkForUpdates();
      const info = r?.updateInfo;
      if (info && r?.isUpdateAvailable) {
        set({ phase: 'available', progress: null, checkedAt: Date.now(), ...describe(info) });
        if (manual || shouldPrompt(info.version, o.current, persisted.snooze, Date.now())) o.onPrompt(state);
      } else {
        set({ phase: 'latest', latest: info?.version ?? o.current, checkedAt: Date.now(), notes: [] });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      o.log.warn('update check failed', err);
      set({ phase: manual ? 'error' : 'idle', error: manual ? friendlyError(msg).replace('The update could not be completed.', 'Could not check for updates.') : null, checkedAt: Date.now() });
    } finally { busy = false; }
    return state;
  }

  /** Download (with automatic retries on network loss), verify, then install in place and relaunch. */
  async function install(): Promise<void> {
    if (!o.enabled || busy || !state.latest || (state.phase !== 'available' && state.phase !== 'error')) return;
    busy = true;
    const target = state.latest;
    try {
      if (downloadedVersion !== target) {
        for (let attempt = 0; ; attempt++) {
          set({ phase: 'downloading', error: null, notice: attempt ? 'Reconnecting…' : null, progress: state.progress && attempt ? state.progress : { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, etaSeconds: null } });
          try {
            await autoUpdater.downloadUpdate(); // resolves only after the SHA-512 check passed
            downloadedVersion = target;
            break;
          } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            o.log.warn(`update download failed (attempt ${attempt + 1})`, err);
            if (!isNetworkError(msg) || attempt >= RETRY_DELAYS.length) throw err;
            const wait = RETRY_DELAYS[attempt]!;
            set({ notice: `Connection lost. Retrying in ${Math.round(wait / 1000)} s…` });
            await sleep(wait);
          }
        }
      }
      set({ phase: 'installing', notice: null, error: null });
      persisted.pending = { target, from: o.current, at: Date.now() };
      await save();
      await o.beforeInstall();
      o.log.info(`installing ${target} in place and relaunching`);
      await o.log.flush();
      autoUpdater.quitAndInstall(true, true); // silent NSIS install into the existing folder, then start ZERO
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (persisted.pending) { persisted.pending = null; await save(); }
      set({ phase: 'error', error: friendlyError(msg), notice: null });
      busy = false;
    }
  }

  async function remindLater() {
    if (!state.latest) return;
    persisted.snooze = { version: state.latest, until: Date.now() + SNOOZE_MS };
    await save();
  }

  /** The "updated" / "did not take effect" note is shown once. */
  function acknowledge() { if (state.justUpdated || state.failedTo) set({ justUpdated: null, failedTo: null }); }

  return { init, check, install, remindLater, acknowledge, get state() { return state; }, get busy() { return busy; } };
}
