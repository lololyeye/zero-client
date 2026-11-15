import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { listProcesses as linuxProcesses } from './linux';
import { parseTasklist } from '../../shared/builtins';

/**
 * What differs between the Windows and Linux editions of ZERO, in one place. Everything else is shared code.
 * Windows keeps exactly the behaviour it had before Linux support existed.
 */
export type PlatformId = 'win32' | 'linux';
export const PLATFORM: PlatformId = process.platform === 'linux' ? 'linux' : 'win32';
export const IS_LINUX = PLATFORM === 'linux';

export interface Capabilities {
  /** System sound in screen shares. Electron captures it on Windows only (loopback); on Linux the picture is shared without it. */
  streamAudio: boolean;
  /** The OS names Discord's list of detectable games uses for this platform (Linux also runs Windows games through Proton). */
  gameOs: string[];
}

export const CAPABILITIES: Capabilities = IS_LINUX
  ? { streamAudio: false, gameOs: ['linux', 'win32'] }
  : { streamAudio: true, gameOs: ['win32'] };

/** The platform part of the browser user agent Discord sees (it must match the system ZERO runs on). */
export const UA_PLATFORM = IS_LINUX ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';

/**
 * Names of running programs, for GameDetection.
 * Windows: `tasklist` with a filter (see games.ts for why). Linux: /proc, no command at all.
 */
export function runningPrograms(windowsFilter: string): Promise<string[]> {
  if (IS_LINUX) return linuxProcesses();
  return new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh', '/fi', windowsFilter], { windowsHide: true, timeout: 10_000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? [] : parseTasklist(out)));
  });
}

export const fileExists = (p: string) => { try { return existsSync(p); } catch { return false; } };
export const readText = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
