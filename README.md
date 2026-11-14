<p align="center"><img src="build/icon.png" width="112" alt="ZERO logo"></p>

<h1 align="center">ZERO</h1>

<p align="center">A themeable, lightweight desktop client for Discord on Windows.<br>
Custom themes and backgrounds that actually apply everywhere, with no restart needed.</p>

<p align="center"><a href="https://github.com/lololyeye/zero-client/releases/latest"><b>Download for Windows</b></a></p>

---

## Install

1. Download `ZERO-Setup-x.y.z.exe` from the [latest release](https://github.com/lololyeye/zero-client/releases/latest).
2. Run it and choose where to install.
3. Sign in to Discord as usual. ZERO loads Discord's official web app.
4. Open ZERO's settings with the **ZERO button** at the bottom left, next to Discord's settings gear (or press `Ctrl+,`). They open inside the window, like Discord's own settings. `Esc` closes them.

> The installer is not code-signed yet, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

**Updates:** at startup ZERO checks GitHub once for a newer release. If one exists, it offers to download the new installer. Your settings, themes and backgrounds are kept. You can turn the check off in Settings → General.

## Features

- **Themes:** 8 presets plus your own. Change any color and see it live in Discord and in the preview.
- **Backgrounds:** PNG / JPG / WebP images or gradients, per area (whole window, sidebar, servers, DMs, settings). Controls for position, size, opacity, blur, brightness, contrast, overlay and surface opacity.
- **Layouts:** compact density, rail and channel-list widths, chat width, avatar shape, hidden timestamps.
- **Performance profiles:** Balanced, Lightweight or Custom. Each switch does something real.
- **Safe Mode:** `Ctrl+Shift+Z` removes every customization instantly. ZERO also turns it on by itself after repeated failed starts.
- **Backups:** settings are saved atomically with rolling backups, and a corrupted file is restored from the latest backup.
- **Plugins:** CSS-only plugins with explicit permissions.

Shortcuts: `Ctrl+,` opens or closes ZERO settings, `Esc` closes them, `Ctrl+F` searches them, `Ctrl+Shift+Z` toggles Safe Mode.

## Privacy and safety

ZERO never reads, stores or sends your Discord token or password. It does not automate your account and does not use Discord's API. It only restyles the page you see. The only network request ZERO makes on its own is the optional update check to GitHub.

ZERO is an independent project and is **not affiliated with Discord Inc.** Modified clients are a grey area under Discord's Terms of Service; use it at your own risk.

## Build from source

```bash
npm install
npm start          # build + run
npm run check      # typecheck + lint + tests
npm run package    # Windows installer in ./release
```

Docs: [architecture](docs/ARCHITECTURE.md) · [verification](docs/VERIFICATION.md) · [known issues](docs/KNOWN_ISSUES.md)

## License

MIT © lololyeye
