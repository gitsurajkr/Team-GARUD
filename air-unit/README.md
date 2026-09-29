# air-unit

Multi-drone **SITL telemetry bridge** for the GCS.

It reads every SITL drone off a single MAVLink UDP port, **demuxes them by
MAVLink system id**, and broadcasts per-drone telemetry to the GCS over a plain
JSON **WebSocket**. Field names mirror the on-drone `Air-Unit` telemetry schema
(`navigation` / `attitude` / `gps` / `battery`), so the GCS talks to this the
same way it will later talk to the real companion stack.

```
 4x ArduPilot SITL ──udp:14550──▶ air-unit       ──ws://:8765──▶ GCS
   (one UDP stream,                (demux by sysid,              (drone selector +
    unique sysids)                  fold telemetry)               map + telem panel)
```

## Install

```powershell
cd air-unit
python -m pip install -r requirements.txt   # pymavlink, websockets, PyYAML
```

## Run

```powershell
python run.py
```

Then start the GCS (`cd ../gcs; npm run dev`) — it auto-connects to
`ws://127.0.0.1:8765` and shows every drone the backend reports.

## Full simulation flow

1. **SITL (in WSL)** — launch as many drones as you want (`--count N`; there is
   no limit here), forwarding to the Windows host:
   ```bash
   sim_vehicle.py -v ArduCopter --count 6 --auto-sysid --no-mavproxy \
     --out=udp:172.20.16.1:14550
   ```
   (Repeat the `--out` per instance, or point them all at the same host:port —
   they arrive with distinct system ids and are demuxed here.) Every drone
   needs a **unique system id** — two drones on the same sysid collapse into one
   roster row. Ports 14550–14559 are listened on by default; widen the range in
   `config.yaml` if you give each instance its own port beyond that.

2. **Backend (on Windows)** — `python run.py` (listens on `0.0.0.0:14550`).

3. **GCS (on Windows)** — `npm run dev` in `../gcs`.

## Several real drones (one radio pair per drone)

1. **Give every aircraft its own `SYSID_THISMAV`** (1, 2, 3, …) and reboot it.
   ArduPilot ships every board as 1. Two aircraft on one id are flagged
   **SYSID CONFLICT** in the GCS: everything is refused except Disarm/Kill,
   which go to *both* — there is no way to tell which one a command would reach.
2. Plug the ground radios into the laptop in any order, before or after
   starting the backend. The default `serial:auto:57600` picks up every USB
   serial adapter and reopens a radio that is pulled and plugged back in.
3. Each roster row shows the COM port it is heard on, so you can match rows to
   radios. Label the radios.

If other USB serial devices are plugged in, `auto` opens them too — list the
radios by name instead: `serial:COM3:57600,serial:COM4:57600,…`.

## Config

Edit `config.yaml` (env overrides: `AIRUNIT_CONNECTION`, `AIRUNIT_WS_HOST`,
`AIRUNIT_WS_PORT`):

| Key                     | Default                | Notes                                  |
| ----------------------- | ---------------------- | -------------------------------------- |
| `mavlink.connection`    | `udpin:0.0.0.0:14550`  | comma-separated; ports may be a range (`udpin:0.0.0.0:14550-14559`) |
| `mavlink.timeout_sec`   | `3.0`                  | mark a drone disconnected after this   |
| `websocket.host` `port` | `127.0.0.1` `8765`     | GCS connects here                      |
| `telemetry_rate_hz`     | `10`                   | batched per-drone telemetry push rate  |
| `roster_rate_hz`        | `1`                    | drone roster / connection-status rate  |

## WebSocket protocol

Broadcast-only, one JSON object per frame:

```jsonc
// ~10 Hz — full state for every drone
{ "type": "telemetry", "drones": [
  { "sysid": 1, "drone_id": "drone-1", "timestamp": 1725900000.0,
    "connected": true, "armed": true, "mode": "GUIDED",
    "navigation": { "latitude": 28.36, "longitude": 77.54, "altitude": 50.0,
                    "altitude_amsl": 220.0, "groundspeed": 0.0, "airspeed": 0.0,
                    "climbrate": 0.0, "heading": 90.0 },
    "attitude": { "roll": 0.0, "pitch": 0.0, "yaw": 90.0 },
    "gps": { "fixtype": 3, "satellites": 14, "hdop": 0.8 },
    "battery": { "voltage": 12.6, "current": 15.0, "level": 87, "consumed_mah": 0 } }
]}

// ~1 Hz — lightweight roster (drives the selector, connection dots)
{ "type": "drones", "drones": [
  { "sysid": 1, "drone_id": "drone-1", "connected": true, "armed": true, "mode": "GUIDED" }
]}
```

## Commands (GCS → backend)

The WebSocket is **bidirectional**. Send a JSON frame with a `cmd` field; every
command replies with a `command_ack`, and some emit richer frames.

| Frame | Effect | MAVLink |
| ----- | ------ | ------- |
| `{cmd:"scan"}` | rebroadcast the roster of all detected sysids | passive |
| `{cmd:"connect", sysid}` | request data streams, mark connected | REQUEST_DATA_STREAM |
| `{cmd:"disconnect", sysid}` | mark disconnected | — |
| `{cmd:"preflight", sysid}` | local checks **+ the FC's own prearm verdict** → `preflight_result` | RUN_PREARM_CHECKS + SYS_STATUS |
| `{cmd:"arm"/"disarm", sysid}` | arm / disarm | COMPONENT_ARM_DISARM |
| `{cmd:"force_arm", sysid}` | arm bypassing prearm checks (**dangerous**) | COMPONENT_ARM_DISARM p2=21196 |
| `{cmd:"set_safety", sysid, disengage}` | safety switch OFF (`true`) / ON (`false`). `disengage` is **required** | DO_SET_SAFETY_SWITCH_STATE |
| `{cmd:"takeoff", sysid, alt}` | guided takeoff | NAV_TAKEOFF |
| `{cmd:"set_mode", sysid, mode}` | GUIDED / AUTO / RTL / LAND / LOITER … | DO_SET_MODE |
| `{cmd:"reposition", sysid, lat, lon, alt}` | fly-to (GUIDED) | DO_REPOSITION (COMMAND_INT) |
| `{cmd:"set_speed", sysid, speed}` | change cruise speed mid-mission | DO_CHANGE_SPEED |
| `{cmd:"upload_mission", sysid, waypoints:[{lat,lon,alt}], alt?, speed?}` | upload mission → `mission_progress` | MISSION_ITEM_INT protocol |
| `{cmd:"start_mission", sysid, waypoints, alt?, takeoff_alt?, speed?}` | full launch: upload → GUIDED → arm → AUTO → run | ack-gated sequence |
| `{cmd:"set_current", sysid, seq}` | **jump** to waypoint `seq` | MISSION_SET_CURRENT |
| `{cmd:"get_fence"/"set_fence", sysid, radius, alt_max, enable, action}` | geofence → `fence` frame | PARAM_SET / PARAM_REQUEST_READ |
| `{cmd:"get_failsafe"/"set_failsafe", sysid, values}` | failsafe params → `failsafe` frame | PARAM_SET / PARAM_REQUEST_READ |

### The safety switch is the operator's

Nothing in this backend moves the safety switch on its own. `start_mission`
**refuses** to launch while it is ON rather than releasing it for you — the point
of that switch is that a human decides when the props may spin. `arm`,
`force_arm` and `takeoff` are refused too, and the gate fails *closed*: anything
short of a definite "switch is OFF" blocks. A board that answers `UNSUPPORTED`
(no switch fitted, and SITL) is recorded as such so it is not grounded by that
rule.

MAVLink has no field reporting the switch's position, so the state is inferred —
the FC naming it in a fresh `PreArm:` line beats our record of what we last
commanded, which beats inferring from a passing prearm check.

### Command concurrency

The WebSocket read loop dispatches commands without awaiting them, so a slow one
can never delay the next. Per drone:

- **Emergency** (`disarm`, safety switch ON) runs immediately and cancels any
  sequence in flight — otherwise a launch past its arm step would re-arm the
  aircraft a second after you stopped it.
- **Long** (`start_mission`, `upload_mission`, `set_fence`, `set_failsafe`,
  `preflight`) holds a per-drone lock; a second one is **refused**, not queued.
- Everything else runs inline.

Different drones never block each other.

**Multi-drone targeting:** all drones share one UDP port. The runtime records
each drone's source address on receive and sends every command to that exact
address — so commanding sysid 5 never leaks to sysid 6.

Backend → GCS frames: `telemetry`, `drones` (roster), `status` (STATUSTEXT),
`command_ack`, `mission_progress`, `preflight_result`.

## Layout

```
src/air_unit/
  config.py                 runtime config (yaml + env overrides)
  models.py                 Air-Unit-shaped telemetry + command/mission models
  core/
    enums.py                CopterMode / MavSeverity + name<->number (from Air-Unit)
  mavlink/
    aggregator.py           per-sysid state folding + STATUSTEXT capture
  infrastructure/
    fc_runtime.py           owns the socket; recv loop, per-sysid address
                            targeting, command senders, mission-upload protocol
  services/
    commands.py             routes inbound WS command frames -> FcRuntime
  transport/
    ws_server.py            WebSocket hub (fan-out + inbound commands)
  app.py                    composition root (runtime -> registry -> hub -> dispatch)
```

The backend only ever forwards what the flight controllers actually report — it
never synthesises telemetry. To exercise it without aircraft, run ArduPilot
SITL as described in [Full simulation flow](#full-simulation-flow).
