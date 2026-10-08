<div align="center">

# 🦅 Team Garud

### Autonomous search drone for GPS-denied disaster zones

**Track 1 · Drone Innovation** — sweep an unknown zone, find survivors, tag each one on the operator's map.

![status](https://img.shields.io/badge/status-active%20development-blue)
![gcs](https://img.shields.io/badge/GCS-field%20tested-success)
![multi--drone](https://img.shields.io/badge/multi--drone-one%20GCS-success)
![indoor nav](https://img.shields.io/badge/indoor%20nav-GPS--denied-orange)
![offline](https://img.shields.io/badge/network-offline%20by%20design-lightgrey)

</div>

---

## ✨ Where we are

| Capability | Status |
| --- | --- |
| **Ground Control Station** — live telemetry, camera feeds, map, mission clock | ✅ Working · flown on a real drone |
| **Multi-drone control from one GCS** — every aircraft demuxed by MAVLink system id | ✅ Working |
| **Autonomous mission + failsafes** — Start / Abort (Return) / Emergency Stop | ✅ Working · verified in real-world flights |
| **GPS-denied indoor navigation** — LiDAR SLAM + autonomous exploration | ✅ Working |
| **3D perception** — live 3D map, obstacle clearance | ✅ Working |
| **Survivor detection** — on-board camera, tagged on the map | ✅ Working |

### 📈 Highlights

| | |
| --- | --- |
| 🏠 **100 %** | of rooms reached across our test mazes |
| 🧱 **~90 % fewer** | wall contacts with turn-aware speed control |
| ⚡ **4–6× faster** | mapping and planning cycle after optimisation |
| 🖥️ **< 1 s** | per planning cycle on the on-board Jetson Orin Nano |

> Everything runs end-to-end. We keep tuning the navigation stack and the
> airframe to fly faster and with more margin in tight spaces.

---

## 🛰️ One GCS, many drones

The operator console flies a whole fleet from one laptop. Every aircraft gets
its own row in the roster — mode, arm state, battery, position, camera — and
commands go to exactly the drone that is selected.

```
  Drone 1 ─┐
  Drone 2 ─┼── MAVLink (radio / UDP) ──▶  air-unit  ──ws://:8765──▶  GCS
  Drone N ─┘                              (demux by system id)      (one console)
```

- Real drones and simulated ones can be on the same roster at once (real ones are flagged **REAL**).
- Two aircraft on the same system id are flagged **SYSID CONFLICT**, and only Disarm/Kill is allowed until it is fixed.
- Radios can be plugged in or pulled at any time; the bridge picks them up again.

---

## 🧭 GPS-denied indoor navigation

Indoors there is no GPS. The drone finds its own position from its LiDAR,
builds a map as it flies, and explores the building by itself, with no operator
input after **Start**.

- **Localisation without GPS** — 3D LiDAR + IMU SLAM, fed to the flight controller as its position source.
- **Autonomous exploration** — picks the next unexplored area, plans a safe path to it, and comes home when the building is covered.
- **Tight spaces** — built for 1.0 m corridors with a 7″ guarded airframe, keeping a safety margin from every wall.
- **Live 3D map to the GCS** — the operator sees the map grow during the mission.
- **Failsafes** — return or land if the position estimate degrades.

Every change is tested end-to-end on many randomly generated mazes, including
ones never used for tuning, so the stack isn't tuned to a single layout.

> The exploration and path-planning algorithms are our own work and are **not
> published** in this repository.

More detail: [Perception](perception/README.md).

---

## 🚁 The aircraft

| | |
| --- | --- |
| Frame | 7″ quad, 325 mm wheelbase (motor to motor) |
| Props | 7″, with prop guards (≈ 44 cm wide overall) |
| Flight controller | ArduPilot |
| Main sensor | Livox Mid-360 3D LiDAR (360° × 59°) |
| Backup sensors | Downward rangefinder + optical flow |

---

## 📁 Repository

```
  ArduPilot SITL ──udp:14550──┐
                              ├──▶  air-unit        ──ws://:8765──▶  GCS
  Real drone ────serial:COM3──┘     (Python bridge)                 (Electron app)
```

| Directory | What it is |
| --------- | ---------- |
| [`gcs/`](gcs/) | The operator console — Electron + Next.js. What you look at. |
| [`air-unit/`](air-unit/) | Python bridge: reads MAVLink from every drone, demuxes by system id, serves telemetry to the GCS and relays commands back. |
| [`perception/`](perception/) | Overview of the indoor navigation and perception stack (documentation only). |
| [`videos/`](videos/) | Offline detection scripts (`detect.py`, `detect_survivor.py`) for annotating recorded footage. Not part of the GCS runtime. |

Each directory has its own README with the deeper detail:
[GCS](gcs/README.md) · [air-unit](air-unit/README.md) · [Perception](perception/README.md).

---

## Quick start

```bash
cd gcs
npm install
npm run dev
```

The GCS renders only what it receives — telemetry from the `air-unit`
backend over `ws://127.0.0.1:8765`, and camera frames from the companion
computers. With nothing feeding it, the roster stays empty and the camera panes
show **No Signal**. Start the backend (below) to bring it to life.

---

## Prerequisites

| Need | Version | For |
| ---- | ------- | --- |
| [Node.js](https://nodejs.org) | 18+ (20 LTS recommended) | The GCS |
| [Python](https://python.org) | 3.10+ | The air-unit bridge |
| ArduPilot SITL | optional | Flying the stack without real aircraft |

On Windows, if PowerShell blocks `npm.ps1`, run once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Install

```bash
git clone <repo-url>
cd Team_garud

# GCS
cd gcs && npm install && cd ..

# Backend
cd air-unit && python -m pip install -r requirements.txt && cd ..
```

---

## Running

There are two ways to run, depending on what you're working on. Both serve the
GCS the same data over `ws://127.0.0.1:8765`, so the app itself never changes —
only what's feeding it.

### 1. Backend + SITL — the full pipeline, no aircraft

```bash
# Terminal A — simulated drones (in WSL, pointing at the Windows host IP)
sim_vehicle.py -v ArduCopter --count 4 --auto-sysid --no-mavproxy \
  --out=udp:172.20.16.1:14550

# Terminal B — the bridge
cd air-unit && python run.py

# Terminal C — the GCS
cd gcs && npm run dev
```

### 2. Real drone over a telemetry radio

Same as above, minus SITL. `air-unit/config.yaml` already lists a serial
radio alongside the SITL ports:

```yaml
connection: "udpin:0.0.0.0:14550,...,serial:COM3:57600"
```

Plug the radio in and that drone joins the roster flagged **REAL**. If the radio
isn't connected the backend skips it and logs a note — no error, no config edit.
Change `COM3` to match your port (`/dev/ttyUSB0` on Linux).

> **Start them in any order.** The GCS retries the WebSocket every 1.5 s, so you
> can start the bridge after the app is already open and it connects on its own
> — no restart, no refresh.
>
> **Only one backend at a time.** The bridge binds port `8765`; a second
> instance fails with `EADDRINUSE`.

## Building a release

```bash
cd gcs
npm run build     # static export -> out/, compile main -> dist-electron/
npm start         # run the built app without packaging it
npm run dist      # Windows .exe / Linux AppImage via electron-builder
```

Installer output lands in `gcs/dist/`.

---

## Camera feeds

The camera panes read **live MJPEG streams** from the companion computers —
nothing is played back from disk. Each drone's stream and detections URL is
mapped by system id in
[`gcs/shared/videoConfig.ts`](gcs/shared/videoConfig.ts) (`LIVE_CAMERAS`); a
drone with no entry, or one whose stream is unreachable, shows **No Signal**.

The scripts in [`videos/`](videos/) are a separate offline tool for annotating
recorded footage; they are not wired into the GCS. Source footage is **not in
git** — it runs to several GB, and `.gitignore` excludes `videos/` (the Python
scripts themselves *are* tracked).

---

## Configuration

| What | Where |
| ---- | ----- |
| MAVLink ports, serial radio, telemetry rates | [`air-unit/config.yaml`](air-unit/config.yaml) (env overrides: `AIRUNIT_CONNECTION`, `AIRUNIT_WS_HOST`, `AIRUNIT_WS_PORT`) |
| Backend URL, default link | [`gcs/shared/config.ts`](gcs/shared/config.ts) |
| Live camera stream / detections URLs per drone | [`gcs/shared/videoConfig.ts`](gcs/shared/videoConfig.ts) |
| Default map centre | `DEFAULT_VIEW` in [`gcs/components/map/GeoMapPane.tsx`](gcs/components/map/GeoMapPane.tsx) |

> **Known rough edge:** the camera IPs and the air-unit URL on the GCS side are
> currently compile-time constants, so running the bridge or the cameras on
> another machine means editing those files and rebuilding. Fine on one laptop;
> worth wiring to the config loader before field use.

---

## Offline by design

The mission runs with **no external network** (brief §7). The packaged app
blocks all public-internet traffic and permits only the local link — loopback
and RFC-1918 private addresses — plus an explicit allowlist of map-tile hosts so
the geographic map can load during development. See
[`gcs/electron/main.ts`](gcs/electron/main.ts).

---

<div align="center">

**Team Garud** · built for Track 1 · Drone Innovation

</div>
