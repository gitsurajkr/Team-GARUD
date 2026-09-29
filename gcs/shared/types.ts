/**
 * Domain types shared between the Electron main process (telemetry producer)
 * and the Next.js renderer (consumer). Keep this file free of any runtime
 * imports from either side so both build targets can consume it cleanly.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** State of the local MAVLink link to the drone. */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface LinkStatus {
  state: ConnectionState;
  /** Human-readable endpoint, e.g. "udp://0.0.0.0:14550". */
  endpoint?: string;
  /** ms since last heartbeat, or null if never received. */
  lastHeartbeatMs: number | null;
  message?: string;
}

/**
 * High-level mission phase, driven by the operator (start/abort) and by the
 * onboard autonomy reporting progress over telemetry.
 */
export type MissionPhase =
  | "idle"
  | "setup"
  | "armed"
  | "entering"
  | "exploring"
  | "returning"
  | "exited"
  | "completed"
  | "aborted";

export interface MissionStatus {
  phase: MissionPhase;
  /** 0..1 estimate of exploration coverage, if the drone reports it. */
  coverage: number;
  survivorsFound: number;
  /** Elapsed flight time in seconds (max permitted: 1800s / 30 min). */
  elapsedSec: number;
  startedAt: number | null;
}

/** Distilled flight telemetry the dashboard renders live. */
export interface DroneTelemetry {
  /** Local position in the arena frame (metres), origin at the entry point. */
  position: Vec3;
  velocity: Vec3;
  /** Attitude in radians. */
  roll: number;
  pitch: number;
  yaw: number;
  /** Heading in degrees 0..360. */
  heading: number;
  altitudeM: number;
  armed: boolean;
  flightMode: string;
  battery: BatteryStatus;
  /** Timestamp (ms) this snapshot was assembled. */
  updatedAt: number;
}

export interface BatteryStatus {
  voltage: number;
  current: number;
  /** Remaining percentage 0..100, or null if unknown. */
  remaining: number | null;
}

/** A cell type in the explored 2D occupancy map. */
export type CellType = "unknown" | "free" | "wall" | "corridor" | "room";

/**
 * A live 2D occupancy/exploration map. Encoded as a flat row-major array so it
 * serializes cheaply across IPC. `data[row * width + col]` is a probability of
 * occupancy 0..100, or -1 for unknown (ROS-style convention).
 */
export interface OccupancyMap {
  /** World coordinate (m) of the map's (0,0) cell corner. */
  origin: Vec2;
  /** Metres per cell. */
  resolution: number;
  width: number;
  height: number;
  data: Int8Array | number[];
  updatedAt: number;
}

/** A survivor detected and localised by the onboard perception stack. */
export interface Survivor {
  id: string;
  /** Grid box the survivor was localised to, e.g. { col: 3, row: 5 }. */
  grid: GridCoord;
  /** Best-estimate world position (m) in the arena frame. */
  worldPos: Vec2;
  /** Detector confidence 0..1. */
  confidence: number;
  detectedAt: number;
  /** Optional base64 JPEG thumbnail from the moment of detection. */
  thumbnail?: string;
}

/** A grid box coordinate in the arena's modular grid. */
export interface GridCoord {
  col: number;
  row: number;
}

/** A single log/event line surfaced to the operator. */
export interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

/** Options for opening the local MAVLink link. */
export interface LinkOptions {
  transport: "udp" | "tcp" | "serial";
  /** For udp/tcp. */
  host?: string;
  port?: number;
  /** For serial. */
  path?: string;
  baudRate?: number;
}

/** Static configuration handed to the renderer at startup. */
export interface AppConfig {
  link: LinkOptions;
  /** WebSocket URL of the air-unit backend (multi-drone telemetry). */
  airUnitUrl: string;
  grid: {
    arenaSizeM: number;
    cellSizeM: number;
  };
}

/* --------------------------------------------------------------------------
 * air-unit backend wire types.
 *
 * The backend reads every SITL drone off one MAVLink port, demuxes by system
 * id, and broadcasts these frames over WebSocket. Field names mirror the
 * on-drone Air-Unit telemetry schema. `null` means "not yet measured".
 * ------------------------------------------------------------------------ */

export interface AirUnitNavigation {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null; // relative to home (m)
  altitude_amsl: number | null; // MSL (m)
  groundspeed: number | null; // m/s
  airspeed: number | null; // m/s
  climbrate: number | null; // m/s
  heading: number | null; // deg 0..359
}

export interface AirUnitAttitude {
  roll: number | null; // rad
  pitch: number | null; // rad
  yaw: number | null; // deg -180..180
}

export interface AirUnitGps {
  fixtype: number | null; // 0..6
  satellites: number | null;
  hdop: number | null;
}

export interface AirUnitBattery {
  voltage: number | null; // V
  current: number | null; // A
  level: number | null; // 0..100
  consumed_mah: number | null;
}

/**
 * The flight controller's assessment of itself (from SYS_STATUS / HEARTBEAT).
 * This is the FC's verdict, not the GCS's — the only authority on whether the
 * aircraft would actually arm.
 */
export interface AirUnitHealth {
  /** null until the FC has reported it — "unknown", not "failing". */
  prearm_ok: boolean | null;
  /** Sensors the FC has enabled but reports unhealthy. */
  unhealthy: string[];
  /** MAV_STATE name, e.g. STANDBY / ACTIVE / CRITICAL. */
  system_status: string;
  /** True when system_status is CRITICAL or EMERGENCY — a failsafe has fired. */
  failsafe: boolean;
  /** Recent "PreArm: ..." lines explaining what is blocking arming. */
  prearm_messages: string[];
  /**
   * Safety switch. MAVLink carries NO field for this, so it is inferred:
   * true = the FC names the switch as a prearm blocker, false = prearm passes
   * so the switch cannot be inhibiting the motors, null = cannot tell.
   */
  safety_engaged: boolean | null;
}

/**
 * The flight controller's own home position. RTL returns here and the
 * cylindrical geofence is centred here — it is set at arming and can be moved
 * in flight, so it is not necessarily where the drone booted.
 */
export interface AirUnitHome {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null; // AMSL (m)
}

/** Geofence configuration read back off the flight controller. */
export interface FenceState {
  sysid: number;
  /** False when FENCE_* could not be read at all (no fence support / no link). */
  known: boolean;
  enabled: boolean;
  radius: number | null;
  alt_max: number | null;
  /** FENCE_ACTION: 1 = RTL-or-Land, 2 = always Land, 0 = report only. */
  action: number | null;
  /** FENCE_MARGIN (m) — the breach fires this far *inside* the boundary. */
  margin: number | null;
}

/**
 * Failsafe configuration read off the flight controller: what the aircraft will
 * DO when something goes wrong. Separate from preflight, which asks whether it
 * is fit to fly right now. A null value means the parameter could not be read.
 */
export interface FailsafeConfig {
  sysid: number;
  values: Record<string, number | null>;
}

/** One drone's full state, keyed in the store by `sysid`. */
export interface DroneSnapshot {
  sysid: number;
  drone_id: string;
  timestamp: number; // backend unix seconds of last message
  connected: boolean;
  armed: boolean;
  mode: string;
  navigation: AirUnitNavigation;
  attitude: AirUnitAttitude;
  gps: AirUnitGps;
  battery: AirUnitBattery;
  health?: AirUnitHealth;
  home?: AirUnitHome;
}

/** Lightweight roster entry (pushed ~1 Hz for the drone selector). */
export interface DroneRosterEntry {
  sysid: number;
  drone_id: string;
  /** GCS has issued `connect` for this drone (data streams requested). */
  connected: boolean;
  /** Telemetry is fresh (heartbeat within the backend timeout). */
  linked: boolean;
  armed: boolean;
  mode: string;
  /** True = a real drone over a telemetry radio (serial); false = SITL. */
  real?: boolean;
  /** Where it is heard: "COM4" for a radio, "ip:port" for UDP. */
  link?: string | null;
  /**
   * Serial ports carrying this sysid when there is more than one — two
   * aircraft share a SYSID_THISMAV. Empty/absent = unambiguous. While set, the
   * backend refuses every command except disarm/kill (which go to all of them).
   */
  conflict?: string[];
}

/** A line in the status console (STATUSTEXT, command acks, mission events). */
export interface StatusLine {
  id: number;
  sysid: number;
  ts: number; // unix seconds
  severity: number; // 0..7 (MavSeverity); lower = worse
  label: string; // e.g. "WARNING", "CMD", "MISSION"
  text: string;
}

export interface PreflightCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  sysid: number;
  ok: boolean;
  checks: PreflightCheckResult[];
}

export interface MissionProgress {
  sysid: number;
  state: "uploading" | "complete" | "failed";
  uploaded: number;
  total: number;
  detail: string;
}

/** A single waypoint being drawn / uploaded. */
export interface Waypoint {
  lat: number;
  lon: number;
  /** Altitude for THIS waypoint (m, relative to home). Set per-waypoint. */
  alt: number;
  /** Seconds to hold at this waypoint before moving on. 0 = fly straight through. */
  hold?: number;
}

/**
 * What the aircraft does once the last waypoint is reached.
 *
 * "hold" is ArduCopter's own default — it loiters at the final waypoint until a
 * mode change, a disarm, or a failsafe. That is a legitimate ending for a search
 * (camera parked over a survivor) but it must be chosen, not inherited by
 * accident: with no battery failsafe configured the aircraft hovers there until
 * the pack is flat.
 */
export type MissionFinish = "rtl" | "land" | "hold";

/** WebSocket frames emitted by the backend. */
export type AirUnitFrame =
  | { type: "telemetry"; drones: DroneSnapshot[] }
  | { type: "drones"; drones: DroneRosterEntry[] }
  | { type: "status"; sysid: number; timestamp: number; severity: number; severity_label: string; text: string }
  | { type: "command_ack"; sysid: number; command: string; ok: boolean; detail: string }
  | ({ type: "mission_progress" } & MissionProgress)
  | ({ type: "preflight_result" } & PreflightResult)
  | ({ type: "fence" } & FenceState)
  | ({ type: "failsafe" } & FailsafeConfig);

/** A lat/lon box of map to download for offline use. */
export interface TileBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Progress of an offline map download ("Save area offline"). */
export interface TilePrefetchProgress {
  /** Tiles in the area across every zoom level. */
  total: number;
  /** Downloaded now. */
  saved: number;
  /** Already on disk, skipped. */
  cached: number;
  /** Could not be fetched (no network, or Google refused). */
  failed: number;
  /** True on the final report. */
  done: boolean;
  /** Why it stopped early (too big, cancelled, already running). */
  error?: string;
}
