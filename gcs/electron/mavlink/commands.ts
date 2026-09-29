import { encodeV2 } from "./protocol";
import {
  MSG,
  MAV_CMD,
  MAV_MODE_FLAG,
  COPTER_MODE,
  CRC_EXTRA,
  ARM_FORCE_MAGIC,
} from "./messages";

/**
 * Builders for the outbound commands the operator can issue. Each returns a
 * ready-to-send MAVLink v2 frame. The mission brief permits the operator only
 * to START the mission and trigger a safety ABORT / EMERGENCY STOP — these map
 * onto ARM + mode changes + MISSION_START, and force-disarm / flight
 * termination respectively.
 */

const COMMAND_LONG_LEN = 33;

interface Target {
  sysid: number;
  compid: number;
}

const DEFAULT_TARGET: Target = { sysid: 1, compid: 1 };

function commandLong(
  seq: number,
  command: number,
  params: number[],
  target: Target = DEFAULT_TARGET,
): Buffer {
  const payload = Buffer.alloc(COMMAND_LONG_LEN);
  for (let i = 0; i < 7; i++) payload.writeFloatLE(params[i] ?? 0, i * 4);
  payload.writeUInt16LE(command, 28);
  payload.writeUInt8(target.sysid, 30);
  payload.writeUInt8(target.compid, 31);
  payload.writeUInt8(0, 32); // confirmation
  return encodeV2({
    msgid: MSG.COMMAND_LONG,
    payload,
    crcExtra: CRC_EXTRA[MSG.COMMAND_LONG],
    seq,
  });
}

/** Arm (or disarm) the vehicle. `force` bypasses pre-arm checks / forces disarm. */
export function arm(seq: number, on: boolean, force = false, target?: Target): Buffer {
  return commandLong(
    seq,
    MAV_CMD.COMPONENT_ARM_DISARM,
    [on ? 1 : 0, force ? ARM_FORCE_MAGIC : 0],
    target,
  );
}

/** Switch to an ArduCopter custom flight mode. */
export function setMode(seq: number, copterMode: number, target?: Target): Buffer {
  return commandLong(
    seq,
    MAV_CMD.DO_SET_MODE,
    [MAV_MODE_FLAG.CUSTOM_MODE_ENABLED, copterMode],
    target,
  );
}

/** Kick off the loaded autonomous mission (AUTO). */
export function missionStart(seq: number, target?: Target): Buffer {
  return commandLong(seq, MAV_CMD.MISSION_START, [0, 0], target);
}

/** Return-to-launch — used as a soft abort back toward the entry/exit point. */
export function returnToLaunch(seq: number, target?: Target): Buffer {
  return setMode(seq, COPTER_MODE.RTL, target);
}

/** Hard emergency stop: force-disarm immediately (motors cut). */
export function emergencyDisarm(seq: number, target?: Target): Buffer {
  return arm(seq, false, true, target);
}

export { COPTER_MODE };
