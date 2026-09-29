"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mapBounds, mapZoomIn, mapZoomOut } from "../map/GeoMapPane";
import type { TilePrefetchProgress } from "../../shared/types";

/** window.gcs never changes after load, so there is nothing to subscribe to. */
const noSubscribe = () => () => {};

/**
 * Map zoom buttons. Deliberately not a Leaflet control: rendering them here lets
 * them sit in the HUD's bottom-right stack directly above the status console,
 * and move with it when it collapses.
 *
 * Under them, in Electron, "Save area offline" — downloads the map on screen
 * into the tile cache so it still shows at the field with no network.
 */
export function ZoomControl() {
  // window.gcs only exists in Electron; false while prerendering.
  const hasCache = useSyncExternalStore(
    noSubscribe,
    () => !!window.gcs?.tileCache,
    () => false,
  );

  return (
    <div className="relative">
      <div className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/70 backdrop-blur-md shadow-2xl">
        <Btn label="Zoom in" onClick={mapZoomIn}>+</Btn>
        <div className="h-px bg-white/10" />
        <Btn label="Zoom out" onClick={mapZoomOut}>−</Btn>
        {hasCache && (
          <>
            <div className="h-px bg-white/10" />
            <SaveOffline />
          </>
        )}
      </div>
    </div>
  );
}

function SaveOffline() {
  const [progress, setProgress] = useState<TilePrefetchProgress | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = progress !== null && !progress.done;

  useEffect(() => {
    const off = window.gcs?.onTilesProgress((p) => {
      setProgress(p);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      // Leave the final result up long enough to read, then tidy away.
      if (p.done) clearTimer.current = setTimeout(() => setProgress(null), 6000);
    });
    return () => {
      off?.();
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  const onClick = () => {
    if (running) {
      window.gcs?.cancelPrefetch();
      return;
    }
    const b = mapBounds();
    if (!b) return;
    setProgress({ total: 0, saved: 0, cached: 0, failed: 0, done: false });
    window.gcs?.prefetchTiles(b);
  };

  return (
    <>
      <Btn
        label={running ? "Stop saving map" : "Save area offline — download the map on screen (zoom 10–20) for use with no internet"}
        onClick={onClick}
      >
        {running ? (
          <span className="text-[10px]">■</span>
        ) : (
          <svg className="mx-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" />
          </svg>
        )}
      </Btn>
      {progress && (
        <div className="absolute right-full bottom-0 mr-2 whitespace-nowrap rounded-md border border-white/10 bg-black/80 px-2 py-1 text-[11px] text-white/80 shadow-2xl">
          {statusText(progress)}
        </div>
      )}
    </>
  );
}

function statusText(p: TilePrefetchProgress): string {
  if (p.error && p.error !== "Cancelled") return p.error;
  const have = p.saved + p.cached;
  if (!p.done) {
    return p.total ? `Saving map… ${Math.floor((100 * (have + p.failed)) / p.total)}%` : "Saving map…";
  }
  const head = p.error === "Cancelled" ? "Stopped" : "Map saved offline";
  return `${head} — ${have.toLocaleString()} tiles` + (p.failed ? `, ${p.failed.toLocaleString()} failed` : "");
}

function Btn({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-7 w-7 text-base font-semibold leading-none text-white/75 transition-colors hover:bg-white/15 hover:text-white"
    >
      {children}
    </button>
  );
}
