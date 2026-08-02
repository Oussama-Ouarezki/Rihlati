'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Clock, MapPin, Navigation } from 'lucide-react';
import type { Locale, MilestoneKind, PublicMilestone } from '@rihlati/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Roadmap, type RoadmapItem, type RoadmapStatus } from '@/components/roadmap';
import { formatDateOnly } from '@/lib/format';

/**
 * THE PROGRAMME MAP — what a CLIENT sees, on the offer page and on their own
 * trip page. The agency sees a different thing entirely (a list editor at
 * /console/offers/[id]/programme), and that asymmetry is the design:
 *
 *   the agency is EDITING a schedule   → wants density, order, every field
 *   the client is READING a journey    → wants shape, position, one step
 *
 * This file is the thin Rihlati-shaped layer: it turns milestones into
 * {@link RoadmapItem}s, owns the detail sheet, and holds every translated
 * string. The drawing lives in `components/roadmap/`, which is generic and
 * knows nothing about trips.
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
 * `dayOffset` plus the departure date is a real calendar date, computed here
 * and never stored — that is the whole reason milestones hold an offset (see
 * Trip Programme.md §4). Without a departure date we show "Jour 3", which is
 * honest: the agency has not fixed one.
 */
function milestoneDate(departureDate: string | null, dayOffset: number): string | null {
  if (!departureDate) return null;
  const date = new Date(`${departureDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

export function ProgrammeMap(props: {
  milestones: PublicMilestone[];
  /**
   * The step the group is on right now. Null on the public offer page: a buyer
   * is looking at a trip that has not started, so "you are here" would be a
   * lie — and with no current stop the road simply shows nothing travelled.
   */
  currentMilestoneId?: string | null;
  departureDate?: string | null;
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations('programmeMap');
  const tKinds = useTranslations('milestoneKinds');
  const [openId, setOpenId] = useState<string | null>(null);

  const items: RoadmapItem[] = useMemo(
    () =>
      props.milestones.map((milestone) => {
        const status: RoadmapStatus = milestone.isDone
          ? 'completed'
          : milestone.id === props.currentMilestoneId
            ? 'current'
            : 'upcoming';

        return {
          id: milestone.id,
          title: milestone.title,
          description: milestone.description,
          status,
          badge: milestone.timeOfDay,
          groupLabel: t('dayLabel', { day: milestone.dayOffset + 1 }),
          icon: KIND_ICON[milestone.kind],
        };
      }),
    [props.milestones, props.currentMilestoneId, t],
  );

  if (props.milestones.length === 0) return null;

  const open = props.milestones.find((milestone) => milestone.id === openId) ?? null;
  const openDate = open ? milestoneDate(props.departureDate ?? null, open.dayOffset) : null;
  const doneCount = props.milestones.filter((milestone) => milestone.isDone).length;

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">{t('tapHint')}</p>

      <Roadmap
        items={items}
        // Arabic reads right to left, so the road has to curve the same way.
        rtl={locale === 'ar'}
        labels={{
          start: t('start'),
          goal: t('goal'),
          progress: t('progress', { done: doneCount, total: props.milestones.length }),
          completed: t('statusCompleted'),
          current: t('youAreHere'),
          upcoming: t('statusUpcoming'),
        }}
        onSelect={setOpenId}
      />

      {/* Details live here, not on the marker. One tap, one screen, full text —
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
