import { ipcMain, type BrowserWindow } from "electron";
import { EVENT, CMD } from "../../shared/channels";
import { DEFAULT_CONFIG } from "../../shared/config";
import type {
  AppConfig,
  LinkOptions,
  LinkStatus,
  TileBounds,
} from "../../shared/types";
import { cancelPrefetch, prefetch } from "../tiles";
import { MavlinkLink } from "../mavlink/link";
import { TelemetryAggregator } from "../mavlink/telemetry";
import { MissionController } from "../mission/controller";

const HEARTBEAT_TIMEOUT_MS = 3000;

/**
 * Central wiring: constructs the link + telemetry + mission stack, forwards
 * their events to the renderer via `webContents.send`, and handles renderer
 * commands via `ipcMain.handle`. Returns a disposer.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): () => void {
  const link = new MavlinkLink();
  const telemetry = new TelemetryAggregator();
  const mission = new MissionController(link);
  let config: AppConfig = DEFAULT_CONFIG;
  let lastHeartbeat: number | null = null;

  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  const setLinkStatus = (status: Partial<LinkStatus>) => {
    const full: LinkStatus = {
      state: status.state ?? "disconnected",
      endpoint: link.endpoint,
      lastHeartbeatMs:
        lastHeartbeat === null ? null : Date.now() - lastHeartbeat,
      message: status.message,
    };
    send(EVENT.LINK_STATUS, full);
  };

  // --- link/telemetry/mission event fan-out -------------------------------
  link.on("frame", (frame) => telemetry.ingest(frame));
  link.on("open", () => setLinkStatus({ state: "connecting" }));
  link.on("close", () => setLinkStatus({ state: "disconnected" }));
  link.on("error", (err: Error) =>
    setLinkStatus({ state: "error", message: err.message }),
  );

  telemetry.on("telemetry", (snap) => send(EVENT.TELEMETRY, snap));
  telemetry.on("log", (entry) => send(EVENT.LOG, entry));
  telemetry.on("heartbeat", () => {
    lastHeartbeat = Date.now();
    setLinkStatus({ state: "connected" });
  });

  mission.on("status", (status) => send(EVENT.MISSION_STATUS, status));
  mission.on("survivor", (s) => send(EVENT.SURVIVOR, s));

  // Detect a stale link (no heartbeat within timeout).
  const watchdog = setInterval(() => {
    if (lastHeartbeat && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      setLinkStatus({ state: "error", message: "heartbeat lost" });
    }
  }, 1000);

  // --- renderer commands ---------------------------------------------------
  ipcMain.handle(CMD.GET_CONFIG, () => config);

  ipcMain.handle(CMD.LINK_CONNECT, (_e, opts: LinkOptions) => {
    config = { ...config, link: opts };
    lastHeartbeat = null;
    setLinkStatus({ state: "connecting" });
    link.open(opts);
  });

  ipcMain.handle(CMD.LINK_DISCONNECT, () => {
    link.close();
    telemetry.reset();
    setLinkStatus({ state: "disconnected" });
  });

  ipcMain.handle(CMD.ARM, () => mission.start()); // arm is folded into start
  ipcMain.handle(CMD.MISSION_START, () => mission.start());
  ipcMain.handle(CMD.MISSION_ABORT, () => mission.abort());
  ipcMain.handle(CMD.EMERGENCY_STOP, () => mission.emergencyStop());

  ipcMain.handle(CMD.TILES_PREFETCH, (_e, bounds: TileBounds) =>
    prefetch(bounds, (p) => send(EVENT.TILES_PROGRESS, p)),
  );
  ipcMain.handle(CMD.TILES_CANCEL, () => cancelPrefetch());

  // --- disposer ------------------------------------------------------------
  return () => {
    clearInterval(watchdog);
    cancelPrefetch();
    link.close();
    mission.dispose();
    for (const c of Object.values(CMD)) ipcMain.removeHandler(c);
  };
}
