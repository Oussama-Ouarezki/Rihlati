'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { buildRoad } from './pathHelpers';
import type { RoadGeometry } from './types';

/**
 * How many stops fit across one row, and how tall a row is in real pixels.
 *
 * Two on a phone: a stop is a 40px marker plus a two-line label, and three of
 * those across 360px leaves each one about 110px, which is not enough for
 * "Départ vers l'aéroport" to be legible.
 *
 * The row height is a pixel number rather than a ratio on purpose — it is what
 * keeps the whole thing compact. Nine stops come out around 560px on a phone
 * and 260px on a desktop, instead of the ~900px the first vertical version
 * took at every width.
 */
const NARROW = { columns: 2, rowHeightPx: 124 };
const WIDE = { columns: 4, rowHeightPx: 128 };

/**
 * Matches a media query without breaking server rendering.
 *
 * `useSyncExternalStore` takes a separate server snapshot, which is the whole
 * point: the server has no viewport, so it renders the narrow layout and the
 * client widens it on hydration. Assuming desktop instead would send phones a
 * layout built for a screen they do not have.
 */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false, // server: assume the narrow layout
  );
}

export function useRoadPath(
  count: number,
  rtl: boolean,
): { geometry: RoadGeometry; isWide: boolean; heightPx: number } {
  const isWide = useMediaQuery('(min-width: 640px)');
  const layout = isWide ? WIDE : NARROW;

  // Rebuilding the path on every render would be wasteful for a twenty-step
  // programme and outright silly during a resize.
  const geometry = useMemo(
    () => buildRoad(count, { columns: layout.columns, rtl }),
    [count, layout.columns, rtl],
  );

  return { geometry, isWide, heightPx: geometry.rows * layout.rowHeightPx };
}
