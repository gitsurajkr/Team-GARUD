/** Haversine distance in metres between two lat/lon points. */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Home position per drone — captured the first time a drone reports a valid
 * fix, so the HUD can show distance-to-home without the backend tracking it.
 */
const homes = new Map<number, { lat: number; lon: number }>();

export function noteHome(sysid: number, lat: number | null, lon: number | null): void {
  if (lat === null || lon === null) return;
  if (!homes.has(sysid)) homes.set(sysid, { lat, lon });
}

export function distanceHome(
  sysid: number,
  lat: number | null,
  lon: number | null,
): number | null {
  const h = homes.get(sysid);
  if (!h || lat === null || lon === null) return null;
  return haversineM(h.lat, h.lon, lat, lon);
}
