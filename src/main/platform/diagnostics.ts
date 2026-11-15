import { app } from 'electron';
import os from 'node:os';
import { audioInfo, cpuModel, gpuDrivers, installFormat, parseOsRelease, portalInfo, sessionInfo, type InstallFormat } from './linux';
import { fileExists, readText } from './index';

/**
 * Settings > Linux: what ZERO runs on and whether voice, screen sharing, the GPU and updates can work.
 * Everything here is about the system. Nothing about the account, the Discord session, messages, cookies or
 * tokens is read, so the exported report contains none of it.
 */
export type Level = 'ok' | 'warn' | 'error' | 'info';
export interface Check { id: string; label: string; level: Level; text: string }
export interface LinuxInfo {
  system: [string, string][];
  checks: Check[];
  format: InstallFormat;
}

const GB = 1024 ** 3;

export async function linuxInfo(ctx: {
  version: string; installed: string; hotPackage: boolean; hardwareAcceleration: boolean;
  partialPlugins: string[]; updateStatus: string;
}): Promise<LinuxInfo> {
  const rel = parseOsRelease(readText('/etc/os-release') || readText('/usr/lib/os-release'));
  const session = sessionInfo(process.env);
  const audio = audioInfo(process.env.XDG_RUNTIME_DIR, fileExists);
  const portal = await portalInfo();
  const drivers = await gpuDrivers();
  const format = installFormat({ env: process.env, execPath: process.execPath, packaged: app.isPackaged, exists: fileExists });
  let gpu = 'unknown';
  try {
    const info: any = await app.getGPUInfo('basic');
    const d = info?.gpuDevice?.find((x: any) => x.active) ?? info?.gpuDevice?.[0];
    const vendors: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' };
    if (d) gpu = [vendors[d.vendorId] ?? `vendor 0x${Number(d.vendorId).toString(16)}`, String(d.deviceString ?? '').slice(0, 80)].filter(Boolean).join(' ');
  } catch { /* GPU process not up */ }
  let features: Record<string, string> = {};
  try { features = app.getGPUFeatureStatus() as unknown as Record<string, string>; } catch { /* unavailable */ }
  const on = (k: string) => String(features[k] ?? '').startsWith('enabled');

  const system: [string, string][] = [
    ['Distribution', rel.version && !rel.name.includes(rel.version) ? `${rel.name} ${rel.version}` : rel.name],
    ['Kernel', os.release()],
    ['Desktop', session.desktop],
    ['Display server', session.type === 'wayland' ? 'Wayland' : session.type === 'x11' ? 'X11' : session.type],
    ['CPU', `${cpuModel(readText('/proc/cpuinfo')) || os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} threads)`],
    ['Memory', `${(os.totalmem() / GB).toFixed(1)} GB (${(os.freemem() / GB).toFixed(1)} GB free)`],
    ['GPU', gpu],
    ['GPU driver', drivers.length ? drivers.join(', ') : 'unknown'],
    ['Audio', audio.detail],
    ['ZERO', ctx.hotPackage ? `${ctx.version} (quick update over installed ${ctx.installed})` : ctx.version],
    ['Installed as', FORMAT_NAME[format]],
    ['Electron / Chromium', `${process.versions.electron} / ${process.versions.chrome}`],
  ];

  const checks: Check[] = [];
  // GPU
  if (!ctx.hardwareAcceleration) checks.push({ id: 'gpu', label: 'GPU acceleration', level: 'info', text: 'Off in Settings > General. ZERO draws with the CPU (software rendering).' });
  else if (on('gpu_compositing')) {
    const extra = [on('video_decode') ? 'video decoding on the GPU' : 'video decoded by the CPU', on('video_encode') ? 'stream encoding on the GPU' : 'streams encoded by the CPU'];
    checks.push({ id: 'gpu', label: 'GPU acceleration', level: 'ok', text: `Active (${extra.join(', ')}).` });
  } else checks.push({ id: 'gpu', label: 'GPU acceleration', level: 'warn', text: 'Chromium turned GPU compositing off on this system (driver blocklisted or unavailable). ZERO works with software rendering, using more CPU.' });
  if (drivers.includes('nouveau')) checks.push({ id: 'nouveau', label: 'NVIDIA driver', level: 'info', text: 'The open-source nouveau driver is in use. For smooth streaming, install the NVIDIA driver from Driver Manager.' });
  // audio
  checks.push(audio.pulseCompatible
    ? { id: 'audio', label: 'Voice and sound', level: 'ok', text: `${audio.detail}. Microphones and outputs are listed in Discord's Voice settings and follow device changes.` }
    : { id: 'audio', label: 'Voice and sound', level: 'error', text: `${audio.detail}.` });
  // screen capture
  if (session.type === 'wayland') {
    checks.push(portal.screencast
      ? { id: 'capture', label: 'Screen sharing', level: 'ok', text: `Wayland: through the desktop portal (${portal.backends.join(', ')}) and PipeWire. Your desktop shows its own window to choose what to share.` }
      : { id: 'capture', label: 'Screen sharing', level: 'error', text: 'Wayland needs xdg-desktop-portal with a backend for your desktop (for example xdg-desktop-portal-gnome, -kde or -gtk) to share the screen.' });
  } else if (session.type === 'x11') {
    checks.push({ id: 'capture', label: 'Screen sharing', level: 'ok', text: 'X11: screens and windows are listed in ZERO\'s picker.' });
  } else checks.push({ id: 'capture', label: 'Screen sharing', level: 'warn', text: 'No graphical session detected.' });
  checks.push({ id: 'streamAudio', label: 'Stream sound', level: 'info', text: 'Screen shares carry no system sound on Linux (Electron captures it on Windows only). Your voice in the call is not affected.' });
  checks.push({ id: 'portal', label: 'Desktop portal', level: portal.installed ? 'ok' : session.type === 'wayland' ? 'error' : 'info', text: portal.installed ? `Installed (${portal.backends.join(', ')})` : 'Not installed. Only needed on Wayland.' });
  // notifications (Chromium uses libnotify)
  const notify = ['/usr/lib/x86_64-linux-gnu/libnotify.so.4', '/usr/lib64/libnotify.so.4', '/usr/lib/libnotify.so.4'].some(fileExists);
  checks.push({ id: 'notify', label: 'Notifications', level: notify ? 'ok' : 'warn', text: notify ? 'Desktop notifications go through your notification server.' : 'libnotify was not found: Discord notifications may not appear. Install libnotify4 (Debian, Ubuntu, Mint) or libnotify (Fedora, Arch).' });
  // plugins
  checks.push({ id: 'plugins', label: 'Plugins', level: ctx.partialPlugins.length ? 'info' : 'ok', text: ctx.partialPlugins.length ? `On with limits on Linux: ${ctx.partialPlugins.join(', ')}. See each plugin's settings.` : 'Every plugin you use works fully on Linux.' });
  // updates
  checks.push({ id: 'updates', label: 'Updates', level: format === 'snap' || format === 'flatpak' ? 'warn' : 'ok', text: ctx.updateStatus });
  return { system, checks, format };
}

export const FORMAT_NAME: Record<InstallFormat, string> = {
  appimage: 'AppImage', deb: '.deb package', rpm: '.rpm package', flatpak: 'Flatpak', snap: 'Snap', unpacked: 'Unpacked folder', dev: 'Development run',
};

/** Plain-text report for bug reports. System facts only; the caller passes it through the log redactor too. */
export function reportText(i: LinuxInfo, extra: string[]): string {
  const icon = { ok: 'OK  ', warn: 'WARN', error: 'FAIL', info: 'INFO' };
  return [
    `ZERO Linux diagnostics, ${new Date().toISOString()}`,
    '',
    ...i.system.map(([k, v]) => `${k.padEnd(20)} ${v}`),
    '',
    ...i.checks.map((c) => `[${icon[c.level]}] ${c.label}: ${c.text}`),
    '',
    'Environment',
    ...['XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION', 'GDK_BACKEND', 'ELECTRON_OZONE_PLATFORM_HINT', 'LANG'].map((k) => `${k.padEnd(28)} ${process.env[k] ?? '(not set)'}`),
    ...(extra.length ? ['', ...extra] : []),
    '',
    'This report contains no account data, messages, cookies or tokens.',
  ].join('\n');
}
