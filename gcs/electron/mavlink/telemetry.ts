import { EventEmitter } from "node:events";
import type { MavFrame } from "./protocol";
import { decode, type DecodedMessage } from "./parser";
import type { DroneTelemetry, LogEntry } from "../../shared/types";

/**
 * Folds the decoded MAVLink message stream into a single live telemetry
 * snapshot for the renderer, and surfaces STATUSTEXT as operator log lines.
 *
 * Events:
 *   "telemetry" (snapshot: DroneTelemetry)
 *   "log"       (entry: LogEntry)
 *   "heartbeat"
 */
export class TelemetryAggregator extends EventEmitter {
  private state: DroneTelemetry = blankTelemetry();

  /** Feed one raw frame; returns the decoded message (or null) for callers. */
  ingest(frame: MavFrame): DecodedMessage | null {
    const msg = decode(frame);
    if (!msg) return null;

    switch (msg.type) {
      case "heartbeat":
        this.state.armed = msg.armed;
        this.state.flightMode = msg.flightMode;
        this.emit("heartbeat");
        break;
      case "attitude":
        this.state.roll = msg.roll;
        this.state.pitch = msg.pitch;
        this.state.yaw = msg.yaw;
        this.state.heading = normalizeDeg((msg.yaw * 180) / Math.PI);
        break;
      case "local_position_ned":
        // MAVLink NED: x=north, y=east, z=down. Altitude is -z.
        this.state.position = { x: msg.x, y: msg.y, z: msg.z };
        this.state.velocity = { x: msg.vx, y: msg.vy, z: msg.vz };
        this.state.altitudeM = -msg.z;
        break;
      case "sys_status":
        this.state.battery = {
          voltage: msg.voltage,
          current: msg.current,
          remaining: msg.remaining,
        };
        break;
      case "statustext":
        this.emit("log", {
          level: severityToLevel(msg.severity),
          message: msg.text,
          ts: Date.now(),
        } satisfies LogEntry);
        return msg;
    }

    this.state.updatedAt = Date.now();
    this.emit("telemetry", this.snapshot());
    return msg;
  }

  snapshot(): DroneTelemetry {
    // Return a copy so downstream consumers can't mutate internal state.
    return { ...this.state, position: { ...this.state.position }, velocity: { ...this.state.velocity }, battery: { ...this.state.battery } };
  }

  reset(): void {
    this.state = blankTelemetry();
  }
}

function blankTelemetry(): DroneTelemetry {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    roll: 0,
    pitch: 0,
    yaw: 0,
    heading: 0,
    altitudeM: 0,
    armed: false,
    flightMode: "UNKNOWN",
    battery: { voltage: 0, current: 0, remaining: null },
    updatedAt: 0,
  };
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** MAV_SEVERITY: 0..3 => error, 4 => warn, else info. */
function severityToLevel(sev: number): LogEntry["level"] {
  if (sev <= 3) return "error";
  if (sev <= 4) return "warn";
  return "info";
}
