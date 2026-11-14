import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildDetectableIndex, matchGame, parseTasklist, type Detectable } from '../shared/builtins';

const LIST_URL = 'https://discord.com/api/v9/applications/detectable'; // public list, no account involved
const LIST_MAX_AGE = 7 * 24 * 3600_000;
const SCAN_MS = 15_000;

export interface DetectedGame { id: string; name: string; start: number }

/**
 * GameDetection: while enabled, reads the names of running programs every 15 s (Windows `tasklist`, no elevated
 * rights, nothing else read) and matches them against Discord's public list of detectable games.
 * Disabled = no timer, no process at all.
 */
export function createGameDetector(o: { dir: string; log: { info(m: string): void; warn(m: string, e?: unknown): void }; onChange(g: DetectedGame | null): void }) {
  let index: Map<string, Detectable> | null = null;
  let loading: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let ignored: string[] = [];
  let current: DetectedGame | null = null;
  let scanning = false;
  const file = path.join(o.dir, 'detectable-games.json');

  async function loadIndex(): Promise<void> {
    let raw: string | null = null;
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs < LIST_MAX_AGE) raw = await fs.readFile(file, 'utf8');
    } catch { /* no cache yet */ }
    if (!raw) {
      try {
        const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.text();
        await fs.writeFile(file, raw);
      } catch (err) {
        o.log.warn('game list download failed', err);
        try { raw = await fs.readFile(file, 'utf8'); } catch { raw = '[]'; }
      }
    }
    try { index = buildDetectableIndex(JSON.parse(raw)); } catch { index = new Map(); }
    o.log.info(`game detection: ${index.size} executables known`);
  }

  /**
   * A plain `tasklist` costs ~700 ms of CPU on a typical desktop (~270 processes): too much every 15 s while a game
   * runs. Measured on a Ryzen 5 3600: the full scan only lists processes using > 40 MB (~240 ms, a running game
   * always does), and while a game is detected only that executable is checked (~30 ms).
   */
  function listProcesses(filter: string): Promise<string[]> {
    return new Promise((resolve) => {
      execFile('tasklist', ['/fo', 'csv', '/nh', '/fi', filter], { windowsHide: true, timeout: 10_000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? [] : parseTasklist(out)));
    });
  }
  let currentExe: string | null = null;

  async function scan(): Promise<void> {
    if (scanning || !timer) return;
    scanning = true;
    try {
      if (!index) await (loading ??= loadIndex());
      const idx = index ?? new Map<string, Detectable>();
      // Still running? (a minimized game can drop below the size filter, so it is checked by name)
      if (current && currentExe && /^[\w .()+-]+\.exe$/i.test(currentExe)) {
        const still = await listProcesses(`IMAGENAME eq ${currentExe}`);
        if (still.some((p) => p.toLowerCase() === currentExe)) return;
      }
      const procs = await listProcesses('MEMUSAGE gt 40000');
      const g = matchGame(procs, idx, ignored);
      currentExe = g ? (procs.find((p) => idx.get(p.toLowerCase()) === g)?.toLowerCase() ?? null) : null;
      if ((g?.id ?? null) !== (current?.id ?? null)) {
        current = g ? { id: g.id, name: g.name, start: Date.now() } : null;
        o.log.info(current ? `game detected: ${current.name}` : 'game closed');
        if (timer) o.onChange(current);
      }
    } finally { scanning = false; }
  }

  return {
    get current() { return current; },
    configure(enabled: boolean, ignoredNames: string[]) {
      const changedIgnore = JSON.stringify(ignoredNames) !== JSON.stringify(ignored);
      ignored = ignoredNames;
      if (enabled && !timer) {
        timer = setInterval(() => void scan(), SCAN_MS);
        timer.unref();
        void scan();
      } else if (!enabled && timer) {
        clearInterval(timer); timer = null;
        if (current) { current = null; o.onChange(null); }
      } else if (enabled && changedIgnore) {
        if (current && ignored.some((n) => n.toLowerCase() === current!.name.toLowerCase())) { current = null; o.onChange(null); }
        void scan();
      }
    },
  };
}
