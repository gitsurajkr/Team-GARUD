# AirMouse — Ground Control Station (GCS)

Operator console for the **Track 1 · Drone Innovation** mission: an autonomous
GPS-denied indoor search drone that maps a maze-like arena, detects up to 6
survivors, and tags each on a live 2D map.

The GCS is an **Electron desktop app** with a **Next.js (static-export)**
renderer. All privileged work — the MAVLink link, command sending, telemetry
aggregation — lives in the Electron **main process**; the UI is a sandboxed
renderer that talks to it over a typed IPC bridge (`window.gcs`).

> **Offline by design.** The mission runs with **no external network** (brief
> §7). The packaged app blocks all public-internet traffic and only permits the
> local link (loopback + RFC-1918 private addresses, e.g. the companion
> computer's video feed).

## What the operator sees (brief §5)

- Live mission status + flight telemetry (mode, armed, attitude, battery)
- Live drone camera feed
- Continuously-updated 2D map of the explored area
- The arena's modular grid, drone pose, and a tagged marker per survivor
- Mission progress: flight clock (30-min limit), coverage, survivor count
- The only permitted operator actions: **Start**, **Abort (Return)**, **Emergency Stop**

## Architecture

```
gcs/
├─ electron/                 # Main process (Node) — compiled to dist-electron/
│  ├─ main.ts                #   window, app:// protocol, offline hardening
│  ├─ preload.ts             #   contextBridge → window.gcs (typed)
│  ├─ ipc/register.ts        #   wires link+telemetry+mission → IPC, event fan-out
│  ├─ mavlink/
│  │  ├─ protocol.ts         #   MAVLink v1/v2 frame splitter, CRC, v2 encoder
│  │  ├─ messages.ts         #   msg ids, CRC_EXTRA seeds, MAV_CMD / mode enums
│  │  ├─ parser.ts           #   decode HEARTBEAT/ATTITUDE/LOCAL_POS/SYS_STATUS/STATUSTEXT
│  │  ├─ commands.ts         #   arm / set-mode / mission-start / force-disarm builders
│  │  ├─ link.ts             #   transport: UDP (default) / TCP / serial
│  │  └─ telemetry.ts        #   folds decoded stream → DroneTelemetry snapshot
│  └─ mission/controller.ts  #   phase + clock + survivors; start/abort/e-stop
│
├─ shared/                   # Types & constants used by BOTH sides
│  ├─ types.ts               #   telemetry, mission, survivor, map, link
│  ├─ channels.ts            #   IPC channel names (EVENT.* / CMD.*)
│  ├─ grid.ts                #   arena geometry: 15×15 m, 2×2 rooms, grid helpers
│  └─ config.ts              #   default link (UDP 14550) + video URL
│
├─ app/                      # Next.js renderer (static export → out/)
│  ├─ layout.tsx  page.tsx   #   dashboard shell + composition
│  └─ globals.css            #   fixed dark "control room" theme
├─ components/               # UI: hud/ map/ video/
├─ lib/                      # store.ts (zustand) + ipc.ts (bridge → store)
└─ types/global.d.ts         # window.gcs typing (mirrors preload)
```

### Data flow

```
Drone ──MAVLink(UDP/TCP/serial)──▶ link.ts ─frames▶ telemetry.ts ─snapshot▶ ipc/register ─send▶ store ─▶ UI
Operator ─UI▶ window.gcs ─invoke▶ ipc/register ─▶ mission.ts ─COMMAND_LONG▶ link.ts ──▶ Drone
```

Survivor detections and the SLAM occupancy map come from the **onboard
perception stack**. The integration seams are `MissionController.addSurvivor()`
and the `EVENT.MAP_UPDATE` channel — feed them from your perception bridge.
The GCS never synthesises this data (doing so would be manual intervention).

## Getting started

```bash
cd gcs
npm install

# Develop against a real link:
npm run dev
```

`dev` runs `next dev` (http://localhost:3000) and launches the Electron window
pointed at it (with DevTools open). It opens the desktop app automatically; you
don't run `electron` yourself.

The GCS only ever renders data it receives — from the `air-unit`
WebSocket backend, the MAVLink link, and the onboard camera streams. There is
no built-in simulator or fabricated telemetry: to develop without the real
aircraft, run the `air-unit` backend against ArduPilot SITL.

## Running the Electron app

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | Dev mode — hot-reloading UI + Electron window (real link)          |
| `npm run build`     | Production build: static export → `out/`, compile main → `dist-electron/` |
| `npm start`         | Run the **built** app in Electron (`NODE_ENV=production`), loads `out/` via `app://` |

Typical loop while developing: `npm run dev`. To sanity-check the packaged
behaviour without making an installer: `npm run build && npm start`.

> **Windows note:** the scripts use `cross-env` and `concurrently`, so they work
> the same in PowerShell, cmd, and bash. If PowerShell blocks `npm.ps1`, run
> once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Building a Windows `.exe`

Packaging is done by [electron-builder](https://www.electron.build/) (config in
the `build` block of `package.json`).

```bash
npm run dist       # runs `npm run build` first, then electron-builder
```

Output lands in `dist/`:

- `AirMouse GCS Setup <version>.exe` — **NSIS installer** (double-click to install)
- `dist/win-unpacked/AirMouse GCS.exe` — the raw unpacked executable (no install; good for a USB stick / field laptop)

To produce a **single portable .exe** instead of an installer, add `portable`
to the Windows targets in `package.json`:

```jsonc
"win": { "target": ["nsis", "portable"] }
```

then re-run `npm run dist` — you'll also get `AirMouse GCS <version>.exe`
that runs with no installation.

Notes:
- Build the Windows `.exe` **on Windows** (native modules + code signing behave
  best there). The `serialport` optional dependency ships prebuilt binaries; if
  you only use the UDP/TCP link you can ignore it.
- First `electron-builder` run downloads the Electron/NSIS binaries — that step
  needs internet **once**, on the build machine (not during the mission).
- To sign the installer, set `CSC_LINK` / `CSC_KEY_PASSWORD` (see electron-builder docs).

## Configuring the link

Defaults live in `shared/config.ts`:

- **MAVLink**: UDP, bind `0.0.0.0:14550` (conventional ArduPilot/PX4 GCS port).
  Point your telemetry radio / Wi-Fi bridge to forward here. TCP and serial
  transports are supported by `link.ts` (serial needs the optional `serialport`
  dependency).
- **Video**: no camera URL is built in. Type each drone's MJPEG URL (and an
  optional thermal URL) into the camera panel; it is remembered per drone. A
  companion-style `…/stream` URL also gets `…/detections` counts and a
  `…/thermal` feed. Swap the `<img>` in `components/video/CameraPane.tsx` for a
  `<video>`/WebRTC surface if you stream H.264/RTSP instead.

## Notes on the MAVLink implementation

The frame codec is hand-rolled (`electron/mavlink/`) so the default UDP link
builds and runs with **only Node built-ins** — no native parser dependency.
Field offsets follow MAVLink wire ordering (fields sorted by descending type
size); outbound `COMMAND_LONG` frames are CRC-sealed with the correct
`CRC_EXTRA` seed. Extend `messages.ts` + `parser.ts` to decode more messages.
