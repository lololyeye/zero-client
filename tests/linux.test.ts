import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { audioInfo, cpuModel, installFormat, listProcesses, parseOsRelease, portalInfo, processName, sessionInfo } from '../src/main/platform/linux';
import { cleanEnv } from '../src/main/platform/linuxUpdate';
import { activeBuiltins, BUILTINS, buildDetectableIndex, matchGame, sanitizeBuiltins, supportOn } from '../src/shared/builtins';
import { validateManifest } from '../src/shared/plugin';
import { loadPlugins } from '../src/main/plugins';
import { chromeUserAgent } from '../src/main/capture';
import { redact } from '../src/main/logger';

const tmp = mkdtempSync(path.join(tmpdir(), 'zero-linux-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('system facts', () => {
  it('reads os-release of Linux Mint and others', () => {
    const mint = parseOsRelease('NAME="Linux Mint"\nVERSION="22.1 (Xia)"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 22.1"\nVERSION_ID="22.1"\n');
    expect(mint).toEqual({ id: 'linuxmint', name: 'Linux Mint 22.1', version: '22.1', idLike: ['ubuntu', 'debian'] });
    expect(parseOsRelease('ID=fedora\nVERSION_ID=41\nNAME=Fedora Linux').name).toBe('Fedora Linux');
    expect(parseOsRelease('')).toEqual({ id: 'linux', name: 'Linux', version: '', idLike: [] });
  });
  it('detects the session and the desktop', () => {
    expect(sessionInfo({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'X-Cinnamon', DISPLAY: ':0' })).toEqual({ type: 'x11', desktop: 'Cinnamon', wayland: false, display: true });
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' })).toMatchObject({ type: 'wayland', desktop: 'GNOME', wayland: true });
    expect(sessionInfo({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }).desktop).toBe('KDE Plasma');
    expect(sessionInfo({ DISPLAY: ':1', DESKTOP_SESSION: 'xfce' })).toMatchObject({ type: 'x11', desktop: 'XFCE' });
    expect(sessionInfo({})).toMatchObject({ type: 'unknown', desktop: 'unknown', display: false });
  });
  it('finds the sound server from its sockets', () => {
    const has = (...p: string[]) => (f: string) => p.includes(f.replace(/\\/g, '/'));
    expect(audioInfo('/run/user/1000', has('/run/user/1000/pipewire-0', '/run/user/1000/pulse/native'))).toMatchObject({ server: 'pipewire', pulseCompatible: true });
    expect(audioInfo('/run/user/1000', has('/run/user/1000/pipewire-0'))).toMatchObject({ server: 'pipewire', pulseCompatible: false });
    expect(audioInfo('/run/user/1000', has('/run/user/1000/pulse/native'))).toMatchObject({ server: 'pulseaudio', pulseCompatible: true });
    expect(audioInfo('/run/user/1000', has('/proc/asound/cards'))).toMatchObject({ server: 'alsa', pulseCompatible: false });
    expect(audioInfo(undefined, () => false).server).toBe('unknown');
  });
  it('tells install formats apart', () => {
    const base = { execPath: '/opt/ZERO/zero', packaged: true, exists: (p: string) => p === '/var/lib/dpkg/info/zero-client.list' };
    expect(installFormat({ ...base, env: {} })).toBe('deb');
    expect(installFormat({ ...base, env: { APPIMAGE: '/home/u/Apps/ZERO-0.7.0-x86_64.AppImage' }, execPath: '/tmp/.mount_ZERO/zero' })).toBe('appimage');
    expect(installFormat({ ...base, env: {}, exists: (p) => p === '/var/lib/rpm' })).toBe('rpm');
    expect(installFormat({ ...base, env: { FLATPAK_ID: 'app.zero.client' } })).toBe('flatpak');
    expect(installFormat({ ...base, env: {}, execPath: '/home/u/zero/zero', exists: () => false })).toBe('unpacked');
    expect(installFormat({ ...base, env: {}, packaged: false })).toBe('dev');
  });
  it('reads portal backends and the CPU', async () => {
    const dir = path.join(tmp, 'portals');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'gtk.portal'), '[portal]\nDBusName=org.freedesktop.impl.portal.desktop.gtk\nInterfaces=org.freedesktop.impl.portal.FileChooser;org.freedesktop.impl.portal.Settings;\n');
    expect(await portalInfo([dir])).toEqual({ installed: true, backends: ['gtk'], screencast: false });
    writeFileSync(path.join(dir, 'gnome.portal'), 'Interfaces=org.freedesktop.impl.portal.ScreenCast;org.freedesktop.impl.portal.Screenshot;\n');
    expect((await portalInfo([dir])).screencast).toBe(true);
    expect(await portalInfo([path.join(tmp, 'none')])).toEqual({ installed: false, backends: [], screencast: false });
    expect(cpuModel('processor\t: 0\nmodel name\t: AMD Ryzen 5 3600 6-Core Processor\n')).toBe('AMD Ryzen 5 3600 6-Core Processor');
  });
});

describe('GameDetection on Linux', () => {
  it('reads program names from /proc, including Proton games', async () => {
    expect(processName(Buffer.from('/home/u/.steam/steamapps/common/Valheim/valheim.x86_64\0-batchmode\0'))).toBe('valheim.x86_64');
    expect(processName('Z:\\home\\u\\Games\\EldenRing\\Game\\eldenring.exe\0')).toBe('eldenring.exe');
    expect(processName('\0')).toBeNull();
    const proc = path.join(tmp, 'proc');
    for (const [pid, cmd, comm] of [['1', '/sbin/init\0', 'systemd'], ['42', 'C:\\Games\\VALORANT-Win64-Shipping.exe\0', 'VALORANT-Win64-'], ['77', '', 'kworker/0:1'], ['self', 'x', 'x']] as const) {
      mkdirSync(path.join(proc, pid), { recursive: true });
      writeFileSync(path.join(proc, pid, 'cmdline'), cmd);
      writeFileSync(path.join(proc, pid, 'comm'), comm + '\n');
    }
    expect((await listProcesses(proc)).sort()).toEqual(['VALORANT-Win64-Shipping.exe', 'init', 'kworker/0:1']);
    expect(await listProcesses(path.join(tmp, 'missing'))).toEqual([]);
  });
  it('matches native and Windows entries of the detectable list', () => {
    const list = [
      { id: '1', name: 'Valheim', executables: [{ os: 'linux', name: 'valheim.x86_64' }, { os: 'win32', name: 'valheim.exe' }] },
      { id: '2', name: 'VALORANT', executables: [{ os: 'win32', name: 'valorant-win64-shipping.exe' }] },
      { id: '3', name: 'Some Java Game', executables: [{ os: 'linux', name: 'java' }] },
    ];
    const linux = buildDetectableIndex(list, ['linux', 'win32']);
    expect(matchGame(['bash', 'valheim.x86_64'], linux, [])?.name).toBe('Valheim');
    expect(matchGame(['VALORANT-Win64-Shipping.exe'], linux, [])?.name).toBe('VALORANT');
    expect(matchGame(['java'], linux, [])).toBeNull(); // too generic
    const windows = buildDetectableIndex(list);
    expect(matchGame(['valheim.x86_64'], windows, [])).toBeNull(); // Windows index unchanged
    expect(matchGame(['valheim.exe'], windows, [])?.name).toBe('Valheim');
  });
});

describe('plugin compatibility', () => {
  it('declares Linux limits and never starts unsupported plugins', () => {
    expect(supportOn('streamPresets', 'linux').level).toBe('partial');
    expect(supportOn('voiceOverlay', 'linux').level).toBe('partial');
    expect(supportOn('callTimer', 'linux').level).toBe('supported');
    for (const d of BUILTINS) expect(supportOn(d.id, 'win32').level).toBe('supported');
    const all = sanitizeBuiltins({ callTimer: { enabled: true }, streamPresets: { enabled: true } });
    expect(Object.keys(activeBuiltins(all, false, 'linux')).sort()).toEqual(['callTimer', 'streamPresets']);
  });
  it('third-party plugins can declare their systems', async () => {
    const m = { id: 'win-only', name: 'W', version: '1.0.0', description: 'd', author: 'a', apiVersion: 1, permissions: [], platforms: ['win32'] };
    expect(validateManifest(m).platforms).toEqual(['win32']);
    expect(() => validateManifest({ ...m, platforms: ['macos'] })).toThrow(/platforms/);
    expect(validateManifest({ ...m, platforms: undefined }).platforms).toBeUndefined();
    const dir = path.join(tmp, 'plugins');
    mkdirSync(path.join(dir, 'win-only'), { recursive: true });
    writeFileSync(path.join(dir, 'win-only', 'plugin.json'), JSON.stringify(m));
    mkdirSync(path.join(dir, 'everywhere'), { recursive: true });
    writeFileSync(path.join(dir, 'everywhere', 'plugin.json'), JSON.stringify({ ...m, id: 'everywhere', platforms: undefined }));
    const r = await loadPlugins(dir, { enabled: { 'win-only': true, everywhere: true }, granted: {} }, false, 'linux');
    expect(r.infos.find((i) => i.manifest.id === 'win-only')).toMatchObject({ status: 'incompatible', error: 'Made for Windows only.' });
    expect(r.infos.find((i) => i.manifest.id === 'everywhere')?.status).toBe('enabled');
    expect((await loadPlugins(dir, { enabled: { 'win-only': true }, granted: {} }, false, 'win32')).infos.find((i) => i.manifest.id === 'win-only')?.status).toBe('enabled');
  });
});

describe('platform details', () => {
  it('presents the right system to Discord', () => {
    expect(chromeUserAgent('140.0.7339.80', 'X11; Linux x86_64')).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    expect(chromeUserAgent('140.0.7339.80')).toContain('Windows NT 10.0');
  });
  it('hides home folders in logs and reports', () => {
    expect(redact('failed to open /home/alice/.config/ZERO/config.json')).toBe('failed to open /home/<user>/.config/ZERO/config.json');
    expect(redact('C:\\Users\\bob\\AppData')).toBe('C:\\Users\\<user>\\AppData');
  });
  it('starts the next AppImage with a clean environment', () => {
    const e = cleanEnv({ APPIMAGE: '/a', APPDIR: '/tmp/.mount', ARGV0: 'x', HOME: '/home/u', PATH: '/usr/bin' });
    expect(e).toEqual({ HOME: '/home/u', PATH: '/usr/bin' });
  });
});
