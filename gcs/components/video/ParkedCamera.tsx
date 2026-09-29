"use client";

import { useState } from "react";
import { useGcsStore } from "../../lib/store";
import { CameraPane } from "./CameraPane";

/**
 * Small corner camera panel (shown when the map owns the main view). "Expand"
 * swaps it into the main view (the map drops to the corner) via the store flag.
 */
export function ParkedCamera() {
  const [open, setOpen] = useState(true);
  const setCameraExpanded = useGcsStore((s) => s.setCameraExpanded);

  return (
    <div className="w-96 rounded-lg border border-white/10 bg-black/70 backdrop-blur-md shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
          Camera Feed
        </span>
        <div className="flex items-center gap-2 text-[10px] text-white/40">
          <button type="button" onClick={() => setCameraExpanded(true)} className="hover:text-white/80" title="Show camera in the main view">
            ⤢ expand
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)} className="hover:text-white/80">
            {open ? "▾ hide" : "▸ show"}
          </button>
        </div>
      </div>
      <div className={open ? "h-52" : "h-0"} style={{ overflow: "hidden" }}>
        <div className="h-52 relative">
          <CameraPane />
        </div>
      </div>
    </div>
  );
}
