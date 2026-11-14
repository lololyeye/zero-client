# Verification on the real Discord client

Date: 2026-11-14 · Windows 11 Home · Electron 33 · signed-in Discord (visual refresh) inside ZERO.

How: ZERO was started with `--settings --remote-debugging-port=9333`. A script drove the **settings window's own allowlisted IPC** (the same calls the UI makes) and inspected the Discord page over the DevTools protocol. Colors were checked by **sampling painted pixels** of in-memory screenshots at measured element positions; nothing was written to disk. Message content was never read.

Earlier verification (v0.1) only checked the login page and unit tests. It was misleading: the theme did not apply to the signed-in interface at all.

## Theme checklist — 49/49 passed

| Check | Result (measured) |
|---|---|
| One `style#zero-theme`, Discord variable resolves to ZERO's value | pass |
| Midnight: server rail / channel list / chat painted | `#14161b` / `#171a20` / `#1b1e25` (exact) |
| Edit accent + chat surface live (no restart) | `--brand-500 = #ff3355`; chat repainted `#202838` |
| Editing a preset forks to "Midnight (custom)" and persists | pass |
| Invalid theme (`colors.text` injection) rejected, previous kept | pass |
| Chat image background visible, 50% surface opacity | `#8f144f` (= exact 50% mix of `#202838` over `#ff0066`) |
| Rail unaffected by chat background | `#14161b` |
| Overlay color + opacity | green `#10931c` |
| Image opacity 0 / brightness 0 | image hidden / darkened |
| Position/size: stretched split image left red, right blue | `#d2080b` / `#0608d7` |
| Disable background → plain surface | `#202838` |
| Sidebar image behind channel list and rail, chat unaffected | `#8b0d43`, `#890b41`, `#202838` |
| Aurora global gradient visible | pass |
| 8 presets × 2 rounds: correct values, always 1 style, no residue | pass |
| Frost (light) paints light surfaces, text color applied | `#f4f7fb`, `#1c2430` |
| Safe Mode removes everything / restores | Discord default `#121214` → theme back |
| Balanced has blur, Lightweight drops blur and keeps colors, Custom "backgrounds off" removes layers | pass |
| Navigate server ↔ DMs: route switches, style intact | pass |
| DM-area background shown on DMs only | `#8f144f` on DMs, `#202838` in servers |
| Discord reload (Ctrl+R equivalent) re-applies without ZERO restart | pass |
| Settings-area background (Discord User Settings modal), checked separately | nav, content and edge all `#8d0f46` (single 50% tint) |
| Compatibility check | `ok` |

## Reliability

| Scenario | Result |
|---|---|
| Full ZERO restart | active theme, background and accent restored; compat `ok` |
| Background image file deleted | layer omitted (plain surface), compat `degraded: 1 background image missing`, Discord unaffected |
| `config.json` corrupted | preserved as `config.json.corrupt-<time>`, restored from newest backup, theme intact |
| 60 theme updates fired back-to-back (slider drag) | all accepted in 18 ms, final value applied, 1 style |
| 30 rapid preset switches | 1 style element, correct final preset |
| Unit/regression tests | 79/79 (`npm test`), typecheck clean, lint 0 errors |

## Performance (idle, Discord signed in, Task Manager metric)

| | Processes | Task Manager memory | Total private | Idle CPU (all cores) |
|---|---|---|---|---|
| Before (v0.1), 3 min | 6 | 347 MB | 624 MB | 0.41 % |
| After, Balanced + sidebar image, 3 min | 6 | 277 MB | 539 MB | 0.42 % |
| After, Lightweight, 3 min | 6 | 316 MB | 563 MB | 0.17 % |
| After, Lightweight, 10 min | 6 | 319 MB | 567 MB | 0.06 % |

Reading the numbers honestly:

- Balanced after vs. before: −70 MB (−20%) in Task Manager memory, idle CPU unchanged.
- **Lightweight does not lower memory.** The 316 MB vs. 277 MB gap is run-to-run variance in Discord's own renderer (what it caches and preloads), not something Lightweight added. Lightweight lowers **CPU/GPU work** (no blur, no animations, no spellchecker): idle CPU 0.06–0.17% vs. 0.42%.
- No growth: +2.7 MB from minute 3 to minute 10 (noise level).
- Process count is the Chromium minimum for Discord (main, renderer, GPU, network, audio, video-capture utility). None were disabled, since all are needed for voice and video.

## Found during verification and fixed

- Nested translucent panes compounded the dimming (25% of the image visible instead of 50%). Fixed with a single tint layer.
- The visual-refresh client paints the channel list with the frame variable and the chat with `base-lower`. The "Channel list" and "Chat surface" colors had no visible effect until the variable map was corrected.
- User Settings is now a modal, so the settings-area selector matched nothing. Its main pane also used the card surface (double tint). Both fixed.
- The compatibility check reported "message input missing" on the Friends page. That anchor is now optional.

## Not verified automatically

Theme import/export file dialogs (logic covered by unit tests) and live voice/video calls.
