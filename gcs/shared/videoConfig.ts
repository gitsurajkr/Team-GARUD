/**
 * Live camera feeds. Nothing is hardcoded: the operator types each drone's
 * camera URL into the camera panel (see CameraPane), and it is remembered per
 * MAVLink system id. This file only turns what they typed into a feed.
 */

export interface LiveCamera {
  /** RGB MJPEG stream URL. */
  stream: string;
  /** Thermal MJPEG stream URL. Omitted: no thermal feed (THM hidden). */
  thermal?: string;
  /** Detections JSON URL, polled once a second for live counts + FPS. */
  detections?: string;
  label?: string;
}

/**
 * The thermal feed for a camera, or undefined when it has none (the THM
 * button is then hidden). Only ever a URL that was typed in or verified to
 * play at Connect — never a guess, which would show a THM that never loads.
 */
export function thermalUrl(cam: LiveCamera): string | undefined {
  return cam.thermal || undefined;
}

export type ParsedCamera = { ok: true; cam: LiveCamera } | { ok: false; error: string };

type ParsedUrl = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate one pasted feed URL. It is used exactly as typed — cameras serve
 * their video at all sorts of paths (`/`, `/stream`, `/video_feed`…), so no
 * path is guessed. Only a missing `http://` is filled in.
 */
function parseFeedUrl(raw: string, what: string): ParsedUrl {
  let s = raw.trim();
  if (!s) return { ok: false, error: `Enter the ${what} URL` };
  if (/^rtsps?:\/\//i.test(s)) {
    return { ok: false, error: `${what}: RTSP can't play in the GCS — use the camera's HTTP (MJPEG) address` };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`; // bare IP:port
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: `${what}: that isn't a valid URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `${what}: ${u.protocol.replace(":", "").toUpperCase()} isn't supported — use http://` };
  }
  return { ok: true, url: s };
}

/**
 * Turn whatever the operator pasted into a camera entry. URLs are used as
 * typed (only `http://` is added if missing):
 *
 *   192.168.137.75:5000              -> http://192.168.137.75:5000
 *   http://IP:8080/stream            -> as given (+ …/detections)
 *   http://host/anything.mjpg        -> as given, no detections
 *
 * Only a companion-style `…/stream` URL gets the `…/detections` counts. At
 * Connect, findVideoUrl / findThermalTwin (components/video/probeFeed) then
 * find the real feeds.
 *
 * The feed is shown in an <img>, so it must be HTTP(S) MJPEG. RTSP cannot play
 * in a browser at all; say so rather than fail silently.
 */
export function parseCameraUrl(raw: string, thermalRaw = ""): ParsedCamera {
  const rgb = parseFeedUrl(raw, "RGB");
  if (!rgb.ok) return rgb;
  const cam: LiveCamera = { stream: rgb.url };
  const u = new URL(rgb.url);
  const path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/stream")) {
    cam.detections = `${u.origin}${path.slice(0, -"/stream".length)}/detections`;
  }
  if (thermalRaw.trim()) {
    const thm = parseFeedUrl(thermalRaw, "Thermal");
    if (!thm.ok) return thm;
    cam.thermal = thm.url;
  }
  return { ok: true, cam };
}
