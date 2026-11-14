# Performance audit (ZERO 0.4)

Every number on this page was measured, on one PC, with the method written next to it. Where something could not
be measured (a real call, a game plus Go Live, Discord Stable side by side in the same state, Vesktop), it says so
instead of guessing. Reproduce any of it with the tools at the end.

**Test PC:** Ryzen 5 3600 (6 cores / 12 threads), GeForce GTX 1650 (4 GB, driver 32.0.16.2124), 16 GB RAM,
Windows 11, two monitors, 144 Hz main display. ZERO dev build on Electron 45.3 (Chromium 156), signed in.

## Summary

- **ZERO itself is not what makes Discord heavy.** Its own code took 19.6 ms of CPU during 36 s of rapid server
  switching, against 2.8 s for Discord's web app. Its stylesheet makes no measurable difference to style or layout
  time (on/off A/B, three runs each). What Discord costs is its web app running in Chromium; ZERO can stay out of
  its way, not rewrite it.
- **No memory accumulation from navigation.** 108 server switches with scrolling: the JS heap retained after
  garbage collection went from 95.5 to 96.5 MB, and DOM nodes and listeners went up and down with no trend.
- **Screen sharing uses the GPU's encoder on this card.** Discord's web client offers H.264 first. On the
  GTX 1650 Chromium encodes it with *NVIDIA H.264 Encoder MFT* (NVENC) and decodes it on D3D11. A 1080p ~55 fps
  screen stream cost 4.7 % CPU in H.264, against 13.1 % in VP8 (software). This is why no profile turns off
  hardware acceleration.
- **Real fixes in 0.4:** game detection costs about 3× less CPU per scan with no game running, and about 23×
  less while a game runs. ZERO stops all DOM work while hidden behind a game. The call timer no longer re-runs every
  plugin's DOM pass each second. Background throttling applies live. The memory figure in Settings is now private
  memory, as in Task Manager (it used to include shared memory).
- **New:** three real profiles (Balanced / Performance / Low Resource), and live diagnostics. The diagnostics show
  session memory history, main-process stalls, GPU status, and the codec, encoder and frame rate of your stream,
  with dropouts in calls.

## What was measured

### ZERO's own cost

| Test | Result |
|---|---|
| Idle, window hidden, 30 s CPU profile | ZERO injected code 3.4 ms, Discord scripts 46 ms |
| Rapid switching: 18 server switches + scrolling, 36 s | ZERO 19.6 ms, Discord JS + native 2,829 ms (+5,182 ms Chromium native work) |
| ZERO styles on vs off, same switching run, alternated 3× | Task time on 8,352 / 7,920 / 8,111 ms vs off 8,511 / 8,468 / 7,541 ms; style recalc 841 / 924 / 729 vs 817 / 863 / 670 ms: noise |
| Main process | 6 MB JS heap, ~80 MB private memory |

Method: Chrome DevTools Protocol sampling profiler (250 µs) on the Discord page; a sample counts as ZERO's when any
frame on its stack belongs to ZERO's injected scripts. Test scripts were tagged and excluded.

### Memory over time

| Test | Result |
|---|---|
| 6 rounds × 18 switches, forced GC after each | heap 95.5 → 95.1 → 95.6 → 95.7 → 96.1 → 96.3 → 96.5 MB |
| DOM nodes / JS listeners after each round | 3,356–3,445 / 1,227–1,253, alternating, no trend |
| Chromium memory-pressure signal (drops caches) | −8 MB: not worth adding, so ZERO does not use it |
| MessageLogger / edit history | capped (2,000 messages, 10 edits each) |
| Game list (25,279 apps, 12.6 MB JSON) | 1.6 MB kept after parsing; a 26 MB peak, released, once per start when the feature is on |

ZERO now keeps one memory sample per minute (one `getAppMetrics()` call), and Settings > Performance draws the
whole session. After 40 minutes it shows the trend in MB per hour, ignoring the first 10 minutes while Discord fills
its caches. That is the honest way to answer "does it grow over hours" on your own PC.

### Rendering (Discord page, 144 Hz)

| | Median | p95 | Notes |
|---|---|---|---|
| Server switch (click → messages painted) | 64–88 ms | 120–158 ms | Discord's own work |
| Frame interval during switching | 6.9 ms | 7.1 ms | p99 13.8 ms; 14 frames > 50 ms in 18 switches, all at switch moments |

Unfocused, Discord already shows static avatars and emoji and stops GIFs (0 animated images on any server while
unfocused). ZERO's *Pause when unfocused* freezes the remaining CSS animations. When ZERO is minimized or covered by
a fullscreen game, Chromium stops painting it entirely, and 0.4 also pauses ZERO's DOM work.

### Startup

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Window and Discord page created | 327 ms | 347 ms | 318 ms |
| Discord UI ready (server list) | 2,399 ms | 2,354 ms | 2,238 ms |

The remaining ~2 s are Discord's web app downloading and starting. ZERO's part is the first ~0.3 s.

### Video and screen sharing (GTX 1650)

Loopback test inside ZERO: real screen capture → encoder → decoder, 1920×1080, 6 s per codec. The encoder name is
read from WebRTC's own statistics. GPU engine use comes from Windows' GPU counters.

| Codec | Encoder | Decoder | CPU (whole client) |
|---|---|---|---|
| H.264 | hardware: NVIDIA H.264 Encoder MFT | hardware: D3D11 | 4.7 % |
| VP8 | software (libvpx) | software | 13.1 % |
| VP9 | software | hardware | — |
| AV1 | software | software | — |

Discord's web voice engine lists video codecs as H.264, VP8, VP9 (H.265 only behind a flag); it never uses AV1.
Which codec a real Go Live uses is decided by Discord's server, so Settings > Performance > Voice and stream now
shows it live: codec, resolution, frame rate, bitrate, hardware or CPU, and the reason if quality is being reduced.

### Game detection (GameDetection / AutoDND)

| Scan (every 15 s while one of these is on) | CPU per scan |
|---|---|
| 0.3: full `tasklist` | ~700 ms |
| 0.4: no game running, processes over 40 MB only | ~240 ms |
| 0.4: a game is running, check that one executable | ~31 ms |

With a game open, that is about 4.7 % of one core in 0.3 against 0.2 % in 0.4. A minimized game whose memory drops
below the filter is still found, because it is checked by name. With both features off, nothing runs.

### Idle, after the changes

5 minutes, sampled every 2 s, at the same time. The two clients were **not** in the same state, so this is context,
not a head-to-head result. ZERO was minimized, with Settings open (7th process). Canary had been running 11 h in the
background.

| | Processes | Memory avg / peak | CPU avg / p95 | GPU memory |
|---|---|---|---|---|
| ZERO 0.4 dev, idle, minimized | 7 | 390 / 409 MB | 0.12 % / 0.43 % | 71 MB |
| Discord Canary (desktop), idle, 11 h uptime | 6 | 582 / 620 MB | 0.67 % / 2.41 % | 1,159 MB |

Before the changes, the same dev build idle measured 378–381 MB and 0.06–0.45 % CPU. Idle was never where ZERO
spent its effort, and 0.4 does not claim to have changed it. The gains are in the targeted cases above.

## What changed in 0.4

- **Game scan** (`src/main/games.ts`): as above.
- **Hidden window** (`src/preload/runtime.ts`): while minimized or covered, no plugin DOM work; one catch-up pass
  when shown. Verified: 0 platform indicators drawn while hidden, 5 within 800 ms of becoming visible.
- **Call timer**: changes inside ZERO's own elements no longer wake the shared DOM observer, so the 1 s timer tick
  no longer re-runs every plugin's DOM pass. The tick does nothing while hidden and skips identical writes.
  Verified by counting the DOM queries the passes make: 4 ticks of a ZERO element → 0; 4 changes to Discord's DOM → 12.
- **Profiles** (`src/shared/config.ts`): Balanced / Performance / Low Resource / Custom, all applied live. Verified
  in the app: switching keeps the page (no reload), animations off in Performance and Low Resource, spellcheck off
  in Low Resource, background throttling switched live (`getBackgroundThrottling` true → false → true).
- **Diagnostics** (Settings > Performance): private memory per process, session memory history and trend, ZERO
  main-process stalls (a 250 ms timer's lateness, only while the page is open), Chromium GPU feature status, live
  voice and stream statistics, and recommendations from measured values only. Stream statistics are whitelisted
  fields (codec, encoder, resolution, fps, bitrate, loss, concealment). No IP address, SDP, name or message leaves
  the page. Verified with a live H.264 stream: the panel showed the NVIDIA encoder and D3D11 decoder.

## What is outside ZERO's control

- Discord's web app (React rendering, message lists, its caches) is most of the memory and CPU, in every Discord
  client built on the web app.
- Chromium starts a video-capture service (~62 MB) as soon as Discord lists cameras and microphones. Removing it
  would break device selection.
- Voice processing (echo cancellation, noise suppression) runs inside Discord's web voice engine.
- Discord Stable and Canary use a native voice engine with their own encoder choice; ZERO uses Chromium's WebRTC.

## Not measured yet (needs you)

These need a real call, a game, or another Discord client in the same state. Nothing was invented for them:

1. ZERO alone, 2 h idle, then compared with Discord Stable in the same state (same servers open, minimized).
2. In a call with screen share while a game runs: ZERO vs Discord Stable, same game, same stream settings.
3. Watching a stream; streaming while browsing servers.
4. Vesktop (not installed on the test PC).

## How to measure

`scripts/bench.ps1` samples one client's whole process tree every 2 s and writes a CSV: private memory, CPU (% of
the whole machine), GPU 3D, video encode and decode engine use, and dedicated GPU memory. It reads only Windows
performance counters, never accounts, windows or messages. `scripts/bench-report.mjs` prints averages, peaks, p95
and memory growth per minute.

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bench.ps1 -Exe ZERO.exe -Seconds 600 -Label zero-call-game
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bench.ps1 -Exe Discord.exe -Seconds 600 -Label stable-call-game
node scripts/bench-report.mjs bench-results
```

For a fair comparison: fresh start of each client, same account state, let it settle 3 minutes, then measure the
same scenario for the same duration, one client at a time. For "does memory grow over hours", use `-Seconds 7200`
or read Settings > Performance after a long session.

Two traps this audit hit and fixed in the tool: a fresh counter query per sample returns meaningless CPU and GPU
values (one continuous session is needed), and on a French or German Windows decimal commas broke the CSV.
