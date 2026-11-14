import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins } from '../src/main/plugins';
import { validateManifest, PluginManifestError } from '../src/shared/plugin';
import { redact, Logger } from '../src/main/logger';
import { detectMemoryGrowth, recommendations, sessionGrowth, stallStats, summarizeMetrics } from '../src/main/perf';
import { evaluateCompat, COMPAT_PROBE_SCRIPT } from '../src/main/inject';
import { ImageStore, sniffImage, targetSize } from '../src/main/images';
import { PRESETS, compileThemeCss } from '../src/shared/theme';
import { CHANNELS } from '../src/shared/ipc';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'zero-sys-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const manifest = (o: object = {}) => ({ id: 'p1', name: 'P', version: '1.0.0', description: 'd', author: 'a', apiVersion: 1, permissions: ['ui.css'], styles: 'a.css', ...o });
async function plugin(id: string, m: object | string, css = 'body{--x:1}') {
  await mkdir(path.join(dir, id), { recursive: true });
  await writeFile(path.join(dir, id, 'plugin.json'), typeof m === 'string' ? m : JSON.stringify(m));
  await writeFile(path.join(dir, id, 'a.css'), css);
}

describe('plugin manifests', () => {
  it('validates good manifests and rejects unknown permissions / bad versions / traversal', () => {
    expect(validateManifest(manifest()).id).toBe('p1');
    expect(() => validateManifest(manifest({ permissions: ['read.token'] }))).toThrow(PluginManifestError);
    expect(() => validateManifest(manifest({ version: 'one' }))).toThrow();
    expect(() => validateManifest(manifest({ styles: '../../secret.css' }))).toThrow();
    expect(() => validateManifest(manifest({ apiVersion: 2 }))).toThrow();
  });
});

describe('plugin loading and failure recovery', () => {
  it('loads enabled+granted plugins and reports others', async () => {
    await plugin('p1', manifest());
    const r = await loadPlugins(dir, { enabled: { p1: true }, granted: { p1: ['ui.css'] } }, false);
    expect(r.infos[0]!.status).toBe('enabled'); expect(r.css.get('p1')).toContain('--x');
  });
  it('requires explicit permission grants', async () => {
    await plugin('p1', manifest());
    const r = await loadPlugins(dir, { enabled: { p1: true }, granted: {} }, false);
    expect(r.infos[0]!.status).toBe('needs-permission'); expect(r.css.size).toBe(0);
  });
  it('isolates a broken plugin from healthy ones', async () => {
    await plugin('good', manifest({ id: 'good' }));
    await plugin('broken', '{ not json');
    await plugin('evil', manifest({ id: 'evil' }), '@import url(https://evil.test/x.css);');
    await plugin('wrongname', manifest({ id: 'other' }));
    const r = await loadPlugins(dir, { enabled: { good: true, evil: true }, granted: { good: ['ui.css'], evil: ['ui.css'] } }, false);
    const by = Object.fromEntries(r.infos.map((i) => [i.manifest.id, i]));
    expect(by['good']!.status).toBe('enabled');
    expect(by['evil']!.status).toBe('error'); expect(by['broken']!.status).toBe('error'); expect(by['wrongname']!.status).toBe('error');
    expect([...r.css.keys()]).toEqual(['good']);
  });
  it('safe mode loads no plugin css', async () => {
    await plugin('p1', manifest());
    const r = await loadPlugins(dir, { enabled: { p1: true }, granted: { p1: ['ui.css'] } }, true);
    expect(r.css.size).toBe(0); expect(r.infos[0]!.status).toBe('disabled');
  });
  it('flags incompatible api versions', async () => {
    await plugin('p1', manifest({ apiVersion: 7 }));
    expect((await loadPlugins(dir, { enabled: {}, granted: {} }, false)).infos[0]!.status).toBe('incompatible');
  });
  it('handles a missing plugins folder', async () => {
    expect((await loadPlugins(path.join(dir, 'nope'), { enabled: {}, granted: {} }, false)).infos).toEqual([]);
  });
});

describe('logging redaction', () => {
  it('removes token-shaped strings, secrets in key/value pairs and user paths', () => {
    const tok = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.GabcDE.' + 'x'.repeat(30);
    const out = redact(`oops ${tok} Authorization: Bearer abc123 url=https://x/y?token=SECRET&a=1 at C:\\Users\\jane\\app`);
    expect(out).not.toContain(tok); expect(out).not.toContain('abc123'); expect(out).not.toContain('SECRET'); expect(out).not.toContain('jane');
  });
  it('writes redacted lines to disk and never throws', async () => {
    const f = path.join(dir, 'l', 'zero.log'); const l = new Logger(f);
    l.error('failed', new Error('password=hunter2')); await l.flush();
    const text = await readFile(f, 'utf8'); expect(text).toContain('[error]'); expect(text).not.toContain('hunter2');
    await expect(new Logger('Z:\\no\\such\\drive\\x.log').flush()).resolves.toBeUndefined();
  });
});

describe('performance monitoring', () => {
  it('aggregates process metrics', () => {
    const s = summarizeMetrics([{ pid: 1, type: 'Browser', cpu: { percentCPUUsage: 1.25 }, memory: { workingSetSize: 102400 } }, { pid: 2, type: 'Tab', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 204800 } }]);
    expect(s.ramMb).toBe(300); expect(s.cpuPercent).toBe(3.3);
  });
  it('detects sustained memory growth but ignores noise', () => {
    expect(detectMemoryGrowth(Array.from({ length: 30 }, (_, i) => 200 + i * 2)).growing).toBe(true);
    expect(detectMemoryGrowth(Array.from({ length: 30 }, (_, i) => 200 + (i % 2 ? 1 : -1))).growing).toBe(false);
    expect(detectMemoryGrowth([1, 2]).growing).toBe(false);
  });
  it('prefers private memory (what Task Manager shows) and names utility processes', () => {
    const s = summarizeMetrics([{ pid: 1, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 600 * 1024, privateBytes: 500 * 1024 } }, { pid: 2, type: 'Utility', name: 'Audio Service', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 90 * 1024, privateBytes: 10 * 1024 } }]);
    expect(s.ramMb).toBe(510); expect(s.processes[1]!.type).toBe('Audio Service');
  });
  it('reports session growth per hour, ignoring the first 10 minutes of cache filling', () => {
    expect(sessionGrowth(Array.from({ length: 20 }, () => 400))).toBeNull();
    const warmupThenFlat = [...Array.from({ length: 10 }, (_, i) => 200 + i * 20), ...Array.from({ length: 60 }, () => 400)];
    expect(sessionGrowth(warmupThenFlat)).toBe(0);
    expect(sessionGrowth(Array.from({ length: 70 }, (_, i) => 400 + i))).toBe(60); // +1 MB per minute
  });
  it('summarizes main-process timer lateness', () => {
    expect(stallStats([1, 2])).toBeNull();
    expect(stallStats([...Array.from({ length: 99 }, () => 2), 180])).toEqual({ p50: 2, p99: 180, max: 180 });
  });
  it('recommends only from measured problems', () => {
    const ok = { hardwareAcceleration: true, gpuFeatures: { video_encode: 'enabled' }, session: { minutes: 0, ramMb: [], growthMbPerHour: null }, media: null, eventLoop: { p50: 1, p99: 5, max: 9 }, profile: 'balanced' as const, ramMb: 500 };
    expect(recommendations(ok)).toEqual([]);
    expect(recommendations({ ...ok, hardwareAcceleration: false })[0]!.text).toMatch(/Hardware acceleration is off/);
    const cpuStream = { connections: 1, streams: [{ dir: 'send' as const, kind: 'video' as const, codec: 'VP8', kbps: 4000, hw: false, impl: 'libvpx', limit: 'cpu' }] };
    const r = recommendations({ ...ok, media: cpuStream }).map((x) => x.text).join(' ');
    expect(r).toMatch(/encoded on the CPU/); expect(r).toMatch(/CPU is busy/);
    const dropouts = { connections: 1, streams: [{ dir: 'recv' as const, kind: 'audio' as const, codec: 'opus', kbps: 64, concealedPct: 4.2 }] };
    expect(recommendations({ ...ok, media: dropouts })[0]!.text).toMatch(/4.2% of received voice/);
  });
});

describe('long-session simulation', () => {
  it('re-applying themes repeatedly does not grow memory or output', () => {
    const before = process.memoryUsage().heapUsed;
    let len = 0;
    for (let i = 0; i < 3000; i++) len = Math.max(len, compileThemeCss(PRESETS[i % PRESETS.length]!).length);
    const growthMb = (process.memoryUsage().heapUsed - before) / 1048576;
    expect(growthMb).toBeLessThan(50); expect(len).toBeLessThan(40_000);
  });
});

describe('compatibility check', () => {
  const probe = (o: any = {}) => ({ loggedInShell: true, style: { present: true, count: 1, bytes: 10 }, winning: true, variables: ['a', 'b', 'c'].map((name) => ({ name, present: true })), selectors: [{ name: 's', matches: 3 }, { name: 'input', matches: 0, optional: true }], ...o });
  it('reports ok / degraded / unknown honestly', () => {
    expect(evaluateCompat(probe(), 'u').verdict).toBe('ok');
    expect(evaluateCompat(probe({ selectors: [{ name: 's', matches: 0 }] }), 'u').verdict).toBe('degraded');
    expect(evaluateCompat(probe({ loggedInShell: false }), 'u').verdict).toBe('unknown');
    expect(evaluateCompat(null, 'u').verdict).toBe('unknown');
  });
  it('flags a losing cascade, duplicate or missing stylesheet, and missing images', () => {
    expect(evaluateCompat(probe({ winning: false }), 'u').summary).toMatch(/overriding/);
    expect(evaluateCompat(probe({ style: { present: true, count: 2, bytes: 1 } }), 'u').verdict).toBe('degraded');
    expect(evaluateCompat(probe({ style: { present: false, count: 0, bytes: 0 } }), 'u').verdict).toBe('degraded');
    expect(evaluateCompat(probe({ style: { present: false, count: 0, bytes: 0 } }), 'u', 0, { expectStyle: false }).verdict).toBe('ok');
    expect(evaluateCompat(probe(), 'u', 0, { missingImages: ['abc'] }).verdict).toBe('degraded');
  });
  it('redacts channel ids from the reported url', () => {
    expect(evaluateCompat(probe(), 'https://discord.com/channels/123456789/987654321').url).toBe('https://discord.com/channels/…');
  });
  it('the probe is read-only and never touches storage, cookies or the network', () => {
    expect(COMPAT_PROBE_SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(|XMLHttpRequest|token|appendChild|remove\(|textContent\s*=/i);
  });
});

describe('background images', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  it('detects formats by magic bytes, not extension', () => {
    expect(sniffImage(png)).toBe('png'); expect(sniffImage(Buffer.from('MZ...........................'))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('webp');
  });
  it('downscales high-resolution images (e.g. 8K) to 2560px', () => {
    expect(targetSize(7680, 4320)).toEqual({ width: 2560, height: 1440 });
    expect(targetSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('imports through the codec, resizing oversized images, and rejects non-images', async () => {
    let resizedTo: [number, number] | null = null;
    const codec = { decode: () => { const img: any = { width: 7680, height: 4320, resize: (w: number, h: number) => { resizedTo = [w, h]; return { ...img, width: w, height: h }; }, toJPEG: () => Buffer.from('jpeg'), toPNG: () => Buffer.from('png') }; return img; } };
    const store = new ImageStore(path.join(dir, 'bg'), codec as any);
    await writeFile(path.join(dir, 'big.png'), png);
    const r = await store.import(path.join(dir, 'big.png'));
    expect(resizedTo).toEqual([2560, 1440]); expect(r.width).toBe(2560); expect(await store.resolve(r.id)).toBeTruthy();
    await writeFile(path.join(dir, 'fake.png'), 'not an image at all, just text content here');
    await expect(store.import(path.join(dir, 'fake.png'))).rejects.toThrow(/Unsupported/);
    expect(await store.resolve('../../x')).toBeNull();
  });
});

describe('ipc surface', () => {
  it('exposes no channel that could return credentials', () => {
    expect(CHANNELS.some((c) => /token|credential|cookie|password/i.test(c))).toBe(false);
  });
});
