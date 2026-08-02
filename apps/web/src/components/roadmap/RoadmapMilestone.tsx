'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapItem, RoadPoint } from './types';

/**
 * One stop on the road: a circular marker sitting exactly on the asphalt, with
 * its label directly underneath.
 *
 * ## Two things that look like styling and are not
 *
 * **The marker is the anchor, not the label.** The `<li>` is a zero-size point
 * on the curve and everything hangs off it. Centring a marker-plus-label block
 * on the point instead — the obvious first go — puts the *block's* midpoint on
 * the road, sliding the marker off it.
 *
 * **The label sits below, never beside.** On a horizontal serpentine the road
 * runs left-to-right through the stop, so the space either side of a marker is
 * asphalt. Below is the only free direction, which is also why a row has to be
 * tall enough for a marker plus two lines of text.
 *
 * The whole thing is one `<button>` with the label inside it: a 40px circle on
 * its own is a poor tap target, and an unlabelled one is useless to a screen
 * reader.
 */
export function RoadmapMilestone(props: {
  item: RoadmapItem;
  point: RoadPoint;
  /** The road's coordinate range, to turn the point into a percentage. */
  size: number;
  /** Label width, so it never spills into the neighbouring column. */
  columnWidthPercent: number;
  isWide: boolean;
  /** Nth item — drives the staggered entrance. */
  index: number;
  revealed: boolean;
  statusLabel: string;
  onSelect: () => void;
}) {
  const { item, point } = props;

  const markerPx = props.isWide ? 44 : 36;

  return (
    /*
     * The `<li>` carries the column width, not the label. A percentage width
     * resolves against the containing block, and an absolutely positioned
     * element with no width of its own is shrink-to-fit — so putting the
     * percentage on the label sized it against the label, collapsing every
     * title to two or three characters.
     *
     * Only the x axis is centred here. The y offset is half a marker, in
     * pixels, so the MARKER lands on the road rather than the marker-plus-
     * label block being centred on it.
     */
    <li
      className="absolute flex flex-col items-center"
      style={{
        left: `${(point.x / props.size) * 100}%`,
        top: `${(point.y / props.size) * 100}%`,
        width: `${props.columnWidthPercent}%`,
        maxWidth: '10.5rem',
        transform: 'translateX(-50%)',
        marginTop: `-${markerPx / 2}px`,
      }}
    >
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={item.status === 'current' ? 'step' : undefined}
        className={cn(
          'group flex w-full flex-col items-center outline-none',
          !props.revealed && 'opacity-0',
          props.revealed && 'animate-roadmap-pop',
        )}
        style={props.revealed ? { animationDelay: `${Math.min(props.index, 12) * 60}ms` } : undefined}
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-full text-base',
            props.isWide ? 'size-11' : 'size-9',
            'ring-4 ring-white transition-transform duration-200',
            'group-hover:scale-110 group-focus-visible:scale-110 group-focus-visible:ring-brand-500',
            item.status === 'completed' && 'bg-emerald-500 text-white shadow-md shadow-emerald-500/40',
            item.status === 'current' &&
              'animate-milestone-pulse bg-brand-600 text-white shadow-lg shadow-brand-600/50',
            item.status === 'upcoming' && 'bg-white text-slate-500 shadow ring-slate-200',
          )}
        >
          {item.status === 'completed' ? (
            <Check className={props.isWide ? 'size-5' : 'size-4'} strokeWidth={3} aria-hidden />
          ) : (
            <span aria-hidden>{item.icon ?? '•'}</span>
          )}
        </span>

        <span
          className={cn(
            'mt-1 w-full rounded-lg bg-white/95 px-1.5 py-1 text-center',
            'shadow-sm ring-1 ring-slate-900/5 backdrop-blur-sm',
            'transition-shadow duration-200 group-hover:shadow-md',
            item.status === 'upcoming' && 'bg-white/85',
          )}
        >
          {/* `line-clamp-2` sets display:-webkit-box. Adding `block` alongside
              it silently overrode that and let titles run to three lines. */}
          <span
            className={cn(
              'line-clamp-2 text-[11px] leading-tight',
              item.status === 'upcoming' ? 'text-slate-600' : 'font-semibold text-slate-900',
            )}
          >
            {item.title}
          </span>
          {item.badge ? (
            <span className="block text-[10px] tabular-nums text-slate-500">{item.badge}</span>
          ) : null}
          {/* Never shown, always read: the marker's colour is the status, and
              colour alone is not information a screen reader can use. */}
          <span className="sr-only">{props.statusLabel}</span>
        </span>
      </button>
    </li>
  );
}
