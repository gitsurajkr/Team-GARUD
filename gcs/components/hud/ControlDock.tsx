"use client";

import { useEffect, useState } from "react";
import { useGcsStore } from "../../lib/store";
import { cmd, COPTER_MODES } from "../../lib/commands";
import type { MissionFinish } from "../../shared/types";
import { ChecksPanel } from "./ChecksPanel";
import { MissionPanel } from "./MissionPanel";

type Tone = "default" | "primary" | "warn" | "danger" | "go";

const TONES: Record<Tone, string> = {
  default: "bg-white/5 text-white/80 hover:bg-white/10 border-white/10",
  primary: "bg-sky-500/25 text-sky-100 hover:bg-sky-500/40 border-sky-500/40",
  warn: "bg-amber-500/25 text-amber-100 hover:bg-amber-500/40 border-amber-500/40",
  danger: "bg-red-500/25 text-red-100 hover:bg-red-500/40 border-red-500/40",
  go: "bg-emerald-500/30 text-emerald-50 hover:bg-emerald-500/50 border-emerald-400/50 font-bold",
};

function Btn({
  onClick,
  disabled,
  tone = "default",
  children,
  title,
  square,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  square?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`text-[11px] font-semibold rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        square ? "w-7 h-7 flex items-center justify-center" : "px-2 py-1"
      } ${TONES[tone]}`}
    >
      {children}
    </button>
  );
}

/**
 * One labelled line of the dock. The fixed-width gutter keeps the rows aligned —
 * without it each row's controls start at a different x and the dock reads as a
 * jumble.
 *
 * Deliberately does NOT wrap. Wrapping pushed overflow onto a second line that
 * began in the label gutter, aligned with nothing; on a narrow window the dock
 * scrolls horizontally instead, which keeps every row readable.
 */
function Row({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-x-2">
      <span
        className={`w-14 shrink-0 ${
          strong
            ? "text-[11px] font-bold text-white/70"
            : "text-[9px] font-semibold uppercase tracking-wider text-white/30"
        }`}
      >
        {label}
      </span>
      <div className="flex items-center gap-x-2">{children}</div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {label && (
        <span className="text-[9px] font-semibold uppercase tracking-wider text-white/30">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

/** How long the button trusts the operator's click over the reported state. */
const SAFETY_INTENT_MS = 4000;

const numCls = "w-14 bg-black/40 border border-white/10 rounded px-1 py-1 text-[11px] font-mono text-white/90";
const Div = () => <div className="h-6 w-px bg-white/10" />;

/**
 * Safety switch — drawn as a physical two-position switch rather than a button,
 * because that is what it is: a latch with a position, not an action. The knob
 * sits left for OFF (motors live, red) and right for ON (inhibited, green), so
 * the current position is readable without parsing a word.
 */
function SafetyBtn({
  on,
  assumed,
  disabled,
  lockedArmed,
  onToggle,
}: {
  on: boolean;
  assumed: boolean;
  disabled: boolean;
  /** Armed and currently OFF — engaging would cut the motors mid-flight. */
  lockedArmed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Safety switch"
      disabled={disabled || lockedArmed}
      onClick={onToggle}
      title={
        lockedArmed
          ? "Locked while armed — engaging the safety switch cuts the motors in flight. Use Disarm."
          : on
            ? `Safety switch ON — motors inhibited, arming refused.${
                assumed ? " (Assumed: the flight controller has not reported it.)" : ""
              } Click to turn OFF.`
            : "Safety switch OFF — motors are LIVE. Click to turn ON."
      }
      className={`flex items-center gap-2 rounded border px-2 py-1 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        on
          ? "border-emerald-400/50 bg-emerald-500/15 hover:bg-emerald-500/25"
          : "border-red-400/60 bg-red-500/20 hover:bg-red-500/30"
      }`}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider text-white/45">
        Safety
      </span>
      {/* track + knob */}
      <span
        className={`relative h-3.5 w-7 shrink-0 rounded-full transition-colors ${
          on ? "bg-emerald-500/70" : "bg-red-500/70"
        }`}
      >
        <span
          // track 28px − knob 10px − 2px inset = 16px travel
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all ${
            on ? "left-4" : "left-0.5"
          }`}
        />
      </span>
      <span
        className={`w-6 text-[10px] font-bold ${on ? "text-emerald-300" : "text-red-300"}`}
      >
        {lockedArmed ? "🔒" : on ? "ON" : "OFF"}
      </span>
    </button>
  );
}

/**
 * Emergency kill — force disarm. Stops the motors at once and ends the mission;
 * airborne, the aircraft falls. That is the intent, so it always confirms first.
 *
 * Sits in the flight row, separated from Arm/Takeoff, in the slot freed by
 * folding Failsafe into the Checks dialog. Unlike the safety switch it IS
 * allowed while armed — this is the one control meant to work in flight.
 */
function KillBtn({
  sysid,
  armed,
  disabled,
}: {
  sysid: number | null;
  armed: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (sysid === null) return;
        const warning = armed
          ? [
              `⚠ KILL — SYS ${sysid}`,
              "",
              "This force-disarms the aircraft IMMEDIATELY.",
              "It is ARMED: the motors stop and it WILL FALL from its current altitude.",
              "The mission ends.",
              "",
              "Only do this if the alternative is worse.",
              "",
              "Proceed?",
            ].join("\n")
          : `⚠ KILL — SYS ${sysid}\n\nForce-disarm the aircraft and end the mission?`;
        if (window.confirm(warning)) cmd.kill(sysid);
      }}
      title="EMERGENCY: force disarm — stops the motors and ends the mission. The aircraft will fall if airborne."
      className={`flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-white transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${
        // Brighter once armed: that is when it actually does something.
        armed
          ? "border-red-400 bg-red-600/90 hover:bg-red-500"
          : "border-red-500/50 bg-red-600/45 hover:bg-red-600/75"
      }`}
    >
      {/* octagon — the universal emergency-stop shape, readable without reading */}
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none"
        stroke="currentColor" strokeWidth={2.2}>
        <path d="M8 2.5h8L21.5 8v8L16 21.5H8L2.5 16V8z" strokeLinejoin="round" />
        <path d="M9 9l6 6M15 9l-6 6" strokeLinecap="round" />
      </svg>
      <span className="text-[11px] font-black uppercase leading-none tracking-wider">
        Kill
      </span>
    </button>
  );
}

/** Bottom-center command dock — acts on the selected drone. */
export function ControlDock() {
  const sysid = useGcsStore((s) => s.selectedSysid);
  const drone = useGcsStore((s) => (s.selectedSysid !== null ? s.drones[s.selectedSysid] : undefined));
  const waypointMode = useGcsStore((s) => s.waypointMode);
  const setWaypointMode = useGcsStore((s) => s.setWaypointMode);
  const repositionMode = useGcsStore((s) => s.repositionMode);
  const setRepositionMode = useGcsStore((s) => s.setRepositionMode);
  const draft = useGcsStore((s) => (s.selectedSysid !== null ? s.draftWaypoints[s.selectedSysid] : undefined));
  const clearDraft = useGcsStore((s) => s.clearDraftWaypoints);
  const popDraft = useGcsStore((s) => s.popDraftWaypoint);
  const progress = useGcsStore((s) => (s.selectedSysid !== null ? s.missionProgress[s.selectedSysid] : undefined));
  const fenceState = useGcsStore((s) => (s.selectedSysid !== null ? s.fence[s.selectedSysid] : undefined));
  const airUnitConnected = useGcsStore((s) => s.airUnitConnected);
  // Operator pressed Connect for this drone — being on the wire is not enough.
  const droneConnected = useGcsStore((s) =>
    s.roster.some((r) => r.sysid === s.selectedSysid && r.connected),
  );
  // Two aircraft on this sysid — a command could reach either of them.
  const sysidClash = useGcsStore((s) =>
    s.roster.some((r) => r.sysid === s.selectedSysid && (r.conflict?.length ?? 0) > 1),
  );
  const pushStatus = useGcsStore((s) => s.pushStatus);
  const wpAlt = useGcsStore((s) => s.draftAlt);
  const setWpAlt = useGcsStore((s) => s.setDraftAlt);

  const [takeoffAlt, setTakeoffAlt] = useState(10);
  const [jumpSeq, setJumpSeq] = useState(1);
  // Cruise speed for the mission legs. 0 (or blank) means "don't send
  // DO_CHANGE_SPEED" — the FC keeps its own WPNAV_SPEED, which defaults to 10 m/s.
  const [cruiseSpeed, setCruiseSpeed] = useState(4);
  // Last value actually sent, so Apply can show whether it is pending.
  const [appliedSpeed, setAppliedSpeed] = useState<number | null>(null);
  const [fenceRadius, setFenceRadius] = useState(300);
  const [fenceAlt, setFenceAlt] = useState(60);
  const [panel, setPanel] = useState<"checks" | "mission" | null>(null);
  // How the mission ends. RTL by default — see MissionPanel for why this
  // is an explicit choice rather than inheriting ArduCopter's "hold".
  const [finish, setFinish] = useState<MissionFinish>("rtl");

  // Disarm/Kill stay live through a SYSID conflict — the backend sends them to
  // every aircraft on the sysid. Everything else needs an unambiguous target.
  const canEmergency = sysid !== null && airUnitConnected && droneConnected;
  const has = canEmergency && !sysidClash;
  const armed = drone?.armed ?? false;
  const wpCount = draft?.length ?? 0;
  // undefined -> the field is omitted from the frame and the FC keeps its default
  const speedArg = cruiseSpeed > 0 ? cruiseSpeed : undefined;

  // Tri-state on purpose: undefined means we have not heard from the FC, which
  // is NOT the same as "fence off". Showing OFF there would claim the search
  // area is unbounded when we simply do not know.
  const fenceOn: boolean | null = fenceState?.known ? fenceState.enabled : null;

  // Pull the fence off the FC when a drone is selected, so the map circle and
  // the toggle show what the aircraft actually has — not a stale local guess.
  // Also re-request when the backend link comes up: sendCommand silently no-ops
  // while the socket is down, and without this the request would be lost for good.
  useEffect(() => {
    if (has) cmd.getFence(sysid!);
  }, [has, sysid]);

  // Losing the connection disables the mode buttons, so they could not be
  // switched off again — and a map click would still fire a reposition.
  useEffect(() => {
    if (!has) {
      setRepositionMode(false);
      setWaypointMode(false);
    }
  }, [has, setRepositionMode, setWaypointMode]);

  // --- safety switch ------------------------------------------------------
  // The button must flip on the click, not a round-trip later. `intent` is what
  // the operator just asked for; it overrides the reported state until the
  // aircraft agrees (no flicker) or until it expires (so a command the FC
  // refused reverts instead of leaving the button lying).
  const reportedSafety = drone?.health?.safety_engaged ?? null;
  const [safetyIntent, setSafetyIntent] = useState<boolean | null>(null);
  // The override stops the moment the aircraft agrees, so there is no flicker.
  const intentLive = safetyIntent !== null && reportedSafety !== safetyIntent;
  // Unknown counts as ON — the fail-safe direction.
  const safetyOn = intentLive ? safetyIntent! : reportedSafety !== false;

  // Give up on an intent the aircraft never confirms, so a refused command
  // reverts the button instead of leaving it showing something untrue.
  useEffect(() => {
    if (safetyIntent === null) return;
    const id = setTimeout(() => setSafetyIntent(null), SAFETY_INTENT_MS);
    return () => clearTimeout(id);
  }, [safetyIntent]);

  const toggleSafety = () => {
    if (!has) return;
    const next = !safetyOn;
    // Engaging the switch cuts motor output in hardware. Airborne, that is not
    // a safe state — it is a crash. Disarm is the in-flight emergency action.
    if (next && armed) {
      pushStatus({
        sysid: sysid ?? 0,
        ts: Date.now() / 1000,
        severity: 4,
        label: "REJECTED",
        text: "Safety switch ON — refused while armed. It would cut the motors in flight. Use Disarm.",
      });
      return;
    }
    setSafetyIntent(next);
    cmd.setSafety(sysid!, !next); // the command takes `disengage`
  };

  /**
   * Gate anything that can spin the props. The safety switch inhibits motor
   * output in hardware, so these commands cannot succeed while it is ON —
   * refusing here with a reason beats firing one the FC will quietly drop.
   */
  const blockedBySafety = (what: string): boolean => {
    if (!safetyOn) return false;
    pushStatus({
      sysid: sysid ?? 0,
      ts: Date.now() / 1000,
      severity: 4,
      label: "REJECTED",
      text: `${what} — safety switch is ON. Turn it OFF first.`,
    });
    return true;
  };

  /**
   * ± only adjusts the number — Apply is what reaches the aircraft.
   *
   * These used to send on every click, so trimming 4 → 9 m/s fired five separate
   * DO_CHANGE_SPEED commands at the FC (each one ack-waited), and the operator
   * had no way to pick a value without every intermediate step going out too.
   */
  const nudgeSpeed = (delta: number) => {
    setCruiseSpeed((v) => Math.min(20, Math.max(0.5, v + delta)));
  };

  /** True when the typed speed has not been sent yet. */
  const speedDirty = cruiseSpeed > 0 && cruiseSpeed !== appliedSpeed;

  return (
    // max-w + wrap: the dock has outgrown a single line on a 1366-wide window,
    // and a clipped Disarm button is worse than a taller dock.
    <div className="flex w-max max-w-[94vw] rounded-xl border border-white/10 bg-black/70 backdrop-blur-md shadow-2xl px-3 py-2">
      {/* hud-scroll: if the rows ever exceed the viewport cap they scroll
          sideways rather than clipping a control off the edge. */}
      <div className="hud-scroll flex flex-col gap-2 overflow-x-auto">
      {/* row 1 — flight */}
      <Row label={sysidClash ? `SYS ${sysid} ⚠` : has ? `SYS ${sysid}` : "—"} strong>
        {/* Each panel renders whatever is in the store; the request that fills
            it is fired here, on open, so the panels need no mount effects. */}
        {/* Preflight and failsafe share one dialog (two tabs); the request that
            fills the opening tab is fired here so the panel needs no mount effect. */}
        <Btn
          onClick={() => { if (has) { cmd.preflight(sysid!); setPanel("checks"); } }}
          disabled={!has}
          title="Preflight checks and failsafe settings"
        >
          Checks
        </Btn>
        <KillBtn sysid={sysid} armed={armed} disabled={!canEmergency} />
        <SafetyBtn
          on={safetyOn}
          assumed={reportedSafety === null && !intentLive}
          disabled={!has}
          /* Only ENGAGING is locked out in flight; releasing it can only ever
             restore motor output, so that stays available. */
          lockedArmed={armed && !safetyOn}
          onToggle={toggleSafety}
        />
        {/* Both states share one grid cell, the inactive one `invisible` (not
            clickable, not focusable). The cell keeps the wider state's width,
            so arming no longer resizes the centred dock and shoves every
            control sideways. */}
        <div className="grid shrink-0">
          <div className={`col-start-1 row-start-1 flex items-center ${armed ? "" : "invisible"}`}>
            <Btn tone="danger" onClick={() => canEmergency && cmd.disarm(sysid!)} disabled={!canEmergency}>Disarm</Btn>
          </div>
          <div className={`col-start-1 row-start-1 flex items-center gap-x-2 ${armed ? "invisible" : ""}`}>
            <Btn
              tone="warn"
              onClick={() => has && !blockedBySafety("Arm") && cmd.arm(sysid!)}
              disabled={!has}
              title={safetyOn ? "Blocked — turn the safety switch OFF first" : "Arm the motors"}
            >
              Arm
            </Btn>
            <Btn
              tone="danger"
              disabled={!has}
              onClick={() =>
                has &&
                // Force arm bypasses prearm in software; it cannot bypass the
                // hardware safety switch, so it is gated too.
                !blockedBySafety("Force Arm") &&
                window.confirm("⚠ FORCE ARM bypasses ALL prearm checks & failsafes and spins the motors immediately.\n\nContinue?") &&
                cmd.forceArm(sysid!)
              }
              title={
                safetyOn
                  ? "Blocked — turn the safety switch OFF first (force arm cannot bypass it)"
                  : "Arm bypassing prearm checks / failsafes (dangerous)"
              }
            >
              Force Arm
            </Btn>
          </div>
        </div>

        <select
          value={drone?.mode ?? ""}
          onChange={(e) => has && e.target.value && cmd.setMode(sysid!, e.target.value)}
          disabled={!has}
          className="bg-black/50 border border-white/10 rounded px-1.5 py-1 text-[11px] font-semibold text-white/85 disabled:opacity-30"
          title="Set flight mode"
        >
          <option className="bg-black text-white/75" value="" disabled>Mode</option>
          {COPTER_MODES.map((m) => <option className="bg-black" key={m} value={m}>{m}</option>)}
        </select>
        <Btn tone={repositionMode ? "primary" : "default"} onClick={() => has && setRepositionMode(!repositionMode)} disabled={!has}
          title="Then click the map and confirm — the drone flies there (GUIDED)">
          {repositionMode ? "Click map…" : "Reposition"}
        </Btn>

      </Row>

      <div className="h-px bg-white/10" />

      {/* row 2 — mission */}
      <Row label="Mission">
        <Group label="">
          <Btn tone={waypointMode ? "primary" : "default"} onClick={() => setWaypointMode(!waypointMode)} disabled={!has}
            title="Click the map to drop waypoints">
            {waypointMode ? "Drawing…" : "Draw WPs"}
          </Btn>
          <input type="number" value={wpAlt} min={1} onChange={(e) => setWpAlt(Number(e.target.value))} className={numCls}
            title="Altitude given to NEW waypoints as you draw them. Edit individual waypoints in the WPs panel." />
          <Btn square onClick={() => has && popDraft(sysid!)} disabled={!has || wpCount === 0} title="Undo last waypoint">↶</Btn>
          <Btn square onClick={() => has && clearDraft(sysid!)} disabled={!has || wpCount === 0} title="Clear waypoints">✕</Btn>
        </Group>

        <Div />

        <Btn onClick={() => has && setPanel("mission")} disabled={!has}
          title="Edit altitude and hold time per waypoint, and choose how the mission ends">
          WPs ({wpCount})
        </Btn>

        <Div />

        <Btn tone="primary"
          onClick={() => has && wpCount > 0 && cmd.uploadMission(sysid!, draft ?? [], takeoffAlt, speedArg, finish)}
          disabled={!has || wpCount === 0}>
          Upload ({wpCount})
        </Btn>
        <Btn tone="go"
          onClick={() =>
            has && wpCount > 0 && !blockedBySafety("Start mission") &&
            cmd.startMission(sysid!, draft ?? [], wpAlt, takeoffAlt, speedArg, finish)
          }
          disabled={!has || wpCount === 0}
          title={
            safetyOn
              ? "Blocked — turn the safety switch OFF first"
              : "Upload (with takeoff) → GUIDED → Arm → AUTO → run"
          }>
          ▶ Start
        </Btn>

        <Div />

        <Group label="Jump">
          <input type="number" value={jumpSeq} min={1} max={Math.max(1, wpCount)}
            onChange={(e) => setJumpSeq(Number(e.target.value))} className={numCls}
            title={`Waypoint number as shown in the WPs panel (1-${Math.max(1, wpCount)}) — not a raw mission item`} />
          <Btn square onClick={() => has && cmd.setCurrent(sysid!, jumpSeq)} disabled={!has} title="Jump the running AUTO mission to this waypoint">➜</Btn>
        </Group>

        {progress && (
          <span
            className={`text-[11px] font-mono ${
              progress.state === "uploading" ? "text-sky-300"
              : progress.state === "complete" ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {progress.state === "uploading" ? `${progress.uploaded}/${progress.total}`
              : progress.state === "complete" ? "✓" : "failed"}
          </span>
        )}
      </Row>

      <div className="h-px bg-white/10" />

      {/* row 3 — limits: what bounds the flight, speed and fence together. Both
          are live: the ± buttons retarget a running mission. */}
      <Row label="Limits">
        <Group label="Spd">
          <Btn square onClick={() => nudgeSpeed(-1)} disabled={!has} title="Slower by 1 m/s — press Apply to send">–</Btn>
          <input
            type="number" value={cruiseSpeed} min={0} max={20} step={0.5}
            onChange={(e) => setCruiseSpeed(Number(e.target.value))}
            className={numCls}
            title="Cruise speed (m/s). Baked into the mission on Upload/Start; press Apply to change it live mid-mission. 0 = leave the FC's WPNAV_SPEED alone."
          />
          <Btn square onClick={() => nudgeSpeed(1)} disabled={!has} title="Faster by 1 m/s — press Apply to send">+</Btn>
          <Btn
            tone={speedDirty ? "primary" : "default"}
            onClick={() => {
              if (!has || cruiseSpeed <= 0) return;
              cmd.setSpeed(sysid!, cruiseSpeed);
              setAppliedSpeed(cruiseSpeed);
            }}
            disabled={!has || !speedDirty}
            title={
              speedDirty
                ? `Send ${cruiseSpeed} m/s to the aircraft now (DO_CHANGE_SPEED)`
                : `${cruiseSpeed} m/s already sent`
            }
          >
            Apply
          </Btn>
        </Group>

        <Div />

        <Group label="Fence">
          <input
            type="number" value={fenceRadius} min={10} step={10}
            onChange={(e) => setFenceRadius(Number(e.target.value))}
            className={numCls} title="Geofence radius from home (m) "
          />
          <input
            type="number" value={fenceAlt} min={5} step={5}
            onChange={(e) => setFenceAlt(Number(e.target.value))}
            className={numCls} title="Geofence ceiling (m)"
          />
          {fenceOn === true ? (
            <Btn
              tone="warn"
              onClick={() =>
                has &&
                window.confirm("Disable the geofence?\n\nNothing will bound the search area.") &&
                cmd.setFence(sysid!, fenceRadius, fenceAlt, false)
              }
              disabled={!has}
              title="Fence is ON (confirmed by the flight controller) — click to disable"
            >
              ON
            </Btn>
          ) : (
            <Btn
              tone={fenceOn === null ? "default" : "primary"}
              onClick={() => has && cmd.setFence(sysid!, fenceRadius, fenceAlt, true)}
              disabled={!has}
              title={
                fenceOn === null
                  ? "Fence state unknown — the flight controller has not answered. Click to enable. (ArduPilot refuses FENCE_* writes while armed; the backend must be running the current code.)"
                  : "Fence is OFF — click to enable. Breach → RTL. ArduPilot refuses FENCE_* writes while armed."
              }
            >
              {fenceOn === null ? "FENCE ?" : "OFF"}
            </Btn>
          )}


        </Group>
        <Div />


        <div className="flex items-center gap-1">
          <Btn
            tone="primary"
            onClick={() => has && !blockedBySafety("Takeoff") && cmd.takeoff(sysid!, takeoffAlt)}
            disabled={!has}
            title={safetyOn ? "Blocked — turn the safety switch OFF first" : "Take off to this altitude"}
          >
            Takeoff
          </Btn>
          <input type="number" value={takeoffAlt} min={1} onChange={(e) => setTakeoffAlt(Number(e.target.value))} className={numCls} />
        </div>
      </Row>

      </div>

      {/* KILL sits outside the rows: always the same place, always full height,
          never reflowed by a row that grew. */}

      {panel === "checks" && has && (
        <ChecksPanel sysid={sysid!} onClose={() => setPanel(null)} />
      )}
      {panel === "mission" && has && (
        <MissionPanel
          sysid={sysid!}
          finish={finish}
          onFinish={setFinish}
          takeoffAlt={takeoffAlt}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
