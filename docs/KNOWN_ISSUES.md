# Known issues and limitations (v0.2.0)

Honest list; nothing here is hidden by the UI.

## Verified on the real client (2026-11-14)

An automated end-to-end run against the signed-in Discord window passed 49 of 49 checks, plus a separate settings-area check. Colors are checked by sampling painted pixels in memory; no screenshots are stored. The run also covered restart persistence, a missing image, a corrupted config, and stress tests. See `docs/VERIFICATION.md` for the list and the measured values.

## Limitations

1. **Discord's DOM changes.** Backgrounds and a few element rules use class-name prefixes (`page_`, `sidebar_`, `sidebarList_`, `panels_`, `layers_`…), matched at a class boundary so hash changes don't matter, but a *rename* would break that area. Colors use Discord's CSS variables and are more robust. Settings > Advanced > Check theming hooks reports missing parts; Safe Mode (`Ctrl+Shift+Z`) removes everything.
2. **Surface opacity is uniform per area.** Inside an area with a background, all base panes share one tint. Cards, the message input and the user panel are tinted again on top, so the image is dimmer behind them. This is deliberate (readability).
3. **Bottom strip of the server rail.** A short strip at the bottom of the rail (Discord's own fade) shows the sidebar image without the tint.
5. **Share sound captures your whole PC's audio** (Windows system loopback), even when you share a single window. Your Discord call is excluded through Chromium's `restrictOwnAudio`, but other apps you hear are included. Per-app audio would need a native Windows module.
4. **ZERO settings cover the Discord page while open**, like Discord's own settings. Edits are applied to Discord immediately; use the live preview while editing, or close the settings (`Esc`) to see the result.
5. **Theme import/export** is covered by unit tests (round trip, invalid JSON, oversize, missing images disabled). The file dialogs themselves were not driven in the automated run.
6. **Exported themes reference local image ids.** Image bytes are not bundled; imported layers whose image is absent are disabled.
7. **Per-server / per-channel visuals, customizable hotkeys, notification controls, particles:** not implemented, and there are no settings for them.
8. **Screen share** grants the primary screen with system audio; there is no source picker. Voice/video/screen share were **not tested end to end** with live calls.
9. **Plugins are declarative (CSS) only.** No scripted plugins.
10. **Memory** is dominated by Discord's web app (its renderer is about two thirds of the total). Numbers vary with what Discord has loaded (servers, GIFs, voice), so treat a single measurement as ±10%.
11. **Background throttling** changes apply after a restart (Electron limitation for an existing window).
12. **Installer:** `npm run package` is configured (NSIS) but unsigned and not tested; there is no auto-update channel.
13. **Tested on one machine** (Windows 11 Home, Electron 33, 1× display scaling).
14. **Terms of service:** modified clients are a grey area under Discord's ToS. ZERO restricts itself to cosmetic CSS and never touches the account or API, but the risk is yours.
