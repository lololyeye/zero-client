import { describe, expect, it } from 'vitest';
import { compareVersions, fetchLatest, parseRelease } from '../src/main/updates';

describe('update check', () => {
  it('compares versions numerically, including v-prefixes and pre-releases', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
  it('reads the installer asset and ignores drafts, pre-releases and non-GitHub links', () => {
    const rel = { tag_name: 'v0.3.0', html_url: 'https://github.com/lololyeye/zero-client/releases/tag/v0.3.0', body: 'notes', assets: [{ name: 'ZERO-Setup-0.3.0.exe', browser_download_url: 'https://github.com/lololyeye/zero-client/releases/download/v0.3.0/ZERO-Setup-0.3.0.exe' }] };
    const u = parseRelease(rel, '0.2.0')!;
    expect(u.newer).toBe(true); expect(u.latest).toBe('0.3.0'); expect(u.installerUrl).toMatch(/\.exe$/);
    expect(parseRelease({ ...rel, draft: true }, '0.2.0')).toBeNull();
    expect(parseRelease({ ...rel, prerelease: true }, '0.2.0')).toBeNull();
    expect(parseRelease({ ...rel, html_url: 'https://evil.example/x', assets: [{ name: 'a.exe', browser_download_url: 'https://evil.example/a.exe' }] }, '0.2.0')!.installerUrl).toBeNull();
    expect(parseRelease(rel, '0.3.0')!.newer).toBe(false);
  });
  it('treats "no release yet" as no update and surfaces other errors', async () => {
    expect(await fetchLatest(async () => new Response('', { status: 404 }), '0.2.0')).toBeNull();
    await expect(fetchLatest(async () => new Response('', { status: 500 }), '0.2.0')).rejects.toThrow(/500/);
  });
});
