<p align="center"><img src="build/icon.png" width="112" alt="ZERO logo"></p>

<h1 align="center">ZERO</h1>

<p align="center">A themeable, lightweight desktop client for Discord on Windows and Linux.<br>
Custom themes and backgrounds that actually apply everywhere, with no restart needed.</p>

<p align="center"><a href="https://github.com/lololyeye/zero-client/releases/latest"><b>Download for Windows</b></a> · <a href="docs/LINUX.md"><b>Linux (Mint, Ubuntu, Fedora, AppImage)</b></a></p>

---

## Install

1. Download `ZERO-Setup-x.y.z.exe` from the [latest release](https://github.com/lololyeye/zero-client/releases/latest).
2. Run it and choose where to install.
3. Sign in to Discord as usual. ZERO loads Discord's official web app.
4. Open ZERO's settings with the **ZERO button** at the bottom left, next to Discord's settings gear (or press `Ctrl+,`). They open inside the window, like Discord's own settings. `Esc` closes them.

> The installer is not code-signed yet, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

**Linux:** on Linux Mint, Ubuntu or Debian, download `ZERO-x.y.z-amd64.deb` and open it, or use the AppImage on any distribution (`.rpm` for Fedora). See [docs/LINUX.md](docs/LINUX.md) for setup, updates, what works on Linux and troubleshooting. Linux support is new: it is built and started in CI and WSL but not yet confirmed on a real Linux Mint desktop.

**Updates:** at startup ZERO checks GitHub once for a newer release and shows what changed. Most updates are quick: ZERO downloads only its own code (under 1 MB) and restarts on it in a few seconds, with no installer. When a release also updates the Chromium engine, the installer runs silently and ZERO opens again by itself (on Linux: the AppImage replaces itself after a self-test, and a .deb or .rpm opens in your system's package installer). Every update is signed and checked before it is used. Your settings, themes and backgrounds are kept. You can turn the check off in Settings → General.

## Features

- **Themes:** 8 presets plus your own. Change any color and see it live in Discord and in the preview.
- **Backgrounds:** PNG / JPG / WebP images or gradients, per area (whole window, sidebar, servers, DMs, settings). Controls for position, size, opacity, blur, brightness, contrast, overlay and surface opacity.
- **Layouts:** compact density, rail and channel-list widths, chat width, avatar shape, hidden timestamps.
- **Performance profiles:** Balanced, Lightweight or Custom. Each switch does something real.
- **Safe Mode:** `Ctrl+Shift+Z` removes every customization instantly. ZERO also turns it on by itself after repeated failed starts.
- **Backups:** settings are saved atomically with rolling backups, and a corrupted file is restored from the latest backup.
- **Built-in plugins (31, all off by default):** browse them by category in Settings → Plugins. Among them:
  - Chat: ChatFilters, InlineTranslator, MessageStatistics, MessageReminder, SmartBookmarks, SmartText, MessageLogger.
  - Voice and streaming: ConnectionDoctor, VoiceAnalytics, MicStudio, SmartAudioFocus, StreamPresets, VoiceOverlay, CallTimer.
  - Tools: ZERO Dashboard, MultiPanel (a second channel side by side), DownloadManager, ClipboardManager, QuickNotes.
  - Appearance and privacy: ThemeStudio, WorkspaceProfiles, NotificationProfiles, PrivacyMode.
  - `Ctrl+Shift+L` opens the ZERO panel inside Discord.
- **Style add-ons:** CSS-only add-ons from your plugins folder, with explicit permissions.
- **Streaming:** Go Live and watching streams work in ZERO. Pick a screen or an app window, and turn on **Share sound** to stream your PC's audio (Windows only: Electron cannot capture system sound on Linux). Your voice call is left out of the stream, so viewers don't hear an echo.

Shortcuts: `Ctrl+,` opens or closes ZERO settings, `Esc` closes them, `Ctrl+F` searches them, `Ctrl+Shift+Z` toggles Safe Mode.

## Privacy and safety

ZERO never reads, stores or sends your Discord token or password. It does not automate your account and does not use Discord's API. It only restyles the page you see. The only network request ZERO makes on its own is the optional update check to GitHub. A few plugins reach the network only while you turn them on: GameDetection downloads Discord's public list of games, and InlineTranslator sends the text of a message you choose to translate to the MyMemory translation service.

ZERO is an independent project and is **not affiliated with Discord Inc.** Modified clients are a grey area under Discord's Terms of Service; use it at your own risk.

## Build from source

```bash
npm install
npm start          # build + run
npm run check      # typecheck + lint + tests
npm run package    # Windows installer in ./release
npm run package:linux   # AppImage, .deb, .rpm (run on Linux; the .rpm needs rpmbuild)
```

Docs: [architecture](docs/ARCHITECTURE.md) · [Linux](docs/LINUX.md) · [verification](docs/VERIFICATION.md) · [known issues](docs/KNOWN_ISSUES.md)

## License

MIT © lololyeye
