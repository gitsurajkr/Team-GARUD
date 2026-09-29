import { EventEmitter } from "node:events";
import type { MavlinkLink } from "../mavlink/link";
import * as cmd from "../mavlink/commands";
import { COPTER_MODE } from "../mavlink/messages";
import type {
  MissionPhase,
  MissionStatus,
  Survivor,
} from "../../shared/types";
import { MAX_SURVIVORS } from "../../shared/grid";

/**
 * Owns operator-facing mission state and translates the three permitted
 * operator actions (START, ABORT, EMERGENCY STOP — mission brief section 4)
 * into MAVLink command frames sent over the link.
 *
 * Survivor detections and map updates originate from the onboard perception /
 * SLAM stack; this controller exposes ingest hooks (`addSurvivor`) that the
 * telemetry/perception bridge feeds. It does NOT synthesise them — doing so
 * would be manual intervention.
 *
 * Events:
 *   "status"   (status: MissionStatus)
 *   "survivor" (survivor: Survivor)
 */
export class MissionController extends EventEmitter {
  private phase: MissionPhase = "idle";
  private startedAt: number | null = null;
  private survivors = new Map<string, Survivor>();
  private seq = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly link: MavlinkLink) {
    super();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }

  /** Arm + switch to AUTO + start the loaded mission. */
  start(): void {
    this.link.send(cmd.arm(this.nextSeq(), true));
    this.link.send(cmd.setMode(this.nextSeq(), COPTER_MODE.AUTO));
    this.link.send(cmd.missionStart(this.nextSeq()));
    this.startedAt = Date.now();
    this.setPhase("entering");
    this.startClock();
  }

  /** Soft abort: return toward the entry/exit point. */
  abort(): void {
    this.link.send(cmd.returnToLaunch(this.nextSeq()));
    this.setPhase("returning");
  }

  /** Hard emergency stop: force-disarm immediately (motors cut). */
  emergencyStop(): void {
    this.link.send(cmd.emergencyDisarm(this.nextSeq()));
    this.setPhase("aborted");
    this.stopClock();
  }

  /** Feed a survivor detection from the onboard perception bridge. */
  addSurvivor(s: Survivor): void {
    if (this.survivors.size >= MAX_SURVIVORS && !this.survivors.has(s.id)) return;
    this.survivors.set(s.id, s);
    this.emit("survivor", s);
    this.emitStatus();
  }

  setPhase(phase: MissionPhase): void {
    this.phase = phase;
    this.emitStatus();
  }

  status(): MissionStatus {
    const elapsedSec = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      phase: this.phase,
      coverage: 0, // fed by SLAM coverage estimate when available
      survivorsFound: this.survivors.size,
      elapsedSec,
      startedAt: this.startedAt,
    };
  }

  private emitStatus(): void {
    this.emit("status", this.status());
  }

  private startClock(): void {
    this.stopClock();
    this.timer = setInterval(() => this.emitStatus(), 1000);
  }

  private stopClock(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stopClock();
    this.removeAllListeners();
  }
}
