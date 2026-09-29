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
 * Typed contract for the `window.gcs` bridge injected by the Electron preload.
 * Mirrors `GcsApi` in electron/preload.ts (declared here so the renderer never
 * imports from the electron build target).
 */
export interface GcsBridge {
  getConfig(): Promise<AppConfig>;
  connect(opts: LinkOptions): Promise<void>;
  disconnect(): Promise<void>;
  startMission(): Promise<void>;
  abortMission(): Promise<void>;
  emergencyStop(): Promise<void>;

  /** Map tiles are served through the on-disk offline cache (gcstile://). */
  tileCache: true;
  /** Download an area of map for offline use; resolves with the final report. */
  prefetchTiles(bounds: TileBounds): Promise<TilePrefetchProgress>;
  cancelPrefetch(): Promise<void>;
  onTilesProgress(cb: (p: TilePrefetchProgress) => void): () => void;

  onTelemetry(cb: (t: DroneTelemetry) => void): () => void;
  onLinkStatus(cb: (s: LinkStatus) => void): () => void;
  onMissionStatus(cb: (s: MissionStatus) => void): () => void;
  onMapUpdate(cb: (m: OccupancyMap) => void): () => void;
  onSurvivor(cb: (s: Survivor) => void): () => void;
  onLog(cb: (l: LogEntry) => void): () => void;
}

declare global {
  interface Window {
    /** Present only when running inside Electron; undefined in a plain browser. */
    gcs?: GcsBridge;
  }
}

export {};
