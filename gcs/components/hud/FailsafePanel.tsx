"use client";

import { useState } from "react";
import { useGcsStore } from "../../lib/store";
import { cmd } from "../../lib/commands";

type Spec =
  | { name: string; label: string; hint: string; kind: "choice"; options: Record<number, string>; recommend: number }
  | { name: string; label: string; hint: string; kind: "number"; unit: string; step: number };

const SPECS: Spec[] = [
  {
    name: "BATT_FS_LOW_ACT", label: "Battery low", kind: "choice", recommend: 2,
    hint: "when the pack reaches the low threshold",
    options: { 0: "Nothing", 1: "Land", 2: "RTL", 3: "SmartRTL → RTL", 4: "SmartRTL → Land", 6: "Land (auto mission)" },
  },
  {
    name: "BATT_LOW_VOLT", label: "Low voltage", kind: "number", unit: "V", step: 0.1,
    hint: "0 disables the voltage trigger entirely",
  },
  {
    name: "BATT_FS_CRT_ACT", label: "Battery critical", kind: "choice", recommend: 1,
    hint: "last resort — get it down now",
    options: { 0: "Nothing", 1: "Land", 2: "RTL", 3: "SmartRTL → RTL", 4: "SmartRTL → Land", 6: "Land (auto mission)" },
  },
  {
    name: "FS_GCS_ENABLE", label: "GCS link loss", kind: "choice", recommend: 1,
    hint: "telemetry to this station drops out",
    options: { 0: "Disabled", 1: "RTL", 2: "Continue if in AUTO", 3: "SmartRTL → RTL", 4: "SmartRTL → Land", 5: "Land" },
  },
  {
    name: "FS_THR_ENABLE", label: "RC link loss", kind: "choice", recommend: 1,
    hint: "the pilot's transmitter drops out",
    options: { 0: "Disabled", 1: "RTL", 2: "Continue if in AUTO", 3: "SmartRTL → RTL", 4: "SmartRTL → Land", 5: "Land" },
  },
  {
    name: "FS_EKF_ACTION", label: "EKF failure", kind: "choice", recommend: 1,
    hint: "the position estimate stops being trustworthy",
    options: { 1: "Land", 2: "AltHold", 3: "Land (even in Stabilize)" },
  },
];

/**
 * "What should the aircraft DO when something goes wrong?" — the handful of
 * ArduCopter failsafe parameters worth setting before a search flight. Only the
 * rows the operator actually changes are written.
 *
 * A tab body sharing a Modal with the preflight checks. Still a separate tab,
 * not a merged list: whether the aircraft is fit to fly now and what it does
 * when something breaks are different questions with different answers.
 */
export function FailsafeTab({ sysid }: { sysid: number }) {
  const config = useGcsStore((s) => s.failsafe[sysid]);
  // Only what the operator edited — an untouched row is never written.
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  const [seen, setSeen] = useState(config);

  // A fresh read off the aircraft is the truth, so it supersedes pending edits.
  // Adjusting state during render (guarded) is React's documented way to derive
  // from a changing input; ControlDock fires the initial read when it opens this.
  if (config !== seen) {
    setSeen(config);
    setEdits({});
    setSending(false);
  }

  const live = config?.values ?? {};
  const valueOf = (name: string): number | null =>
    edits[name] ?? (live[name] ?? null);

  const dirty = Object.keys(edits).length > 0;

  const apply = () => {
    if (!dirty) return;
    setSending(true);
    cmd.setFailsafe(sysid, edits);
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-2">
        <span className="text-[10px] text-white/35">
          read live off the flight controller ·{" "}
          {dirty ? `${Object.keys(edits).length} change(s) pending` : "no changes"}
        </span>
        <button
          type="button"
          onClick={() => setEdits({})}
          disabled={!dirty}
          className="ml-auto rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-white/70 hover:bg-white/10 disabled:opacity-30"
        >
          Revert
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || sending}
          className="rounded border border-emerald-400/50 bg-emerald-500/30 px-3 py-1 text-[11px] font-bold text-emerald-50 hover:bg-emerald-500/50 disabled:opacity-40"
        >
          {sending ? "Writing…" : "Apply"}
        </button>
      </div>
      {!config && (
        <div className="py-6 text-center text-xs text-white/40">
          Reading failsafe parameters from the flight controller…
        </div>
      )}

      {config && (
        <div className="space-y-2">
          {SPECS.map((sp) => {
            const v = valueOf(sp.name);
            const unread = live[sp.name] === null || live[sp.name] === undefined;
            const changed = sp.name in edits;
            return (
              <div
                key={sp.name}
                className={`rounded-lg border px-3 py-2 ${
                  changed ? "border-amber-400/40 bg-amber-400/5" : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-white/90">{sp.label}</div>
                    <div className="text-[10px] text-white/35">{sp.hint}</div>
                  </div>

                  {unread ? (
                    <span className="shrink-0 text-[10px] text-white/30">not available</span>
                  ) : sp.kind === "choice" ? (
                    <select
                      value={v ?? ""}
                      onChange={(e) =>
                        setEdits((p) => ({ ...p, [sp.name]: Number(e.target.value) }))
                      }
                      className="shrink-0 rounded border border-white/10 bg-black/60 px-2 py-1 text-[11px] font-semibold text-white/90"
                    >
                      {/* The FC may hold a value this build does not name. */}
                      {v !== null && !(v in sp.options) && (
                        <option className="bg-black" value={v}>{`(${v})`}</option>
                      )}
                      {Object.entries(sp.options).map(([k, label]) => (
                        <option className="bg-black" key={k} value={k}>
                          {label}
                          {Number(k) === sp.recommend ? "  ★" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <input
                        type="number"
                        step={sp.step}
                        value={v ?? 0}
                        onChange={(e) =>
                          setEdits((p) => ({ ...p, [sp.name]: Number(e.target.value) }))
                        }
                        className="w-20 rounded border border-white/10 bg-black/60 px-2 py-1 text-[11px] font-mono text-white/90"
                      />
                      <span className="text-[10px] text-white/35">{sp.unit}</span>
                    </div>
                  )}
                </div>

                <div className="mt-1 font-mono text-[9px] text-white/25">
                  {sp.name}
                  {changed && live[sp.name] !== null && live[sp.name] !== undefined
                    ? ` · on aircraft: ${live[sp.name]}`
                    : ""}
                </div>
              </div>
            );
          })}
          <p className="pt-1 text-[10px] leading-relaxed text-white/30">
            ★ marks a sensible default for a search flight. Values are written straight to the
            flight controller and confirmed against its echo — ArduPilot may clamp or refuse them,
            and refuses parameter writes entirely while armed.
          </p>
        </div>
      )}
    </>
  );
}
