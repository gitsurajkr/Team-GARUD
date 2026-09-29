import type { GridCoord, Vec2 } from "./types";

/**
 * Arena geometry from the mission brief (section 3):
 *   - total arena <= 15 m x 15 m
 *   - modular grid structure
 *   - standard room 2 m x 2 m, corridor clear width >= 1 m
 *
 * Survivors must be localised to a "grid coordinate or grid box". We model the
 * arena as a uniform square grid; the box size is configurable but defaults to
 * 1 m to match the minimum corridor width.
 *
 * Convention: arena frame origin (0,0) is the bottom-left corner. Column index
 * increases with +x (labelled A, B, C ...), row index increases with +y
 * (labelled 1, 2, 3 ...). Grid boxes are 0-indexed internally; labels are
 * human-facing.
 */
export const ARENA_SIZE_M = 15;
export const ROOM_SIZE_M = 2;
export const MIN_CORRIDOR_WIDTH_M = 1;
export const DEFAULT_CELL_SIZE_M = 1;
export const MAX_FLIGHT_TIME_SEC = 30 * 60;
export const MAX_SURVIVORS = 6;

/** Number of grid boxes per side for a given cell size. */
export function gridDimension(cellSizeM: number = DEFAULT_CELL_SIZE_M): number {
  return Math.ceil(ARENA_SIZE_M / cellSizeM);
}

/** Convert an arena-frame world position (m) to a grid box coordinate. */
export function worldToGrid(
  pos: Vec2,
  cellSizeM: number = DEFAULT_CELL_SIZE_M,
): GridCoord {
  const max = gridDimension(cellSizeM) - 1;
  const col = clamp(Math.floor(pos.x / cellSizeM), 0, max);
  const row = clamp(Math.floor(pos.y / cellSizeM), 0, max);
  return { col, row };
}

/** World position (m) of the centre of a grid box. */
export function gridCenter(
  coord: GridCoord,
  cellSizeM: number = DEFAULT_CELL_SIZE_M,
): Vec2 {
  return {
    x: (coord.col + 0.5) * cellSizeM,
    y: (coord.row + 0.5) * cellSizeM,
  };
}

/** Human-facing label for a grid box, e.g. { col: 2, row: 4 } -> "C5". */
export function gridLabel(coord: GridCoord): string {
  return `${columnLabel(coord.col)}${coord.row + 1}`;
}

/** Column letters: 0 -> A, 25 -> Z, 26 -> AA, ... */
export function columnLabel(col: number): string {
  let n = col;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
