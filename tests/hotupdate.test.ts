import { generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonical, chooseBoot, MAX_TRIES, packageUrl, parseManifest, planUpdate, sha512, signedPayload, testFeed } from '../src/shared/hotUpdate';
import { UPDATE_PUBLIC_KEY } from '../src/shared/updateKey';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const other = generateKeyPairSync('ed25519').privateKey;
const asar = Buffer.from('fake app package '.repeat(100));

function manifest(over: Record<string, unknown> = {}, key = privateKey) {
  const m: Record<string, unknown> = {
    format: 1, version: '0.6.0', date: '2026-11-15T10:00:00.000Z', electron: '45.3.2',
    notes: { summary: 'Quick updates', changes: ['A', '', 7], improvements: ['B'], fixes: [] },
    app: { file: 'ZERO-app-0.6.0.asar', size: asar.length, sha512: sha512(asar) },
    installer: { file: 'ZERO-Setup-0.6.0.exe', size: 121560981, sha512: sha512(Buffer.from('installer')) },
    ...over,
  };
  m.signature = sign(null, Buffer.from(signedPayload(m)), key).toString('base64');
  return m;
}

describe('manifest signature', () => {
  it('signs canonical JSON (key order does not matter)', () => {
    expect(canonical({ b: 1, a: [true, { d: null, c: 'x' }] })).toBe('{"a":[true,{"c":"x","d":null}],"b":1}');
    expect(canonical({ a: 1, u: undefined })).toBe('{"a":1}');
  });
  it('accepts a correctly signed manifest and cleans the notes', () => {
    const p = parseManifest(manifest(), PUB);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.manifest.notes).toEqual({ summary: 'Quick updates', changes: ['A'], improvements: ['B'], fixes: [] });
    expect(p.manifest.app?.file).toBe('ZERO-app-0.6.0.asar');
  });
  it('refuses unsigned, re-signed with another key, or edited manifests', () => {
    const { signature: _s, ...unsigned } = manifest();
    expect(parseManifest(unsigned, PUB)).toMatchObject({ ok: false });
    expect(parseManifest(manifest({}, other), PUB)).toMatchObject({ ok: false, error: 'manifest: bad signature' });
    const edited = manifest();
    (edited.app as any).sha512 = sha512(Buffer.from('evil'));
    expect(parseManifest(edited, PUB)).toMatchObject({ ok: false, error: 'manifest: bad signature' });
    const v = manifest(); v.version = '9.9.9';
    expect(parseManifest(v, PUB)).toMatchObject({ ok: false });
    expect(parseManifest(manifest(), UPDATE_PUBLIC_KEY)).toMatchObject({ ok: false }); // the test key is not ZERO's key
    expect(parseManifest(null, PUB)).toMatchObject({ ok: false });
  });
  it('refuses signed manifests with unsafe file names or bad entries', () => {
    expect(parseManifest(manifest({ app: { file: '../../evil.asar', size: 10, sha512: sha512(asar) } }), PUB)).toMatchObject({ ok: false, error: 'manifest: bad app entry' });
    expect(parseManifest(manifest({ app: { file: 'ZERO-app-0.5.0.asar', size: 10, sha512: sha512(asar) } }), PUB)).toMatchObject({ ok: false });
    expect(parseManifest(manifest({ installer: { file: 'ZERO-Setup-0.6.0.exe', size: -1, sha512: 'x' } }), PUB)).toMatchObject({ ok: false });
    expect(parseManifest(manifest({ format: 2 }), PUB)).toMatchObject({ ok: false });
    expect(parseManifest(manifest({ app: null }), PUB)).toMatchObject({ ok: true });
  });
  it('the public key built into ZERO is a valid Ed25519 key', () => {
    expect(Buffer.from(UPDATE_PUBLIC_KEY, 'base64').length).toBe(44);
  });
});

describe('update plan', () => {
  const m = (over = {}) => { const p = parseManifest(manifest(over), PUB); if (!p.ok) throw new Error(p.error); return p.manifest; };
  it('downloads only the app package when Electron is the same', () => {
    expect(planUpdate(m(), '0.5.0', '45.3.2')).toBe('quick');
    expect(planUpdate(m(), '0.5.0', '45.3.1')).toBe('full');
    expect(planUpdate(m({ app: null }), '0.5.0', '45.3.2')).toBe('full');
    expect(planUpdate(m(), '0.6.0', '45.3.2')).toBeNull();
    expect(planUpdate(m(), '0.7.0', '45.3.2')).toBeNull();
  });
  it('downloads from the release of that version, or a local test feed only', () => {
    const x = m();
    expect(packageUrl(x, x.app!, null)).toBe('https://github.com/lololyeye/zero-client/releases/download/v0.6.0/ZERO-app-0.6.0.asar');
    expect(packageUrl(x, x.app!, 'http://127.0.0.1:8123/feed/')).toBe('http://127.0.0.1:8123/feed/ZERO-app-0.6.0.asar');
    expect(testFeed('http://127.0.0.1:8123/')).toBe('http://127.0.0.1:8123/');
    for (const bad of ['https://evil.com/', 'http://localhost:1/', 'http://127.0.0.1:1/x', 'http://a@127.0.0.1/', 'file:///C:/', 7]) expect(testFeed(bad)).toBeNull();
  });
});

describe('boot loader choice', () => {
  const dir = path.join('C:', 'p', 'updates');
  const ctx = (files: Record<string, Buffer>, over = {}) => ({
    dir, installed: '0.5.0', electron: '45.3.2', publicKey: PUB, join: path.join,
    read: (f: string) => files[f] ?? null, ...over,
  });
  const file = path.join(dir, 'ZERO-app-0.6.0.asar');
  it('starts a verified, newer package built for this Electron', () => {
    expect(chooseBoot({ manifest: manifest(), tries: 0 }, ctx({ [file]: asar }))).toEqual({ use: file, version: '0.6.0' });
    expect(chooseBoot({ manifest: manifest(), tries: MAX_TRIES - 1 }, ctx({ [file]: asar })).use).toBe(file);
  });
  it('falls back to the installed code otherwise', () => {
    expect(chooseBoot(null, ctx({}))).toMatchObject({ use: null, reject: null });
    expect(chooseBoot({ manifest: manifest(), tries: 0 }, ctx({ [file]: asar }, { installed: '0.6.0' }))).toMatchObject({ use: null, reject: null }); // the installer brought it
    expect(chooseBoot({ manifest: manifest(), tries: 0 }, ctx({ [file]: asar }, { electron: '46.0.0' }))).toMatchObject({ use: null });
    expect(chooseBoot({ manifest: manifest({}, other), tries: 0 }, ctx({ [file]: asar }))).toMatchObject({ use: null });
    expect(chooseBoot({ manifest: manifest(), tries: MAX_TRIES }, ctx({ [file]: asar }))).toMatchObject({ use: null, reject: '0.6.0' });
    expect(chooseBoot({ manifest: manifest(), tries: 0 }, ctx({}))).toMatchObject({ use: null, reject: '0.6.0' });
    const tampered = Buffer.from(asar); tampered[3] = 0;
    expect(chooseBoot({ manifest: manifest(), tries: 0 }, ctx({ [file]: tampered }))).toMatchObject({ use: null, reason: 'package on disk does not match' });
    expect(chooseBoot({ manifest: manifest(), tries: 'x' }, ctx({ [file]: asar }))).toMatchObject({ use: null });
  });
});
