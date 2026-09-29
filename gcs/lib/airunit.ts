"use client";

import { useEffect } from "react";
import type { AirUnitFrame } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/config";
import { useGcsStore } from "./store";

/**
 * Live WebSocket link to the air-unit backend.
 *
 * `useAirUnit()` opens the socket, routes every inbound frame into the store,
 * and auto-reconnects. `sendCommand()` sends a command frame back to the
 * backend (arm / takeoff / mission upload / …). Uses the browser-native
 * WebSocket so it works in the Electron renderer and a plain `next dev` tab.
 */

let activeSocket: WebSocket | null = null;

/** Send a command frame to the backend. Returns false if the link is down. */
export function sendCommand(cmd: Record<string, unknown>): boolean {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(cmd));
    return true;
  }
  return false;
}

export function useAirUnit(): void {
  const store = useGcsStore.getState();

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const handle = (frame: AirUnitFrame) => {
      switch (frame.type) {
        case "telemetry":
          store.setDrones(frame.drones);
          break;
        case "drones":
          store.setRoster(frame.drones);
          break;
        case "status":
          store.pushStatus({
            sysid: frame.sysid,
            ts: frame.timestamp,
            severity: frame.severity,
            label: frame.severity_label,
            text: frame.text,
          });
          break;
        case "command_ack":
          store.pushStatus({
            sysid: frame.sysid,
            ts: Date.now() / 1000,
            severity: frame.ok ? 6 : 3,
            label: frame.ok ? "CMD" : "CMD FAIL",
            text: `${frame.command}: ${frame.detail}`,
          });
          break;
        case "mission_progress":
          store.setMissionProgress(frame);
          if (frame.state !== "uploading") {
            store.pushStatus({
              sysid: frame.sysid,
              ts: Date.now() / 1000,
              severity: frame.state === "complete" ? 6 : 3,
              label: "MISSION",
              text: `${frame.state} (${frame.uploaded}/${frame.total}) ${frame.detail}`,
            });
          }
          break;
        case "failsafe":
          store.setFailsafe(frame);
          break;
        case "fence":
          store.setFence(frame);
          store.pushStatus({
            sysid: frame.sysid,
            ts: Date.now() / 1000,
            severity: frame.enabled ? 6 : 4,
            label: "FENCE",
            text: !frame.known
              ? "could not read FENCE_* from the flight controller"
              : frame.enabled
                ? `on — r=${frame.radius ?? "?"} m, alt≤${frame.alt_max ?? "?"} m, action=${frame.action ?? "?"}`
                : "OFF — nothing bounds the search area",
          });
          break;
        case "preflight_result": {
          store.setPreflight(frame);
          const failed = frame.checks.filter((c) => !c.ok);
          store.pushStatus({
            sysid: frame.sysid,
            ts: Date.now() / 1000,
            severity: frame.ok ? 6 : 4,
            label: "PREFLIGHT",
            text: frame.ok
              ? `all ${frame.checks.length} checks passed`
              : `FAILED (${failed.length}/${frame.checks.length})`,
          });
          // One line per failure carrying the *reason* — for the FC prearm check
          // that reason is ArduPilot's own "PreArm: ..." text, which is the whole
          // point of asking it. A bare list of names would throw that away.
          for (const c of failed) {
            store.pushStatus({
              sysid: frame.sysid,
              ts: Date.now() / 1000,
              severity: 4,
              label: "  ↳",
              text: `${c.name}: ${c.detail}`,
            });
          }
          break;
        }
      }
    };

    const connect = (url: string) => {
      if (closed) return;
      ws = new WebSocket(url);
      activeSocket = ws;

      ws.onopen = () => store.setAirUnitConnected(true);
      ws.onmessage = (ev) => {
        try {
          handle(JSON.parse(ev.data as string));
        } catch {
          /* ignore malformed frame */
        }
      };
      const scheduleReconnect = () => {
        store.setAirUnitConnected(false);
        if (activeSocket === ws) activeSocket = null;
        if (closed || retry) return;
        retry = setTimeout(() => {
          retry = null;
          connect(url);
        }, 1500);
      };
      ws.onclose = scheduleReconnect;
      ws.onerror = () => ws?.close();
    };

    const start = (url: string) => connect(url);
    const gcs = window.gcs;
    if (gcs) {
      gcs
        .getConfig()
        .then((cfg) => start(cfg.airUnitUrl ?? DEFAULT_CONFIG.airUnitUrl))
        .catch(() => start(DEFAULT_CONFIG.airUnitUrl));
    } else {
      start(DEFAULT_CONFIG.airUnitUrl);
    }

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      if (activeSocket === ws) activeSocket = null;
      store.setAirUnitConnected(false);
    };
    // store actions are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
