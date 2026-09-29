"use client";

import { useGcsStore } from "../../lib/store";
import { droneColor } from "../../lib/droneColors";
import { cmd } from "../../lib/commands";
import type { DroneRosterEntry } from "../../shared/types";

/**
 * Top-left roster: Scan discovers every drone on the wire; each row can be
 * Connected (one by one) and selected. The whole dashboard focuses the
 * selected drone.
 */
export function DroneRoster() {
  const roster = useGcsStore((s) => s.roster);
  const drones = useGcsStore((s) => s.drones);
  const selectedSysid = useGcsStore((s) => s.selectedSysid);
  const selectDrone = useGcsStore((s) => s.selectDrone);
  const airUnitConnected = useGcsStore((s) => s.airUnitConnected);

  // Merge roster + any drones already streaming, so rows show up promptly.
  // The backend only streams telemetry for Connected drones, so a drone known
  // only from telemetry is connected by definition.
  const bySysid = new Map<number, DroneRosterEntry>();
  for (const r of roster) bySysid.set(r.sysid, r);
  for (const d of Object.values(drones)) {
    if (!bySysid.has(d.sysid)) {
      bySysid.set(d.sysid, {
        sysid: d.sysid,
        drone_id: d.drone_id,
        connected: true,
        linked: d.connected,
        armed: d.armed,
        mode: d.mode,
        real: false,
      });
    }
  }
  const entries = [...bySysid.values()].sort((a, b) => a.sysid - b.sysid);
  const connectedCount = entries.filter((e) => e.connected).length;

  return (
    <div className="w-56 rounded-sm border border-white/10 bg-black/60 backdrop-blur-md shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        {/* The count is what tells the operator a row is scrolled out of view. */}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/70">
          Drones{" "}
          {entries.length > 0 && (
            <span className="font-mono normal-case text-white/40">
              {connectedCount}/{entries.length}
            </span>
          )}
        </span>
        <span className={`text-[10px] ${airUnitConnected ? "text-emerald-400" : "text-red-500"}`}>
          {airUnitConnected ? "● AirUnit Connected" : "○ AirUnit Disconnected"}
        </span>
      </div>

      {/* Sized to the window, not a fixed 13rem — that fitted three rows and
          clipped the 4th drone's Connect button below the fold. */}
      <div className="hud-scroll max-h-[40vh] overflow-y-auto p-2 space-y-1">
        {entries.length === 0 && (
          <div className="text-[11px] text-white/30 px-1 py-2">
            No drones yet — press Scan.
          </div>
        )}
        {entries.map((e) => {
          const color = droneColor(e.sysid);
          const active = e.sysid === selectedSysid;
          const clash = e.conflict && e.conflict.length > 1 ? e.conflict : null;
          return (
            <div
              key={e.sysid}
              onClick={() => selectDrone(e.sysid)}
              className={`cursor-pointer rounded-md border px-2 py-1.5 transition-colors ${
                clash
                  ? "border-red-500/70 bg-red-500/10"
                  : active
                    ? "border-white/40 bg-white/10"
                    : "border-white/5 bg-white/[0.02] hover:bg-white/5"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: color, opacity: e.linked ? 1 : 0.3 }}
                  />
                  <span className="text-xs font-semibold text-white/90">SYS {e.sysid}</span>
                  {e.real ? (
                    <span className="text-[8px] font-bold px-1 rounded bg-emerald-500/30 text-emerald-300">REAL</span>
                  ) : (
                    <span className="text-[8px] font-bold px-1 rounded bg-white/10 text-white/40">SIM</span>
                  )}
                  {e.armed && <span className="text-[9px] font-bold text-amber-400">ARM</span>}
                </div>
                <span className="text-[10px] font-mono text-sky-300">{e.mode}</span>
              </div>
              {clash && (
                <div
                  className="mt-1 text-[10px] font-semibold leading-tight text-red-300"
                  title="Two aircraft share this SYSID_THISMAV, so a command could reach either. Only Disarm/Kill are sent (to both). Give each aircraft a unique SYSID_THISMAV and reboot it."
                >
                  ⚠ SYSID CONFLICT — {clash.join(" + ")}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between">
                <span className={`text-[10px] ${e.connected ? "text-emerald-400" : "text-white/35"}`}>
                  {e.connected ? "connected" : "not connected"}
                  {/* Which radio — how the operator tells five real drones apart. */}
                  {e.real && e.link && !clash && (
                    <span className="ml-1.5 font-mono text-white/35">{e.link}</span>
                  )}
                </span>
                {!e.connected ? (
                  <button
                    type="button"
                    onClick={(ev) => { ev.stopPropagation(); cmd.connect(e.sysid); }}
                    disabled={!!clash}
                    title={clash ? "Blocked — fix the SYSID conflict first" : undefined}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded bg-sky-500/25 text-sky-200 hover:bg-sky-500/40 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Connect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      // Disconnecting does not land the aircraft — it only stops
                      // this GCS seeing and commanding it.
                      if (
                        e.armed &&
                        !window.confirm(
                          `SYS ${e.sysid} is ARMED.\n\nDisconnecting stops telemetry and control from this GCS. ` +
                            "The aircraft keeps flying in its current mode.\n\nDisconnect anyway?",
                        )
                      ) return;
                      cmd.disconnect(e.sysid);
                    }}
                    className="text-[10px] px-2 py-0.5 rounded text-white/40 hover:text-white/70"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-2 border-t border-white/10 flex gap-2">
        <button
          type="button"
          onClick={() => cmd.scan()}
          className="flex-1 text-xs font-semibold py-1.5 rounded-md bg-sky-500/20 text-sky-200 hover:bg-sky-500/35 border border-sky-500/30"
        >
          Scan
        </button>
        <button
          type="button"
          onClick={() =>
            entries
              .filter((e) => !e.connected && !(e.conflict && e.conflict.length > 1))
              .forEach((e) => cmd.connect(e.sysid))
          }
          className="flex-1 text-xs font-semibold py-1.5 rounded-md bg-white/5 text-white/70 hover:bg-white/10 border border-white/10"
        >
          Connect All
        </button>
      </div>
    </div>
  );
}
