/**
 * Canonical IPC channel names shared by the Electron main process and the
 * preload bridge. Grouped by direction:
 *
 *  - `EVENT.*`  : main -> renderer, pushed via webContents.send (one-way stream)
 *  - `CMD.*`    : renderer -> main, request/response via ipcRenderer.invoke
 */

/** Streamed events pushed from main to the renderer. */
export const EVENT = {
  TELEMETRY: "event:telemetry",
  LINK_STATUS: "event:link-status",
  MISSION_STATUS: "event:mission-status",
  MAP_UPDATE: "event:map-update",
  SURVIVOR: "event:survivor",
  LOG: "event:log",
  TILES_PROGRESS: "event:tiles-progress",
} as const;

/** Commands invoked by the renderer and handled in main. */
export const CMD = {
  GET_CONFIG: "cmd:get-config",
  LINK_CONNECT: "cmd:link-connect",
  LINK_DISCONNECT: "cmd:link-disconnect",
  ARM: "cmd:arm",
  MISSION_START: "cmd:mission-start",
  MISSION_ABORT: "cmd:mission-abort",
  EMERGENCY_STOP: "cmd:emergency-stop",
  TILES_PREFETCH: "cmd:tiles-prefetch",
  TILES_CANCEL: "cmd:tiles-cancel",
} as const;

export type EventChannel = (typeof EVENT)[keyof typeof EVENT];
export type CommandChannel = (typeof CMD)[keyof typeof CMD];
