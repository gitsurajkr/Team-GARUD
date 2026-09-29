"use client";

import { useEffect, useRef, useState } from "react";
import { useGcsStore } from "../../lib/store";
import type { StatusLine } from "../../shared/types";

function sevColor(sev: number): string {
  if (sev <= 3) return "text-red-400";
  if (sev === 4) return "text-amber-400";
  if (sev === 5) return "text-sky-300";
  if (sev === 6) return "text-white/75";
  return "text-white/40";
}

function hhmmss(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

/** Bottom-right ArduPilot status / command console (see reference GCS). */
export function StatusConsole() {
  const statusLog = useGcsStore((s) => s.statusLog);
  const selectedSysid = useGcsStore((s) => s.selectedSysid);
  // Default to the selected drone only — keeps each drone's messages separate.
  const [onlySelected, setOnlySelected] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the view is parked at the tail. Only then do we follow new messages —
  // otherwise arriving traffic would yank the operator off the history they're reading.
  const pinnedRef = useRef(true);

  const lines: StatusLine[] = onlySelected
    ? statusLog.filter((l) => l.sysid === selectedSysid)
    : statusLog;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="w-[370px] max-w-[38vw] rounded-sm bg-black/70 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/70">
            Status Messages
          </span>
          <span className="text-[10px] text-white/30">{lines.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOnlySelected((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              onlySelected
                ? "border-sky-500/40 bg-sky-500/20 text-sky-200"
                : "border-white/10 text-white/50 hover:text-white/80"
            }`}
            title="Toggle: selected drone only / all drones"
          >
            {onlySelected ? `SYS ${selectedSysid ?? "—"} only` : "All drones"}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="text-[10px] text-white/40 hover:text-white/70"
          >
            {collapsed ? "▴" : "▾"}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div
          ref={bodyRef}
          onScroll={handleScroll}
          className="hud-scroll h-40 overflow-y-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed"
        >
          {lines.length === 0 && (
            <div className="text-white/25 py-2">No messages yet.</div>
          )}
          {lines.map((l) => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap">
              <span className="text-white/30 shrink-0">{hhmmss(l.ts)}</span>
              <span className="text-white/40 shrink-0">S{l.sysid}</span>
              <span className={`shrink-0 font-semibold ${sevColor(l.severity)}`}>
                {l.label}
              </span>
              <span className={sevColor(l.severity)}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
