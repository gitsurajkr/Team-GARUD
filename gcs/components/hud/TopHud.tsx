"use client";

import { useGcsStore } from "../../lib/store";
import { distanceHome, noteHome } from "../../lib/geo";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { HeadingCompass } from "./HeadingCompass";
import type { DroneSnapshot } from "../../shared/types";

const GPS_FIX = ["No GPS", "No Fix", "2D", "3D", "DGPS", "RTK Flt", "RTK Fix"];

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function Metric({
  label,
  value,
  unit,
  warn,
}: {
  label: string;
  value: string;
  unit?: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-[92px]">
      <div className="text-[9px] uppercase tracking-wider text-white/40 leading-none">{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className={`font-mono text-sm font-semibold tabular-nums ${warn ? "text-amber-400" : "text-white/95"}`}>
          {value}
        </span>
        {unit && <span className="text-[9px] text-white/40">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * The FC's own health verdict, condensed to one chip. Ordered worst-first: a
 * fired failsafe outranks an unhealthy sensor, which outranks a prearm block.
 * "—" means the flight controller has not told us yet, which is not the same
 * as healthy, so it stays grey rather than green.
 */
function FailsafeStat({ drone }: { drone: DroneSnapshot }) {
  const h = drone.health;
  if (!h) return <StatusStat label="FS" value="—" tone="text-white/30" />;

  if (h.failsafe) {
    return <StatusStat label="FS" value={h.system_status} tone="text-red-400 animate-pulse" />;
  }
  if (h.unhealthy.length > 0) {
    return <StatusStat label="FS" value={h.unhealthy.join(",")} tone="text-amber-400" />;
  }
  if (h.prearm_ok === false) {
    return <StatusStat label="FS" value="PREARM" tone="text-amber-400" />;
  }
  if (h.prearm_ok === null) {
    return <StatusStat label="FS" value="—" tone="text-white/30" />;
  }
  return <StatusStat label="FS" value="clear" tone="text-emerald-400" />;
}

function StatusStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-white/35">{label}</span>
      <span className={`text-xs font-bold font-mono ${tone ?? "text-white/90"}`}>{value}</span>
    </div>
  );
}

export function TopHud() {
  const sysid = useGcsStore((s) => s.selectedSysid);
  const drone: DroneSnapshot | undefined = useGcsStore((s) =>
    s.selectedSysid !== null ? s.drones[s.selectedSysid] : undefined,
  );

  if (sysid === null || !drone) {
    return (
      <div className="pointer-events-none rounded-xl border border-white/10 bg-black/55 px-8 py-4 backdrop-blur-md">
        <span className="text-xs text-white/40">No drone selected — Scan &amp; Connect to begin</span>
      </div>
    );
  }

  const { navigation: nav, attitude: att, gps, battery: bat } = drone;
  noteHome(drone.sysid, nav.latitude, nav.longitude);
  const dHome = distanceHome(drone.sysid, nav.latitude, nav.longitude);
  const fix = gps.fixtype ?? -1;
  const batt = bat.level;
  const battTone = batt === null || batt === undefined ? "text-white/40" : batt < 25 ? "text-red-400" : "text-white/90";

  return (
    <div className="pointer-events-none rounded-sm bg-black/55 ">
      {/* status row (replaces the old top header bar) */}
      <div className="flex items-center gap-5 px-4 py-1.5 border-b border-white/10">
        <StatusStat label="Drone" value={`SYS ${drone.sysid}`} />
        <StatusStat label="Batt" value={batt !== null && batt !== undefined ? `${batt}%` : "—"} tone={battTone} />
        <StatusStat label="Mode" value={drone.mode} tone="text-sky-300" />
        <StatusStat label="Armed" value={drone.armed ? "ARMED" : "SAFE"} tone={drone.armed ? "text-amber-400" : "text-white/60"} />
        <StatusStat label="Link" value={drone.connected ? "OK" : "STALE"} tone={drone.connected ? "text-emerald-400" : "text-red-400"} />
        <FailsafeStat drone={drone} />
      </div>

      {/* data + instruments */}
      <div className="flex items-center gap-4 px-4 py-2.5">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Metric label="HDOP" value={fmt(gps.hdop, 2)} warn={(gps.hdop ?? 0) > 1.5} />
          <Metric label="Batt Curr" value={fmt(bat.current, 2)} unit="A" />
          <Metric label="Batt Volt" value={fmt(bat.voltage, 2)} unit="V" />
          <Metric label="Dist Home" value={fmt(dHome, 1)} unit="m" />
          <Metric label="Sats" value={gps.satellites?.toString() ?? "—"} warn={(gps.satellites ?? 0) < 6} />
          <Metric label="GPS Fix" value={fix >= 0 ? (GPS_FIX[fix] ?? `#${fix}`) : "—"} warn={fix < 3} />
        </div>

        <div className="flex items-center gap-2 px-1">
          <AttitudeIndicator roll={att.roll} pitch={att.pitch} size={116} />
          <HeadingCompass heading={nav.heading} size={116} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Metric label="V Speed" value={fmt(nav.climbrate, 2)} unit="m/s" />
          <Metric label="H Speed" value={fmt(nav.groundspeed, 2)} unit="m/s" />
          <Metric label="Alt AGL" value={fmt(nav.altitude, 1)} unit="m" />
          <Metric label="Alt MSL" value={fmt(nav.altitude_amsl, 1)} unit="m" />
          <Metric label="Latitude" value={fmt(nav.latitude, 6)} />
          <Metric label="Longitude" value={fmt(nav.longitude, 6)} />
        </div>
      </div>
    </div>
  );
}
