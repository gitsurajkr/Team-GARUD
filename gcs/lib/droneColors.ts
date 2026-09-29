/** Stable per-drone accent colors, indexed by system id (sysid 1 = first). */
const PALETTE = [
  "#22c55e", // green
  "#38bdf8", // sky
  "#f59e0b", // amber
  "#a78bfa", // violet
  "#f472b6", // pink
  "#f87171", // red
];

/**
 * Color for a drone. Keyed on the sysid alone — not its position in some list —
 * so the roster (every drone heard) and the map (only Connected ones) always
 * agree, and a drone keeps its colour as others connect and disconnect.
 */
export function droneColor(sysid: number): string {
  const i = Math.max(0, sysid - 1);
  if (i < PALETTE.length) return PALETTE[i];
  // Past the palette, step the hue by the golden angle so a 7th, 8th, … drone
  // gets a colour of its own instead of repeating the 1st on the map.
  const hue = (i * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 80%, 62%)`;
}
