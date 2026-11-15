import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Applying a verified full update on Linux. Called only after the package matched the signed size and SHA-512.
 *
 * AppImage: the new file is copied next to the running one, made executable and started once with
 * --zero-selftest (it prints its version and exits before opening anything). Only if that works is the old
 * file kept as <name>.zero-backup and the new one moved into its place, then started. The backup is removed
 * once the new version has started normally, so a broken download can never leave the user without ZERO.
 *
 * .deb / .rpm: ZERO never asks for root itself. The verified package is handed to the system's package
 * installer (Linux Mint: Package Installer; Fedora: Software), which shows what it installs and asks for the
 * password. The update is the user's decision there.
 */

export const BACKUP_SUFFIX = '.zero-backup';

export class UpdateApplyError extends Error {}

/** Runs the new AppImage with --zero-selftest and checks that it reports the expected version. */
export function selfTest(file: string, version: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, ['--zero-selftest'], { timeout: timeoutMs, env: cleanEnv(), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const m = /ZERO-SELFTEST (\S+)/.exec(String(stdout));
      if (m?.[1] === version) return resolve();
      const why = err ? (err.killed ? 'it did not start in time' : (String(stderr).trim().split('\n').pop() || err.message).slice(0, 300)) : `it reported ${m ? `version ${m[1]} instead of ${version}` : 'no version'}`;
      reject(new UpdateApplyError(`The new AppImage could not start on this system (${why}). Your current ZERO is unchanged.`));
    });
  });
}

/** The variables an AppImage runtime sets for its own mount; the next AppImage sets fresh ones. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_SILENT_INSTALL', 'CHROME_DESKTOP']) delete out[k];
  return out;
}

/** Puts a verified AppImage in place of the running one, keeping a backup. Returns the path to start. */
export async function replaceAppImage(downloaded: string, target: string, version: string): Promise<string> {
  const dir = path.dirname(target);
  try { await fsp.access(dir, fsConstants.W_OK); }
  catch { throw new UpdateApplyError(`ZERO cannot write to ${dir}. Move the AppImage to a folder you own (for example ~/Applications), or download the new version from GitHub.`); }
  const fresh = target + '.zero-new';
  const backup = target + BACKUP_SUFFIX;
  await fsp.copyFile(downloaded, fresh);
  await fsp.chmod(fresh, 0o755);
  try { await selfTest(fresh, version); }
  catch (err) { await fsp.unlink(fresh).catch(() => undefined); throw err; }
  await fsp.rm(backup, { force: true });
  await fsp.rename(target, backup);
  try { await fsp.rename(fresh, target); }
  catch (err) { await fsp.rename(backup, target).catch(() => undefined); throw err; } // put the old one back
  return target;
}

/** Starts ZERO again from the given AppImage, detached from this process (which then quits). */
export function startDetached(file: string): void {
  spawn(file, [], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
}

/** Removes the previous AppImage once the new version has started normally. */
export async function dropBackup(target: string | undefined): Promise<void> {
  if (target) await fsp.rm(target + BACKUP_SUFFIX, { force: true }).catch(() => undefined);
}
