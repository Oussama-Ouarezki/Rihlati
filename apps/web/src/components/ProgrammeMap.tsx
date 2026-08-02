'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Clock, MapPin, Navigation } from 'lucide-react';
import type { Locale, MilestoneKind, PublicMilestone } from '@rihlati/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * THE PROGRAMME MAP — what a CLIENT sees, on the offer page and on their own
 * trip page. The agency sees a different thing entirely (a list editor at
 * /console/offers/[id]/programme), and that asymmetry is the design:
 *
 *   the agency is EDITING a schedule   → wants density, order, every field
 *   the client is READING a journey    → wants shape, position, one step
 *
 * So this renders the milestones as a serpentine path of nodes rather than a
 * list. At a glance you get the shape of the trip — how many days, where the
 * weight is, how far along the group is — and nothing else. A node carries
 * only an icon, a short title and a time. Everything else is one tap away, in
 * a sheet, because a traveler standing in an airport at 4am reads one thing.
 *
 * See obsidian/Backend/Trip Programme.md §7.
 */

const KIND_ICON: Record<MilestoneKind, string> = {
  meeting: '📍',
  transport: '🚌',
  flight: '✈️',
  hotel: '🏨',
  ritual: '🕋',
  ziyara: '🕌',
  meal: '🍽️',
  free_time: '🕐',
  other: '•',
};

/**
 * Lateral offsets in rem, cycled across the WHOLE programme — not restarted
 * per day. Eight entries is one full S-curve, which is what makes the path
 * read as a snake instead of a column of beads.
 *
 * Restarting the cycle at each day was the first attempt and it looked broken:
 * an Omra with one step on most days put every node dead centre and the snake
 * never appeared. The path is continuous, so its geometry has to be too.
 *
 * Amplitude is capped at 4rem: a 8rem tile centred at ±4rem spans 4rem–16rem
 * of a 20rem (320px) phone, so the narrowest screen still never scrolls
 * sideways. Anything smaller than this and the curve stops reading as a path.
 */
const WAVE = [0, 2.6, 4, 2.6, 0, -2.6, -4, -2.6];

/**
 * Every cell is exactly this tall. That is not a styling preference — it lets
 * the connector between two nodes be computed as arithmetic (we know dx and dy
 * before rendering) instead of measured in a layout effect. No refs, no
 * resize observers, and it renders correctly on the server.
 */
/**
 * Tall enough for the worst case: node + a title clamped to TWO lines + a time
 * + the tile's own padding. Sized short at first and two-line titles spilled
 * into the node below them, which is the failure a fixed height invites — if
 * the tile ever grows a third line, this number grows with it.
 */
const CELL_HEIGHT_REM = 8.5;
const NODE_SIZE_REM = 3.25;
/** Extra room above the first node of a day, where its label sits. */
const DAY_GAP_REM = 2.5;

/**
 * One colour per day, cycled. Colour is the only thing separating days at a
 * glance when you are scrolling fast, so days that are far apart never share a
 * neighbouring hue.
 */
const DAY_COLORS = [
  { band: 'bg-sky-50 text-sky-900 ring-sky-200', node: 'bg-sky-500', soft: 'border-sky-300 text-sky-700', line: 'bg-sky-200', halo: 'ring-sky-200' },
  { band: 'bg-emerald-50 text-emerald-900 ring-emerald-200', node: 'bg-emerald-500', soft: 'border-emerald-300 text-emerald-700', line: 'bg-emerald-200', halo: 'ring-emerald-200' },
  { band: 'bg-amber-50 text-amber-900 ring-amber-200', node: 'bg-amber-500', soft: 'border-amber-300 text-amber-700', line: 'bg-amber-200', halo: 'ring-amber-200' },
  { band: 'bg-violet-50 text-violet-900 ring-violet-200', node: 'bg-violet-500', soft: 'border-violet-300 text-violet-700', line: 'bg-violet-200', halo: 'ring-violet-200' },
  { band: 'bg-rose-50 text-rose-900 ring-rose-200', node: 'bg-rose-500', soft: 'border-rose-300 text-rose-700', line: 'bg-rose-200', halo: 'ring-rose-200' },
  { band: 'bg-teal-50 text-teal-900 ring-teal-200', node: 'bg-teal-500', soft: 'border-teal-300 text-teal-700', line: 'bg-teal-200', halo: 'ring-teal-200' },
] as const;

/**
 * `dayOffset` plus the departure date is a real calendar date, computed here
 * and never stored — that is the whole reason milestones hold an offset (see
 * Trip Programme.md §4). Without a departure date we simply show "Day 3",
 * which is honest: the agency has not fixed one.
 */
function milestoneDate(departureDate: string | null, dayOffset: number): string | null {
  if (!departureDate) return null;
  const date = new Date(`${departureDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

interface MapItem {
  milestone: PublicMilestone;
  /** Nth distinct day, not `dayOffset` — picks the colour, so gaps don't skip hues. */
  dayIndex: number;
  startsNewDay: boolean;
  /** Blank space above this node; non-zero only where a day label goes. */
  extraTopRem: number;
}

/**
 * Flattens the programme into one continuous path, marking where each day
 * begins. One list rather than a list-per-day, because the connectors have to
 * cross day boundaries — that continuity is the difference between a map and
 * three stacked charts.
 */
function toMapItems(milestones: PublicMilestone[]): MapItem[] {
  let dayIndex = -1;
  let previousDayOffset: number | null = null;

  return milestones.map((milestone, index) => {
    const startsNewDay = milestone.dayOffset !== previousDayOffset;
    if (startsNewDay) dayIndex += 1;
    previousDayOffset = milestone.dayOffset;

    return {
      milestone,
      dayIndex,
      startsNewDay,
      // The very first node needs no gap: the section heading is already there.
      extraTopRem: startsNewDay && index > 0 ? DAY_GAP_REM : 0,
    };
  });
}

export function ProgrammeMap(props: {
  milestones: PublicMilestone[];
  /**
   * The step the group is on right now — the node that gets the ring and the
   * pulse. Null on the public offer page: a buyer is looking at a trip that
   * has not started, so "you are here" would be a lie.
   */
  currentMilestoneId?: string | null;
  departureDate?: string | null;
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations('programmeMap');
  const tKinds = useTranslations('milestoneKinds');
  const [openId, setOpenId] = useState<string | null>(null);

  // The wave is drawn with a physical translateX, so Arabic has to mirror it
  // or the path would curve the wrong way against the reading direction.
  const dirSign = locale === 'ar' ? -1 : 1;

  if (props.milestones.length === 0) return null;

  const items = toMapItems(props.milestones);
  const open = props.milestones.find((milestone) => milestone.id === openId) ?? null;
  const openDate = open ? milestoneDate(props.departureDate ?? null, open.dayOffset) : null;

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">{t('tapHint')}</p>

      <ol className="pb-4">
        {items.map((item, index) => {
          const next = items[index + 1];
          const date = milestoneDate(props.departureDate ?? null, item.milestone.dayOffset);

          return (
            <MapNode
              key={item.milestone.id}
              item={item}
              offsetRem={WAVE[index % WAVE.length]! * dirSign}
              nextOffsetRem={next ? WAVE[(index + 1) % WAVE.length]! * dirSign : null}
              // The gap above the NEXT node is part of the distance this
              // node's connector has to travel.
              nextExtraTopRem={next?.extraTopRem ?? 0}
              color={DAY_COLORS[item.dayIndex % DAY_COLORS.length]!}
              isCurrent={item.milestone.id === props.currentMilestoneId}
              dayLabel={t('dayLabel', { day: item.milestone.dayOffset + 1 })}
              dateLabel={date ? formatDateOnly(date, locale) : null}
              kindLabel={tKinds(item.milestone.kind)}
              onOpen={() => setOpenId(item.milestone.id)}
            />
          );
        })}
      </ol>

      {/* Details live here, not on the node. One tap, one screen, full text —
          and it works the same on the offer page and the trip page. */}
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
          {open ? (
            <>
              <SheetHeader className="pe-12">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('dayLabel', { day: open.dayOffset + 1 })}
                  {openDate ? ` · ${formatDateOnly(openDate, locale)}` : ''}
                  {` · ${tKinds(open.kind)}`}
                </p>
                <SheetTitle className="text-lg">
                  <span aria-hidden className="me-2">
                    {KIND_ICON[open.kind]}
                  </span>
                  {open.title}
                </SheetTitle>
                {open.timeOfDay ? (
                  <SheetDescription className="flex items-center gap-1.5">
                    <Clock className="size-4" aria-hidden />
                    {open.timeOfDay}
                  </SheetDescription>
                ) : null}
              </SheetHeader>

              <div className="space-y-4 px-4 pb-6">
                {open.description ? (
                  <p className="whitespace-pre-line leading-relaxed text-slate-700">
                    {open.description}
                  </p>
                ) : null}

                {open.locationName ? (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">{t('location')}</p>
                    <p className="font-medium">{open.locationName}</p>
                  </div>
                ) : null}

                {/* Only ever present for someone who booked — the public offer
                    page receives null here. See toBuyerMilestone on the API. */}
                {open.meetingPoint ? (
                  <div className="rounded-xl bg-brand-50 p-4">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-brand-800">
                      <MapPin className="size-4" aria-hidden />
                      {t('meetingPoint')}
                    </p>
                    <p className="mt-1 font-medium text-brand-900">{open.meetingPoint}</p>
                  </div>
                ) : null}

                {open.mapUrl ? (
                  <a
                    href={open.mapUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 font-medium text-white"
                  >
                    <Navigation className="size-4" aria-hidden />
                    {t('openMap')}
                  </a>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MapNode(props: {
  item: MapItem;
  offsetRem: number;
  /** Null on the last node of the whole programme — nothing to connect to. */
  nextOffsetRem: number | null;
  nextExtraTopRem: number;
  color: (typeof DAY_COLORS)[number];
  isCurrent: boolean;
  dayLabel: string;
  dateLabel: string | null;
  kindLabel: string;
  onOpen: () => void;
}) {
  const { item, color, isCurrent } = props;
  const { milestone } = item;
  const t = useTranslations('programmeMap');

  // Connector geometry: straight trigonometry on numbers we already know, so
  // nothing has to be measured after paint. dy is the cell height plus any
  // day-label gap sitting above the next node; dx is its lateral offset.
  const dx = props.nextOffsetRem === null ? 0 : props.nextOffsetRem - props.offsetRem;
  const dy = CELL_HEIGHT_REM + props.nextExtraTopRem;
  const lengthRem = Math.hypot(dy, dx);
  const angleDeg = (Math.atan2(dx, dy) * 180) / Math.PI;

  const state = milestone.isDone ? 'done' : isCurrent ? 'current' : 'upcoming';

  return (
    <li
      className="relative"
      style={{ height: `${CELL_HEIGHT_REM + item.extraTopRem}rem` }}
    >
      {/* The day marker. A chip at the edge rather than a full-width band:
          a band would cut the path in half, and the path is the point. Colour
          carries the day; the label just names it. */}
      {item.startsNewDay ? (
        <span
          className={cn(
            'absolute start-0 top-0 z-10 flex items-baseline gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1',
            color.band,
          )}
        >
          {props.dayLabel}
          {props.dateLabel ? (
            <span className="font-normal opacity-70">{props.dateLabel}</span>
          ) : null}
        </span>
      ) : null}

      <div
        className="absolute inset-x-0 flex justify-center"
        style={{ top: `${item.extraTopRem}rem` }}
      >
        <div
          className="relative flex w-32 flex-col items-center"
          style={{ transform: `translateX(${props.offsetRem}rem)` }}
        >
          {props.nextOffsetRem !== null ? (
            <span
              aria-hidden
              className={cn(
                'absolute start-1/2 -z-10 w-1 rounded-full',
                milestone.isDone ? 'bg-brand-300' : color.line,
              )}
              style={{
                top: `${NODE_SIZE_REM / 2}rem`,
                height: `${lengthRem}rem`,
                transform: `translateX(-50%) rotate(${angleDeg}deg)`,
                transformOrigin: 'top center',
              }}
            />
          ) : null}

          <button
            type="button"
            onClick={props.onOpen}
            aria-label={`${props.kindLabel} — ${milestone.title}`}
            className={cn(
              'flex items-center justify-center rounded-full text-xl shadow-sm transition',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
              state === 'done' && 'bg-brand-600 text-white',
              // A halo in the day's own hue: a white ring is invisible on a
              // white page, and the pulse alone does nothing for anyone who
              // has reduced motion turned on.
              state === 'current' &&
                cn('animate-milestone-pulse text-white ring-4', color.node, color.halo),
              state === 'upcoming' && cn('border-2 bg-white', color.soft),
            )}
            style={{ width: `${NODE_SIZE_REM}rem`, height: `${NODE_SIZE_REM}rem` }}
          >
            {state === 'done' ? (
              <Check className="size-5" aria-hidden />
            ) : (
              <span aria-hidden>{KIND_ICON[milestone.kind]}</span>
            )}
          </button>

          {/* The tile. Opaque on purpose: the path runs behind it, and a
              connector crossing the glyphs makes both unreadable. Two lines
              maximum, which is why the title is capped at MILESTONE_TITLE_MAX
              characters on the way in — see the shared schema. */}
          <div className="mt-1.5 rounded-lg bg-white px-1.5 py-1 text-center shadow-sm ring-1 ring-slate-200/80">
            <p
              className={cn(
                'line-clamp-2 text-xs leading-tight',
                state === 'upcoming' ? 'text-slate-600' : 'font-semibold text-slate-900',
              )}
            >
              {milestone.title}
            </p>
            {milestone.timeOfDay ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {milestone.timeOfDay}
              </span>
            ) : null}
          </div>
          {isCurrent ? (
            <span className="mt-1 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
              {t('youAreHere')}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
