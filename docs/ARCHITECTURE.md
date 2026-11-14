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

Profiles: **Balanced** (everything on), **Lightweight** (no blur, no animations, spellcheck off; colors and backgrounds kept), **Custom** (each switch: backgrounds, blur, animations, pause when unfocused, background throttling, spellcheck). Every switch has a real implementation; background throttling applies after a restart.

## Reliability

- `ConfigStore`: atomic write (tmp+rename), serialized writes, 8 rolling backups (at most one automatic backup per 10 min), backup before every migration, a corrupt file is preserved (`.corrupt-<time>`) and the newest valid backup restored, and configs from newer versions are refused, never overwritten.
- Crash-streak counter: 3 starts without 15 s of healthy runtime → Safe Mode (no themes/plugins/layout rules). It can also be toggled with `Ctrl+Shift+Z`, from the tray, in Settings > Advanced, or with `--safe-mode`.
- The compatibility check is read-only. It verifies the stylesheet is present (exactly one) and **winning** (Discord's variable resolves to ZERO's value), plus the required anchors and variables. Optional parts (message input) are not flagged on pages that don't have them. It reports `ok / degraded / unknown` and never claims a Discord build is "supported".
- Plugin failures are isolated per plugin and surfaced in the UI.

## Plugins (v1: declarative)

`plugins/<id>/plugin.json` + optional stylesheet. Permission model (`ui.css`, `ui.panel`, `storage.local`, `theme.read`, `shortcuts`): the user must grant each. v1 loads only linted CSS; **no plugin JavaScript is executed**. A scripted runtime needs a real sandbox (a separate sandboxed renderer with a message API) and is deliberately not faked with `vm`.

## Runtime lessons (verified by running the app)

- `webContents.insertCSS` with `cssOrigin:'user'` cannot be removed. ZERO no longer uses `insertCSS` at all: the preload controller owns a single style element.
- The settings window and Discord share the default session. Never install session-wide header rewrites for the settings page; use a CSP `<meta>` in `settings.html` instead.
- Opening Settings in the same tick as the main window left Discord's renderer unresponsive. `--settings` opens it after first paint.
