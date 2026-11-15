import {
  app, BrowserWindow, WebContentsView, ipcMain, shell, session, protocol, Tray, Menu, nativeImage, dialog, net,
  type WebContents,
} from 'electron';
import { chromeUserAgent, createPicker } from './capture';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs, readFileSync } from 'node:fs';

const bootStart = performance.now();
import { ConfigStore } from './store';
import { Logger } from './logger';
import { ImageStore } from './images';
import { loadPlugins, type LoadedPlugins } from './plugins';
import { COMPAT_PROBE_SCRIPT, evaluateCompat, type CompatReport } from './inject';
import { recommendations, sessionGrowth, stallStats, summarizeMetrics, type MediaStream, type PerfSnapshot } from './perf';
import { activeTheme, applyThemeEdit, composeDiscordCss, referencedImages } from './compose';
import * as T from './themeOps';
import { resolvePerf, sanitizeConfig, sanitizeLayout, sanitizePerfOptions, toPerfProfile, type Config, type PerfProfile } from '../shared/config';
import { validateTheme } from '../shared/theme';
import { CHANNELS } from '../shared/ipc';
import { routeKind } from '../preload/controller';
import type { UpdateState } from './updates';
import { createUpdater } from './updater';
import { createOverlay } from './overlay';
import { createGameDetector } from './games';
import { activeBuiltins, BUILTINS, sanitizeBuiltin } from '../shared/builtins';
import { PluginDataStore } from './pluginData';
import { isDataPlugin, PAGE_DATA_PLUGINS, type PluginData } from '../shared/pluginData';

const APP_NAME = 'ZERO';
const BRANCH_URL = { stable: 'https://discord.com/app', ptb: 'https://ptb.discord.com/app', canary: 'https://canary.discord.com/app' } as const;
const DISCORD_HOSTS = /^(?:[\w-]+\.)?(?:discord\.com|discordapp\.com|discord\.gg|discord\.media|discordapp\.net)$/i;
const ALLOWED_PERMS = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'mediaKeySystem']);

protocol.registerSchemesAsPrivileged([
  // bypassCSP: Discord's CSP would otherwise refuse our local background images. The handler serves ONLY
  // validated files from the backgrounds folder (no arbitrary filesystem access).
  { scheme: 'zero-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

let config: Config;
let store: ConfigStore;
let log: Logger;
let images: ImageStore;
let plugins: LoadedPlugins = { infos: [], css: new Map() };
let discordWin: BrowserWindow | null = null;
/** ZERO settings: a layer inside the Discord window (like Discord's own settings), not a separate window. */
let settingsView: WebContentsView | null = null;
let tray: Tray | null = null;
let quitting = false;
let startupMs: number | null = null;
let notes: string[] = [];
let compat: CompatReport | null = null;
let gpuInfo: string | null = null;
// Session memory history: one getAppMetrics() call per minute (a few microseconds), at most 24 h of points.
const ramHistory: number[] = [];
function startRamHistory() {
  setInterval(() => {
    ramHistory.push(summarizeMetrics(app.getAppMetrics() as any).ramMb);
    if (ramHistory.length > 1440) ramHistory.shift();
  }, 60_000).unref();
}
// Main-process stalls: how late a 250 ms timer fires (Windows timers add 0-16 ms of normal jitter). Runs only
// while the Performance page is polling, over the last minute.
let loopSamples: number[] = [];
let loopTimer: NodeJS.Timeout | null = null;
let loopIdle: NodeJS.Timeout | null = null;
function eventLoopStats() {
  if (!loopTimer) {
    let last = performance.now();
    loopTimer = setInterval(() => {
      const now = performance.now();
      loopSamples.push(Math.max(0, now - last - 250)); last = now;
      if (loopSamples.length > 240) loopSamples.shift();
    }, 250);
    loopTimer.unref();
  }
  if (loopIdle) clearTimeout(loopIdle);
  loopIdle = setTimeout(() => { if (loopTimer) clearInterval(loopTimer); loopTimer = null; loopSamples = []; }, 10_000);
  loopIdle.unref();
  return stallStats(loopSamples);
}
// Voice / stream statistics from the Discord page (only on request, see preload/mediastats.ts).
let rtcSeq = 0;
const rtcWaiting = new Map<number, (detail: string) => void>();
function requestMedia(): Promise<PerfSnapshot['media']> {
  const wc = discordWin?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(null);
  const id = ++rtcSeq;
  return new Promise((resolve) => {
    const done = (detail: string | null) => { rtcWaiting.delete(id); resolve(detail === null ? null : parseMedia(detail)); };
    const t = setTimeout(() => done(null), 2500);
    rtcWaiting.set(id, (d) => { clearTimeout(t); done(d); });
    wc.send('zero:rtc-req', id);
  });
}
/** The page is untrusted input: keep known fields with the right types only. */
function parseMedia(detail: string): PerfSnapshot['media'] {
  let raw: any; try { raw = JSON.parse(detail); } catch { return null; }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const t = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : null);
  const streams: MediaStream[] = (Array.isArray(raw?.streams) ? raw.streams : []).slice(0, 40).map((x: any) => ({
    dir: x?.dir === 'send' ? 'send' : 'recv', kind: x?.kind === 'video' ? 'video' : 'audio', codec: t(x?.codec), kbps: n(x?.kbps),
    width: n(x?.width), height: n(x?.height), fps: n(x?.fps), impl: t(x?.impl), hw: typeof x?.hw === 'boolean' ? x.hw : null, limit: t(x?.limit),
    dropped: n(x?.dropped), freezes: n(x?.freezes), concealedPct: n(x?.concealedPct), jitterMs: n(x?.jitterMs), lost: n(x?.lost),
  }));
  return { connections: n(raw?.connections) ?? 0, streams };
}
let updater: ReturnType<typeof createUpdater> | null = null;
let updateTimer: NodeJS.Timeout | undefined;

const userData = () => app.getPath('userData');
const rendererDir = () => path.join(__dirname, '..', 'renderer');

let appIcon: Electron.NativeImage | null = null;
function makeIcon(size = 32) {
  // The ZERO logo (assets/icon.png, rendered from assets/logo.svg); a drawn fallback keeps the app usable without it.
  if (appIcon === null) {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    appIcon = img.isEmpty() ? nativeImage.createEmpty() : img;
  }
  if (!appIcon.isEmpty()) return appIcon.resize({ width: size, height: size, quality: 'best' });
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c);
    const o = (y * size + x) * 4;
    let rgba: [number, number, number, number] = [0, 0, 0, 0];
    if (d <= size * 0.46) rgba = d >= size * 0.34 ? [124, 140, 255, 255] : [27, 30, 37, 255];
    buf[o] = rgba[2]; buf[o + 1] = rgba[1]; buf[o + 2] = rgba[0]; buf[o + 3] = rgba[3];
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ------------------------------------------------------------------------------------------------
// Theme service: single source of truth -> one compiled stylesheet -> Discord preload controller.
// ------------------------------------------------------------------------------------------------
const theme = {
  css: '',
  missing: new Set<string>(),
  route: 'other',
  lastPushAt: 0,
  pushes: 0,
};

async function refreshMissingImages() {
  const missing = new Set<string>();
  for (const id of referencedImages(config)) if (!(await images.resolve(id))) missing.add(id);
  theme.missing = missing;
}

function payload() {
  return { css: theme.css, pauseWhenUnfocused: resolvePerf(config).pauseWhenUnfocused };
}

/** Recompile (cheap, pure) and push to the Discord renderer. Never waits on the page, so it cannot stall. */
function recompileAndPush() {
  try {
    theme.css = composeDiscordCss(config, plugins.css.values(), theme.missing);
  } catch (err) {
    // A theme that fails to compile must not take Discord down: fall back to no customization.
    log.error('theme compile failed; customizations temporarily disabled', err);
    theme.css = '';
  }
  const wc = discordWin?.webContents;
  if (wc && !wc.isDestroyed()) { wc.send('zero:apply', payload()); theme.pushes++; theme.lastPushAt = Date.now(); }
}

function applySpellcheck() {
  try { session.defaultSession.setSpellCheckerEnabled(resolvePerf(config).spellcheck); } catch (err) { log.warn('spellcheck toggle failed', err); }
}
/** Live: no reload, so a call or stream in progress is never interrupted. */
function applyThrottle() {
  const wc = discordWin?.webContents;
  if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(resolvePerf(config).backgroundThrottle);
}

// ------------------------------------------------------------------------------------------------
// Persistence: config changes apply immediately; writes to disk are debounced (slider drags).
// ------------------------------------------------------------------------------------------------
let saveTimer: NodeJS.Timeout | undefined;
function saveSoon(delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void store.save(config).catch((err) => log.error('saving settings failed', err)); }, delay);
}
async function flushSave() { clearTimeout(saveTimer); await store.save(config); }

/**
 * Keeps you signed in across restarts and updates: before ZERO exits, Discord's page is unloaded normally (so
 * Discord's own code writes its state) and Chromium's storage is flushed to disk. ZERO never reads that storage.
 */
let sessionSaved: Promise<void> | null = null;
function saveSession(): Promise<void> {
  return (sessionSaved ??= (async () => {
    const win = discordWin && !discordWin.isDestroyed() ? discordWin : null;
    const wc = win?.webContents;
    if (win && wc && !wc.isDestroyed() && isDiscordUrl(wc.getURL())) {
      win.hide();
      wc.once('will-prevent-unload', (e) => e.preventDefault()); // a "leave page?" prompt must not block quitting
      await Promise.race([wc.loadURL('about:blank').catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    }
    session.defaultSession.flushStorageData();
    await session.defaultSession.cookies.flushStore();
  })().catch((err) => log.warn('session save failed', err)));
}

function publicState() {
  const perf = resolvePerf(config);
  return {
    config, plugins: plugins.infos, notes, compat, startupMs, safeMode: config.recovery.safeMode,
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    pluginsDir: path.join(userData(), 'plugins'), perf, missingImages: [...theme.missing], update: updater?.state ?? null,
  };
}
function broadcast() { if (settingsView && !settingsView.webContents.isDestroyed()) settingsView.webContents.send('state:changed', publicState()); }

/** Commit a new config: apply to Discord now, persist soon, tell the settings window. */
function commit(next: Config, opts: { broadcast?: boolean } = {}) {
  config = next;
  recompileAndPush();
  pushBuiltins();
  saveSoon();
  if (opts.broadcast !== false) broadcast();
}

// ------------------------------------------------------------------------------------------------
// Built-in plugins: enabled ones (and the detected game) go to the Discord page; nothing is sent while all are off.
let games: ReturnType<typeof createGameDetector> | null = null;
let pluginData: PluginDataStore;
let lastBuiltins = '';
function builtinsPayload() {
  const plugins = activeBuiltins(config.builtins, config.recovery.safeMode);
  // Saved data goes to the page only for the plugins that are on (a plugin that is off never sees it).
  const data = Object.fromEntries(PAGE_DATA_PLUGINS.filter((k) => plugins[k]).map((k) => [k, pluginData.get(k)]));
  return { plugins, game: games?.current ?? null, data };
}
function pushBuiltins(force = false) {
  const b = config.builtins;
  const safe = config.recovery.safeMode;
  games?.configure(!safe && (b.gameDetection?.enabled === true || b.autoDndWhilePlaying?.enabled === true),
    b.ignoreActivities?.enabled ? (b.ignoreActivities.settings.ignored as string[]) : []);
  const p = builtinsPayload();
  const json = JSON.stringify(p);
  if (!force && json === lastBuiltins) return;
  lastBuiltins = json;
  const wc = discordWin?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('zero:builtins', p);
}
const crashReloads: number[] = [];

async function reloadPlugins() {
  plugins = await loadPlugins(path.join(userData(), 'plugins'), config.plugins, config.recovery.safeMode);
}

function setSafeMode(on: boolean) {
  commit({ ...config, recovery: { ...config.recovery, safeMode: on } });
  void reloadPlugins().then(() => { recompileAndPush(); broadcast(); });
  log.info(`safe mode ${on ? 'on' : 'off'}`);
}

// ------------------------------------------------------------------------------------------------
// Windows, session hardening
// ------------------------------------------------------------------------------------------------
function isDiscordUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && DISCORD_HOSTS.test(u.hostname); } catch { return false; }
}

function hardenSession(ses: Electron.Session) {
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMS.has(permission) && isDiscordUrl(wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMS.has(permission) && (!wc || isDiscordUrl(wc.getURL())));
  // Screen share (Go Live): the user picks a screen or window in ZERO's picker. "Share sound" captures system audio
  // (Windows loopback); the Discord preload asks Chromium for restrictOwnAudio, so the call itself is not re-sent.
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    // Answer exactly once. Denying (empty streams) makes Electron throw after it has already rejected the request.
    let answered = false;
    const reply = (streams: Electron.Streams) => {
      if (answered) return;
      answered = true;
      try { cb(streams); } catch { /* denial acknowledged: the page gets AbortError */ }
    };
    try {
      if (!req.frame || !isDiscordUrl(req.frame.url)) return reply({});
      log.info(`screen share requested (audio: ${req.audioRequested})`);
      const choice = await picker.pick(req.audioRequested);
      if (!choice) return reply({});
      reply(choice.audio ? { video: { id: choice.id, name: choice.name }, audio: 'loopback' } : { video: { id: choice.id, name: choice.name } });
    } catch (err) { log.warn('display media failed', err); reply({}); }
  });
}

function guardNavigation(wc: WebContents) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:/i.test(url) && !isDiscordUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isDiscordUrl(url)) { e.preventDefault(); if (/^https:/i.test(url)) void shell.openExternal(url); }
  });
}

function updateRoute(url: string) {
  let kind = 'other';
  try { kind = routeKind(new URL(url).pathname); } catch { /* keep other */ }
  if (kind === theme.route) return;
  theme.route = kind;
  discordWin?.webContents.send('zero:route', kind);
}

const picker = createPicker({
  window: () => discordWin,
  // StreamPresets: only while that plugin is on. Presets are written by the picker page through main, never by Discord.
  presets: {
    get: () => {
      if (!config.builtins.streamPresets?.enabled || config.recovery.safeMode) return null;
      const d = pluginData.get('streamPresets');
      const enc = String((app.getGPUFeatureStatus() as unknown as Record<string, string>).video_encode ?? '');
      return { presets: d.presets, last: d.last, hardwareEncode: config.general.hardwareAcceleration && enc.startsWith('enabled') };
    },
    update: (fn: (d: PluginData['streamPresets']) => void) => {
      if (!config.builtins.streamPresets?.enabled || config.recovery.safeMode) return;
      const d = structuredClone(pluginData.get('streamPresets'));
      fn(d);
      pluginData.set('streamPresets', d);
    },
  },
  preload: path.join(__dirname, '..', 'preload', 'picker.js'),
  page: path.join(rendererDir(), 'picker.html'),
  guard: (wc) => guardNavigation(wc),
});

function createDiscordWindow() {
  const perf = resolvePerf(config);
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 940, minHeight: 500, show: false, title: APP_NAME,
    backgroundColor: activeTheme(config).colors.background, icon: makeIcon(64), autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'discord.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true,
      backgroundThrottling: perf.backgroundThrottle,
    },
  });
  discordWin = win;
  guardNavigation(win.webContents);
  win.once('ready-to-show', () => {
    if (!config.general.startMinimized) win.show();
    startupMs = Math.round(performance.now() - bootStart);
    log.info(`startup: window ready in ${startupMs} ms`);
    broadcast();
  });
  // SPA navigations keep the document (our <style> stays); only the route attribute needs updating.
  win.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) updateRoute(url); });
  win.webContents.on('did-navigate', (_e, url) => { theme.route = ''; updateRoute(url); });
  win.webContents.on('render-process-gone', (_e, d) => { log.error(`discord renderer gone: ${d.reason}`); if (d.reason !== 'clean-exit') win.webContents.reload(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && input.key === ',') { e.preventDefault(); toggleSettings(); }
    if (ctrl && input.shift && input.key.toLowerCase() === 'z') { e.preventDefault(); setSafeMode(!config.recovery.safeMode); }
  });
  win.on('close', (e) => {
    if (!quitting && config.general.minimizeToTray && tray) { e.preventDefault(); win.hide(); }
  });
  win.on('resize', () => { fitSettings(); picker.fit(); updateLayer.fit(); });
  win.on('closed', () => { picker.cancel(); discordWin = null; settingsView = null; });
  void win.loadURL(BRANCH_URL[config.general.discordBranch]);
}

/** Update screen: a layer in the Discord window, like settings. Never a browser page or a separate window. */
const updateLayer = createOverlay({
  window: () => discordWin,
  preload: path.join(__dirname, '..', 'preload', 'update.js'),
  page: path.join(rendererDir(), 'update.html'),
  guard: (wc) => guardNavigation(wc),
});

function onUpdateState(s: UpdateState) {
  updateLayer.webContents?.send('updater:state', s);
  settingsView?.webContents.send('update:state', s); // live progress in Settings > About, without a page rebuild
  if (s.phase !== 'downloading' && s.phase !== 'verifying') broadcast();
}

/** Periodic checks while ZERO stays open (Settings > General). 0 = only at startup. */
function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  const hours = config.general.updateIntervalHours;
  if (!updater || !app.isPackaged || !config.general.checkUpdates || !hours) return;
  updateTimer = setInterval(() => void updater?.check(false), hours * 3600_000);
  updateTimer.unref();
}

function startUpdate() {
  if (!updater) return;
  if (updater.state.latest && (updater.state.phase === 'available' || updater.state.phase === 'error')) void updater.install();
  else void updater.check(true);
  updateLayer.open();
}

function fitSettings() {
  if (!settingsView || !discordWin) return;
  const [width, height] = discordWin.getContentSize();
  settingsView.setBounds({ x: 0, y: 0, width: width!, height: height! });
}

function openSettings() {
  const win = discordWin;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (settingsView) { settingsView.webContents.focus(); return; }
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'settings.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  settingsView = view;
  view.setBackgroundColor('#00000000'); // the page fades in over Discord
  guardNavigation(view.webContents);
  view.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && input.key === ',') { e.preventDefault(); closeSettings(); }
    if (ctrl && input.shift && input.key.toLowerCase() === 'z') { e.preventDefault(); setSafeMode(!config.recovery.safeMode); }
  });
  view.webContents.on('render-process-gone', () => closeSettings());
  win.contentView.addChildView(view);
  fitSettings();
  void view.webContents.loadFile(path.join(rendererDir(), 'settings.html')).then(() => view.webContents.focus());
}

function closeSettings() {
  const view = settingsView;
  if (!view) return;
  settingsView = null;
  if (discordWin && !discordWin.isDestroyed()) { discordWin.contentView.removeChildView(view); discordWin.webContents.focus(); }
  if (!view.webContents.isDestroyed()) view.webContents.close(); // frees the settings renderer
}

function toggleSettings() { if (settingsView) closeSettings(); else openSettings(); }

function createTray() {
  tray = new Tray(makeIcon(32));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: () => { discordWin?.show(); } },
    { label: 'ZERO settings', click: openSettings },
    { label: 'Toggle Safe Mode', click: () => setSafeMode(!config.recovery.safeMode) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => discordWin?.show());
}

// ------------------------------------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------------------------------------
function registerIpc() {
  // Discord preload: may only ask for the current stylesheet. Checked against the exact window + main frame.
  ipcMain.handle('zero:init', (e) => {
    const wc = discordWin?.webContents;
    if (!wc || e.sender !== wc || e.senderFrame !== wc.mainFrame) return null;
    theme.route = '';
    updateRoute(wc.getURL());
    return { ...payload(), route: theme.route, hint: !config.general.introSeen, builtins: builtinsPayload() };
  });

  const fromDiscord = (e: Electron.IpcMainEvent) => { const wc = discordWin?.webContents; return !!wc && e.sender === wc && e.senderFrame === wc.mainFrame; };
  // The ZERO button in Discord's user panel can only ask to open settings and to dismiss the one-time hint.
  ipcMain.on('zero:openSettings', (e) => { if (fromDiscord(e)) openSettings(); });
  // CrashHandler: Discord showed its crash screen. Reload, at most 3 times in 10 minutes.
  ipcMain.on('zero:rtc', (e, id: unknown, detail: unknown) => {
    if (!fromDiscord(e) || typeof id !== 'number' || typeof detail !== 'string') return;
    rtcWaiting.get(id)?.(detail);
  });
  ipcMain.on('zero:crash', (e) => {
    if (!fromDiscord(e) || !config.builtins.crashHandler?.enabled || config.recovery.safeMode) return;
    const now = Date.now();
    while (crashReloads.length && now - crashReloads[0]! > 600_000) crashReloads.shift();
    if (crashReloads.length >= 3) { log.warn('crash handler: too many crashes, not reloading again'); return; }
    crashReloads.push(now);
    log.warn('crash handler: Discord crash screen detected, reloading');
    discordWin?.webContents.reload();
  });
  // Built-in plugin data (reminders, saved messages, notes, snippets): only for a plugin that is on, validated
  // against its schema, size-capped. See shared/pluginData.ts.
  ipcMain.on('zero:data', (e, id: unknown, json: unknown) => {
    if (!fromDiscord(e) || !isDataPlugin(id) || typeof json !== 'string' || config.recovery.safeMode || !config.builtins[id]?.enabled) return;
    if (!pluginData.setFromPage(id, json)) log.warn(`plugin data for ${id} refused (invalid or too large)`);
  });
  // MessageReminder: clicking a reminder notification brings the window to the front (at most once a second).
  let lastFocus = 0;
  ipcMain.on('zero:focus', (e) => {
    if (!fromDiscord(e) || !config.builtins.messageReminder?.enabled || Date.now() - lastFocus < 1000) return;
    lastFocus = Date.now();
    if (discordWin) { if (discordWin.isMinimized()) discordWin.restore(); discordWin.show(); discordWin.focus(); }
  });
  ipcMain.on('zero:hintDone', (e) => { if (fromDiscord(e) && !config.general.introSeen) commit({ ...config, general: { ...config.general, introSeen: true } }, { broadcast: false }); });

  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!settingsView || e.sender !== settingsView.webContents) throw new Error('Unauthorized sender');
  };
  const handle = (ch: (typeof CHANNELS)[number], fn: (...a: any[]) => unknown | Promise<unknown>) =>
    ipcMain.handle(ch, async (e, ...args) => {
      guard(e);
      try { return { ok: true, data: await fn(...args) }; }
      catch (err) { log.warn(`ipc ${ch} failed`, err); return { ok: false, error: (err as Error).message }; }
    });

  handle('state:get', () => publicState());
  handle('settings:close', () => { setImmediate(closeSettings); });
  handle('update:check', async () => (updater ? updater.check(true) : null));
  handle('update:open', () => { startUpdate(); });
  // The update screen can only read the updater state and send one of five actions.
  ipcMain.handle('updater:get', (e) => {
    if (!updateLayer.webContents || e.sender !== updateLayer.webContents) throw new Error('Unauthorized sender');
    return updater?.state ?? null;
  });
  ipcMain.on('updater:act', (e, action: unknown) => {
    if (!updater || !updateLayer.webContents || e.sender !== updateLayer.webContents) return;
    if (action === 'install') void updater.install();
    else if (action === 'retry') {
      if (updater.state.failedTo || !updater.state.latest) { updater.acknowledge(); void updater.check(true); } else void updater.install();
    } else if (action === 'later') { void updater.remindLater(); updateLayer.close(); }
    else if (action === 'hide') updateLayer.close();
    else if (action === 'done') { updater.acknowledge(); updateLayer.close(); }
  });
  // Live edit: validate -> commit (Discord updates immediately) -> persist (debounced). Invalid input keeps
  // the previous working theme because validateTheme throws before anything is changed.
  handle('theme:update', (t) => {
    const valid = validateTheme(t);
    const { config: next, id } = applyThemeEdit(config, valid);
    const forked = id !== valid.id;
    commit(next, { broadcast: forked });
    return { id, name: next.themes[id]!.name, forked };
  });
  handle('theme:select', (id: string) => {
    if (!config.themes[id]) throw new Error('Theme not found');
    commit({ ...config, activeThemeId: id });
  });
  handle('theme:duplicate', (id) => commit(T.duplicateTheme(config, id)));
  handle('theme:rename', (id, name) => commit(T.renameTheme(config, id, name)));
  handle('theme:delete', (id) => commit(T.deleteTheme(config, id)));
  handle('theme:import', async () => {
    const r = await dialog.showOpenDialog(discordWin!, { title: 'Import ZERO theme', filters: [{ name: 'ZERO theme', extensions: ['json', 'zerotheme'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = await fs.readFile(r.filePaths[0], 'utf8');
    const imported = T.parseImportedTheme(text);
    // image layers stay disabled unless that image id already exists locally
    for (const l of imported.backgrounds) if (l.kind === 'image' && l.imageId && (await images.resolve(l.imageId))) l.enabled = true;
    commit(T.addTheme(config, imported));
    return imported.name;
  });
  handle('theme:export', async (id: string) => {
    const t = config.themes[id]; if (!t) throw new Error('Theme not found');
    const r = await dialog.showSaveDialog(discordWin!, { title: 'Export ZERO theme', defaultPath: `${t.id}.zerotheme.json`, filters: [{ name: 'ZERO theme', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return false;
    await fs.writeFile(r.filePath, T.exportTheme(t), 'utf8');
    return true;
  });
  handle('layout:select', (id: string) => { if (!config.layouts[id]) throw new Error('Layout not found'); commit({ ...config, activeLayoutId: id }); });
  handle('layout:save', (l) => {
    if (typeof l?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(l.id)) throw new Error('Invalid layout id');
    const clean = sanitizeLayout(l.id, l);
    commit({ ...config, layouts: { ...config.layouts, [clean.id]: clean }, activeLayoutId: clean.id }, { broadcast: false });
  });
  handle('layout:delete', (id: string) => {
    if (Object.keys(config.layouts).length <= 1) throw new Error('At least one layout profile is required');
    const { [id]: _x, ...rest } = config.layouts;
    commit({ ...config, layouts: rest, activeLayoutId: config.activeLayoutId === id ? Object.keys(rest)[0]! : config.activeLayoutId });
  });
  handle('perf:snapshot', async (): Promise<PerfSnapshot> => {
    const m = summarizeMetrics(app.getAppMetrics() as any);
    if (gpuInfo === null) {
      gpuInfo = 'unavailable';
      try {
        const info: any = await app.getGPUInfo('basic'); const d = info?.gpuDevice?.find((x: any) => x.active) ?? info?.gpuDevice?.[0];
        const vendors: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' };
        if (d) { const v = vendors[d.vendorId] ?? 'vendor ' + d.vendorId; const name = String(d.deviceString ?? ''); gpuInfo = name ? (name.startsWith(v) ? name : v + ' ' + name) : v + ' (device ' + d.deviceId + ')'; }
      } catch { /* optional */ }
    }
    const perf = resolvePerf(config);
    let gpuFeatures: Record<string, string> = {};
    try { gpuFeatures = Object.fromEntries(Object.entries(app.getGPUFeatureStatus()).filter(([k]) => ['gpu_compositing', 'rasterization', 'video_decode', 'video_encode', 'webgl'].includes(k))) as Record<string, string>; } catch { /* optional */ }
    const media = await requestMedia();
    const base = {
      ramMb: m.ramMb, hardwareAcceleration: config.general.hardwareAcceleration, gpuFeatures, profile: config.performance.profile,
      eventLoop: eventLoopStats(), media, session: { minutes: ramHistory.length, ramMb: ramHistory.slice(-240), growthMbPerHour: sessionGrowth(ramHistory) },
    };
    return {
      ...m, ...base, recommendations: recommendations(base), gpu: gpuInfo, startupMs, at: Date.now(),
      activeModules: ['core', config.recovery.safeMode ? 'theme-engine (safe mode: off)' : 'theme-engine', ...plugins.infos.filter((p) => p.status === 'enabled').map((p) => `plugin:${p.manifest.id}`)],
      background: [
        perf.backgroundThrottle ? 'Discord throttled while hidden/minimized' : 'Discord not throttled when hidden',
        perf.pauseWhenUnfocused ? 'CSS animations paused while unfocused' : 'animations run while unfocused',
        `${theme.pushes} theme update(s) pushed this session; stylesheet ${(theme.css.length / 1024).toFixed(1)} KB`,
        'live statistics are sampled only while this page is open; memory history: one sample per minute',
      ],
    };
  });
  handle('perf:set', (p: { profile?: PerfProfile; custom?: unknown }) => {
    const profile = toPerfProfile(p.profile, config.performance.profile);
    const custom = p.custom ? sanitizePerfOptions({ ...config.performance.custom, ...(p.custom as object) }) : config.performance.custom;
    commit({ ...config, performance: { profile, custom } });
    applySpellcheck();
    applyThrottle();
  });
  handle('general:set', (g) => { commit(sanitizeConfig({ ...config, general: { ...config.general, ...(g && typeof g === 'object' ? g : {}) } })); scheduleUpdateChecks(); });
  handle('bg:import', async () => {
    const r = await dialog.showOpenDialog(discordWin!, { title: 'Choose a background image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return images.import(r.filePaths[0]);
  });
  handle('bg:list', () => images.list());
  handle('builtins:set', (id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }) => {
    const def = BUILTINS.find((d) => d.id === id);
    if (!def || !patch || typeof patch !== 'object') return;
    const cur = config.builtins[id]!;
    const next = sanitizeBuiltin(def, { enabled: patch.enabled ?? cur.enabled, settings: { ...cur.settings, ...patch.settings } });
    commit({ ...config, builtins: { ...config.builtins, [id]: next } });
    if (patch.enabled !== undefined) log.info(`built-in plugin ${id} ${next.enabled ? 'on' : 'off'}`);
  });
  handle('plugins:setEnabled', async (id: string, on: boolean) => { config = { ...config, plugins: { ...config.plugins, enabled: { ...config.plugins.enabled, [id]: on } } }; await reloadPlugins(); commit(config); });
  handle('plugins:grant', async (id: string, perms: string[]) => { config = { ...config, plugins: { ...config.plugins, granted: { ...config.plugins.granted, [id]: perms } } }; await reloadPlugins(); commit(config); });
  handle('plugins:openFolder', async () => { const d = path.join(userData(), 'plugins'); await fs.mkdir(d, { recursive: true }); await shell.openPath(d); });
  handle('plugins:reload', async () => { await reloadPlugins(); commit(config); });
  handle('backups:list', () => store.listBackups());
  handle('backups:restore', async (name: string) => { await flushSave(); config = await store.restoreBackup(name); await reloadPlugins(); await refreshMissingImages(); commit(config); });
  handle('recovery:safeMode', (on: boolean) => setSafeMode(on));
  handle('compat:check', async () => {
    const wc = discordWin?.webContents; if (!wc) throw new Error('Discord window is not open');
    const raw = await Promise.race([wc.executeJavaScript(COMPAT_PROBE_SCRIPT), new Promise((r) => setTimeout(() => r(null), 5000))]);
    compat = evaluateCompat(raw, wc.getURL(), Date.now(), { expectStyle: !config.recovery.safeMode, missingImages: [...theme.missing] });
    broadcast(); return compat;
  });
  handle('discord:reload', () => { discordWin?.webContents.reloadIgnoringCache(); });
  handle('logs:open', () => shell.showItemInFolder(path.join(userData(), 'logs', 'zero.log')));
}

// ------------------------------------------------------------------------------------------------
async function main() {
  // Isolated builds for the update lifecycle test set "zeroTestName" (separate profile); real builds never do.
  let testName: string | null = null;
  try { const n = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).zeroTestName; if (typeof n === 'string' && /^ZERO [\w ]{1,30}$/.test(n)) testName = n; } catch { /* default name */ }
  app.setName(testName ?? APP_NAME);
  // ZERO_DEV_SECOND_INSTANCE lets an unpackaged dev build run beside the installed app (for side-by-side benchmarks).
  const devSecond = !app.isPackaged && process.env.ZERO_DEV_SECOND_INSTANCE === '1';
  if (!devSecond && !app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--safe-mode')) setSafeMode(true);
    if (discordWin) { discordWin.show(); discordWin.focus(); }
  });
  process.on('uncaughtException', (err) => { log?.error('uncaughtException', err); });
  process.on('unhandledRejection', (err) => { log?.error('unhandledRejection', err); });

  store = new ConfigStore(userData());
  log = new Logger(path.join(userData(), 'logs', 'zero.log'));
  let loaded;
  try { loaded = await store.load(); }
  catch (err) {
    dialog.showErrorBox(APP_NAME, `Your settings were created by a newer ZERO version and were left untouched.\n\n${(err as Error).message}`);
    app.exit(1); return;
  }
  config = loaded.config; notes = loaded.notes;
  for (const n of notes) log.info(n);

  // Recovery: explicit --safe-mode flag, or three starts in a row without a healthy session.
  if (process.argv.includes('--safe-mode')) {
    config = { ...config, recovery: { ...config.recovery, safeMode: true } };
    notes.push('Started with --safe-mode: customizations are disabled.');
  } else if (config.recovery.crashStreak >= 3 && !config.recovery.safeMode) {
    config = { ...config, recovery: { crashStreak: 0, safeMode: true } };
    notes.push('ZERO did not start cleanly several times, so customizations were disabled (Safe Mode). Open Settings > Advanced to turn them back on.');
  }
  config = { ...config, recovery: { ...config.recovery, crashStreak: config.recovery.crashStreak + 1 } };
  await store.save(config, false);
  setTimeout(() => { config = { ...config, recovery: { ...config.recovery, crashStreak: 0 } }; saveSoon(0); }, 15_000).unref();

  images = new ImageStore(path.join(userData(), 'backgrounds'), {
    decode: (buf) => {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const s = img.getSize();
      return { width: s.width, height: s.height, resize: (w: number, h: number) => img.resize({ width: w, height: h, quality: 'best' }), toJPEG: (q: number) => img.toJPEG(q), toPNG: () => img.toPNG() } as any;
    },
  });

  if (!config.general.hardwareAcceleration) app.disableHardwareAcceleration();
  // Present as the Chromium ZERO runs on, so Discord enables Go Live and stream watching (see capture.ts).
  app.userAgentFallback = chromeUserAgent(process.versions.chrome);
  await app.whenReady();
  protocol.handle('zero-asset', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'bg' || req.method !== 'GET') return new Response('not found', { status: 404 });
    const file = await images.resolve(decodeURIComponent(u.pathname.slice(1)));
    if (!file) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    // Image ids are random and immutable: let Chromium cache and reuse the decoded image.
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' } });
  });
  hardenSession(session.defaultSession);
  applySpellcheck();
  await reloadPlugins();
  await refreshMissingImages();
  if (theme.missing.size) log.warn(`missing background image(s): ${[...theme.missing].join(', ')}`);
  theme.css = composeDiscordCss(config, plugins.css.values(), theme.missing);
  pluginData = new PluginDataStore(userData(), (err) => log.error('plugin data save failed', err));
  await pluginData.load();
  registerIpc();
  if (config.general.minimizeToTray) createTray();
  createDiscordWindow();
  startRamHistory();
  // update check: once, a little after startup, so it never competes with Discord loading
  games = createGameDetector({ dir: userData(), log, onChange: () => pushBuiltins(true) });
  pushBuiltins(true);
  updater = createUpdater({
    current: app.getVersion(), enabled: app.isPackaged, log, stateFile: path.join(userData(), 'update-state.json'),
    onState: onUpdateState,
    onPrompt: () => { updater?.acknowledge(); updateLayer.open(); },
    beforeInstall: async () => {
      quitting = true; // windows must really close (not hide to the tray) so the installer can replace the files
      closeSettings();
      await Promise.all([flushSave(), saveSession(), pluginData.flush()]);
    },
  });
  await updater.init();
  if (updater.state.justUpdated || updater.state.failedTo) discordWin?.once('ready-to-show', () => setTimeout(() => updateLayer.open(), 1200));
  if (config.general.checkUpdates && app.isPackaged) setTimeout(() => void updater?.check(false), 8000).unref();
  scheduleUpdateChecks();
  if (process.argv.includes('--settings')) discordWin?.once('ready-to-show', () => setTimeout(openSettings, 1500));
  let flushed = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (flushed) return;
    // make sure a debounced edit and the Discord login are on disk before exiting
    e.preventDefault();
    flushed = true;
    void Promise.all([flushSave().catch((err) => log.error('final save failed', err)), saveSession(), pluginData.flush()]).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('child-process-gone', (_e, d) => log.warn(`child process gone: ${d.type} ${d.reason}`));
}

void main().catch((err) => { console.error(err); app.exit(1); });
