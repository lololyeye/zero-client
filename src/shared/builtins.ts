/**
 * Built-in plugins: shipped with ZERO, reviewed code, off by default. Each one runs only while enabled, so a
 * disabled plugin costs nothing. None of them reads, stores or sends account credentials.
 */

export type SettingValue = string | boolean | string[];

export type SettingDef =
  | { key: string; label: string; type: 'bool'; default: boolean }
  | { key: string; label: string; type: 'text'; default: string; max: number; placeholder?: string }
  | { key: string; label: string; type: 'select'; default: string; options: { value: string; label: string }[] }
  | { key: string; label: string; type: 'list'; default: string[]; placeholder?: string };

export interface BuiltinDef {
  id: string;
  name: string;
  description: string;
  /** shown under the description when the plugin depends on another one */
  note?: string;
  settings: SettingDef[];
}

export interface BuiltinState { enabled: boolean; settings: Record<string, SettingValue> }

export const BUILTINS: BuiltinDef[] = [
  {
    id: 'accountPanelServerProfile', name: 'AccountPanelServerProfile',
    description: 'Right click your account panel in the bottom left to view your profile in the current server',
    settings: [],
  },
  {
    id: 'autoDndWhilePlaying', name: 'AutoDNDWhilePlaying',
    description: 'Automatically updates your online status (online, idle, dnd) when launching games',
    note: 'Uses the games found by GameDetection.',
    settings: [
      { key: 'status', label: 'Status while playing', type: 'select', default: 'dnd', options: [
        { value: 'dnd', label: 'Do Not Disturb' }, { value: 'idle', label: 'Idle' }, { value: 'invisible', label: 'Invisible' }] },
    ],
  },
  {
    id: 'callTimer', name: 'CallTimer',
    description: 'Adds a timer to vcs',
    settings: [{ key: 'format', label: 'Format', type: 'select', default: 'stopwatch', options: [
      { value: 'stopwatch', label: '01:02:03' }, { value: 'human', label: '1h 2m 3s' }] }],
  },
  {
    id: 'crashHandler', name: 'CrashHandler',
    description: 'Utility plugin for handling and possibly recovering from crashes without a restart',
    note: 'Reloads Discord when its "Something went wrong" screen appears (at most 3 times in 10 minutes).',
    settings: [],
  },
  {
    id: 'customRpc', name: 'CustomRPC',
    description: 'Add a fully customisable Rich Presence (Game status) to your Discord profile',
    note: 'Visible to others only while "Share your activity" is on (see GameActivityToggle).',
    settings: [
      { key: 'type', label: 'Activity type', type: 'select', default: '0', options: [
        { value: '0', label: 'Playing' }, { value: '2', label: 'Listening to' }, { value: '3', label: 'Watching' }, { value: '5', label: 'Competing in' }] },
      { key: 'name', label: 'Name', type: 'text', default: 'ZERO', max: 128, placeholder: 'Required' },
      { key: 'details', label: 'Details (first line)', type: 'text', default: '', max: 128 },
      { key: 'state', label: 'State (second line)', type: 'text', default: '', max: 128 },
      { key: 'appId', label: 'Application ID (optional, for images)', type: 'text', default: '', max: 20, placeholder: 'Digits only' },
      { key: 'largeImage', label: 'Large image key (an asset name of that application)', type: 'text', default: '', max: 128 },
      { key: 'elapsed', label: 'Show elapsed time', type: 'bool', default: true },
    ],
  },
  {
    id: 'gameActivityToggle', name: 'GameActivityToggle',
    description: 'Adds a button next to the mic and deafen button to toggle game activity.',
    settings: [],
  },
  {
    id: 'gameDetection', name: 'GameDetection',
    description: 'Detects the games you are running and shows them on your profile, like the Discord desktop app',
    note: 'Checks the list of running programs every 15 seconds while enabled.',
    settings: [],
  },
  {
    id: 'ignoreActivities', name: 'IgnoreActivities',
    description: 'Ignore activities from showing up on your status ONLY. You can configure which ones are specifically ignored.',
    note: 'One game name per line, as shown on your profile.',
    settings: [{ key: 'ignored', label: 'Ignored games', type: 'list', default: [], placeholder: 'e.g. Valorant' }],
  },
  {
    id: 'messageLogger', name: 'MessageLogger',
    description: 'Temporarily logs deleted and edited messages.',
    note: 'Kept in memory only, cleared when ZERO restarts.',
    settings: [
      { key: 'ignoreSelf', label: 'Ignore my own messages', type: 'bool', default: true },
      { key: 'ignoreBots', label: 'Ignore bots', type: 'bool', default: false },
      { key: 'logEdits', label: 'Show previous versions of edited messages', type: 'bool', default: true },
    ],
  },
  {
    id: 'platformIndicators', name: 'PlatformIndicators',
    description: 'Adds platform indicators (Desktop, Mobile, Web...) to users',
    settings: [
      { key: 'memberList', label: 'Member list', type: 'bool', default: true },
      { key: 'messages', label: 'Messages', type: 'bool', default: true },
      { key: 'dms', label: 'Direct messages list', type: 'bool', default: true },
    ],
  },
];

export const BUILTIN_IDS = new Set(BUILTINS.map((b) => b.id));

function sanitizeValue(def: SettingDef, v: unknown): SettingValue {
  switch (def.type) {
    case 'bool': return typeof v === 'boolean' ? v : def.default;
    case 'text': return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, def.max) : def.default;
    case 'select': return typeof v === 'string' && def.options.some((o) => o.value === v) ? v : def.default;
    case 'list': return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 128)).filter(Boolean).slice(0, 100) : def.default;
  }
}

export function sanitizeBuiltin(def: BuiltinDef, raw: any): BuiltinState {
  const settings: Record<string, SettingValue> = {};
  for (const s of def.settings) settings[s.key] = sanitizeValue(s, raw?.settings?.[s.key]);
  return { enabled: raw?.enabled === true, settings };
}

export function sanitizeBuiltins(raw: any): Record<string, BuiltinState> {
  return Object.fromEntries(BUILTINS.map((d) => [d.id, sanitizeBuiltin(d, raw?.[d.id])]));
}

/** Only the plugins that are on, with their settings: what the Discord page receives. */
export function activeBuiltins(all: Record<string, BuiltinState>, safeMode: boolean): Record<string, Record<string, SettingValue>> {
  if (safeMode) return {};
  return Object.fromEntries(Object.entries(all).filter(([, s]) => s.enabled).map(([id, s]) => [id, s.settings]));
}

/** Rich presence built from CustomRPC settings (null when it would be invalid). */
export function customActivity(s: Record<string, SettingValue>, startedAt: number): Record<string, unknown> | null {
  const name = String(s.name ?? '').trim();
  if (!name) return null;
  const a: Record<string, unknown> = { name, type: Number(s.type ?? 0) || 0, flags: 1 };
  const appId = String(s.appId ?? '').trim();
  if (/^\d{17,20}$/.test(appId)) a.application_id = appId;
  const details = String(s.details ?? '').trim(); if (details) a.details = details;
  const state = String(s.state ?? '').trim(); if (state) a.state = state;
  const img = String(s.largeImage ?? '').trim();
  if (img && a.application_id && /^[\w-]{1,128}$/.test(img)) a.assets = { large_image: img };
  if (s.elapsed) a.timestamps = { start: startedAt };
  return a;
}

/** Process name matching for GameDetection: Discord's list gives "folder/game.exe"; Windows gives "game.exe". */
const GENERIC = new Set(['launcher.exe', 'game.exe', 'client.exe', 'start.exe', 'setup.exe', 'update.exe', 'updater.exe', 'app.exe', 'main.exe', 'play.exe', 'run.exe', 'bootstrap.exe', 'unitycrashhandler64.exe', 'crashreporter.exe', 'java.exe', 'javaw.exe', 'python.exe', 'node.exe', 'electron.exe', 'chrome.exe', 'discord.exe', 'zero.exe', 'steam.exe', 'explorer.exe']);

export interface Detectable { id: string; name: string; exes: string[] }

export function buildDetectableIndex(list: unknown): Map<string, Detectable> {
  const idx = new Map<string, Detectable>();
  if (!Array.isArray(list)) return idx;
  for (const app of list) {
    if (!app || typeof app.id !== 'string' || typeof app.name !== 'string' || !Array.isArray(app.executables)) continue;
    const exes: string[] = [];
    for (const e of app.executables) {
      if (!e || e.os !== 'win32' || typeof e.name !== 'string' || e.is_launcher === true) continue;
      const base = e.name.toLowerCase().replace(/\\/g, '/').split('/').pop()!;
      if (!base.endsWith('.exe') || GENERIC.has(base) || base.startsWith('>')) continue;
      exes.push(base);
    }
    const d = { id: app.id, name: app.name, exes };
    for (const x of exes) if (!idx.has(x)) idx.set(x, d);
  }
  return idx;
}

export function matchGame(processNames: string[], idx: Map<string, Detectable>, ignored: string[]): Detectable | null {
  const skip = new Set(ignored.map((n) => n.toLowerCase()));
  for (const p of processNames) {
    const d = idx.get(p.toLowerCase());
    if (d && !skip.has(d.name.toLowerCase())) return d;
  }
  return null;
}

/** "Image Name","PID",... rows from `tasklist /fo csv /nh` → image names. */
export function parseTasklist(csv: string): string[] {
  const names = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}
