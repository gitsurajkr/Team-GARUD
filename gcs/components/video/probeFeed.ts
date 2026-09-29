/**
 * Browser-only feed discovery for the camera panel: find the real MJPEG video
 * behind the address the operator typed. Kept out of shared/ because it needs
 * the DOM (Image), which the Electron main-process build does not have.
 */

/**
 * Where camera servers commonly put the MJPEG video, tried in this order when
 * the typed address is not the video itself (often it is a web page around it).
 */
const COMMON_VIDEO_PATHS = [
  "/stream", "/video_feed", "/video", "/mjpeg", "/stream.mjpg", "/mjpg/video.mjpg", "/?action=stream",
];

/** How long one candidate gets to show its first frame. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * True if `url` shows a picture in an <img> — i.e. it is an MJPEG stream or an
 * image, not a web page. Uses an Image rather than fetch() so it works across
 * origins with no CORS headers, exactly like the real feed does.
 */
function probeImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      img.onload = img.onerror = null;
      // Hang up now: small camera servers often serve only one client at a
      // time, and a lingering probe would lock the real feed out.
      img.src = "";
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    // An MJPEG stream never "finishes" loading; a decoded first frame is enough.
    const poll = setInterval(() => { if (img.naturalWidth > 0) finish(true); }, 150);
    img.onload = () => finish(true);
    img.onerror = () => finish(false); // a web page / 404 fails fast
    img.src = url;
  });
}

/**
 * Find the actual video behind what the operator typed: the address as given
 * first, then the usual video paths on the same host. Null when none shows a
 * picture. `onTry` reports each attempt, for a progress line.
 */
export async function findVideoUrl(url: string, onTry?: (candidate: string) => void): Promise<string | null> {
  const origin = new URL(url).origin;
  const candidates = [url];
  for (const p of COMMON_VIDEO_PATHS) {
    const c = origin + p;
    if (!candidates.includes(c)) candidates.push(c);
  }
  for (const c of candidates) {
    onTry?.(c);
    if (await probeImage(c)) return c;
  }
  return null;
}

/**
 * The companion scripts serve thermal at `…/thermal` beside `…/stream`. Check
 * that twin actually plays; undefined when the video is not a `…/stream` URL
 * or the camera has no thermal feed.
 */
export async function findThermalTwin(video: string): Promise<string | undefined> {
  if (!video.includes("/stream")) return undefined;
  const twin = video.replace("/stream", "/thermal");
  return (await probeImage(twin)) ? twin : undefined;
}
