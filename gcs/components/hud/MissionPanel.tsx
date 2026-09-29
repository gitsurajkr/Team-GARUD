"use client";

import { useGcsStore } from "../../lib/store";
import type { MissionFinish } from "../../shared/types";
import { Modal } from "./Modal";

const FINISH: { value: MissionFinish; label: string; hint: string }[] = [
  { value: "rtl", label: "Return to launch", hint: "fly home and land — the safe default" },
  { value: "land", label: "Land here", hint: "descend and land at the last waypoint" },
  {
    value: "hold",
    label: "Hold at last waypoint",
    hint: "keeps the camera on target — but it hovers until a failsafe or you act",
  },
];

/**
 * Per-waypoint mission editor: altitude and hold time for each point, plus what
 * the aircraft does when it reaches the end. The ending is an explicit choice
 * because ArduCopter's own default ("hold") burns the pack hovering, and with no
 * battery failsafe set that ends with the aircraft on the ground.
 */
export function MissionPanel({
  sysid,
  finish,
  onFinish,
  takeoffAlt,
  onClose,
}: {
  sysid: number;
  finish: MissionFinish;
  onFinish: (f: MissionFinish) => void;
  takeoffAlt: number;
  onClose: () => void;
}) {
  const wps = useGcsStore((s) => s.draftWaypoints[sysid] ?? []);
  const update = useGcsStore((s) => s.updateDraftWaypoint);
  const pop = useGcsStore((s) => s.popDraftWaypoint);
  const clear = useGcsStore((s) => s.clearDraftWaypoints);

  const applyAltToAll = (alt: number) => {
    wps.forEach((_, i) => update(sysid, i, { alt }));
  };

  const totalHold = wps.reduce((a, w) => a + (w.hold ?? 0), 0);

  return (
    <Modal
      title={`Mission — SYS ${sysid}`}
      subtitle="Altitude and hold time per waypoint, and how the mission ends."
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-white/35">
            {wps.length} waypoint{wps.length === 1 ? "" : "s"}
            {totalHold > 0 ? ` · ${totalHold}s total hold` : ""}
          </span>
          <button
            type="button"
            onClick={() => clear(sysid)}
            disabled={wps.length === 0}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-white/70 hover:bg-white/10 disabled:opacity-30"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-sky-500/40 bg-sky-500/25 px-3 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-500/40"
          >
            Done
          </button>
        </>
      }
    >
      {wps.length === 0 ? (
        <div className="py-6 text-center text-xs text-white/40">
          No waypoints yet — use <span className="text-white/70">Draw WPs</span> and click the map.
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wider text-white/35">
            <span className="w-6">#</span>
            <span className="flex-1">Position</span>
            <span className="w-14 text-center">Alt (m)</span>
            <span className="w-14 text-center">Hold (s)</span>
            <span className="w-5" />
          </div>

          <div className="space-y-1">
            {/* Takeoff is item 1 on the aircraft but is not editable here — it
                comes from the dock's Takeoff altitude field. Shown for context. */}
            <div className="flex items-center gap-2 rounded border border-white/5 bg-white/[0.02] px-1.5 py-1 opacity-60">
              <span className="w-6 text-[10px] font-bold text-white/40">T/O</span>
              <span className="flex-1 font-mono text-[10px] text-white/35">takeoff, in place</span>
              <span className="w-14 text-center font-mono text-[11px] text-white/50">{takeoffAlt}</span>
              <span className="w-14 text-center text-[10px] text-white/25">—</span>
              <span className="w-5" />
            </div>

            {wps.map((w, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-1.5 py-1"
              >
                <span className="w-6 text-[11px] font-bold text-white/70">{i + 1}</span>
                <span className="flex-1 truncate font-mono text-[10px] text-white/45">
                  {w.lat.toFixed(6)}, {w.lon.toFixed(6)}
                </span>
                <input
                  type="number" min={1} step={1} value={w.alt}
                  onChange={(e) => update(sysid, i, { alt: Number(e.target.value) })}
                  className="w-14 rounded border border-white/10 bg-black/50 px-1 py-0.5 text-center text-[11px] font-mono text-white/90"
                  title="Altitude at this waypoint (m, relative to home)"
                />
                <input
                  type="number" min={0} step={1} value={w.hold ?? 0}
                  onChange={(e) => update(sysid, i, { hold: Number(e.target.value) })}
                  className="w-14 rounded border border-white/10 bg-black/50 px-1 py-0.5 text-center text-[11px] font-mono text-white/90"
                  title="Seconds to hover here before moving on. 0 = fly straight through."
                />
                <button
                  type="button"
                  onClick={() => { if (i === wps.length - 1) pop(sysid); }}
                  disabled={i !== wps.length - 1}
                  title={
                    i === wps.length - 1
                      ? "Remove this waypoint"
                      : "Only the last waypoint can be removed"
                  }
                  className="w-5 text-center text-[11px] text-white/30 hover:text-red-300 disabled:opacity-20 disabled:hover:text-white/30"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => applyAltToAll(wps[0].alt)}
            className="mt-2 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/60 hover:bg-white/10"
            title="Copy waypoint 1's altitude to every waypoint"
          >
            Apply {wps[0].alt} m to all
          </button>
        </>
      )}

      <div className="mt-4 border-t border-white/10 pt-3">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/55">
          When the last waypoint is reached
        </div>
        <div className="space-y-1">
          {FINISH.map((f) => (
            <label
              key={f.value}
              className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 transition-colors ${
                finish === f.value
                  ? f.value === "hold"
                    ? "border-amber-400/40 bg-amber-400/10"
                    : "border-emerald-400/40 bg-emerald-400/10"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/5"
              }`}
            >
              <input
                type="radio"
                name="finish"
                checked={finish === f.value}
                onChange={() => onFinish(f.value)}
                className="mt-0.5 accent-emerald-400"
              />
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold text-white/90">{f.label}</span>
                <span className="block text-[10px] leading-snug text-white/40">{f.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {finish === "hold" && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-300/80">
            No terminal command will be uploaded. Make sure a battery failsafe is set
            in the Failsafe panel — otherwise nothing brings the aircraft down.
          </p>
        )}
      </div>
    </Modal>
  );
}
