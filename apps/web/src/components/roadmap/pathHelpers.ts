import type { RoadGeometry, RoadPoint } from './types';

/**
 * ROAD GEOMETRY — where the curve comes from.
 *
 * The obvious way to place markers on an SVG path is to draw the path, then
 * ask the browser where its points are with `getTotalLength()` /
 * `getPointAtLength()`. We do the opposite: **choose the points first, then
 * build a curve through them.**
 *
 * That inversion buys three things, and they are the reason this file exists:
 *
 *   1. Marker positions are exact numbers we already have, so nothing has to
 *      be measured after paint — no refs, no layout effect, no markers
 *      snapping into place on slow phones.
 *   2. It renders correctly on the server, because `getPointAtLength` needs a
 *      real DOM and could only ever run after hydration.
 *   3. The travelled stretch is just the same builder run over the first N
 *      points, so "how far along are we" needs no path-length arithmetic at
 *      all.
 *
 * ## The shape: a horizontal serpentine
 *
 * The road runs across, turns at the edge, and comes back — like a snake, or
 * like the way anyone draws a route on a napkin. The first version ran
 * vertically, one stop per row, and the complaint was fair: a nine-step
 * programme was nearly a thousand pixels tall. Packing three or four stops
 * into each row cuts that by two thirds and uses the width that was sitting
 * empty on every screen.
 *
 * ## Everything is a fraction of the box, not a pixel
 *
 * Coordinates run 0–100 on both axes and the SVG is stretched to whatever the
 * container is. Markers are positioned in percentages of the same container,
 * so the two agree by construction at any size — no shared pixel constant to
 * drift apart.
 */

/** Both axes run 0–100. The SVG stretches; see RoadPath on why that is safe. */
export const ROAD_VIEW_SIZE = 100;

/**
 * Horizontal inset for the stops, as a fraction of the width. The U-turns
 * bulge past the outermost stop, and this is the room they bulge into.
 */
const INSET_X = 0.09;

/** How far a stop sits down its row. Above the middle — the label goes below. */
const NODE_Y_IN_ROW = 0.4;

/**
 * How far a turn bulges past the last stop of a row, as a fraction of the
 * width. This is the "roundness" of the corner: at 0 the road would fold back
 * on itself in a crease, and much beyond this it stops looking like a road and
 * starts looking like a paperclip.
 */
const TURN_BULGE = 0.13;

/**
 * Where each stop sits, in a boustrophedon: left to right, then right to left,
 * and so on. Odd rows are reversed so the route is continuous — which is the
 * whole point of a serpentine, and the reason the numbering never jumps.
 */
export function serpentinePoints(count: number, columns: number, rtl: boolean): RoadPoint[] {
  const rows = Math.max(Math.ceil(count / columns), 1);
  const usableWidth = ROAD_VIEW_SIZE * (1 - INSET_X * 2);
  const rowHeight = ROAD_VIEW_SIZE / rows;

  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const withinRow = index % columns;
    // Every other row runs backwards. Without this the road would have to jump
    // from the right edge back to the left, which is a page break, not a road.
    const column = row % 2 === 0 ? withinRow : columns - 1 - withinRow;

    const fraction = columns === 1 ? 0.5 : (column + 0.5) / columns;
    const x = ROAD_VIEW_SIZE * INSET_X + fraction * usableWidth;

    return {
      // Arabic reads right to left, so the road has to start on the right and
      // run the other way. Mirroring x is the whole of RTL support here.
      x: rtl ? ROAD_VIEW_SIZE - x : x,
      y: row * rowHeight + rowHeight * NODE_Y_IN_ROW,
    };
  });
}

/**
 * The `d` for a road through the given serpentine points.
 *
 * Straight runs along a row, and a cubic U-turn wherever the row changes. The
 * turn's control points sit directly outboard of the two stops it joins, which
 * is what makes it a clean half-round rather than a diagonal shortcut.
 *
 * Pass a prefix of the points to draw only the stretch already travelled — the
 * route is identical because it is the same function over the same points.
 */
export function serpentinePath(points: RoadPoint[]): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  if (points.length === 1) return `M ${r(first.x)} ${r(first.y)}`;

  let d = `M ${r(first.x)} ${r(first.y)}`;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]!;
    const point = points[i]!;

    if (point.y === previous.y) {
      d += ` L ${r(point.x)} ${r(point.y)}`;
      continue;
    }

    // Row change. Bulge outwards on whichever edge we are already at, so the
    // turn leaves the row the same way it re-enters the next one.
    const outward = previous.x > ROAD_VIEW_SIZE / 2 ? 1 : -1;
    const bulge = outward * TURN_BULGE * ROAD_VIEW_SIZE;

    d +=
      ` C ${r(previous.x + bulge)} ${r(previous.y)},` +
      ` ${r(previous.x + bulge)} ${r(point.y)},` +
      ` ${r(point.x)} ${r(point.y)}`;
  }

  return d;
}

export function buildRoad(
  count: number,
  options: { columns: number; rtl: boolean },
): RoadGeometry {
  const points = serpentinePoints(count, options.columns, options.rtl);

  return {
    d: serpentinePath(points),
    points,
    columns: options.columns,
    rows: Math.max(Math.ceil(count / options.columns), 1),
    size: ROAD_VIEW_SIZE,
  };
}

/** Two decimals is plenty at this scale and keeps the `d` string readable. */
function r(value: number): number {
  return Math.round(value * 100) / 100;
}
