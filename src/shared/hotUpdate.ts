import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * ZERO's update manifest (zero-update.json, published with every GitHub release) and the rules that decide
 * what to do with it. No Electron imports: shared by the boot loader and the updater, unit-tested in Node.
 *
 * A release ships two packages:
 *  - the app package (ZERO-app-<v>.asar, well under 1 MB): ZERO's own code. When the release runs on the same
 *    Electron as the installed app, this is all that is downloaded. ZERO restarts on it in a couple of seconds,
 *    with no installer and nothing written to the install folder.
 *  - the full package, only needed when the Electron runtime itself changes. Windows: the installer
 *    (ZERO-Setup-<v>.exe). Linux: the AppImage, .deb or .rpm, matching how ZERO was installed. The installer
 *    silently into the existing folder and starts ZERO again.
 * The manifest is signed (Ed25519). The public key is built into ZERO, and the private key never leaves the
 * maintainer's machine. Each package is checked against the size and SHA-512 written in the signed manifest
 * before it is used, and the boot loader checks the app package again on every start.
 */
export const REPO = 'lololyeye/zero-client';
export const FEED_URL = `https://github.com/${REPO}/releases/latest/download/zero-update.json`;
export const MAX_MANIFEST_BYTES = 128 * 1024;
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export interface ReleaseNotes { summary: string; changes: string[]; improvements: string[]; fixes: string[] }
export interface UpdatePackage { file: string; size: number; sha512: string }
export interface Manifest {
  format: 1;
  version: string;
  date: string;
  /** The exact Electron version the app package was built for. */
  electron: string;
  notes: ReleaseNotes;
  app: UpdatePackage | null;
  installer: UpdatePackage;
  /** Linux packages (optional: a release may ship Windows only). */
  linux: { appimage: UpdatePackage | null; deb: UpdatePackage | null; rpm: UpdatePackage | null };
}
/** quick: app package only. full: the platform package. manual: no package fits this install (download page). */
export type UpdateKind = 'quick' | 'full' | 'manual';
/** How a full update is applied. */
export type FullTarget = 'installer' | 'appimage' | 'deb' | 'rpm';

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

/** JSON with sorted keys and no spaces: the exact bytes that are signed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The signed bytes of a manifest: everything except the signature field. */
export function signedPayload(raw: Record<string, unknown>): string {
  const { signature: _s, ...rest } = raw;
  return canonical(rest);
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const MAX_PACKAGE = 400 * 1024 * 1024;

// oxlint-disable-next-line no-control-regex
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, 12) : []);
export const emptyNotes = (): ReleaseNotes => ({ summary: '', changes: [], improvements: [], fixes: [] });
export function sanitizeNotes(v: any): ReleaseNotes {
  return { summary: str(v?.summary, 400), changes: list(v?.changes), improvements: list(v?.improvements), fixes: list(v?.fixes) };
}
export const hasNotes = (n: ReleaseNotes | null | undefined) => !!n && (!!n.summary || n.changes.length + n.improvements.length + n.fixes.length > 0);

function pkg(v: any, name: RegExp): UpdatePackage | null {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.file !== 'string' || !name.test(v.file)) return null;
  if (!Number.isSafeInteger(v.size) || v.size <= 0 || v.size > MAX_PACKAGE) return null;
  if (typeof v.sha512 !== 'string' || !SHA512.test(v.sha512)) return null;
  return { file: v.file, size: v.size, sha512: v.sha512 };
}

export type Parsed = { ok: true; manifest: Manifest } | { ok: false; error: string };

/**
 * Checks the signature first (with the key built into ZERO), then the shape. Anything unsigned, signed with
 * another key, edited after signing or malformed is refused as a whole.
 */
export function parseManifest(raw: unknown, publicKeyB64: string): Parsed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'manifest: not an object' };
  const r = raw as Record<string, any>;
  if (typeof r.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(r.signature)) return { ok: false, error: 'manifest: unsigned' };
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(signedPayload(r), 'utf8'), key, Buffer.from(r.signature, 'base64'))) return { ok: false, error: 'manifest: bad signature' };
  } catch { return { ok: false, error: 'manifest: bad signature' }; }
  if (r.format !== 1) return { ok: false, error: 'manifest: unknown format' };
  if (typeof r.version !== 'string' || !VERSION.test(r.version)) return { ok: false, error: 'manifest: bad version' };
  if (typeof r.electron !== 'string' || !VERSION.test(r.electron)) return { ok: false, error: 'manifest: bad electron version' };
  const v = r.version.replace(/\./g, '\\.');
  const installer = pkg(r.installer, new RegExp(`^ZERO-Setup-${v}\\.exe$`));
  if (!installer) return { ok: false, error: 'manifest: bad installer entry' };
  const app = r.app == null ? null : pkg(r.app, new RegExp(`^ZERO-app-${v}\\.asar$`));
  if (r.app != null && !app) return { ok: false, error: 'manifest: bad app entry' };
  const date = typeof r.date === 'string' && !isNaN(Date.parse(r.date)) ? r.date : '';
  const lx = r.linux && typeof r.linux === 'object' ? r.linux : {};
  const linux = {
    appimage: lx.appimage == null ? null : pkg(lx.appimage, new RegExp(`^ZERO-${v}-x86_64\\.AppImage$`)),
    deb: lx.deb == null ? null : pkg(lx.deb, new RegExp(`^ZERO-${v}-amd64\\.deb$`)),
    rpm: lx.rpm == null ? null : pkg(lx.rpm, new RegExp(`^ZERO-${v}-x86_64\\.rpm$`)),
  };
  if ((lx.appimage != null && !linux.appimage) || (lx.deb != null && !linux.deb) || (lx.rpm != null && !linux.rpm)) return { ok: false, error: 'manifest: bad linux entry' };
  return { ok: true, manifest: { format: 1, version: r.version, date, electron: r.electron, notes: sanitizeNotes(r.notes), app, installer, linux } };
}

/**
 * The full package for this install, and how it is applied. Windows: the installer. Linux: the package of the
 * same format (an AppImage stays an AppImage, a .deb install gets the .deb). Flatpak, Snap, unpacked folders
 * and development runs have none: their update comes from their own channel or the download page.
 */
export function fullPackage(m: Manifest, os: 'win32' | 'linux', format: string): { pkg: UpdatePackage; target: FullTarget } | null {
  if (os === 'win32') return { pkg: m.installer, target: 'installer' };
  if (format === 'appimage' && m.linux.appimage) return { pkg: m.linux.appimage, target: 'appimage' };
  if (format === 'deb' && m.linux.deb) return { pkg: m.linux.deb, target: 'deb' };
  if (format === 'rpm' && m.linux.rpm) return { pkg: m.linux.rpm, target: 'rpm' };
  return null;
}

/** What a manifest means for the running ZERO: nothing, the app package only, or the full installer. */
export function planUpdate(m: Manifest, current: string, electron: string): UpdateKind | null {
  if (compareVersions(m.version, current) <= 0) return null;
  return m.app && m.electron === electron ? 'quick' : 'full';
}

/** Where a package is downloaded from: the release of that exact version (or a local test feed). */
export function packageUrl(m: Manifest, p: UpdatePackage, testFeed: string | null): string {
  if (testFeed) return new URL(encodeURIComponent(p.file), testFeed).toString();
  return `https://github.com/${REPO}/releases/download/v${m.version}/${encodeURIComponent(p.file)}`;
}

/** A local feed is accepted for isolated test builds only, and only on this machine. */
export function testFeed(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname.endsWith('/') && !u.search && !u.username ? u.toString() : null;
  } catch { return null; }
}

export const sha512 = (buf: Buffer | Uint8Array) => createHash('sha512').update(buf).digest('base64');

// ---- boot record: which app package the boot loader starts --------------------------------------
/** Written by the updater once an app package is verified; read by the boot loader on every start. */
export interface BootRecord {
  /** The signed manifest, exactly as published: the loader checks its signature again. */
  manifest: Record<string, unknown>;
  /** Starts since the package was last seen healthy. Three in a row and the loader goes back to the installed code. */
  tries: number;
}
export const MAX_TRIES = 3;

export type BootChoice =
  | { use: string; version: string }
  | { use: null; reject: string | null; reason: string };

/**
 * The boot loader's decision. The app package is used only if its manifest is still validly signed, it is
 * newer than the installed code, it was built for this exact Electron, it has not failed to start three times,
 * and the file on disk still matches the signed size and SHA-512.
 */
export function chooseBoot(rec: unknown, ctx: { dir: string; installed: string; electron: string; publicKey: string; read(file: string): Buffer | null; join(dir: string, f: string): string }): BootChoice {
  const r = rec as Partial<BootRecord> | null;
  if (!r || typeof r !== 'object' || !r.manifest) return { use: null, reject: null, reason: 'no app package' };
  const p = parseManifest(r.manifest, ctx.publicKey);
  if (!p.ok) return { use: null, reject: null, reason: p.error };
  const m = p.manifest;
  if (!m.app) return { use: null, reject: null, reason: 'no app package in manifest' };
  if (compareVersions(m.version, ctx.installed) <= 0) return { use: null, reject: null, reason: 'installed code is as new' };
  if (m.electron !== ctx.electron) return { use: null, reject: null, reason: `built for Electron ${m.electron}` };
  if (!Number.isInteger(r.tries) || r.tries! < 0) return { use: null, reject: m.version, reason: 'bad record' };
  if (r.tries! >= MAX_TRIES) return { use: null, reject: m.version, reason: `did not start ${MAX_TRIES} times` };
  const file = ctx.join(ctx.dir, m.app.file);
  const buf = ctx.read(file);
  if (!buf || buf.length !== m.app.size || sha512(buf) !== m.app.sha512) return { use: null, reject: m.version, reason: 'package on disk does not match' };
  return { use: file, version: m.version };
}

/** What the boot loader tells the app it started (globalThis.__zeroBoot). */
export interface BootInfo {
  /** Folder that holds the app packages and boot.json. */
  dir: string;
  /** Profile name (isolated test builds use another one). */
  name: string;
  installed: string;
  running: string;
  /** Path of the app package in use, or null for the installed code. */
  package: string | null;
  /** A version the loader stopped using because it failed. */
  rejected: string | null;
  testFeed: string | null;
}
