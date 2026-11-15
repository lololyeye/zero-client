# ZERO on Linux

ZERO runs natively on Linux (x86_64). It is built and tested first for **Linux Mint 22** (Cinnamon, based on Ubuntu 24.04), and packaged for other distributions too. This page covers installing, updating, what works, what does not, and how to fix common problems.

> **Honest status.** The Linux build is new in 0.7.0. It was built, installed and started on Ubuntu (WSL2 and the GitHub Actions runner) and its system checks were run there. It has **not yet been run on a real Linux Mint desktop** by the developer. Voice, screen sharing, GPU drivers, notifications and the tray need confirmation on real hardware. See [What was tested](#what-was-tested). Reports are welcome.

## Install

### Linux Mint, Ubuntu, Debian, Pop!_OS, Zorin: the .deb (recommended)

1. Download `ZERO-x.y.z-amd64.deb` from the [latest release](https://github.com/lololyeye/zero-client/releases/latest).
2. Double-click it. Linux Mint opens it in **Package Installer**. Click **Install package** and enter your password.
   Or in a terminal: `sudo apt install ./ZERO-x.y.z-amd64.deb`
3. Start ZERO from the menu (**Internet → ZERO**) or run `zero`.

The package installs to `/opt/ZERO`, adds a menu entry, the icon, and an AppArmor profile on systems that use one (Ubuntu 24.04 and later restrict unprivileged user namespaces; the profile lets Chromium's sandbox work there). Remove it with `sudo apt remove zero-client`.

### Any distribution: the AppImage

1. Download `ZERO-x.y.z-x86_64.AppImage`.
2. Put it in a folder you own, for example `~/Applications`. ZERO updates the file in place, so the folder must be writable.
3. Make it executable (right-click → Properties → Permissions → *Allow executing file as program*, or `chmod +x ZERO-*.AppImage`) and run it.

AppImages need FUSE 2. Linux Mint ships it; if the AppImage does not start, install it: `sudo apt install libfuse2t64` (Ubuntu 24.04, Mint 22) or `sudo apt install libfuse2` (older releases).

### Fedora, openSUSE: the .rpm

`sudo dnf install ./ZERO-x.y.z-x86_64.rpm`. The .rpm is built and checked by CI but was not installed on a Fedora machine yet.

### Your settings

ZERO keeps its settings, themes, backgrounds and plugin data in `~/.config/ZERO`. Logs are in `~/.config/ZERO/logs`. Removing the package does not remove this folder.

## Updates

ZERO checks GitHub once at startup (you can turn this off in Settings → General). How the update is applied depends on how ZERO was installed. Every file is checked against the signed manifest (Ed25519 signature, size, SHA-512) before it is used.

| Install | Quick update (ZERO's own code) | Full update (new Chromium engine) |
|---|---|---|
| AppImage | Restart in place, a few seconds | The new AppImage is started once with `--zero-selftest`. Only if it reports the right version is the old file kept as `*.zero-backup` and the new one moved into its place. The backup is deleted after the new version has started normally. If the folder is not writable, ZERO says so and changes nothing. |
| .deb / .rpm | Restart in place, a few seconds | The verified package is opened in your system's package installer (Mint: Package Installer). **ZERO never asks for your password and never runs anything as root.** You confirm there, then click **Restart ZERO**. |
| Flatpak, Snap, unpacked folder | Restart in place | The download page opens. |

Quick updates are stored in `~/.config/ZERO/updates`, not in the install folder. They therefore also work for the .deb in `/opt` and for the read-only AppImage. If a new version fails to start three times in a row, ZERO goes back to the installed version by itself.

## Settings → Linux

This section only appears on Linux. It shows:
- **System:** distribution, kernel, desktop, X11 or Wayland, CPU, memory, GPU and driver, sound server, how ZERO is installed, and the Electron and Chromium versions.
- **Diagnostics:** checks with a short explanation for GPU acceleration, the NVIDIA nouveau driver, sound, screen sharing, stream sound, the desktop portal, notifications, plugins and updates.
- **Export report:** saves a plain text file with these facts, which you can attach to a bug report. Home folder paths are replaced by `/home/<user>`. The report never contains tokens, messages, server names or account details.

## Compatibility

| Feature | Linux status | Notes |
|---|---|---|
| Sign in, chat, servers, DMs | Works (same Discord web app) | Tested: discord.com loads, Linux user agent |
| Themes, backgrounds, layouts | Works | Page-side code, the same as on Windows |
| Performance profiles | Works | Hardware acceleration can be turned off in Settings → General |
| Voice calls, microphone, devices | Expected to work | Chromium talks to PulseAudio or PipeWire (pipewire-pulse). Needs a real-hardware test |
| Screen sharing on X11 (Mint Cinnamon) | Expected to work | ZERO's own picker lists screens and windows. Needs a real-hardware test |
| Screen sharing on Wayland | Expected to work through the system portal | Needs `xdg-desktop-portal` and a backend (GNOME, KDE or wlr). Untested |
| Stream sound ("Share sound") | **Not available** | Electron captures system audio on Windows only. The picker says so; your voice in the call is not affected |
| Notifications | Expected to work | Needs libnotify (a dependency of the .deb) and a notification daemon |
| Tray icon | Expected to work | Cinnamon, KDE and XFCE show it. GNOME needs the AppIndicator extension |
| Game activity (GameDetection) | Works | Reads `/proc`: native Linux games and Windows games through Steam Proton or Wine. Unit-tested |
| Quick updates, AppImage update | Works | Tested in WSL2: self-test, swap with backup, refusal of a corrupted or wrong-version file, refusal of a read-only folder |
| .deb / .rpm full update | Expected to work | Opens the system installer. Not run end to end yet |

## Plugin report

Plugins can declare which systems they support. A plugin that does not support yours cannot be turned on, and Settings shows why. Third-party plugins can add `"platforms": ["linux", "win32"]` to `plugin.json`. Without that field they are treated as cross-platform.

| Level | Plugins |
|---|---|
| **Supported** (29) | AccountPanelServerProfile, AutoDNDWhilePlaying, CallTimer, ChatFilters, ClipboardManager, ConnectionDoctor, CrashHandler, CustomRPC, DownloadManager, GameActivityToggle, GameDetection (native and Proton games), IgnoreActivities, InlineTranslator, MessageLogger, MessageReminder, MessageStatistics, MicStudio, MultiPanel, NotificationProfiles, PlatformIndicators, PrivacyMode, QuickNotes, SmartAudioFocus, SmartBookmarks, SmartText, ThemeStudio, VoiceAnalytics, WorkspaceProfiles, ZERO Dashboard |
| **Partial** (2) | **StreamPresets**: saved setups and the encoder check work, but shares have no system sound. **VoiceOverlay**: needs a compositing desktop for transparency (Cinnamon, GNOME and KDE have one); on Wayland it cannot be placed in a corner or kept above full-screen games |
| **Unsupported** | none |

"Supported" means the plugin uses no Windows-only feature: these plugins run inside the Discord page or use Electron APIs that exist on Linux. It does not mean each one was tried by hand on Linux Mint.

## Troubleshooting

- **The AppImage does nothing when started.** Install FUSE 2 (`sudo apt install libfuse2t64`), or run it from a terminal to see the error. To run it without FUSE: `./ZERO-*.AppImage --appimage-extract-and-run`.
- **"The SUID sandbox helper binary was found, but is not configured correctly".** Use the .deb, which sets up the sandbox and AppArmor profile. Do not run ZERO with `--no-sandbox`.
- **Black or flickering window, or high CPU.** Turn off hardware acceleration in Settings → General and restart. Settings → Linux shows whether Chromium is using the GPU.
- **NVIDIA.** The proprietary driver (Driver Manager in Mint) works best. With the open `nouveau` driver Chromium often disables GPU compositing, and the diagnostics say so.
- **No microphone or wrong output.** Check that `pipewire-pulse` (Mint 22) or `pulseaudio` is running. Pick devices in Discord's Voice & Video settings. `pavucontrol` shows which app uses which device.
- **Screen sharing shows nothing on Wayland.** Install `xdg-desktop-portal` and the backend for your desktop (`xdg-desktop-portal-gnome`, `-kde` or `-wlr`), then log out and back in.
- **No notifications.** Install `libnotify4`, and check that your desktop's notifications are not muted (Do Not Disturb).
- **The window is not grouped with its menu icon.** The .desktop file uses `StartupWMClass=zero`. If you made your own launcher, use the same value.
- **Something else.** Settings → Linux → **Export report**, then open an issue with the file and `~/.config/ZERO/logs/zero.log`.

## Architecture

- `src/main/platform/index.ts`: what differs per system (`PLATFORM`, `CAPABILITIES`, the user agent, the list of running programs). Everything else in ZERO is shared.
- `src/main/platform/linux.ts`: pure functions that read system facts: `/etc/os-release`, the session (X11 or Wayland and the desktop), `/proc` for running programs, the install format (AppImage, .deb, .rpm, Flatpak, Snap), the sound server sockets, portal backends, CPU and GPU drivers. They are tested with fake inputs in `tests/linux.test.ts`.
- `src/main/platform/diagnostics.ts`: builds Settings → Linux and the report text.
- `src/main/platform/linuxUpdate.ts`: the AppImage self-test and swap, and the clean environment for starting the new file.
- `src/shared/builtins.ts`: `supportOn(id, os)` gives each built-in plugin's level and reason; `activeBuiltins` never starts an unsupported one.
- `src/shared/plugin.ts`, `src/main/plugins.ts`: the optional `platforms` field for third-party plugins.
- `src/shared/hotUpdate.ts`: the signed manifest carries optional `linux.appimage`, `linux.deb` and `linux.rpm` entries. `fullPackage()` picks the one for this install. Clients older than 0.7.0 ignore these entries; the signature still covers them.
- The renderer is unchanged in its security model: context isolation, sandboxed preloads, an allowlist of IPC channels (`linux:info` and `linux:export` were added; both return system facts only).
- Packaging: `package.json` → `build.linux`, `deb`, `rpm`, `appImage`. `.github/workflows/linux.yml` builds the three packages on Ubuntu 24.04. It runs the unit tests, installs the .deb for real, runs `--zero-selftest` on the installed app and on the AppImage, and uploads the files.

## What was tested

| Check | Where | Result |
|---|---|---|
| Typecheck, lint, 150 unit tests (12 Linux-specific) | Windows | Pass |
| AppImage and .deb build | Ubuntu 26.04 (WSL2) | Pass |
| .deb control file, dependencies, `apt-get install -s` | Ubuntu 26.04 (WSL2) | Resolves; `t64` alternatives for Ubuntu 24.04 / Mint 22 |
| .desktop file, icons, permissions | Ubuntu 26.04 (WSL2) | Pass |
| `--zero-selftest` on the unpacked app, the AppImage (FUSE and extracted) | Ubuntu 26.04 (WSL2) | Pass |
| Full start (headless), discord.com login page, Linux user agent | Ubuntu 26.04 (WSL2) | Pass, window ready in 1.2–1.6 s |
| Settings → Linux data through the settings bridge; unknown IPC channel refused; no Node in the page | Ubuntu 26.04 (WSL2) | Pass |
| AppImage update: corrupted file, wrong version, good file with backup, backup removal, read-only folder | Ubuntu 26.04 (WSL2) | Pass |
| .rpm build | GitHub Actions only | Not run locally (no root for `rpmbuild`) |
| Windows build and `--zero-selftest` | Windows 11 | Pass |
| Voice, screen sharing, GPU, notifications, tray, Wayland | Real Linux Mint | **Not tested yet** |

## Benchmark notes

The only Linux numbers so far come from a headless run in WSL2 with software rendering (Ryzen 5 3600). From process start to a ready window took 1.25 to 1.57 s over four runs. These numbers say nothing about GPU rendering or memory use on a real desktop, which still need measuring on Linux Mint. Settings → Performance shows the startup time and memory on any system.
