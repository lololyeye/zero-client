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

/** Plugin catalog groups (Settings > Plugins). */
export const CATEGORIES = {
  chat: 'Chat', voice: 'Voice & streaming', presence: 'Status & games', appearance: 'Appearance & profiles', privacy: 'Privacy & notifications', tools: 'Tools',
} as const;
export type Category = keyof typeof CATEGORIES;

export interface BuiltinDef {
  id: string;
  name: string;
  category: Category;
  description: string;
  /** shown under the description when the plugin depends on another one */
  note?: string;
  settings: SettingDef[];
}

export interface BuiltinState { enabled: boolean; settings: Record<string, SettingValue> }

export const BUILTINS: BuiltinDef[] = [
  {
    id: 'accountPanelServerProfile', name: 'AccountPanelServerProfile', category: 'presence',
    description: 'Right click your account panel in the bottom left to view your profile in the current server',
    settings: [],
  },
  {
    id: 'autoDndWhilePlaying', name: 'AutoDNDWhilePlaying', category: 'presence',
    description: 'Automatically updates your online status (online, idle, dnd) when launching games',
    note: 'Uses the games found by GameDetection.',
    settings: [
      { key: 'status', label: 'Status while playing', type: 'select', default: 'dnd', options: [
        { value: 'dnd', label: 'Do Not Disturb' }, { value: 'idle', label: 'Idle' }, { value: 'invisible', label: 'Invisible' }] },
    ],
  },
  {
    id: 'callTimer', name: 'CallTimer', category: 'voice',
    description: 'Adds a timer to vcs',
    settings: [{ key: 'format', label: 'Format', type: 'select', default: 'stopwatch', options: [
      { value: 'stopwatch', label: '01:02:03' }, { value: 'human', label: '1h 2m 3s' }] }],
  },
  {
    id: 'connectionDoctor', name: 'ConnectionDoctor', category: 'voice',
    description: 'Live network check for calls: ping, packet loss, jitter, voice server, drops, with plain advice.',
    note: 'In the ZERO panel (Ctrl+Shift+L) › Connection. Reads Discord\'s own call numbers; "Copy report" leaves out addresses and names.',
    settings: [],
  },
  {
    id: 'crashHandler', name: 'CrashHandler', category: 'tools',
    description: 'Utility plugin for handling and possibly recovering from crashes without a restart',
    note: 'Reloads Discord when its "Something went wrong" screen appears (at most 3 times in 10 minutes).',
    settings: [],
  },
  {
    id: 'customRpc', name: 'CustomRPC', category: 'presence',
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
    id: 'gameActivityToggle', name: 'GameActivityToggle', category: 'presence',
    description: 'Adds a button next to the mic and deafen button to toggle game activity.',
    settings: [],
  },
  {
    id: 'gameDetection', name: 'GameDetection', category: 'presence',
    description: 'Detects the games you are running and shows them on your profile, like the Discord desktop app',
    note: 'Checks the list of running programs every 15 seconds while enabled.',
    settings: [],
  },
  {
    id: 'ignoreActivities', name: 'IgnoreActivities', category: 'presence',
    description: 'Ignore activities from showing up on your status ONLY. You can configure which ones are specifically ignored.',
    note: 'One game name per line, as shown on your profile.',
    settings: [{ key: 'ignored', label: 'Ignored games', type: 'list', default: [], placeholder: 'e.g. Valorant' }],
  },
  {
    id: 'micStudio', name: 'MicStudio', category: 'voice',
    description: 'Test your microphone live: level, clipping, background noise, sensitivity check. Save and switch voice setting profiles.',
    note: 'In the ZERO panel (Ctrl+Shift+L) › Mic. The test stays on your PC and is never recorded. Profiles apply your Discord voice settings with Discord\'s own actions.',
    settings: [],
  },
  {
    id: 'messageLogger', name: 'MessageLogger', category: 'chat',
    description: 'Temporarily logs deleted and edited messages.',
    note: 'Kept in memory only, cleared when ZERO restarts.',
    settings: [
      { key: 'ignoreSelf', label: 'Ignore my own messages', type: 'bool', default: true },
      { key: 'ignoreBots', label: 'Ignore bots', type: 'bool', default: false },
      { key: 'logEdits', label: 'Show previous versions of edited messages', type: 'bool', default: true },
    ],
  },
  {
    id: 'messageReminder', name: 'MessageReminder', category: 'chat',
    description: 'Right click a message › Remind me: in 10 minutes, tomorrow, next week. ZERO brings you back to the message.',
    note: 'Reminders ring while ZERO is running (one that was due while it was closed rings at the next start). Listed in the ZERO panel (Ctrl+Shift+L). Saved on this PC only.',
    settings: [],
  },
  {
    id: 'platformIndicators', name: 'PlatformIndicators', category: 'presence',
    description: 'Adds platform indicators (Desktop, Mobile, Web...) to users',
    settings: [
      { key: 'memberList', label: 'Member list', type: 'bool', default: true },
      { key: 'messages', label: 'Messages', type: 'bool', default: true },
      { key: 'dms', label: 'Direct messages list', type: 'bool', default: true },
    ],
  },
  {
    id: 'privacyMode', name: 'PrivacyMode', category: 'privacy',
    description: 'Ctrl+Shift+H blurs names, avatars and message previews before you share your screen.',
    note: 'A red badge shows while it is on. Nothing is changed on your account.',
    settings: [
      { key: 'names', label: 'Blur names', type: 'bool', default: true },
      { key: 'avatars', label: 'Blur avatars', type: 'bool', default: true },
      { key: 'previews', label: 'Blur statuses and previews (DM list, activities)', type: 'bool', default: true },
      { key: 'messages', label: 'Blur message text, images and embeds', type: 'bool', default: false },
      { key: 'notifications', label: 'Hide names and text in desktop notifications', type: 'bool', default: true },
      { key: 'hover', label: 'Show a blurred item while the mouse is over it', type: 'bool', default: false },
      { key: 'autoStream', label: 'Turn on by itself while you share your screen', type: 'bool', default: false },
    ],
  },
  {
    id: 'quickNotes', name: 'QuickNotes', category: 'tools',
    description: 'A small notepad inside ZERO: notes, lists, links, from any server.',
    note: 'In the ZERO panel (Ctrl+Shift+L, or the button in the channel header). Saved on this PC only.',
    settings: [],
  },
  {
    id: 'smartBookmarks', name: 'SmartBookmarks', category: 'chat',
    description: 'Save messages, images, links and files into your own collections, and search them all.',
    note: 'Right click a message › Save message. Browse in the ZERO panel (Ctrl+Shift+L). Saved on this PC only; Discord image links can expire, the message link stays.',
    settings: [],
  },
  {
    id: 'smartAudioFocus', name: 'SmartAudioFocus', category: 'voice',
    description: 'Lowers or silences chosen Discord sounds while you are in a call, streaming or gaming.',
    note: 'Incoming call ringing is never changed. Only Discord\'s own sounds are affected, never voices or streams.',
    settings: [
      { key: 'when', label: 'When', type: 'select', default: 'call', options: [
        { value: 'call', label: 'In a call or streaming' }, { value: 'stream', label: 'Only while streaming' }, { value: 'game', label: 'While a game runs or streaming (GameDetection)' }] },
      { key: 'messages', label: 'Message sounds', type: 'select', default: 'quiet', options: [{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quieter' }, { value: 'mute', label: 'Silent' }] },
      { key: 'mentions', label: 'Mention sounds', type: 'select', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quieter' }, { value: 'mute', label: 'Silent' }] },
      { key: 'voice', label: 'People joining or leaving the call', type: 'select', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quieter' }, { value: 'mute', label: 'Silent' }] },
      { key: 'streams', label: 'Stream start, stop and viewers', type: 'select', default: 'quiet', options: [{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quieter' }, { value: 'mute', label: 'Silent' }] },
      { key: 'self', label: 'Your mute, deafen and push-to-talk', type: 'select', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quieter' }, { value: 'mute', label: 'Silent' }] },
      { key: 'level', label: 'How quiet is "Quieter"', type: 'select', default: '25', options: [
        { value: '50', label: 'Half volume' }, { value: '25', label: 'A quarter' }, { value: '10', label: 'Barely audible' }] },
    ],
  },
  {
    id: 'smartText', name: 'SmartText', category: 'chat',
    description: 'Saved replies with variables. Type ;; in a message box to insert one.',
    note: 'Variables: {me}, {user} (the person in a DM, or the one you are replying to), {channel}, {server}, {date}, {time}. Inserted into the box, never sent for you. Manage them in the ZERO panel (Ctrl+Shift+L).',
    settings: [],
  },
  {
    id: 'streamPresets', name: 'StreamPresets', category: 'voice',
    description: 'Saved screen-share setups in ZERO\'s picker: one click shares the same screen or app, with or without sound.',
    note: 'The picker also reopens on your last source and says whether your graphics card encodes the stream. Resolution and frame rate stay in Discord\'s stream menu, under its own Nitro rules.',
    settings: [],
  },
  {
    id: 'voiceAnalytics', name: 'VoiceAnalytics', category: 'voice',
    description: 'A history of your calls: duration, ping, packet loss, voice server changes and drops.',
    note: 'Numbers only, kept on this PC (last 200 calls). Never audio, never who was in the call. In the ZERO panel › Calls.',
    settings: [],
  },
  {
    id: 'chatFilters', name: 'ChatFilters', category: 'chat',
    description: 'Hide, fold or dim messages by word, person or bots, only on your screen.',
    note: 'Nothing is deleted or reported: the messages stay in Discord and a folded one opens with a click.',
    settings: [
      { key: 'words', label: 'Messages containing (one word or phrase per line)', type: 'list', default: [], placeholder: 'spoiler\nleague of legends' },
      { key: 'people', label: 'Messages from (user names or IDs, one per line)', type: 'list', default: [] },
      { key: 'bots', label: 'Messages from bots', type: 'bool', default: false },
      { key: 'mode', label: 'Filtered messages are', type: 'select', default: 'collapse', options: [
        { value: 'collapse', label: 'Folded (click to show)' }, { value: 'dim', label: 'Dimmed' }, { value: 'hide', label: 'Hidden' }] },
      { key: 'keepMentions', label: 'Never filter a message that mentions you', type: 'bool', default: true },
    ],
  },
  {
    id: 'clipboardManager', name: 'ClipboardManager', category: 'tools',
    description: 'A short history of what you copy in ZERO, to copy again or insert into a message.',
    note: 'Only copies made inside ZERO, kept in memory: the list is gone when Discord reloads or ZERO closes. In the ZERO panel › Clipboard.',
    settings: [
      { key: 'max', label: 'Keep', type: 'select', default: '30', options: [{ value: '15', label: 'Last 15' }, { value: '30', label: 'Last 30' }, { value: '50', label: 'Last 50' }] },
      { key: 'menus', label: 'Also keep what Discord\'s menus copy (Copy Text, Copy Link)', type: 'bool', default: true },
    ],
  },
  {
    id: 'downloadManager', name: 'DownloadManager', category: 'tools',
    description: 'Lists the files you download from Discord, with their progress, and finds them in their folder.',
    note: 'In the ZERO panel › Downloads. Pictures, videos, sound, PDF and text open directly; other files are only shown in their folder.',
    settings: [
      { key: 'folder', label: 'Where files go', type: 'select', default: 'ask', options: [{ value: 'ask', label: 'Ask every time' }, { value: 'downloads', label: 'Straight to the Downloads folder' }] },
    ],
  },
  {
    id: 'inlineTranslator', name: 'InlineTranslator', category: 'chat',
    description: 'Right click a message › Translate: the translation shows under it.',
    note: 'Only the text of the message you pick is sent, to the MyMemory translation service (api.mymemory.translated.net), and nothing else. Up to 500 characters per message.',
    settings: [
      { key: 'to', label: 'Translate into', type: 'select', default: 'en', options: [{ value: 'en', label: 'English' }, { value: 'fr', label: 'French' }, { value: 'es', label: 'Spanish' }, { value: 'de', label: 'German' }, { value: 'it', label: 'Italian' }, { value: 'pt', label: 'Portuguese' }, { value: 'nl', label: 'Dutch' }, { value: 'pl', label: 'Polish' }, { value: 'tr', label: 'Turkish' }, { value: 'ru', label: 'Russian' }, { value: 'uk', label: 'Ukrainian' }, { value: 'ar', label: 'Arabic' }, { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' }, { value: 'zh-CN', label: 'Chinese (simplified)' }] },
    ],
  },
  {
    id: 'messageStats', name: 'MessageStatistics', category: 'chat',
    description: 'Your own activity: messages you send each day, DMs and mentions received, your most active channels.',
    note: 'Counted on this PC from the moment it is on, numbers only (never message text). In the ZERO panel › Stats.',
    settings: [],
  },
  {
    id: 'multiPanel', name: 'MultiPanel', category: 'tools',
    description: 'Keep a second channel open beside the main one (split view).',
    note: 'The button next to the ZERO panel button pins the channel you are in to the right. The side panel is a second Discord page: it uses more memory (about 200 MB).',
    settings: [
      { key: 'width', label: 'Side panel width', type: 'select', default: '40', options: [{ value: '33', label: 'A third' }, { value: '40', label: '40%' }, { value: '50', label: 'Half' }] },
    ],
  },
  {
    id: 'notificationProfiles', name: 'NotificationProfiles', category: 'privacy',
    description: 'Quiet hours and focus rules for Discord\'s desktop notifications: while gaming, streaming or in a call.',
    note: 'Only the popups are held back, your Discord settings are not changed. For sounds, see SmartAudioFocus.',
    settings: [
      { key: 'quiet', label: 'Quiet hours', type: 'bool', default: false },
      { key: 'from', label: 'Quiet from', type: 'select', default: '23', options: [{ value: '0', label: '00:00' }, { value: '1', label: '01:00' }, { value: '2', label: '02:00' }, { value: '3', label: '03:00' }, { value: '4', label: '04:00' }, { value: '5', label: '05:00' }, { value: '6', label: '06:00' }, { value: '7', label: '07:00' }, { value: '8', label: '08:00' }, { value: '9', label: '09:00' }, { value: '10', label: '10:00' }, { value: '11', label: '11:00' }, { value: '12', label: '12:00' }, { value: '13', label: '13:00' }, { value: '14', label: '14:00' }, { value: '15', label: '15:00' }, { value: '16', label: '16:00' }, { value: '17', label: '17:00' }, { value: '18', label: '18:00' }, { value: '19', label: '19:00' }, { value: '20', label: '20:00' }, { value: '21', label: '21:00' }, { value: '22', label: '22:00' }, { value: '23', label: '23:00' }] },
      { key: 'to', label: 'Quiet until', type: 'select', default: '8', options: [{ value: '0', label: '00:00' }, { value: '1', label: '01:00' }, { value: '2', label: '02:00' }, { value: '3', label: '03:00' }, { value: '4', label: '04:00' }, { value: '5', label: '05:00' }, { value: '6', label: '06:00' }, { value: '7', label: '07:00' }, { value: '8', label: '08:00' }, { value: '9', label: '09:00' }, { value: '10', label: '10:00' }, { value: '11', label: '11:00' }, { value: '12', label: '12:00' }, { value: '13', label: '13:00' }, { value: '14', label: '14:00' }, { value: '15', label: '15:00' }, { value: '16', label: '16:00' }, { value: '17', label: '17:00' }, { value: '18', label: '18:00' }, { value: '19', label: '19:00' }, { value: '20', label: '20:00' }, { value: '21', label: '21:00' }, { value: '22', label: '22:00' }, { value: '23', label: '23:00' }] },
      { key: 'gaming', label: 'Hold notifications while a game runs (GameDetection)', type: 'bool', default: true },
      { key: 'streaming', label: 'Hold notifications while you share your screen', type: 'bool', default: true },
      { key: 'calls', label: 'Hold notifications while you are in a call', type: 'bool', default: false },
      { key: 'dms', label: 'Still show direct messages', type: 'bool', default: true },
      { key: 'allow', label: 'Always show notifications from (names, one per line)', type: 'list', default: [] },
    ],
  },
  {
    id: 'themeStudio', name: 'ThemeStudio', category: 'appearance',
    description: 'Builds a full color palette from two colors, checks that text stays readable and fixes it in one click.',
    note: 'In ZERO Settings › Colors. It only writes colors of your own theme: no code, nothing from the internet.',
    settings: [],
  },
  {
    id: 'voiceOverlay', name: 'VoiceOverlay', category: 'voice',
    description: 'A small always-on-top list of who is in your call and who is talking, over your games.',
    note: 'Shown only while you are in a call. Clicks go through it. Works over windowed and borderless games, not exclusive fullscreen.',
    settings: [
      { key: 'corner', label: 'Position', type: 'select', default: 'tl', options: [{ value: 'tl', label: 'Top left' }, { value: 'tr', label: 'Top right' }, { value: 'bl', label: 'Bottom left' }, { value: 'br', label: 'Bottom right' }] },
      { key: 'show', label: 'Show', type: 'select', default: 'all', options: [{ value: 'all', label: 'Everyone in the call' }, { value: 'speaking', label: 'Only who is talking' }] },
      { key: 'size', label: 'Size', type: 'select', default: 'normal', options: [{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }] },
    ],
  },
  {
    id: 'workspaceProfiles', name: 'WorkspaceProfiles', category: 'appearance',
    description: 'Save your theme, layout, performance profile and plugins as a workspace ("Gaming", "Work"...) and switch in one click.',
    note: 'In ZERO Settings › Workspaces, and in the tray menu.',
    settings: [],
  },
  {
    id: 'zeroDashboard', name: 'ZERO Dashboard', category: 'tools',
    description: 'A home tab in the ZERO panel: next reminders, saved messages, pinned notes, your last call and today\'s stats.',
    note: 'It shows what the other plugins keep, only for the ones that are on.',
    settings: [],
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
