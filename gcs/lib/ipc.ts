"use client";

import { useEffect } from "react";
import { useGcsStore } from "./store";

/**
 * Wires the `window.gcs` event streams into the Zustand store. Call once near
 * the root of the app. Safe to run in a plain browser (no `window.gcs`) — it
 * simply no-ops, which keeps `next dev` in a browser tab from crashing.
 */
export function useGcsBridge(): void {
  const {
    setTelemetry,
    setLink,
    setMission,
    setMap,
    upsertSurvivor,
    pushLog,
  } = useGcsStore.getState();

  useEffect(() => {
    const gcs = typeof window !== "undefined" ? window.gcs : undefined;
    if (!gcs) return;

    const unsubscribers = [
      gcs.onTelemetry(setTelemetry),
      gcs.onLinkStatus(setLink),
      gcs.onMissionStatus(setMission),
      gcs.onMapUpdate(setMap),
      gcs.onSurvivor(upsertSurvivor),
      gcs.onLog(pushLog),
    ];
    return () => unsubscribers.forEach((off) => off());
    // store setters are stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Convenience wrapper around the command surface with a browser fallback. */
export const gcsCommands = {
  connect: () =>
    window.gcs
      ?.getConfig()
      .then((cfg) => window.gcs?.connect(cfg.link)),
  disconnect: () => window.gcs?.disconnect(),
  startMission: () => window.gcs?.startMission(),
  abortMission: () => window.gcs?.abortMission(),
  emergencyStop: () => window.gcs?.emergencyStop(),
};
