'use client';

import { useMemo } from 'react';
import { Flag, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoadPath } from './RoadPath';
import { RoadmapMilestone } from './RoadmapMilestone';
import { RoadmapLegend } from './RoadmapLegend';
import { RoadmapProgress } from './RoadmapProgress';
import { serpentinePath } from './pathHelpers';
import { useReveal } from './useReveal';
import { useRoadPath } from './useRoadPath';
import type { RoadmapItem } from './types';

/**
 * A winding road with stops along it. Give it any ordered list of
 * {@link RoadmapItem} and it draws them; it knows nothing about trips.
 *
 * The road runs across and folds back at the edges — see `pathHelpers.ts` for
 * why a serpentine rather than a column. Wide screens fit four stops to a row,
 * phones two.
 *
 * Every string is passed in. The component ships no copy of its own, because
 * this app has no hardcoded user-facing text anywhere (see CLAUDE.md).
 */
export function Roadmap(props: {
  items: RoadmapItem[];
  rtl: boolean;
  labels: {
    start: string;
    goal: string;
    progress: string;
    completed: string;
    current: string;
    upcoming: string;
  };
  onSelect: (id: string) => void;
}) {
  const { items } = props;
  const { geometry, isWide, heightPx } = useRoadPath(items.length, props.rtl);
  const { ref, revealed } = useReveal<HTMLDivElement>();

  const currentIndex = useMemo(() => {
    const explicit = items.findIndex((item) => item.status === 'current');
    if (explicit !== -1) return explicit;
    // No explicit current: the road is filled up to the last completed stop.
    return items.map((item) => item.status).lastIndexOf('completed');
  }, [items]);

  /*
   * The travelled stretch is the same builder run over the first N points, so
   * it follows the identical route — turns included — without a single length
   * calculation. This is the payoff for generating the path from points rather
   * than measuring one that already exists.
   */
  const travelledD = useMemo(
    () => (currentIndex < 0 ? '' : serpentinePath(geometry.points.slice(0, currentIndex + 1))),
    [geometry.points, currentIndex],
  );

  if (items.length === 0) return null;

  const doneCount = items.filter((item) => item.status === 'completed').length;
  const last = items.length - 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <RoadmapProgress done={doneCount} total={items.length} label={props.labels.progress} />
        <RoadmapLegend
          labels={{
            completed: props.labels.completed,
            current: props.labels.current,
            upcoming: props.labels.upcoming,
          }}
        />
      </div>

      <div
        ref={ref}
        className={cn('relative', revealed && 'animate-road-reveal')}
        style={{ height: `${heightPx}px` }}
      >
        <RoadPath geometry={geometry} travelledD={travelledD} revealed={revealed} />

        {/* Start and finish ride on the road's own end points, so they stay
            attached to it whatever the route does. */}
        <EndMarker
          label={props.labels.start}
          point={geometry.points[0]}
          size={geometry.size}
          icon={<MapPin className="size-3" aria-hidden />}
          tone="bg-slate-700 text-white"
        />
        <EndMarker
          label={props.labels.goal}
          point={geometry.points[last]}
          size={geometry.size}
          icon={<Flag className="size-3" aria-hidden />}
          tone="bg-emerald-600 text-white animate-roadmap-float"
        />

        <ol className="absolute inset-0">
          {items.map((item, index) => (
            <RoadmapMilestone
              key={item.id}
              item={item}
              point={geometry.points[index]!}
              size={geometry.size}
              columnWidthPercent={(100 - 2 * 9) / geometry.columns}
              isWide={isWide}
              index={index}
              revealed={revealed}
              statusLabel={props.labels[item.status]}
              onSelect={() => props.onSelect(item.id)}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * The start / finish flags. Pinned above their stop rather than beside it —
 * the road runs horizontally through a stop, so sideways is asphalt.
 */
function EndMarker(props: {
  label: string;
  point: { x: number; y: number } | undefined;
  size: number;
  icon: React.ReactNode;
  tone: string;
}) {
  if (!props.point) return null;

  return (
    <span
      className={cn(
        'absolute z-10 flex -translate-x-1/2 -translate-y-[1.9rem] items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold shadow-md',
        props.tone,
      )}
      style={{
        left: `${(props.point.x / props.size) * 100}%`,
        top: `${(props.point.y / props.size) * 100}%`,
      }}
    >
      {props.icon}
      {props.label}
    </span>
  );
}
