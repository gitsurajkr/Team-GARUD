import type { AppConfig } from "./types";
import { ARENA_SIZE_M, DEFAULT_CELL_SIZE_M } from "./grid";

/**
 * Default runtime configuration. Everything here targets a LOCAL link only —
 * no external network (mission brief section 7). Override at runtime via the
 * connect dialog / an env-driven config loader in the main process.
 *
 * MAVLink defaults:
 *   - UDP 14550 is the conventional ground-station listen port for ArduPilot /
 *     PX4 telemetry forwarded over a local Wi-Fi / telemetry radio bridge.
 */
export const DEFAULT_CONFIG: AppConfig = {
  link: {
    transport: "udp",
    host: "0.0.0.0",
    port: 14550,
  },
  // air-unit backend: multi-drone telemetry demuxed from SITL, broadcast
  // over WebSocket. Runs locally alongside the GCS (see ../air-unit).
  airUnitUrl: "ws://127.0.0.1:8765",
   grid: {
    arenaSizeM: ARENA_SIZE_M,
    cellSizeM: DEFAULT_CELL_SIZE_M,
  },
};
