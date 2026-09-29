import { app, net, protocol } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import type { TileBounds, TilePrefetchProgress } from "../shared/types";

/**
 * Offline map-tile cache, the same idea as Mission Planner's gmapcache.
 *
 * The renderer asks for tiles as `gcstile://google/{z}/{x}/{y}` instead of
 * straight from Google. This handler serves a tile from disk when it has it,
 * and otherwise fetches it from Google once and keeps it — so every tile the
 * operator has looked at is still there with no network at the field.
 * `prefetch` downloads a whole area ahead of time (Mission Planner's
 * "Prefetch").
 */

export const TILE_SCHEME = "gcstile";

/** Must be passed to protocol.registerSchemesAsPrivileged before app ready. */
export const TILE_SCHEME_PRIVILEGES = {
  scheme: TILE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

/** Google satellite (the Leaflet layer in GeoMapPane), spread over mt0-mt3. */
const googleUrl = (z: number, x: number, y: number) =>
  `https://mt${(x + y) % 4}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;

/** Deepest zoom Google has real imagery for (GeoMapPane's maxNativeZoom). */
const MAX_PREFETCH_ZOOM = 20;
/** Zoomed out as far as a prefetch goes — enough context to find the area. */
const MIN_PREFETCH_ZOOM = 10;
/** Refuse areas bigger than this (~12 KB a tile → ~600 MB); zoom in instead. */
const MAX_PREFETCH_TILES = 50_000;
/** Parallel downloads during a prefetch. */
const PREFETCH_CONCURRENCY = 6;

const cacheRoot = () => path.join(app.getPath("userData"), "tilecache", "google");
const tilePath = (z: number, x: number, y: number) =>
  path.join(cacheRoot(), String(z), String(x), `${y}.jpg`);

async function readCached(z: number, x: number, y: number): Promise<Buffer | null> {
  try {
    return await fs.readFile(tilePath(z, x, y));
  } catch {
    return null;
  }
}

/** Fetch one tile from Google and write it to the cache. Null on failure. */
async function download(z: number, x: number, y: number): Promise<Buffer | null> {
  try {
    const res = await net.fetch(googleUrl(z, x, y));
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    const file = tilePath(z, x, y);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a half tile that
    // would be served from cache forever.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
    return data;
  } catch {
    return null;
  }
}

/** Serve `gcstile://google/{z}/{x}/{y}` — cache first, then network. */
export function registerTileProtocol(): void {
  protocol.handle(TILE_SCHEME, async (request) => {
    const m = new URL(request.url).pathname.match(/^\/(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return new Response("Bad tile", { status: 400 });
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const data = (await readCached(z, x, y)) ?? (await download(z, x, y));
    if (!data) return new Response("Tile unavailable", { status: 404 });
    return new Response(new Uint8Array(data), { headers: { "content-type": "image/jpeg" } });
  });
}

/** Web-Mercator tile index containing a lat/lon at zoom z. */
function tileXY(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const clampLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const r = (clampLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

function* tilesIn(b: TileBounds, minZ: number, maxZ: number): Generator<[number, number, number]> {
  for (let z = minZ; z <= maxZ; z++) {
    const [x0, y0] = tileXY(b.north, b.west, z);
    const [x1, y1] = tileXY(b.south, b.east, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [z, x, y];
  }
}

function countTiles(b: TileBounds, minZ: number, maxZ: number): number {
  let n = 0;
  for (let z = minZ; z <= maxZ; z++) {
    const [x0, y0] = tileXY(b.north, b.west, z);
    const [x1, y1] = tileXY(b.south, b.east, z);
    n += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return n;
}

let running: { cancelled: boolean } | null = null;

/**
 * Download every tile of `bounds` from MIN_PREFETCH_ZOOM to MAX_PREFETCH_ZOOM,
 * skipping ones already cached. Reports progress through `onProgress`; the
 * last report has `done: true`. One prefetch at a time.
 */
export async function prefetch(
  bounds: TileBounds,
  onProgress: (p: TilePrefetchProgress) => void,
): Promise<TilePrefetchProgress> {
  const total = countTiles(bounds, MIN_PREFETCH_ZOOM, MAX_PREFETCH_ZOOM);
  const p: TilePrefetchProgress = { total, done: false, saved: 0, cached: 0, failed: 0 };
  const finish = (error?: string) => {
    const last = { ...p, done: true, error };
    onProgress(last);
    return last;
  };
  if (running) return finish("A download is already running");
  if (total > MAX_PREFETCH_TILES) {
    return finish(`Area too big (${total.toLocaleString()} tiles) — zoom in and try again`);
  }

  const job = { cancelled: false };
  running = job;
  const it = tilesIn(bounds, MIN_PREFETCH_ZOOM, MAX_PREFETCH_ZOOM);
  let lastReport = 0;
  const worker = async () => {
    for (let next = it.next(); !next.done && !job.cancelled; next = it.next()) {
      const [z, x, y] = next.value;
      try {
        await fs.access(tilePath(z, x, y));
        p.cached++;
      } catch {
        if (await download(z, x, y)) p.saved++;
        else p.failed++;
      }
      // Throttle IPC: a report every 250 ms is plenty for a progress label.
      if (Date.now() - lastReport > 250) {
        lastReport = Date.now();
        onProgress({ ...p });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  } finally {
    running = null;
  }
  return finish(job.cancelled ? "Cancelled" : undefined);
}

export function cancelPrefetch(): void {
  if (running) running.cancelled = true;
}
