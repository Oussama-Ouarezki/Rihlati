import type { RoadGeometry } from './types';

/**
 * THE ROAD.
 *
 * Four strokes of the same shape, stacked. That is the whole trick — a real
 * road drawn as one closed shape needs an outer and an inner contour offset
 * from a centre line, which is genuine computational geometry. Stacking
 * strokes of decreasing width fakes it exactly, for free, and stays perfectly
 * aligned around the U-turns because there is only ever one curve.
 *
 *   1. shoulder    widest, pale — lifts the road off the page
 *   2. asphalt     dark slate: the stretch still ahead
 *   3. travelled   the same route re-drawn over the stops already done
 *   4. centre line thin, white, dashed, and animated so it creeps forward
 *
 * ## Two things here are load-bearing
 *
 * **`preserveAspectRatio="none"`.** The viewBox is square but the rendered box
 * is "container width × rows of fixed height". Those never match, so the SVG
 * has to stretch. Uniform scaling instead would tie the road's height to its
 * width, and a wide screen would render it over a thousand pixels tall.
 *
 * **`vectorEffect="non-scaling-stroke"` on every path.** That stretch would
 * otherwise squash the strokes — a road thick horizontally and thin
 * vertically. This opts stroke widths out of the transform, so they are honest
 * pixels. It is the reason the first version of this file looked wrong, and
 * removing it will make it look wrong again.
 */
export function RoadPath(props: {
  geometry: RoadGeometry;
  /**
   * The same route, drawn only as far as the traveller has got. Built from a
   * prefix of the same points, so it cannot drift from the road underneath.
   */
  travelledD: string;
  /** Plays the dash animation. False leaves the dashes still. */
  revealed: boolean;
}) {
  const { geometry } = props;

  return (
    <svg
      viewBox={`0 0 ${geometry.size} ${geometry.size}`}
      className="absolute inset-0 h-full w-full overflow-visible"
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      {/* 1 — shoulder */}
      <path
        d={geometry.d}
        fill="none"
        strokeWidth={22}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-slate-200/70"
      />

      {/* 2 — asphalt */}
      <path
        d={geometry.d}
        fill="none"
        strokeWidth={16}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-slate-700"
      />

      {/* 3 — the distance already covered */}
      {props.travelledD ? (
        <path
          d={props.travelledD}
          fill="none"
          strokeWidth={16}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-brand-600"
        />
      ) : null}

      {/* 4 — centre line */}
      <path
        d={geometry.d}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="8 11"
        vectorEffect="non-scaling-stroke"
        className={props.revealed ? 'stroke-white/85 animate-road-dashes' : 'stroke-white/85'}
      />
    </svg>
  );
}
