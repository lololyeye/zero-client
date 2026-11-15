# ZERO architecture

## Research summary (Phase 1)

- **Vesktop** (Vencord/Vesktop, GPL-3.0-or-later): an Electron app that loads Discord's official web client and injects Vencord. Build: esbuild + electron-builder, TypeScript. Its README confirms the model "web client in a lightweight Electron shell" and that Discord gets no direct access to the system.
- **License consequence:** Vesktop and Vencord are GPL-3.0. ZERO copies **no** code from them; it reuses only the publicly known *approach* (load the web client in a hardened shell, customise by injecting CSS). ZERO is MIT-licensed original code. If GPL code is ever imported, the whole project must become GPL.
- Only the Vesktop README and `package.json` were inspected; its source was not audited in depth. Findings about its internals beyond those are not claimed here.

## Technology decision: Electron (not Tauri)

| Need | Electron | Tauri (WebView2) |
|---|---|---|
| Discord web client compatibility (voice, video, WebRTC, codecs) | Bundled, known Chromium | System WebView2; version varies, screen-share/WebRTC permissions and per-origin CSS injection are less controllable |
| Screen share with system audio | `setDisplayMediaRequestHandler` + loopback | No equivalent API |
| Inject CSS/DOM into a third-party page | `webContents.insertCSS`, protocol handlers, preload | Limited |
| Install size / RAM | Larger | Smaller |

Voice, video and screen share are core requirements, so Electron wins on compatibility. The RAM cost is measured, not assumed (see *Performance*).

## Layout

```
src/shared    pure, testable logic (no Electron): theme schema + THE css compiler, config + migrations, plugin manifest
src/main      Electron main process: windows, session hardening, theme service, store, images, plugins, perf, IPC
src/preload   discord.ts: theme controller for the Discord page (exposes nothing to the page)
              settings preload: allowlisted invoke only
src/renderer  settings UI (own window; never runs inside Discord's page)
tests         vitest (engine.test.ts pins every root cause listed below)
```

## Theme engine (rebuilt, v0.2)

### Root causes found on the real, signed-in client

The first version "worked" in unit tests and on the login page but not in the real interface. Measured causes:

1. **Cascade lost.** Discord re-declares its variables on nested `.theme-dark` / `.visual-refresh` elements, and its own sheets load after ours, so `:root{--x:…}` never won. Verified: `--background-base-lowest` kept Discord's value.
2. **Wrong variable names.** Part of the map used legacy names (`--background-primary`, …). The visual-refresh client paints the frame and channel list with `--background-base-lowest`, the chat and Friends pages with `--background-base-lower`, and cards with `--background-base-low`.
3. **Backgrounds painted under opaque surfaces.** Image layers sat at `z-index:-1` beneath panes that remained opaque, with guessed pixel areas.
4. **Imports never saved.** An imported image only changed an unsaved draft, so the image was orphaned and nothing reached Discord until a Save that users did not press.
5. **Preview ≠ Discord.** The preview was a separate hand-written renderer, so it could look right while Discord did not.
6. **Fragile apply.** `executeJavaScript` + `insertCSS` with debounce and generation tokens could stall, double-apply, or apply into the wrong document after a reload.
7. **A settings CSP header rewrite hit Discord's session** (same default session) and broke images served to Discord.
8. **Stored preset copies overrode code presets**, so fixes to presets never reached existing users.
9. **Backup spam:** a backup on every save pushed useful snapshots out during live editing.
10. **`getGPUInfo` on every perf sample** (expensive and pointless).

### Pipeline (single source of truth)

```
settings UI ──theme:update (debounced 70 ms)──▶ main: validateTheme ─▶ applyThemeEdit (preset → "<name> (custom)")
                                                 │                      │
                                                 │                      ├─ commit → save (debounced 400 ms, flushed on quit)
                                                 │                      └─ composeDiscordCss(config) → cached string
                                                 ▼
                         Discord preload controller ◀── zero:apply {css, pauseWhenUnfocused}
                         (pulls zero:init on every document load — reloads and navigations restore by themselves)
```

- **One compiler** (`compileThemeCss` in `src/shared/theme.ts`) produces both Discord's stylesheet and the preview's. Only the *anchors* differ (`DISCORD_ANCHORS` vs. the preview's `.pv-*` anchors, with a `scope` prefix so nothing leaks onto the settings page).
- **Cascade:** every declaration is `!important` and declared on all theme scopes, so position in `<head>` does not matter. The controller therefore never moves its element (moving it on each of Discord's hundreds of lazy `<link>` appends would force full style recalcs).
- **Controller** (`src/preload/controller.ts`): exactly one `<style id="zero-theme">`, adopting or de-duplicating leftovers. Text is written only when it changes. A `MutationObserver` watches **only `<head>`'s direct children** (never the app subtree) to re-attach the element if it is removed. If the preload runs before `<head>` exists, the controller waits for DOMContentLoaded. It sets `html[data-zero-route]` (dm/guild) for the DM area and `html.zero-paused` when the window is unfocused.
- **Security:** the Discord preload exposes nothing to the page (no `contextBridge`). It only listens for `zero:apply` / `zero:route` and calls `zero:init`, and main checks that the sender is the Discord window's main frame. `contextIsolation` and `sandbox` stay on. ZERO never reads Discord's storage, network or message DOM.
- **Invalid input:** `theme:update` validates first. On failure the previous theme stays applied and the UI reverts the draft.
- **Presets** always come from code. The first edit of a preset forks it once (`midnight-custom`), and later edits update that fork.

### Backgrounds

- Areas: `global` (appMount), `sidebar` (server rail + channel list), `chat` (servers), `dm` (`html[data-zero-route="dm"]`), `settings` (the User Settings modal `outerContainer > modal`, or the older full-screen layer; its card-surface content pane counts as a base surface). One layer per area.
- Each area paints on its anchor's `::before` (`z-index:-1`, anchor `isolation:isolate`). `::after` is left alone because Discord uses it on the sidebar.
- **One tint layer:** inside an area, base surface variables become `transparent`. Only the anchor's direct children paint the surface color at *Surface opacity* (`effects.transparency`). Raised surfaces (cards, input, user panel) stay translucent. Without this, nested panes compounded: two 50% panes left only 25% of the image visible (measured `#501230` instead of `#8f144f`).
- Overlay color/opacity is an extra gradient layer over the image. Blur, brightness and contrast are CSS filters, and blur edge bleed is clipped. Transition duration is honoured unless animations are off.
- Images are validated by magic bytes and decoded (corrupt → clear error), then downscaled to 2560 px. Ids are content-addressed (sha256 prefix, so re-imports are de-duplicated) and served via the privileged `zero-asset://bg/<id>` scheme: GET only, validated id, immutable cache, so there is no reload on theme edits. Missing files are detected and their layer is omitted, and diagnostics report them.

## Performance

Measured with Task Manager's metric (private working set) on Windows 11, Discord signed in, idle, same procedure each time (fresh start, 60 s settle, 30 s CPU sample at 3 min):

| | Processes | Task Manager memory | Total private | Idle CPU |
|---|---|---|---|---|
| Before (v0.1) | 6 | 347 MB | 624 MB | 0.41 % |
| After, Balanced, sidebar image | 6 | 277 MB | 539 MB | 0.42 % |
| After, Lightweight (3 / 10 min) | 6 | 316 / 319 MB | 563 / 567 MB | 0.17 / 0.06 % |

Lightweight saves CPU/GPU work, not memory: the memory difference between runs is Discord's own variance. No growth was measured between minutes 3 and 10.

Attribution (after): Discord's renderer ≈ 188 MB of the 277 MB, GPU ≈ 41 MB, ZERO's main process ≈ 22 MB, Chromium utility services ≈ 26 MB. Most of the footprint is Discord's own web app; ZERO's controllable overhead is the main process plus the stylesheet.

What changed: no `executeJavaScript`, one stylesheet written only on change, observer limited to `<head>` children, cached GPU info, sampling only while the Performance page is visible, backups throttled. Occlusion tracking is re-enabled (the old workaround for the preview is gone, because the preview no longer depends on Discord's window).

Profiles (0.4): **Balanced** (everything the theme asks for), **Performance** (no blur, no transitions; colors and backgrounds kept), **Low Resource** (also no background images, no spellcheck), **Custom** (each switch: backgrounds, blur, animations, pause when unfocused, background throttling, spellcheck). Every switch has a real implementation and applies live (stylesheet, `session.setSpellCheckerEnabled`, `webContents.setBackgroundThrottling`): Discord is never reloaded, so a call or stream is never cut. No profile turns off hardware acceleration: on Windows it is what gives screen sharing its hardware H.264 encoder. The old Lightweight profile maps to Performance.

The 0.4 performance audit (method, measurements, what changed and what is outside ZERO's control) is in [PERFORMANCE.md](PERFORMANCE.md).

## Reliability

- `ConfigStore`: atomic write (tmp+rename), serialized writes, 8 rolling backups (at most one automatic backup per 10 min), backup before every migration, a corrupt file is preserved (`.corrupt-<time>`) and the newest valid backup restored, and configs from newer versions are refused, never overwritten.
- Crash-streak counter: 3 starts without 15 s of healthy runtime → Safe Mode (no themes/plugins/layout rules). It can also be toggled with `Ctrl+Shift+Z`, from the tray, in Settings > Advanced, or with `--safe-mode`.
- The compatibility check is read-only. It verifies the stylesheet is present (exactly one) and **winning** (Discord's variable resolves to ZERO's value), plus the required anchors and variables. Optional parts (message input) are not flagged on pages that don't have them. It reports `ok / degraded / unknown` and never claims a Discord build is "supported".
- Plugin failures are isolated per plugin and surfaced in the UI.

## Built-in plugins

Thirty-one plugins ship with ZERO (`src/shared/builtins.ts` catalog, `src/preload/runtime.ts` page code, `src/main/games.ts` game detection), all off by default and toggled in Settings > Plugins, which lists them by category with a search box.

- **Where they run.** They need Discord's own data (presences, messages, voice state, settings), so `runtime.ts` runs in Discord's page world. It is one self-contained function installed by the Discord preload with `contextBridge.executeInMainWorld`. It receives only a JSON string event (`zero:cfg`: enabled plugins, their settings, the detected game) and can only emit `zero:crash` (a rate-limited reload request, at most 3 in 10 minutes), `zero:data-save`, `zero:focus`, and the four plugin requests described below (`zero:translate`, `zero:dl-act`, `zero:voice`, `zero:side`). Each is a short string, checked by the Discord preload and again by main, and honoured only while its plugin is on. It gets no IPC, no files and no ZERO storage, and it never reads tokens, cookies or credentials.
- **Cost.** With every plugin off it does nothing. Discord's modules are looked up lazily when the first plugin starts: one scan, about 12 ms. DOM plugins share one MutationObserver throttled to 250 ms, disconnected when none is on. The Flux `dispatch` wrapper is installed only for MessageLogger.
- **Discord internals.** Stores are found by `getName()`. Settings use Discord's own accessors (`getSetting`/`updateSetting`), found from their `("group","key")` declaration. The status setter, `openUserProfileModal` and `LOCAL_ACTIVITY_UPDATE` are Discord's own; nothing calls Discord's HTTP API.
- **GameDetection.** While GameDetection or AutoDND is on, the main process reads running program names every 15 s (`tasklist`). It matches them against Discord's public detectable-games list, cached for 7 days in `detectable-games.json`; generic names and launchers are skipped. IgnoreActivities filters here, so ignored games are never reported.
- **MessageLogger.** Logs in memory only (at most 2000 entries), cleared on restart.
- **Saved plugin data.** MessageReminder, SmartBookmarks, QuickNotes, SmartText, VoiceAnalytics, MicStudio and MessageStatistics keep data across restarts in `plugin-data.json` (`src/main/pluginData.ts`: atomic write, one previous copy, a corrupt file is set aside). The page gets that data inside `zero:cfg`, and only for those plugins while they are on. It hands changes back as a `zero:data-save` string event. The Discord preload accepts only those ids. StreamPresets, DownloadManager and WorkspaceProfiles data are written by ZERO itself, never by the page. The main process also requires the plugin to be on, caps the size at 1.5 MB, and rebuilds the document from the schema in `src/shared/pluginData.ts`: fixed fields, length limits, numeric ids, Discord CDN links only for attachments, capped counts. Nothing of the page's JSON is kept as-is, and none of it is code.
- **The ZERO panel.** Ctrl+Shift+L, or a button in the channel header, opens a panel inside the Discord page with one tab per plugin that has one (Home, Reminders, Saved, Notes, Snippets, Clipboard, Stats, Downloads, Connection, Calls, Mic). "Remind me…" and "Save message…" are added to Discord's own message right-click menu when it opens; nothing is patched in Discord's code. Reminders ring from a 15 s check while ZERO runs (Windows notification plus an in-page toast). Clicking one may send `zero:focus`, which only brings the window to the front, at most once a second, and only while MessageReminder is on.
- **SmartText.** `;;` (or Ctrl+Shift+Space) in a message box opens the picker. The first `;` is removed through Discord's own editor object (a DOM edit would be undone by it), and the text goes in as a paste. It is never sent: the user presses Enter.
- **Sloppy-mode trap.** `executeInMainWorld` evaluates the runtime in non-strict mode. There, a function declared inside a plugin's block also replaces a function of the same name in the runtime scope. A test (`tests/plugindata.test.ts`) fails if a block function reuses a runtime-level name.
- **Finding Discord's objects.** Some exports are proxies that answer any property name, so a lookup by method name alone can return the wrong object. Lookups also check a method's source for the Flux action it dispatches (MicStudio's audio actions, for example).
- **ConnectionDoctor / VoiceAnalytics.** They read Discord's `RTCConnectionStore` (ping, average ping, outbound loss rate in percent, voice server host, state) and the page media statistics (jitter, concealment, see `mediastats.ts`). Only the region part of the server host is shown or kept ("rotterdam"). VoiceAnalytics saves one summary per finished call (numbers, place name, regions, drops), at most 200, through the plugin-data channel.
- **MicStudio.** The test opens its own `getUserMedia` stream and an `AnalyserNode`. Nothing is recorded or sent, and the stream is stopped when the tab is left, the panel closes or the plugin turns off. Profiles store Discord's voice settings and apply them through Discord's own audio action creators, so Discord's own checks still apply.
- **SmartAudioFocus.** It reads Discord's sound list (sound name → `/assets/<hash>.mp3`) and wraps `HTMLMediaElement.prototype.play`. Only those files are matched: a message, voice, stream or self sound is played quieter or skipped while the rule is active. Ringing is never touched. The original `play` is restored when the plugin turns off.
- **StreamPresets.** It lives in ZERO's screen picker, not in the Discord page. Presets are saved by main from a source the picker itself listed (`presetFrom`), never from page data, and the Discord page cannot write them. Resolution and frame rate are not set: Discord applies them only through its own Go Live flow, which enforces Nitro limits.
- **PrivacyMode.** Ctrl+Shift+H sets an attribute on `<html>`; a stylesheet blurs names, avatars, previews and, as an option, message content. While it is on, desktop notifications show "New notification" without a name or text. It can also turn itself on while you share your screen.
- **Desktop notifications.** PrivacyMode and NotificationProfiles share one `Notification` wrapper, installed only while one of them is on and removed when both are off. NotificationProfiles decides first (hold the popup back or not), then PrivacyMode may hide its text. A held popup returns an inert object to Discord. ZERO's own reminders (tag `zero-…`) are never held. Held popups are counted and reported in one toast when the rule ends.
- **ChatFilters.** One DOM pass reads each visible message from `MessageStore` and sets an attribute on its row; CSS folds, dims or hides it. Nothing is removed from Discord, and a folded message opens with a click.
- **MessageStatistics.** It counts `MESSAGE_CREATE` events (the local echo of your own message is skipped): your messages per day and per channel, DMs and mentions received. Numbers only, kept 120 days.
- **ClipboardManager.** It listens to `copy` events and, as an option, wraps `Clipboard.prototype.writeText` (Discord's Copy Text / Copy Link). The history lives in memory only. "Copy" uses the original `writeText`, "Insert" pastes into the message box like SmartText.
- **InlineTranslator.** "Translate" in the message menu sends the text of that one message (markdown marks removed, at most 500 characters) through `zero:translate`. Main (`src/main/translate.ts`) checks the language against a fixed list, allows 10 requests a minute, and calls `api.mymemory.translated.net` with a plain `fetch` (no Discord cookies, no names or ids). The answer is parsed and shown under the message as text.
- **DownloadManager.** Main listens to `will-download` for the Discord window and the side panel (`src/main/downloads.ts`), and records name, size, state and path in plugin data. The page only gets names, sizes and states. It can ask to cancel, show in folder, open, or remove an entry (the file stays). Only pictures, video, sound, PDF and text open directly (`OPENABLE`). "Straight to Downloads" saves under a Windows-safe, unique name.
- **VoiceOverlay.** The page sends who is in the current call (names, talking, muted) at most every 120 ms, on Flux voice events plus a 2 s check. Main parses it (`parseVoice`: 25 people, 32 characters a name) and draws it in a frameless, transparent, always-on-top window that never takes focus or clicks (`src/main/voiceOverlay.ts`, page `voiceoverlay.html`, which only receives data). It is hidden outside calls.
- **MultiPanel.** The button next to the panel button sends the current channel path. Main checks it (`SIDE_PATH`) and opens Discord's own web app at that path in a `WebContentsView` on the right (`src/main/sidePanel.ts`). That page gets no ZERO preload and no IPC; ZERO only inserts CSS into it (the theme, and hiding the server and channel lists) and narrows the main page's `#app-mount` with inserted CSS. It costs a second Discord page in memory.
- **ZERO Dashboard.** A "Home" tab that reads the data of the other plugins that are on (reminders, saved messages, notes, last call, today's counts). It stores nothing itself.
- **ThemeStudio.** In Settings > Colors. `src/shared/themeStudio.ts` builds a palette from a base color and an accent (dark, dim, AMOLED, light), checks WCAG contrast for text, muted text, links and button labels, and can move text lightness until every check passes. It only edits colors of the user's theme through the usual `theme:update` path.
- **WorkspaceProfiles.** Settings > Workspaces (shown while the plugin is on) and the tray menu. A workspace stores the theme id, layout id, performance profile and every built-in plugin's state; it is validated on load (`sanitizeBuiltins`, `sanitizePerfOptions`). Switching never turns WorkspaceProfiles itself off, and a missing theme or layout keeps the current one.

## Style add-ons (plugins folder, v1: declarative)

`plugins/<id>/plugin.json` + optional stylesheet. Permission model (`ui.css`, `ui.panel`, `storage.local`, `theme.read`, `shortcuts`): the user must grant each. v1 loads only linted CSS; **no plugin JavaScript is executed**. A scripted runtime needs a real sandbox (a separate sandboxed renderer with a message API) and is deliberately not faked with `vm`.

## Runtime lessons (verified by running the app)

- `webContents.insertCSS` with `cssOrigin:'user'` cannot be removed. ZERO no longer uses `insertCSS` at all: the preload controller owns a single style element.
- ZERO settings are a `WebContentsView` layered over the Discord page inside the same window (sandboxed, context-isolated, own preload with the channel allowlist). It is created on open and destroyed on close, so it costs nothing while closed. The ZERO button in Discord's user panel (`src/preload/launcher.ts`) can only send `zero:openSettings` and `zero:hintDone`; main checks that the sender is the Discord main frame.
- Streaming: `src/main/capture.ts` sets a plain Chrome user agent for the Chromium ZERO runs (Discord gates Go Live and stream watching on it) and shows the screen/window picker as a layer, like the settings. The picker page can only list sources and answer once; main accepts only ids it listed. With "Share sound", main grants Windows loopback audio, and the Discord preload adds `restrictOwnAudio` to `getDisplayMedia` (via `contextBridge.executeInMainWorld`, the only code ZERO runs in Discord's page world), so the call is not echoed into the stream.
- The settings page and Discord share the default session. Never install session-wide header rewrites for the settings page; use a CSP `<meta>` in `settings.html` instead.
- Opening Settings in the same tick as the main window left Discord's renderer unresponsive. `--settings` opens it after first paint.

## Updates

- **Entry point.** `package.json` points to `dist/boot.js` (`src/boot/index.ts`). It fixes the profile, then starts either the installed code (`resources/app.asar`) or a newer app package from `<profile>/updates/`. The running version is built into the code (`__ZERO_VERSION__`), so a quick update reports its own version, not the installed `package.json`.
- **Manifest.** Each release publishes `zero-update.json` (`scripts/release.mjs`): version, Electron version, structured notes (`docs/release-notes/v<version>.json`), and the size and SHA-512 of the app package (`ZERO-app-<v>.asar`) and of the installer. It is signed with Ed25519. The public key is in `src/shared/updateKey.ts`; the private key stays outside the repository (`scripts/update-key.mjs`). `parseManifest` checks the signature before anything else and refuses unsafe file names.
- **Quick update** (same Electron): the updater downloads the app package to `.part`, checks size and SHA-512 while it streams, moves it into place, writes `boot.json` (the signed manifest and a start counter) and restarts ZERO. Nothing in the install folder changes.
- **Boot checks.** On every start the loader checks the signature again, that the package is newer than the installed code and built for this exact Electron, and that the file still matches the signed SHA-512. It counts starts; the app resets the count after 15 s and on a clean quit. After three failed starts, or if any check fails, it deletes the record and starts the installed code, and the update screen says the update did not apply.
- **Full update** (Electron changed): the installer is downloaded and checked the same way, then run with `--updated /S --force-run` (silent, same folder, starts ZERO when done). The installer brings newer code, so the loader then ignores the old app package and the updater removes it.
- **Older clients.** Releases still publish `latest.yml` and the installer, so versions before 0.6.0 (electron-updater) reach the new system through the installer.
- **Linux.** The manifest can carry `linux.appimage`, `linux.deb` and `linux.rpm` (older clients ignore them; the signature covers them). The quick-update package is the same `.asar` for both systems, since the platform is detected at run time. A full update on Linux replaces the AppImage after `--zero-selftest`, keeping a backup, or opens the .deb/.rpm in the system installer and never asks for root (`src/main/platform/linuxUpdate.ts`). Details in [LINUX.md](LINUX.md).

## Platforms

What differs between Windows and Linux is in `src/main/platform/`; everything else is shared. See [LINUX.md](LINUX.md#architecture).
