import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Linux facts ZERO adapts to. Pure functions over files and environment variables: no Electron imports, no
 * shell commands, no root. Each one returns "unknown" rather than throwing when something is missing, so an
 * unusual distribution can never stop ZERO from starting.
 */

export interface OsRelease { id: string; name: string; version: string; idLike: string[] }

/** /etc/os-release (or /usr/lib/os-release): KEY=value lines, values optionally quoted. */
export function parseOsRelease(text: string): OsRelease {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let s = m[2]!.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    v[m[1]!] = s.slice(0, 120);
  }
  return {
    id: (v.ID ?? 'linux').toLowerCase(),
    name: v.PRETTY_NAME ?? v.NAME ?? 'Linux',
    version: v.VERSION_ID ?? '',
    idLike: (v.ID_LIKE ?? '').toLowerCase().split(/\s+/).filter(Boolean),
  };
}

export type SessionType = 'x11' | 'wayland' | 'tty' | 'unknown';
export interface Session { type: SessionType; desktop: string; wayland: boolean; display: boolean }

/** The display session from the standard variables (XDG_SESSION_TYPE, WAYLAND_DISPLAY, DISPLAY, XDG_CURRENT_DESKTOP). */
export function sessionInfo(env: Record<string, string | undefined>): Session {
  const declared = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  const wayland = !!env.WAYLAND_DISPLAY || declared === 'wayland';
  const type: SessionType = declared === 'wayland' || declared === 'x11' || declared === 'tty' ? declared
    : env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : 'unknown';
  const raw = env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || env.DESKTOP_SESSION || '';
  // "X-Cinnamon", "ubuntu:GNOME", "KDE" → readable names
  const parts = raw.split(':').map((p) => p.replace(/^X-/i, '').trim()).filter(Boolean);
  const known: Record<string, string> = { gnome: 'GNOME', kde: 'KDE Plasma', cinnamon: 'Cinnamon', xfce: 'XFCE', mate: 'MATE', lxqt: 'LXQt', lxde: 'LXDE', budgie: 'Budgie', pantheon: 'Pantheon', unity: 'Unity', hyprland: 'Hyprland', sway: 'Sway', cosmic: 'COSMIC' };
  const pick = parts.find((p) => known[p.toLowerCase()]) ?? parts[parts.length - 1] ?? '';
  const desktop = pick ? (known[pick.toLowerCase()] ?? pick.slice(0, 40)) : 'unknown';
  return { type, desktop, wayland, display: !!(env.DISPLAY || env.WAYLAND_DISPLAY) };
}

/**
 * The program name of a process from /proc/<pid>/cmdline (argv[0], NUL separated). Windows games running
 * through Wine/Proton show their .exe path here ("Z:\\games\\x\\Game.exe"), native games their binary.
 */
export function processName(cmdline: Buffer | string): string | null {
  const s = typeof cmdline === 'string' ? cmdline : cmdline.toString('utf8');
  const argv0 = s.split('\0')[0]?.trim();
  if (!argv0) return null;
  const base = argv0.replace(/\\/g, '/').split('/').pop()!.trim();
  return base && base.length <= 255 ? base : null;
}

/**
 * Names of running programs of this user, read from /proc (no command is run). Processes that vanish while
 * being read, or belong to other users with hidden details, are skipped.
 */
export async function listProcesses(procDir = '/proc'): Promise<string[]> {
  let entries: string[];
  try { entries = await fs.readdir(procDir); } catch { return []; }
  const names = new Set<string>();
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (pid) => {
    try {
      const n = processName(await fs.readFile(path.join(procDir, pid, 'cmdline')));
      if (n) { names.add(n); return; }
      const comm = (await fs.readFile(path.join(procDir, pid, 'comm'), 'utf8')).trim(); // kernel threads have no cmdline
      if (comm) names.add(comm);
    } catch { /* gone, or not readable */ }
  }));
  return [...names];
}

export type InstallFormat = 'appimage' | 'deb' | 'rpm' | 'flatpak' | 'snap' | 'unpacked' | 'dev';

/**
 * How this copy of ZERO was installed, which decides how a full update is applied.
 * AppImage sets $APPIMAGE; Flatpak and Snap set their own variables; the .deb and .rpm both install to
 * /opt/ZERO and are told apart by the package database that owns the file list.
 */
export function installFormat(o: { env: Record<string, string | undefined>; execPath: string; packaged: boolean; exists(p: string): boolean }): InstallFormat {
  if (!o.packaged) return 'dev';
  if (o.env.APPIMAGE && o.env.APPIMAGE.endsWith('.AppImage')) return 'appimage';
  if (o.env.FLATPAK_ID || o.exists('/.flatpak-info')) return 'flatpak';
  if (o.env.SNAP) return 'snap';
  if (o.execPath.startsWith('/opt/') || o.execPath.startsWith('/usr/')) {
    if (o.exists('/var/lib/dpkg/info/zero-client.list')) return 'deb';
    if (o.exists('/var/lib/rpm') || o.exists('/usr/lib/sysimage/rpm')) return 'rpm';
  }
  return 'unpacked';
}

export type AudioServer = 'pipewire' | 'pulseaudio' | 'alsa' | 'unknown';
export interface AudioInfo { server: AudioServer; pulseCompatible: boolean; detail: string }

/**
 * The sound server, from its sockets in $XDG_RUNTIME_DIR. Chromium (and so Discord's voice) talks to the
 * PulseAudio protocol: with PipeWire that is pipewire-pulse, which Linux Mint 22 and current distributions ship.
 */
export function audioInfo(runtimeDir: string | undefined, exists: (p: string) => boolean): AudioInfo {
  const pulse = !!runtimeDir && exists(path.join(runtimeDir, 'pulse', 'native'));
  const pipewire = !!runtimeDir && exists(path.join(runtimeDir, 'pipewire-0'));
  if (pipewire) return { server: 'pipewire', pulseCompatible: pulse, detail: pulse ? 'PipeWire with its PulseAudio layer (pipewire-pulse)' : 'PipeWire without pipewire-pulse: install it for voice and sound' };
  if (pulse) return { server: 'pulseaudio', pulseCompatible: true, detail: 'PulseAudio' };
  if (exists('/proc/asound/cards')) return { server: 'alsa', pulseCompatible: false, detail: 'ALSA only: no sound server found. Voice may not work until PipeWire or PulseAudio runs.' };
  return { server: 'unknown', pulseCompatible: false, detail: 'No sound server found' };
}

export interface PortalInfo { installed: boolean; backends: string[]; screencast: boolean }

/**
 * xdg-desktop-portal is what Wayland screen sharing goes through (with PipeWire). Its backends declare the
 * interfaces they implement in /usr/share/xdg-desktop-portal/portals/*.portal.
 */
export async function portalInfo(roots = ['/usr/share/xdg-desktop-portal/portals', '/usr/local/share/xdg-desktop-portal/portals']): Promise<PortalInfo> {
  const backends: string[] = [];
  let screencast = false;
  for (const dir of roots) {
    let files: string[] = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.portal'))) {
      backends.push(f.replace(/\.portal$/, ''));
      try { if (/org\.freedesktop\.impl\.portal\.ScreenCast/.test(await fs.readFile(path.join(dir, f), 'utf8'))) screencast = true; } catch { /* unreadable */ }
    }
  }
  return { installed: backends.length > 0, backends, screencast };
}

/** /proc/cpuinfo "model name" (the first one), or ''. */
export function cpuModel(cpuinfo: string): string {
  return /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim().slice(0, 100) ?? '';
}

/** The kernel driver of each GPU, from /sys/class/drm/card*\/device/driver (nvidia, amdgpu, i915, xe, nouveau…). */
export async function gpuDrivers(drm = '/sys/class/drm'): Promise<string[]> {
  const out = new Set<string>();
  let cards: string[] = [];
  try { cards = (await fs.readdir(drm)).filter((c) => /^card\d+$/.test(c)); } catch { return []; }
  for (const c of cards) {
    try { out.add(path.basename(await fs.readlink(path.join(drm, c, 'device', 'driver')))); } catch { /* virtual card */ }
  }
  return [...out];
}
