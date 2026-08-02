'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, GripVertical, MapPin } from 'lucide-react';
import type { MilestoneItem } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import {
  deleteMilestone,
  moveMilestone,
  reorderMilestones,
  setMilestoneCompletion,
} from '@/lib/milestone-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<string, string> = {
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

const CHECKPOINT_STYLE: Record<string, string> = {
  none: '',
  mandatory: 'bg-red-50 text-red-700',
  optional: 'bg-sky-50 text-sky-700',
};

/**
 * THE PROGRAMME EDITOR'S LIST — drag a step to move it.
 *
 * ## Why native HTML5 drag and not a library
 *
 * A sortable-list dependency is ~15KB for one screen that agency staff use
 * while building an offer. `draggable` plus three event handlers does the same
 * job here because the list is one column, so "where did it land" is a single
 * index comparison rather than real hit-testing.
 *
 * ## Why the up/down buttons stay
 *
 * HTML5 drag events do not fire on touchscreens, and a drag is not reachable
 * by keyboard. Deleting the buttons would make reordering impossible on a
 * phone and impossible without a mouse — so drag is the shortcut, and the
 * buttons remain the path that always works.
 *
 * The order is applied optimistically and then confirmed by the server, whose
 * `reorder` endpoint rejects any list that is not exactly this offer's current
 * milestone set.
 */
export function MilestoneDragList(props: { offerId: string; milestones: MilestoneItem[] }) {
  const t = useTranslations('programme');
  const tKinds = useTranslations('milestoneKinds');
  const tCheckpoint = useTranslations('checkpointTypes');

  const [order, setOrder] = useState(props.milestones);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const pending = useRef(false);

  // The server is the source of truth. When a revalidation brings new data,
  // adopt it — unless we are mid-flight with our own reorder, which would
  // otherwise snap the list back to the pre-drag order for a moment.
  useEffect(() => {
    if (!pending.current) setOrder(props.milestones);
  }, [props.milestones]);

  const commit = (next: MilestoneItem[]) => {
    setOrder(next);
    pending.current = true;
    void reorderMilestones(
      props.offerId,
      next.map((milestone) => milestone.id),
    ).finally(() => {
      pending.current = false;
    });
  };

  const handleDrop = (targetId: string) => {
    setOverId(null);
    const sourceId = draggingId;
    setDraggingId(null);
    if (!sourceId || sourceId === targetId) return;

    const from = order.findIndex((milestone) => milestone.id === sourceId);
    const to = order.findIndex((milestone) => milestone.id === targetId);
    if (from < 0 || to < 0) return;

    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    commit(next);
  };

  const orderedIds = order.map((milestone) => milestone.id);

  return (
    <ol className="space-y-0 border-s-2 border-dashed border-slate-200 ps-5">
      {order.map((milestone, index) => {
        const remove = deleteMilestone.bind(null, props.offerId, milestone.id);
        const up = moveMilestone.bind(null, props.offerId, orderedIds, milestone.id, 'up');
        const down = moveMilestone.bind(null, props.offerId, orderedIds, milestone.id, 'down');
        const toggleDone = setMilestoneCompletion.bind(
          null,
          props.offerId,
          milestone.id,
          !milestone.completedAt,
        );

        return (
          <li
            key={milestone.id}
            draggable
            onDragStart={(event) => {
              setDraggingId(milestone.id);
              event.dataTransfer.effectAllowed = 'move';
              // Firefox refuses to start a drag without payload on the transfer.
              event.dataTransfer.setData('text/plain', milestone.id);
            }}
            onDragOver={(event) => {
              event.preventDefault(); // without this the drop never fires
              event.dataTransfer.dropEffect = 'move';
              setOverId(milestone.id);
            }}
            onDragLeave={() => setOverId((current) => (current === milestone.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(milestone.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setOverId(null);
            }}
            className={cn(
              'relative -ms-[calc(0.75rem+2px)] ps-6 pb-4 transition-opacity',
              draggingId === milestone.id && 'opacity-40',
            )}
          >
            <span
              className={cn(
                'absolute start-0 top-1 text-lg leading-none',
                milestone.completedAt ? 'text-emerald-600' : 'text-slate-300',
              )}
              aria-hidden
            >
              {milestone.completedAt ? '✓' : '●'}
            </span>

            <Card
              className={cn(
                'ms-2 transition-colors',
                milestone.completedAt && 'bg-emerald-50/40',
                // Where it will land, shown while the pointer is over this row.
                overId === milestone.id && draggingId !== milestone.id && 'ring-2 ring-brand-500',
              )}
            >
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span
                    className="mt-0.5 cursor-grab text-slate-400 active:cursor-grabbing"
                    aria-hidden
                    title={t('dragHint')}
                  >
                    <GripVertical className="size-4" />
                  </span>

                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-bold">
                      <span aria-hidden>{KIND_ICON[milestone.kind] ?? '•'}</span>{' '}
                      {t('dayLabel', { day: milestone.dayOffset + 1 })} — {milestone.title}
                      {milestone.timeOfDay ? (
                        <span className="ms-2 font-normal text-muted-foreground">
                          {milestone.timeOfDay}
                        </span>
                      ) : null}
                    </p>
                    {milestone.description ? (
                      <p className="mt-1 text-sm text-slate-600">{milestone.description}</p>
                    ) : null}
                    {milestone.meetingPoint ? (
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3.5" /> {milestone.meetingPoint}
                      </p>
                    ) : null}
                    {milestone.mapUrl ? (
                      <a
                        href={milestone.mapUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-xs text-brand-700 hover:underline"
                      >
                        {t('openMap')}
                      </a>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">{tKinds(milestone.kind)}</span>
                    {milestone.checkpointType !== 'none' ? (
                      <Badge
                        variant="outline"
                        className={`border-transparent ${CHECKPOINT_STYLE[milestone.checkpointType]}`}
                      >
                        {tCheckpoint(milestone.checkpointType)}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* First in the row because during the trip this is the only
                      one anybody presses — the rest is pre-departure planning. */}
                  <form action={toggleDone}>
                    <Button
                      type="submit"
                      size="sm"
                      variant={milestone.completedAt ? 'outline' : 'default'}
                      className={milestone.completedAt ? '' : 'bg-emerald-600 hover:bg-emerald-700'}
                    >
                      {milestone.completedAt ? t('markNotDone') : t('markDone')}
                    </Button>
                  </form>
                  {milestone.checkpointType !== 'none' ? (
                    <Button
                      size="sm"
                      render={
                        <Link
                          href={`/console/offers/${props.offerId}/programme/${milestone.id}/check-ins`}
                        />
                      }
                    >
                      {t('attendance')}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      <Link href={`/console/offers/${props.offerId}/programme/${milestone.id}`} />
                    }
                  >
                    {t('edit')}
                  </Button>
                  <form action={remove}>
                    <Button type="submit" variant="destructive" size="sm">
                      {t('delete')}
                    </Button>
                  </form>
                  <div className="ms-auto flex gap-1">
                    <form action={up}>
                      <Button
                        type="submit"
                        variant="outline"
                        size="icon-sm"
                        disabled={index === 0}
                        aria-label={t('moveUp')}
                      >
                        <ChevronUp />
                      </Button>
                    </form>
                    <form action={down}>
                      <Button
                        type="submit"
                        variant="outline"
                        size="icon-sm"
                        disabled={index === order.length - 1}
                        aria-label={t('moveDown')}
                      >
                        <ChevronDown />
                      </Button>
                    </form>
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
