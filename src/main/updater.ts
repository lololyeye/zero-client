import { app, net } from 'electron';
import ofs from 'original-fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Logger } from './logger';
import {
  etaSeconds, friendlyError, initialState, isNetworkError, resolvePending, shouldPrompt, staleFiles,
  type Snooze, type UpdateState,
} from './updates';
import {
  FEED_URL, MAX_MANIFEST_BYTES, packageUrl, parseManifest, planUpdate,
  type BootInfo, type BootRecord, type Manifest, type ReleaseNotes, type UpdateKind, type UpdatePackage,
} from '../shared/hotUpdate';
import { UPDATE_PUBLIC_KEY } from '../shared/updateKey';

/**
 * ZERO's in-app updater.
 *  - Reads the signed manifest of the latest GitHub release (zero-update.json) over HTTPS and checks its
 *    signature with the key built into ZERO.
 *  - Quick update (same Electron): downloads only ZERO's code (ZERO-app-<v>.asar, under 1 MB), checks its size
 *    and SHA-512 against the manifest, records it for the boot loader (src/boot/index.ts) and restarts ZERO.
 *    No installer runs and the install folder is not touched; the next start runs the new code.
 *  - Full update (the Electron runtime changed): downloads the installer, checks it the same way and runs it
 *    silently into the existing folder; it starts ZERO again when done.
 *  - On the next launch, checks that the new version is the one running, and shows what's new once.
 * Progress shown to the user comes only from the real download.
 */
interface Pending { target: string; from: string; at: number; kind?: UpdateKind; notes?: ReleaseNotes }
interface Persisted { pending: Pending | null; snooze: Snooze | null }

export interface UpdaterOptions {
  boot: BootInfo;
  /** Only packaged builds can update (a dev run has nothing to replace). */
  enabled: boolean;
  log: Logger;
  stateFile: string;
  onState(s: UpdateState): void;
  /** A version worth showing the user is available (respects "Remind me later"). */
  onPrompt(s: UpdateState): void;
  /** Called right before ZERO quits to update: flush settings, let windows close. */
  beforeInstall(): Promise<void>;
}

const SNOOZE_MS = 24 * 3600_000;
const RETRY_DELAYS = [3000, 8000, 20000];
const IDLE_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fsp = ofs.promises;

export function createUpdater(o: UpdaterOptions) {
  const current = o.boot.running;
  const dir = o.boot.dir;
  let state = initialState(current);
  let persisted: Persisted = { pending: null, snooze: null };
  let manifest: Manifest | null = null;
  let manifestRaw: Record<string, unknown> | null = null;
  let busy = false; // one check/download/install at a time

  const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; o.onState(state); };
  const save = () => fsp.writeFile(o.stateFile, JSON.stringify(persisted), 'utf8').catch((e) => o.log.warn('updater state not saved', e));
  const recordFile = path.join(dir, 'boot.json');

  /** Reads what the previous run left: a started update (to verify) and a snoozed version. Cleans old packages. */
  async function init() {
    try { persisted = { ...persisted, ...JSON.parse(await fsp.readFile(o.stateFile, 'utf8')) }; } catch { /* first run */ }
    const p = persisted.pending;
    const r = resolvePending(p, current);
    if (o.boot.rejected) o.log.warn(`app package ${o.boot.rejected} was not used (damaged or failed to start); running the installed ${o.boot.installed}`);
    if (p) {
      if (r.justUpdated) o.log.info(`update verified: now running ${current} (was ${p.from}, ${p.kind ?? 'full'} update)`);
      else o.log.warn(`update to ${p.target} did not take effect; still running ${current}`);
      persisted.pending = null;
      await save();
    }
    set({
      justUpdated: r.justUpdated, whatsNew: r.justUpdated ? (p?.notes ?? null) : null,
      failedTo: r.failedTo ?? (o.boot.rejected && !r.justUpdated ? o.boot.rejected : null),
      phase: o.enabled ? 'idle' : 'unsupported',
    });
    if (o.enabled) void cleanup();
  }

  /** Removes downloads that are no longer needed (old packages, finished installers, partial files). */
  async function cleanup() {
    try {
      let keep: string | null = null;
      try {
        const app = (JSON.parse(await fsp.readFile(recordFile, 'utf8')) as BootRecord).manifest?.app as UpdatePackage | undefined;
        if (typeof app?.file === 'string') keep = app.file;
      } catch { /* no record */ }
      const files = await fsp.readdir(dir).catch(() => [] as string[]);
      for (const f of staleFiles(files, [keep, o.boot.package ? path.basename(o.boot.package) : null])) {
        await fsp.unlink(path.join(dir, f)).catch(() => undefined); // a file still in use stays until next time
      }
    } catch (err) { o.log.warn('update cleanup failed', err); }
  }

  /** The app is running fine on its code: the boot loader's failed-start counter goes back to zero. */
  function markHealthy() {
    if (!o.boot.package) return;
    try {
      const rec = JSON.parse(ofs.readFileSync(recordFile, 'utf8')) as BootRecord;
      if (rec.tries !== 0) ofs.writeFileSync(recordFile, JSON.stringify({ ...rec, tries: 0 }));
    } catch { /* record gone: nothing to reset */ }
  }

  async function fetchManifest(): Promise<{ m: Manifest; raw: Record<string, unknown> }> {
    const url = o.boot.testFeed ? new URL('zero-update.json', o.boot.testFeed).toString() : FEED_URL;
    const res = await net.fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20_000) } as RequestInit);
    if (res.status === 404) throw new Error('HTTP 404: no manifest');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
    const raw = JSON.parse(text);
    const p = parseManifest(raw, UPDATE_PUBLIC_KEY);
    if (!p.ok) throw new Error(p.error);
    return { m: p.manifest, raw };
  }

  async function check(manual: boolean): Promise<UpdateState> {
    if (!o.enabled) { set({ phase: 'unsupported' }); return state; }
    if (busy) return state;
    busy = true;
    set({ phase: 'checking', error: null, notice: null });
    try {
      const { m, raw } = await fetchManifest();
      const kind = planUpdate(m, current, process.versions.electron);
      if (kind) {
        manifest = m; manifestRaw = raw;
        const pkg = kind === 'quick' ? m.app! : m.installer;
        set({ phase: 'available', progress: null, checkedAt: Date.now(), latest: m.version, releaseDate: m.date || null, notes: m.notes, kind, size: pkg.size });
        if (manual || shouldPrompt(m.version, current, persisted.snooze, Date.now())) o.onPrompt(state);
      } else {
        set({ phase: 'latest', latest: m.version, checkedAt: Date.now(), notes: null, kind: null, size: null });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      o.log.warn('update check failed', err);
      set({ phase: manual ? 'error' : 'idle', error: manual ? friendlyError(msg).replace('The update could not be completed.', 'Could not check for updates.') : null, checkedAt: Date.now() });
    } finally { busy = false; }
    return state;
  }

  /** Is this package already downloaded and intact (e.g. after "Update now" was retried)? */
  async function cached(file: string, p: UpdatePackage): Promise<boolean> {
    try {
      const buf = await fsp.readFile(file);
      return buf.length === p.size && createHash('sha512').update(buf).digest('base64') === p.sha512;
    } catch { return false; }
  }

  /** Streams a package to <file>.part, checking size and SHA-512 as it arrives, then moves it into place. */
  async function download(m: Manifest, p: UpdatePackage, file: string): Promise<void> {
    const part = file + '.part';
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(new Error('download timed out')), IDLE_TIMEOUT_MS);
    const fh = await fsp.open(part, 'w');
    try {
      const res = await net.fetch(packageUrl(m, p, o.boot.testFeed), { cache: 'no-store', credentials: 'omit', signal: ctl.signal } as RequestInit);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash('sha512');
      const reader = res.body.getReader();
      let got = 0;
      const start = Date.now();
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idle); idle = setTimeout(() => ctl.abort(new Error('download timed out')), IDLE_TIMEOUT_MS);
        got += value.byteLength;
        if (got > p.size) throw new Error('size mismatch: more data than the signed size');
        hash.update(value);
        await fh.write(value);
        const now = Date.now();
        if (now - lastEmit > 120 || got === p.size) {
          lastEmit = now;
          const bps = got / Math.max(0.25, (now - start) / 1000);
          set({ phase: 'downloading', notice: null, progress: { percent: (got / p.size) * 100, transferred: got, total: p.size, bytesPerSecond: bps, etaSeconds: etaSeconds(got, p.size, bps) } });
        }
      }
      await fh.close();
      set({ phase: 'verifying' });
      if (got !== p.size) throw new Error(`size mismatch: got ${got} of ${p.size} bytes`);
      if (hash.digest('base64') !== p.sha512) throw new Error('sha512 checksum mismatch');
      await fsp.rename(part, file);
    } catch (err) {
      await fh.close().catch(() => undefined);
      await fsp.unlink(part).catch(() => undefined);
      throw err;
    } finally { clearTimeout(idle); }
  }

  /** Download (with automatic retries on network loss), verify, then switch to the new version and restart. */
  async function install(): Promise<void> {
    const m = manifest, raw = manifestRaw, kind = state.kind;
    if (!o.enabled || busy || !m || !raw || !kind || (state.phase !== 'available' && state.phase !== 'error')) return;
    busy = true;
    const pkg = kind === 'quick' ? m.app! : m.installer;
    const file = path.join(dir, pkg.file);
    try {
      await fsp.mkdir(dir, { recursive: true });
      if (await cached(file, pkg)) set({ phase: 'verifying', error: null, notice: null });
      else {
        for (let attempt = 0; ; attempt++) {
          set({ phase: 'downloading', error: null, notice: attempt ? 'Reconnecting…' : null, progress: { percent: 0, transferred: 0, total: pkg.size, bytesPerSecond: 0, etaSeconds: null } });
          try { await download(m, pkg, file); break; }
          catch (err) {
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
      persisted.pending = { target: m.version, from: current, at: Date.now(), kind, notes: m.notes };
      await save();
      if (kind === 'quick') {
        // The boot loader checks this record (signature, Electron version, file hash) on every start.
        const rec: BootRecord = { manifest: raw, tries: 0 };
        await fsp.writeFile(recordFile + '.tmp', JSON.stringify(rec));
        await fsp.rename(recordFile + '.tmp', recordFile);
      }
      await o.beforeInstall();
      o.log.info(kind === 'quick' ? `switching to ${m.version} (app package) and restarting` : `installing ${m.version} silently and restarting`);
      await o.log.flush();
      if (kind === 'quick') {
        app.relaunch();
        app.quit();
      } else {
        // Same arguments electron-builder's own updater passes: update mode, silent, start ZERO when done.
        spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        app.quit();
      }
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
  function acknowledge() { if (state.justUpdated || state.failedTo) set({ justUpdated: null, whatsNew: null, failedTo: null }); }

  return { init, check, install, remindLater, acknowledge, markHealthy, get state() { return state; }, get busy() { return busy; } };
}
