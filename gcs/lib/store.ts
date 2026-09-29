"use client";

import { create } from "zustand";
import type {
  DroneRosterEntry,
  DroneSnapshot,
  DroneTelemetry,
  LinkStatus,
  LogEntry,
  MissionProgress,
  FailsafeConfig,
  FenceState,
  MissionStatus,
  OccupancyMap,
  PreflightResult,
  StatusLine,
  Survivor,
  Waypoint,
} from "../shared/types";

const MAX_LOGS = 200;
const MAX_STATUS = 300;

/** Where a Reposition click sent a drone — drawn on the map as the fly-to target. */
export interface GuidedTarget {
  lat: number;
  lon: number;
  alt: number;
  /** Date.now() when it was sent. */
  at: number;
}

/**
 * How long a new target is shown before the drone must be in GUIDED for it to
 * stay. ArduCopter only accepts DO_REPOSITION in GUIDED, and the mode arrives
 * with telemetry a moment after the click — so the grace covers that lag, and
 * a target the FC ignored (still in LOITER, AUTO…) disappears on its own.
 */
const GUIDED_TARGET_GRACE_MS = 3000;

const CAMERA_URLS_KEY = "gcs.cameraUrls";

/** Camera URLs typed in for one drone. `thermal` blank = automatic. */
export interface CameraUrls {
  rgb: string;
  thermal?: string;
}

// localStorage can throw (blocked storage, private mode) — a camera URL that
// is not remembered must never take the GCS down with it.
function loadCameraUrls(): Record<number, CameraUrls> {
  try {
    const raw = window.localStorage.getItem(CAMERA_URLS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: Record<number, CameraUrls> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (!Number.isFinite(Number(k))) continue;
        // A bare string is the older, RGB-only format.
        if (typeof v === "string") out[Number(k)] = { rgb: v };
        else if (v && typeof v === "object" && typeof (v as CameraUrls).rgb === "string") {
          const t = (v as CameraUrls).thermal;
          out[Number(k)] = { rgb: (v as CameraUrls).rgb, ...(typeof t === "string" && t ? { thermal: t } : {}) };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveCameraUrls(urls: Record<number, CameraUrls>): void {
  try {
    window.localStorage.setItem(CAMERA_URLS_KEY, JSON.stringify(urls));
  } catch {
    /* not remembered, still used for this session */
  }
}

/** A Reposition click awaiting confirmation. */
export interface PendingFlyTo {
  sysid: number;
  lat: number;
  lon: number;
}

interface GcsState {
  telemetry: DroneTelemetry | null;
  link: LinkStatus;
  mission: MissionStatus | null;
  map: OccupancyMap | null;
  survivors: Survivor[];
  logs: LogEntry[];

  // --- air-unit multi-drone state ---
  drones: Record<number, DroneSnapshot>;
  roster: DroneRosterEntry[];
  selectedSysid: number | null;
  airUnitConnected: boolean;

  // --- command workflow ---
  statusLog: StatusLine[];
  preflight: Record<number, PreflightResult>;
  /** Geofence as read back off each flight controller. */
  fence: Record<number, FenceState>;
  /** Failsafe params as read back off each flight controller. */
  failsafe: Record<number, FailsafeConfig>;
  missionProgress: Record<number, MissionProgress>;
  /** Waypoints being drawn on the map for the selected drone, keyed by sysid. */
  draftWaypoints: Record<number, Waypoint[]>;
  /** Altitude given to waypoints as they are drawn on the map. */
  draftAlt: number;
  /** When true, clicking the map appends a waypoint. */
  waypointMode: boolean;
  /** When true, clicking the map repositions the selected drone (fly-to). */
  repositionMode: boolean;
  /** Current fly-to target per drone, until it leaves GUIDED. */
  guidedTarget: Record<number, GuidedTarget>;
  /** A clicked fly-to spot waiting for the operator to confirm it. Nothing is
   *  sent to the aircraft until they do. */
  pendingFlyTo: PendingFlyTo | null;
  /** When true, the camera fills the main view and the map drops to the corner. */
  cameraExpanded: boolean;
  /** Camera URLs typed in by the operator, per sysid. The only camera source. */
  cameraUrls: Record<number, CameraUrls>;

  setTelemetry: (t: DroneTelemetry) => void;
  setLink: (s: LinkStatus) => void;
  setMission: (s: MissionStatus) => void;
  setMap: (m: OccupancyMap) => void;
  setDrones: (list: DroneSnapshot[]) => void;
  setRoster: (list: DroneRosterEntry[]) => void;
  selectDrone: (sysid: number) => void;
  setAirUnitConnected: (connected: boolean) => void;
  upsertSurvivor: (s: Survivor) => void;
  pushLog: (l: LogEntry) => void;

  pushStatus: (line: Omit<StatusLine, "id">) => void;
  setPreflight: (r: PreflightResult) => void;
  setFence: (f: FenceState) => void;
  setFailsafe: (f: FailsafeConfig) => void;
  setMissionProgress: (p: MissionProgress) => void;
  setDraftAlt: (alt: number) => void;
  setWaypointMode: (on: boolean) => void;
  setRepositionMode: (on: boolean) => void;
  setGuidedTarget: (sysid: number, target: GuidedTarget) => void;
  setPendingFlyTo: (p: PendingFlyTo | null) => void;
  setCameraExpanded: (on: boolean) => void;
  /** Set (or with null, forget) a drone's camera URL. Remembered across restarts. */
  setCameraUrl: (sysid: number, urls: CameraUrls | null) => void;
  /** Load remembered camera URLs. Client-only, after mount (see CameraPane). */
  hydrateCameraUrls: () => void;
  addDraftWaypoint: (sysid: number, wp: Waypoint) => void;
  /** Edit one drawn waypoint in place (altitude, hold time…). */
  updateDraftWaypoint: (sysid: number, index: number, patch: Partial<Waypoint>) => void;
  popDraftWaypoint: (sysid: number) => void;
  clearDraftWaypoints: (sysid: number) => void;
}

const initialLink: LinkStatus = {
  state: "disconnected",
  lastHeartbeatMs: null,
};

let statusCounterSeed = 0;
const nextStatusId = () => (statusCounterSeed += 1);

export const useGcsStore = create<GcsState>((set) => ({
  telemetry: null,
  link: initialLink,
  mission: null,
  map: null,
  survivors: [],
  logs: [],
  drones: {},
  roster: [],
  selectedSysid: null,
  airUnitConnected: false,
  statusLog: [],
  preflight: {},
  fence: {},
  failsafe: {},
  missionProgress: {},
  draftWaypoints: {},
  draftAlt: 15,
  waypointMode: false,
  repositionMode: false,
  guidedTarget: {},
  pendingFlyTo: null,
  cameraExpanded: false,
  cameraUrls: {},

  setTelemetry: (telemetry) => set({ telemetry }),
  setLink: (link) => set({ link }),
  setMission: (mission) => set({ mission }),
  setMap: (map) => set({ map }),
  setDrones: (list) =>
    set((state) => {
      const drones: Record<number, DroneSnapshot> = {};
      for (const d of list) drones[d.sysid] = d;
      // Telemetry only carries Connected drones, so a selected drone that is in
      // the roster but not connected yet must keep the selection — otherwise
      // clicking it (to press Connect) snaps straight back to another drone.
      const sel = state.selectedSysid;
      const selectedSysid =
        sel !== null && (drones[sel] || state.roster.some((r) => r.sysid === sel))
          ? sel
          : list.length > 0
            ? Math.min(...list.map((d) => d.sysid))
            : state.selectedSysid;
      // A fly-to target lasts while its drone is in GUIDED. Once it switches
      // away (AUTO, RTL, LAND…) — or never got there — the target is stale.
      const now = Date.now();
      let guidedTarget = state.guidedTarget;
      for (const [k, t] of Object.entries(state.guidedTarget)) {
        const d = drones[Number(k)];
        if (now - t.at > GUIDED_TARGET_GRACE_MS && (!d || d.mode !== "GUIDED")) {
          if (guidedTarget === state.guidedTarget) guidedTarget = { ...state.guidedTarget };
          delete guidedTarget[Number(k)];
        }
      }
      return { drones, selectedSysid, guidedTarget };
    }),
  setRoster: (roster) =>
    set((state) => {
      const selectedSysid =
        state.selectedSysid !== null
          ? state.selectedSysid
          : roster.length > 0
            ? Math.min(...roster.map((r) => r.sysid))
            : null;
      return { roster, selectedSysid };
    }),
  // A pending fly-to belongs to the drone it was clicked for — switching drones
  // must never leave a confirm button that sends the new one there.
  selectDrone: (selectedSysid) => set({ selectedSysid, pendingFlyTo: null }),
  setAirUnitConnected: (airUnitConnected) => set({ airUnitConnected }),
  upsertSurvivor: (s) =>
    set((state) => {
      const idx = state.survivors.findIndex((x) => x.id === s.id);
      if (idx === -1) return { survivors: [...state.survivors, s] };
      const next = state.survivors.slice();
      next[idx] = s;
      return { survivors: next };
    }),
  pushLog: (l) =>
    set((state) => ({ logs: [...state.logs.slice(-(MAX_LOGS - 1)), l] })),

  pushStatus: (line) =>
    set((state) => ({
      statusLog: [
        ...state.statusLog.slice(-(MAX_STATUS - 1)),
        { ...line, id: nextStatusId() },
      ],
    })),
  setPreflight: (r) =>
    set((state) => ({ preflight: { ...state.preflight, [r.sysid]: r } })),
  setFence: (f) => set((state) => ({ fence: { ...state.fence, [f.sysid]: f } })),
  setFailsafe: (f) => set((state) => ({ failsafe: { ...state.failsafe, [f.sysid]: f } })),
  setMissionProgress: (p) =>
    set((state) => ({
      missionProgress: { ...state.missionProgress, [p.sysid]: p },
    })),
  setDraftAlt: (draftAlt) => set({ draftAlt }),
  // Waypoint-draw and reposition are mutually exclusive map modes.
  // Any mode change drops an unconfirmed fly-to — including the dock turning
  // Reposition off when the link drops.
  setWaypointMode: (waypointMode) =>
    set(waypointMode ? { waypointMode, repositionMode: false, pendingFlyTo: null } : { waypointMode }),
  setRepositionMode: (repositionMode) =>
    set(repositionMode
      ? { repositionMode, waypointMode: false, pendingFlyTo: null }
      : { repositionMode, pendingFlyTo: null }),
  setGuidedTarget: (sysid, target) =>
    set((state) => ({ guidedTarget: { ...state.guidedTarget, [sysid]: target } })),
  setPendingFlyTo: (pendingFlyTo) => set({ pendingFlyTo }),
  setCameraExpanded: (cameraExpanded) => set({ cameraExpanded }),
  setCameraUrl: (sysid, urls) =>
    set((state) => {
      const cameraUrls = { ...state.cameraUrls };
      if (urls) cameraUrls[sysid] = urls;
      else delete cameraUrls[sysid];
      saveCameraUrls(cameraUrls);
      return { cameraUrls };
    }),
  hydrateCameraUrls: () => set({ cameraUrls: loadCameraUrls() }),
  addDraftWaypoint: (sysid, wp) =>
    set((state) => ({
      draftWaypoints: {
        ...state.draftWaypoints,
        [sysid]: [...(state.draftWaypoints[sysid] ?? []), wp],
      },
    })),
  updateDraftWaypoint: (sysid, index, patch) =>
    set((state) => {
      const list = state.draftWaypoints[sysid] ?? [];
      if (index < 0 || index >= list.length) return {};
      const next = list.slice();
      next[index] = { ...next[index], ...patch };
      return { draftWaypoints: { ...state.draftWaypoints, [sysid]: next } };
    }),
  popDraftWaypoint: (sysid) =>
    set((state) => ({
      draftWaypoints: {
        ...state.draftWaypoints,
        [sysid]: (state.draftWaypoints[sysid] ?? []).slice(0, -1),
      },
    })),
  clearDraftWaypoints: (sysid) =>
    set((state) => ({
      draftWaypoints: { ...state.draftWaypoints, [sysid]: [] },
    })),
}));
