"use client";

import type { MissionFinish, Waypoint } from "../shared/types";
import { sendCommand } from "./airunit";

/**
 * Typed wrappers over the backend command protocol. Each returns whether the
 * frame was actually sent (false if the WebSocket is down).
 */
export const cmd = {
  scan: () => sendCommand({ cmd: "scan" }),
  connect: (sysid: number) => sendCommand({ cmd: "connect", sysid }),
  disconnect: (sysid: number) => sendCommand({ cmd: "disconnect", sysid }),
  preflight: (sysid: number) => sendCommand({ cmd: "preflight", sysid }),
  arm: (sysid: number) => sendCommand({ cmd: "arm", sysid }),
  forceArm: (sysid: number) => sendCommand({ cmd: "force_arm", sysid }),
  disarm: (sysid: number) => sendCommand({ cmd: "disarm", sysid }),
  /**
   * KILL — force disarm. Cuts motor output immediately and ends the mission,
   * in flight if need be (the aircraft will fall). Always confirm before calling.
   */
  kill: (sysid: number) => sendCommand({ cmd: "kill", sysid }),
  takeoff: (sysid: number, alt: number) => sendCommand({ cmd: "takeoff", sysid, alt }),
  setMode: (sysid: number, mode: string) => sendCommand({ cmd: "set_mode", sysid, mode }),
  reposition: (sysid: number, lat: number, lon: number, alt: number) =>
    sendCommand({ cmd: "reposition", sysid, lat, lon, alt }),
  /** `speed` (m/s) rides along as a DO_CHANGE_SPEED mission item; omit to keep
   *  the flight controller's WPNAV_SPEED default. */
  /** Builds the SAME mission as startMission — including the NAV_TAKEOFF, without
   *  which ArduCopter refuses AUTO from the ground ("Missing Takeoff Cmd"). */
  uploadMission: (
    sysid: number, waypoints: Waypoint[], takeoffAlt: number,
    speed?: number, finish: MissionFinish = "rtl",
  ) => sendCommand({
    cmd: "upload_mission", sysid, waypoints, takeoff_alt: takeoffAlt, speed, finish,
  }),
  startMission: (
    sysid: number, waypoints: Waypoint[], alt: number, takeoffAlt: number,
    speed?: number, finish: MissionFinish = "rtl",
  ) =>
    sendCommand({
      cmd: "start_mission", sysid, waypoints, alt,
      takeoff_alt: takeoffAlt, speed, finish,
    }),
  setCurrent: (sysid: number, seq: number) => sendCommand({ cmd: "set_current", sysid, seq }),
  /** Cylindrical geofence around home. action 1 = RTL-or-LAND on breach. */
  setFence: (
    sysid: number, radius: number, altMax: number, enable = true, action = 1,
  ) => sendCommand({ cmd: "set_fence", sysid, radius, alt_max: altMax, enable, action }),
  /**
   * Safety switch. `disengage` true releases it so the motors can spin.
   * MAVLink has no readback for this, so the state shown is inferred from the
   * FC's prearm reporting — see AirUnitHealth.safety_engaged.
   */
  setSafety: (sysid: number, disengage: boolean) =>
    sendCommand({ cmd: "set_safety", sysid, disengage }),
  /** Read the failsafe params off the FC (answers with a `failsafe` frame). */
  getFailsafe: (sysid: number) => sendCommand({ cmd: "get_failsafe", sysid }),
  /** Write only the failsafe params the operator changed. */
  setFailsafe: (sysid: number, values: Record<string, number>) =>
    sendCommand({ cmd: "set_failsafe", sysid, values }),
  /** Read FENCE_* back off the FC (answers with a `fence` frame). */
  getFence: (sysid: number) => sendCommand({ cmd: "get_fence", sysid }),
  /** Change horizontal speed immediately, mid-mission. */
  setSpeed: (sysid: number, speed: number) => sendCommand({ cmd: "set_speed", sysid, speed }),
};

/** ArduCopter flight modes offered in the mode dropdown. */
export const COPTER_MODES = [
  "STABILIZE",
  "ALT_HOLD",
  "LOITER",
  "GUIDED",
  "AUTO",
  "RTL",
  "LAND",
  "POSHOLD",
  "BRAKE",
  "SMART_RTL",
] as const;
