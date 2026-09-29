import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EVENT, CMD } from "../shared/channels";
import type {
  AppConfig,
  DroneTelemetry,
  LinkOptions,
  LinkStatus,
  LogEntry,
  MissionStatus,
  OccupancyMap,
  Survivor,
  TileBounds,
  TilePrefetchProgress,
} from "../shared/types";

/**
 * The single, typed surface exposed to the renderer as `window.gcs`. The
 * renderer has no direct Node/Electron access (contextIsolation + no
 * nodeIntegration); everything flows through these functions.
 *
 * Each `on*` subscriber returns an unsubscribe function.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // commands (renderer -> main)
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(CMD.GET_CONFIG),
  connect: (opts: LinkOptions): Promise<void> =>
    ipcRenderer.invoke(CMD.LINK_CONNECT, opts),
  disconnect: (): Promise<void> => ipcRenderer.invoke(CMD.LINK_DISCONNECT),
  startMission: (): Promise<void> => ipcRenderer.invoke(CMD.MISSION_START),
  abortMission: (): Promise<void> => ipcRenderer.invoke(CMD.MISSION_ABORT),
  emergencyStop: (): Promise<void> => ipcRenderer.invoke(CMD.EMERGENCY_STOP),

  // offline map tiles
  /** True: map tiles go through the on-disk cache (gcstile://). */
  tileCache: true as const,
  prefetchTiles: (bounds: TileBounds): Promise<TilePrefetchProgress> =>
    ipcRenderer.invoke(CMD.TILES_PREFETCH, bounds),
  cancelPrefetch: (): Promise<void> => ipcRenderer.invoke(CMD.TILES_CANCEL),
  onTilesProgress: (cb: (p: TilePrefetchProgress) => void) =>
    subscribe<TilePrefetchProgress>(EVENT.TILES_PROGRESS, cb),

  // streamed events (main -> renderer)
  onTelemetry: (cb: (t: DroneTelemetry) => void) =>
    subscribe<DroneTelemetry>(EVENT.TELEMETRY, cb),
  onLinkStatus: (cb: (s: LinkStatus) => void) =>
    subscribe<LinkStatus>(EVENT.LINK_STATUS, cb),
  onMissionStatus: (cb: (s: MissionStatus) => void) =>
    subscribe<MissionStatus>(EVENT.MISSION_STATUS, cb),
  onMapUpdate: (cb: (m: OccupancyMap) => void) =>
    subscribe<OccupancyMap>(EVENT.MAP_UPDATE, cb),
  onSurvivor: (cb: (s: Survivor) => void) =>
    subscribe<Survivor>(EVENT.SURVIVOR, cb),
  onLog: (cb: (l: LogEntry) => void) => subscribe<LogEntry>(EVENT.LOG, cb),
};

export type GcsApi = typeof api;

contextBridge.exposeInMainWorld("gcs", api);
