"use client";

import { useState } from "react";
import { useGcsStore } from "../../lib/store";
import { cmd } from "../../lib/commands";
import type { PreflightCheckResult } from "../../shared/types";

/** Checks that come from the aircraft rather than from our own thresholds. */
const FC_CHECKS = new Set(["FC prearm", "Sensors", "Failsafe state"]);

function CheckGroup({
  label,
  hint,
  checks,
}: {
  label: string;
  hint: string;
  checks: PreflightCheckResult[];
}) {
  if (checks.length === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2 border-b border-white/10 pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-white/55">{label}</span>
        <span className="text-[9px] text-white/25">{hint}</span>
      </div>
      <div>
        {checks.map((c, i) => (
          <div
            key={`${c.name}-${i}`}
            className={`flex items-baseline gap-2 rounded px-1.5 py-1 ${c.ok ? "" : "bg-red-500/10"}`}
          >
            <span
              className={`w-8 shrink-0 text-[9px] font-bold ${
                c.ok ? "text-emerald-400/80" : "text-red-400"
              }`}
            >
              {c.ok ? "OK" : "FAIL"}
            </span>
            <span className="w-24 shrink-0 text-[11px] font-semibold text-white/85">{c.name}</span>
            {/* Reasons can be long (several "PreArm: ..." lines) — wrap, don't clip. */}
            <span
              className={`min-w-0 flex-1 break-words text-[11px] leading-snug ${
                c.ok ? "text-white/40" : "text-red-300"
              }`}
            >
              {c.detail}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "Is this aircraft fit to fly right now?" — every check listed one per row with
 * the reason it failed. The FC prearm row carries ArduPilot's own "PreArm: ..."
 * text, which is the actual thing blocking the motors.
 *
 * A tab body, not a dialog: it shares a Modal with the failsafe settings. Its
 * actions live with its content rather than in the shared footer, so switching
 * tabs cannot leave the wrong buttons on screen.
 */
export function PreflightTab({ sysid }: { sysid: number }) {
  const result = useGcsStore((s) => s.preflight[sysid]);

  // The backend takes ~2 s (the FC re-runs its own prearm checks), so the panel
  // has a pending state. ControlDock fires the first run when it opens this.
  const [running, setRunning] = useState(true);
  const [seen, setSeen] = useState(result);

  // A new result object means our request landed. Adjusting state during render
  // (guarded, so it cannot loop) is React's documented way to derive from a
  // changing input — an effect here would just cause a second render pass.
  if (result !== seen) {
    setSeen(result);
    if (running) setRunning(false);
  }

  const run = () => {
    setRunning(true);
    cmd.preflight(sysid);
  };

  const stale = running;
  const failed = result?.checks.filter((c) => !c.ok) ?? [];

  return (
    <>
      <div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-2">
        {result && (
          <span className={`text-xs font-bold ${result.ok ? "text-emerald-400" : "text-red-400"}`}>
            {result.ok ? "READY TO FLY" : `${failed.length} ISSUE${failed.length === 1 ? "" : "S"}`}
          </span>
        )}
        <span className="text-[10px] text-white/35">fitness to fly right now</span>
        <button
          type="button"
          onClick={run}
          disabled={stale}
          className="ml-auto rounded border border-sky-500/40 bg-sky-500/25 px-3 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-500/40 disabled:opacity-40"
        >
          {stale ? "Checking…" : "Re-run"}
        </button>
      </div>
      {!result && (
        <div className="py-6 text-center text-xs text-white/40">
          Asking the flight controller to run its prearm checks…
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <CheckGroup
            label="Ground station"
            hint="thresholds this GCS applies to incoming telemetry"
            checks={result.checks.filter((c) => !FC_CHECKS.has(c.name))}
          />
          <CheckGroup
            label="Flight controller"
            hint="the aircraft's own verdict — this is what decides arming"
            checks={result.checks.filter((c) => FC_CHECKS.has(c.name))}
          />
        </div>
      )}
    </>
  );
}
