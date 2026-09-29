"use client";

import { useEffect, useState } from "react";
import { useGcsStore } from "../../lib/store";

function Clock() {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () =>
      setNow(new Date().toLocaleString("en-GB", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  // suppressHydrationWarning: time is client-only
  return <span suppressHydrationWarning>{now}</span>;
}

function fmt(v: number | null | undefined, digits = 6): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

/** Slim bottom bar: backend status + selected drone position + clock. */
export function BottomBar() {
  const airUnitConnected = useGcsStore((s) => s.airUnitConnected);
  const droneCount = useGcsStore((s) => Object.keys(s.drones).length);
  const drone = useGcsStore((s) => (s.selectedSysid !== null ? s.drones[s.selectedSysid] : undefined));
  const nav = drone?.navigation;

  return (
    <div className="flex items-center justify-between px-4 h-7 bg-black/80 backdrop-blur-md border-t border-white/10 text-[11px]">
      <div className="flex items-center gap-4">
        <span className="text-white/40">GARUD v0.2</span>
        <span className={airUnitConnected ? "text-emerald-400" : "text-red-500"}>
          {airUnitConnected ? "● AirUnit Connected" : "○ AirUnit Disconnected"}
        </span>
        <span className="text-white/40">{droneCount} drone{droneCount === 1 ? "" : "s"}</span>
      </div>
      <div className="flex items-center gap-4 font-mono text-white/60">
        <span>Lat: {fmt(nav?.latitude)}</span>
        <span>Lon: {fmt(nav?.longitude)}</span>
        <span>AMSL: {fmt(nav?.altitude_amsl, 1)} m</span>
        <span className="text-white/40"><Clock /></span>
      </div>
    </div>
  );
}
