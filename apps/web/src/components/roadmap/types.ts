/**
 * THE ROADMAP COMPONENT — generic on purpose.
 *
 * It knows nothing about trips, offers or agencies. Feed it any ordered list
 * of things with a status and it draws them along a winding road. Rihlati's
 * own mapping (a `PublicMilestone` becomes a `RoadmapItem`) lives in
 * `ProgrammeMap.tsx`, one layer up, so this folder stays reusable.
 */

export type RoadmapStatus = 'completed' | 'current' | 'upcoming';

export interface RoadmapItem {
  id: string;
  title: string;
  description?: string | null;
  status: RoadmapStatus;
  /** Small text under the title — a time, a duration, a version number. */
  badge?: string | null;
  /**
   * Starts a new visual group when it differs from the previous item's.
   * Rihlati passes the day ("Jour 3"); a product roadmap might pass a quarter.
   */
  groupLabel?: string | null;
  /** A single emoji or short glyph shown inside the marker. */
  icon?: string | null;
}

/** A point in the road's 0–100 space on both axes, not pixels. */
export interface RoadPoint {
  x: number;
  y: number;
}

export interface RoadGeometry {
  /** The `d` attribute for the road. */
  d: string;
  /** One point per item, in the same order. Markers sit exactly on these. */
  points: RoadPoint[];
  /** Stops per row, and how many rows that works out to. */
  columns: number;
  rows: number;
  /** Both viewBox axes. Square, because the SVG is stretched to the container. */
  size: number;
}
