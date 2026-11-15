import { app } from 'electron';
import { readFileSync } from 'node:fs';
import ofs from 'original-fs';
import path from 'node:path';
import { chooseBoot, testFeed, type BootInfo } from '../shared/hotUpdate';
import { UPDATE_PUBLIC_KEY } from '../shared/updateKey';

declare const __ZERO_VERSION__: string;

/**
 * ZERO's entry point. It decides which copy of ZERO's code to start:
 *  - the installed code (resources/app.asar, from the installer), or
 *  - a newer app package that the updater downloaded and verified (<profile>/updates/ZERO-app-<v>.asar).
 * The package is used only under the rules of chooseBoot (signature, version, same Electron, file hash, fewer
 * than three failed starts); otherwise the installed code starts. Files in the updates folder are read with
 * original-fs so that the .asar packages are handled as plain files; package.json lives inside the installed
 * app.asar, so it is read with the regular fs.
 */
const APP_NAME = 'ZERO';
let pkg: Record<string, unknown> = {};
try { pkg = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')); } catch { /* defaults */ }
// Isolated builds for the update lifecycle test set "zeroTestName" (separate profile); real builds never do.
const name = typeof pkg.zeroTestName === 'string' && /^ZERO [\w ]{1,30}$/.test(pkg.zeroTestName) ? pkg.zeroTestName : APP_NAME;
// The profile is fixed here, before anything asks for a path (Electron keeps the first userData it resolves).
app.setName(name);
app.setPath('userData', path.join(app.getPath('appData'), name));
const dir = path.join(app.getPath('userData'), 'updates');
const info: BootInfo = {
  dir, name, installed: __ZERO_VERSION__, running: __ZERO_VERSION__, package: null, rejected: null,
  testFeed: name === APP_NAME ? null : testFeed(pkg.zeroTestFeed),
};
const recordFile = path.join(dir, 'boot.json');
const readRecord = () => { try { return JSON.parse(ofs.readFileSync(recordFile, 'utf8')); } catch { return null; } };
const writeRecord = (r: unknown) => { try { ofs.writeFileSync(recordFile, JSON.stringify(r)); } catch { /* read-only profile: no quick updates */ } };
const dropRecord = () => { try { ofs.unlinkSync(recordFile); } catch { /* already gone */ } };

// AppImage updates start the new file once with --zero-selftest before switching to it (platform/linuxUpdate.ts):
// it proves the file runs here, then exits before any window, profile lock or network.
if (process.argv.includes('--zero-selftest')) {
  process.stdout.write(`ZERO-SELFTEST ${info.installed}\n`);
  app.exit(0);
} else if (app.isPackaged) {
  const rec = readRecord();
  const choice = chooseBoot(rec, {
    dir, installed: info.installed, electron: process.versions.electron, publicKey: UPDATE_PUBLIC_KEY,
    read: (f) => { try { return ofs.readFileSync(f); } catch { return null; } },
    join: path.join,
  });
  if (choice.use !== null) {
    writeRecord({ ...rec, tries: rec.tries + 1 }); // reset by the app once it runs (and on a clean quit)
    info.package = choice.use;
    info.running = choice.version;
  } else if (rec) {
    if ('reject' in choice && choice.reject) info.rejected = choice.reject;
    dropRecord(); // stale (the installer brought newer code), damaged or failing: back to the installed code
  }
}

(globalThis as any).__zeroBoot = info;
// Paths are built at run time so the bundler leaves these requires alone.
const load = (file: string) => require(file);
if (process.argv.includes('--zero-selftest')) { /* exiting */ } else if (info.package) {
  try { load(path.join(info.package, 'dist', 'main', 'index.js')); }
  catch (err) {
    console.error('app package failed to load', err);
    dropRecord();
    info.rejected = info.running; info.running = info.installed; info.package = null;
    load(path.join(__dirname, 'main', 'index.js'));
  }
} else load(path.join(__dirname, 'main', 'index.js'));
