"use client";

import { useGcsBridge } from "../lib/ipc";
import { useAirUnit } from "../lib/airunit";
import { useGcsStore } from "../lib/store";
import { GeoMapPane } from "../components/map/GeoMapPane";
import { Brand } from "../components/hud/Brand";
import { TopHud } from "../components/hud/TopHud";
import { DroneRoster } from "../components/hud/DroneRoster";
import { ControlDock } from "../components/hud/ControlDock";
import { StatusConsole } from "../components/hud/StatusConsole";
import { ZoomControl } from "../components/hud/ZoomControl";
import { BottomBar } from "../components/hud/BottomBar";
import { Tape } from "../components/hud/Tape";
import { ParkedCamera } from "../components/video/ParkedCamera";
import { CameraPane } from "../components/video/CameraPane";

/**
 * AirMouse GCS — full-screen main view (map by default) with a translucent
 * HUD, drone roster, command dock, status console and side tapes. The camera can
 * be swapped into the main view (map drops to the corner) via the expand toggle.
 */
export default function Home() {
  useGcsBridge();
  useAirUnit();

  const drone = useGcsStore((s) =>
    s.selectedSysid !== null ? s.drones[s.selectedSysid] : undefined,
  );
  const cameraExpanded = useGcsStore((s) => s.cameraExpanded);
  const setCameraExpanded = useGcsStore((s) => s.setCameraExpanded);

  return (
    <div className="flex flex-col h-screen w-screen bg-black overflow-hidden select-none">
      <div className="relative flex-1 min-h-0">
        {/* MAIN view: camera when expanded, else the map */}
        {cameraExpanded ? (
          <div className="absolute inset-0 z-0 bg-black">
            <CameraPane />
          </div>
        ) : (
          <GeoMapPane />
        )}

        {/* top-left: brand + drone roster */}
        <div className="absolute top-1 left-1 z-[500] flex flex-col gap-2">
          {/* <Brand /> */}
          <DroneRoster />
        </div>

        {/* top-center: flight-data HUD + side tapes (hidden when camera is expanded) */}
        {!cameraExpanded && (
          <>
            <div className="absolute top-1 left-1/2 -translate-x-1/2 z-[500] pointer-events-none">
              <TopHud />
            </div>
            {/* side tapes — flank the centre HUD rather than the viewport edges,
                so they stay readable together on wide displays */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-[400] pointer-events-none">
              <div className="mx-auto flex max-w-[720px] items-center justify-between px-3">
                <Tape label="SPD" unit="m/s" value={drone?.navigation.groundspeed ?? null} step={2} side="left" />
                <Tape label="ALT" unit="m" value={drone?.navigation.altitude ?? null} step={2} side="right" />
              </div>
            </div>
          </>
        )}

        {/* bottom-left corner: map when camera is expanded, else the camera */}
        <div className="absolute bottom-1 left-3 z-[500]">
          {cameraExpanded ? (
            <div className="w-96 rounded-lg border border-white/10 bg-black/70 backdrop-blur-md shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Map</span>
                <button
                  type="button"
                  onClick={() => setCameraExpanded(false)}
                  className="text-[10px] text-white/40 hover:text-white/80"
                  title="Bring the map back to the main view"
                >
                  ⤢ expand
                </button>
              </div>
              <div className="relative h-52">
                <GeoMapPane />
              </div>
            </div>
          ) : (
            <ParkedCamera />
          )}
        </div>

        {/* bottom-center: command dock */}
        <div className="absolute bottom-1 pl-3.5 left-1/2 -translate-x-1/2 z-[500]">
          <ControlDock />
        </div>

        {/* bottom-right: map zoom stacked directly above the status console */}
        <div className="absolute bottom-1 right-3 z-[500] flex flex-col items-end gap-2">
          <ZoomControl />
          <StatusConsole />
        </div>
      </div>

      <BottomBar />
    </div>
  );
}
