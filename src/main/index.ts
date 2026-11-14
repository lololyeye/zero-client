import {
  app, BrowserWindow, WebContentsView, ipcMain, shell, session, protocol, Tray, Menu, nativeImage, dialog, desktopCapturer, net,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';

const bootStart = performance.now();
import { ConfigStore } from './store';
import { Logger } from './logger';
import { ImageStore } from './images';
import { loadPlugins, type LoadedPlugins } from './plugins';
import { COMPAT_PROBE_SCRIPT, evaluateCompat, type CompatReport } from './inject';
import { summarizeMetrics, type PerfSnapshot } from './perf';
import { activeTheme, applyThemeEdit, composeDiscordCss, referencedImages } from './compose';
import * as T from './themeOps';
import { resolvePerf, sanitizeConfig, sanitizeLayout, sanitizePerfOptions, type Config, type PerfProfile } from '../shared/config';
import { validateTheme } from '../shared/theme';
import { CHANNELS } from '../shared/ipc';
import { routeKind } from '../preload/controller';
import { fetchLatest, RELEASES_PAGE, type UpdateInfo } from './updates';

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
let update: UpdateInfo | null = null;

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

// ------------------------------------------------------------------------------------------------
// Persistence: config changes apply immediately; writes to disk are debounced (slider drags).
// ------------------------------------------------------------------------------------------------
let saveTimer: NodeJS.Timeout | undefined;
function saveSoon(delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void store.save(config).catch((err) => log.error('saving settings failed', err)); }, delay);
}
async function flushSave() { clearTimeout(saveTimer); await store.save(config); }

function publicState() {
  const perf = resolvePerf(config);
  return {
    config, plugins: plugins.infos, notes, compat, startupMs, safeMode: config.recovery.safeMode,
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    pluginsDir: path.join(userData(), 'plugins'), perf, missingImages: [...theme.missing], update,
  };
}
function broadcast() { if (settingsView && !settingsView.webContents.isDestroyed()) settingsView.webContents.send('state:changed', publicState()); }

/** Commit a new config: apply to Discord now, persist soon, tell the settings window. */
function commit(next: Config, opts: { broadcast?: boolean } = {}) {
  config = next;
  recompileAndPush();
  saveSoon();
  if (opts.broadcast !== false) broadcast();
}

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
  // Screen share: grants the primary screen with system audio loopback. A source picker is on the roadmap.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const screen = sources.find((s) => s.id.startsWith('screen:')) ?? sources[0];
      if (!screen) return cb({});
      cb({ video: screen, audio: 'loopback' });
    } catch (err) { log.warn('display media failed', err); cb({}); }
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
  win.on('resize', fitSettings);
  win.on('closed', () => { discordWin = null; settingsView = null; });
  void win.loadURL(BRANCH_URL[config.general.discordBranch]);
}

/** One request to GitHub; if a newer release exists, tell the user and let them download it. */
async function checkForUpdates(interactive: boolean): Promise<UpdateInfo | null> {
  try {
    update = await fetchLatest((u, i) => net.fetch(u, i), app.getVersion());
  } catch (err) {
    log.warn('update check failed', err);
    if (interactive) throw new Error('Could not reach GitHub to check for updates.');
    return null;
  }
  broadcast();
  if (update?.newer && !interactive && discordWin && !discordWin.isDestroyed()) {
    const r = await dialog.showMessageBox(discordWin, {
      type: 'info', title: 'ZERO update', buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1,
      message: `ZERO ${update.latest} is available`,
      detail: `You are using ${update.current}. Download and run the new installer; your settings, themes and backgrounds are kept.` +
        (update.notes ? `\n\n${update.notes.slice(0, 600)}` : ''),
    });
    if (r.response === 0) void shell.openExternal(update.installerUrl ?? update.url);
  }
  return update;
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
    return { ...payload(), route: theme.route, hint: !config.general.introSeen };
  });

  const fromDiscord = (e: Electron.IpcMainEvent) => { const wc = discordWin?.webContents; return !!wc && e.sender === wc && e.senderFrame === wc.mainFrame; };
  // The ZERO button in Discord's user panel can only ask to open settings and to dismiss the one-time hint.
  ipcMain.on('zero:openSettings', (e) => { if (fromDiscord(e)) openSettings(); });
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
  handle('update:check', () => checkForUpdates(true));
  handle('update:open', () => { void shell.openExternal(update?.installerUrl ?? update?.url ?? RELEASES_PAGE); });
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
        if (d) gpuInfo = `${vendors[d.vendorId] ?? 'vendor ' + d.vendorId}${d.deviceString ? ' ' + d.deviceString : ''} (device ${d.deviceId})`;
      } catch { /* optional */ }
    }
    const perf = resolvePerf(config);
    return {
      ...m, gpu: gpuInfo, startupMs, profile: config.performance.profile, at: Date.now(),
      activeModules: ['core', config.recovery.safeMode ? 'theme-engine (safe mode: off)' : 'theme-engine', ...plugins.infos.filter((p) => p.status === 'enabled').map((p) => `plugin:${p.manifest.id}`)],
      background: [
        perf.backgroundThrottle ? 'Discord throttled while hidden/minimized' : 'Discord not throttled when hidden',
        perf.pauseWhenUnfocused ? 'CSS animations paused while unfocused' : 'animations run while unfocused',
        `${theme.pushes} theme update(s) pushed this session; stylesheet ${(theme.css.length / 1024).toFixed(1)} KB`,
        'no polling: statistics are sampled only while this page is open',
      ],
    };
  });
  handle('perf:set', (p: { profile?: PerfProfile; custom?: unknown }) => {
    const profile = p.profile && ['balanced', 'lightweight', 'custom'].includes(p.profile) ? p.profile : config.performance.profile;
    const custom = p.custom ? sanitizePerfOptions({ ...config.performance.custom, ...(p.custom as object) }) : config.performance.custom;
    commit({ ...config, performance: { profile, custom } });
    applySpellcheck();
  });
  handle('general:set', (g) => commit(sanitizeConfig({ ...config, general: { ...config.general, ...(g && typeof g === 'object' ? g : {}) } })));
  handle('bg:import', async () => {
    const r = await dialog.showOpenDialog(discordWin!, { title: 'Choose a background image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return images.import(r.filePaths[0]);
  });
  handle('bg:list', () => images.list());
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
  app.setName(APP_NAME);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
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
  registerIpc();
  if (config.general.minimizeToTray) createTray();
  createDiscordWindow();
  // update check: once, a little after startup, so it never competes with Discord loading
  if (config.general.checkUpdates && app.isPackaged) setTimeout(() => void checkForUpdates(false), 8000).unref();
  if (process.argv.includes('--settings')) discordWin?.once('ready-to-show', () => setTimeout(openSettings, 1500));
  let flushed = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (flushed) return;
    // make sure a debounced edit is on disk before exiting
    e.preventDefault();
    flushed = true;
    void flushSave().catch((err) => log.error('final save failed', err)).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('child-process-gone', (_e, d) => log.warn(`child process gone: ${d.type} ${d.reason}`));
}

void main().catch((err) => { console.error(err); app.exit(1); });
