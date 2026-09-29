import type { MavFrame } from "./protocol";
import { MSG, MAV_MODE_FLAG, COPTER_MODE_NAME } from "./messages";

/**
 * Decode the message payloads this GCS cares about. MAVLink orders fields on
 * the wire by descending type size (extensions excepted), and v2 truncates
 * trailing zeros — so each decoder zero-pads the payload to the field extent it
 * reads, then reads at the sorted-wire offsets documented inline.
 */

export type DecodedMessage =
  | { type: "heartbeat"; armed: boolean; baseMode: number; customMode: number; flightMode: string }
  | { type: "sys_status"; voltage: number; current: number; remaining: number | null }
  | { type: "attitude"; roll: number; pitch: number; yaw: number }
  | { type: "local_position_ned"; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { type: "statustext"; severity: number; text: string };

export function decode(frame: MavFrame): DecodedMessage | null {
  const p = pad(frame.payload, 64);
  switch (frame.msgid) {
    case MSG.HEARTBEAT: {
      // wire: custom_mode(u32)@0, type(u8)@4, autopilot@5, base_mode@6, system_status@7, mavlink_version@8
      const customMode = p.readUInt32LE(0);
      const baseMode = p.readUInt8(6);
      const armed = (baseMode & MAV_MODE_FLAG.SAFETY_ARMED) !== 0;
      const flightMode =
        (baseMode & MAV_MODE_FLAG.CUSTOM_MODE_ENABLED)
          ? COPTER_MODE_NAME[customMode] ?? `MODE_${customMode}`
          : "MANUAL";
      return { type: "heartbeat", armed, baseMode, customMode, flightMode };
    }
    case MSG.SYS_STATUS: {
      // wire: 3x u32 sensor masks @0..11, then u16/int16 block:
      // load@12, voltage_battery@14 (u16 mV), current_battery@16 (int16 cA),
      // ... battery_remaining (int8 %) @30
      const voltage = p.readUInt16LE(14) / 1000; // V
      const current = p.readInt16LE(16) / 100; // A (-1 => unknown)
      const remRaw = p.readInt8(30);
      const remaining = remRaw < 0 ? null : remRaw;
      return { type: "sys_status", voltage, current, remaining };
    }
    case MSG.ATTITUDE: {
      // wire: time_boot_ms(u32)@0, roll@4, pitch@8, yaw@12 (all f32)
      return {
        type: "attitude",
        roll: p.readFloatLE(4),
        pitch: p.readFloatLE(8),
        yaw: p.readFloatLE(12),
      };
    }
    case MSG.LOCAL_POSITION_NED: {
      // wire: time_boot_ms(u32)@0, x@4,y@8,z@12,vx@16,vy@20,vz@24 (all f32)
      return {
        type: "local_position_ned",
        x: p.readFloatLE(4),
        y: p.readFloatLE(8),
        z: p.readFloatLE(12),
        vx: p.readFloatLE(16),
        vy: p.readFloatLE(20),
        vz: p.readFloatLE(24),
      };
    }
    case MSG.STATUSTEXT: {
      // wire: severity(u8)@0, text(char[50])@1..50
      const severity = p.readUInt8(0);
      const text = readCString(p.subarray(1, 51));
      return { type: "statustext", severity, text };
    }
    default:
      return null;
  }
}

function pad(buf: Buffer, size: number): Buffer {
  if (buf.length >= size) return buf;
  const out = Buffer.alloc(size);
  buf.copy(out);
  return out;
}

function readCString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return buf.subarray(0, nul === -1 ? buf.length : nul).toString("ascii");
}
