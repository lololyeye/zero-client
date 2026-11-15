// Prepares a release after `npm run package`:
//   release/ZERO-app-<v>.asar   ZERO's code only (the quick update)
//   release/zero-update.json    the signed manifest ZERO reads to update
//   release/notes-<v>.md        the GitHub release text, from docs/release-notes/v<v>.json
// Then publish with: gh release create v<v> release/latest.yml release/ZERO-Setup-<v>.exe release/ZERO-Setup-<v>.exe.blockmap
//   release/ZERO-app-<v>.asar release/zero-update.json --notes-file release/notes-<v>.md ...
// latest.yml and the blockmap stay for clients older than 0.6.0, which update through the installer.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const electron = require('electron/package.json').version;
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'release';
const keyFile = process.env.ZERO_UPDATE_KEY || path.join(homedir(), '.zero-release', 'update-signing-key.pem');

const notes = JSON.parse(readFileSync(`docs/release-notes/v${version}.json`, 'utf8'));
for (const k of ['changes', 'improvements', 'fixes']) if (!Array.isArray(notes[k])) notes[k] = [];
notes.summary = typeof notes.summary === 'string' ? notes.summary : '';

const describe = (file) => {
  const buf = readFileSync(path.join(out, file));
  return { file, size: buf.length, sha512: createHash('sha512').update(buf).digest('base64') };
};
const appFile = `ZERO-app-${version}.asar`;
copyFileSync(path.join(out, 'win-unpacked', 'resources', 'app.asar'), path.join(out, appFile));
const installerFile = `ZERO-Setup-${version}.exe`;

const manifest = {
  format: 1, version, date: new Date().toISOString(), electron,
  notes: { summary: notes.summary, changes: notes.changes, improvements: notes.improvements, fixes: notes.fixes },
  app: describe(appFile), installer: describe(installerFile),
};
const key = createPrivateKey(readFileSync(keyFile));
manifest.signature = sign(null, Buffer.from(canonical(manifest)), key).toString('base64');
const embedded = /UPDATE_PUBLIC_KEY = '([^']+)'/.exec(readFileSync('src/shared/updateKey.ts', 'utf8'))?.[1];
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
if (embedded !== pub) throw new Error('the signing key does not match the public key built into ZERO (src/shared/updateKey.ts)');
writeFileSync(path.join(out, 'zero-update.json'), JSON.stringify(manifest, null, 2) + '\n');

const section = (title, items) => (items.length ? `### ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n` : '');
writeFileSync(path.join(out, `notes-${version}.md`), `${notes.summary ? notes.summary + '\n\n' : ''}${section('New', notes.changes)}${section('Improved', notes.improvements)}${section('Fixed', notes.fixes)}`
  + `Download **${installerFile}** below for a new install. ZERO already installed updates itself from Settings > About.\n`);
console.log(`v${version} (Electron ${electron}): ${appFile} ${(manifest.app.size / 1024).toFixed(0)} KB, ${installerFile} ${(manifest.installer.size / 1048576).toFixed(1)} MB, manifest signed`);
