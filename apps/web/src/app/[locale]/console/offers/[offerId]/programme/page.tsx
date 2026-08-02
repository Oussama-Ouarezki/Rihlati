import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChevronUp, ChevronDown, MapPin } from 'lucide-react';
import type { MilestoneItem, OfferForAgency } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, authedGet, getSession, redirectToLogin } from '@/lib/session';
import {
  createMilestone,
  deleteMilestone,
  moveMilestone,
  setMilestoneCompletion,
} from '@/lib/milestone-actions';
import { MilestoneForm } from '@/components/console/MilestoneForm';
import { CheckpointTypeBadge } from '@/components/console/CheckpointTypeBadge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

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

/**
 * THE PROGRAMME EDITOR — the milestone timeline an agency builds for one
 * offer. See obsidian/Backend/Trip Programme.md.
 */
export default async function ProgrammePage(props: {
  params: Promise<{ locale: string; offerId: string }>;
}) {
  const { offerId } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const offerResponse = await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}`);
  if (offerResponse.status === 404) notFound();
  if (!offerResponse.ok) throw new Error(`API ${offerResponse.status}`);
  const offer = (await offerResponse.json()) as OfferForAgency;

  const milestones = await authedGet<MilestoneItem[]>(
    `/v1/agencies/${agencyId}/offers/${offerId}/milestones`,
  );
  const orderedIds = milestones.map((m) => m.id);

  const t = await getTranslations('programme');
  const createAction = createMilestone.bind(null, offerId);

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/console/offers/${offerId}`} className="text-sm text-muted-foreground hover:text-brand-700">
          ← {offer.title}
        </Link>
        <h2 className="mt-1 text-xl font-bold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {milestones.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground ring-0">{t('empty')}</Card>
      ) : (
        <ol className="space-y-0 border-s-2 border-dashed border-slate-200 ps-5">
          {milestones.map((milestone, index) => (
            <MilestoneRow
              key={milestone.id}
              offerId={offerId}
              milestone={milestone}
              orderedIds={orderedIds}
              isFirst={index === 0}
              isLast={index === milestones.length - 1}
            />
          ))}
        </ol>
      )}

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm">{t('addMilestone')}</CardTitle>
        </CardHeader>
        <CardContent>
          <MilestoneForm action={createAction} submitLabel={t('add')} />
        </CardContent>
      </Card>
    </div>
  );
}

async function MilestoneRow(props: {
  offerId: string;
  milestone: MilestoneItem;
  orderedIds: string[];
  isFirst: boolean;
  isLast: boolean;
}) {
  const { offerId, milestone, orderedIds } = props;
  const t = await getTranslations('programme');
  const tKinds = await getTranslations('milestoneKinds');

  const remove = deleteMilestone.bind(null, offerId, milestone.id);
  const toggleDone = setMilestoneCompletion.bind(
    null,
    offerId,
    milestone.id,
    !milestone.completedAt,
  );
  const up = moveMilestone.bind(null, offerId, orderedIds, milestone.id, 'up');
  const down = moveMilestone.bind(null, offerId, orderedIds, milestone.id, 'down');

  return (
    <li className="relative -ms-[calc(0.75rem+2px)] ps-6 pb-4">
      <span
        className={`absolute start-0 top-1 text-lg leading-none ${
          milestone.completedAt ? 'text-emerald-600' : 'text-slate-300'
        }`}
      >
        {milestone.completedAt ? '✓' : '●'}
      </span>

      <Card className={milestone.completedAt ? 'ms-2 bg-emerald-50/40' : 'ms-2'}>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-40 flex-1">
              <p className="text-sm font-bold">
                <span aria-hidden>{KIND_ICON[milestone.kind] ?? '•'}</span>{' '}
                {t('dayLabel', { day: milestone.dayOffset + 1 })} — {milestone.title}
                {milestone.timeOfDay ? (
                  <span className="ms-2 font-normal text-muted-foreground">{milestone.timeOfDay}</span>
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
              <CheckpointTypeBadge checkpointType={milestone.checkpointType} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* The tick-off. First button in the row because during the trip
                this is the only one anybody presses — every other control here
                is planning work done before departure. */}
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
                render={<Link href={`/console/offers/${offerId}/programme/${milestone.id}/check-ins`} />}
              >
                {t('attendance')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/console/offers/${offerId}/programme/${milestone.id}`} />}
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
                <Button type="submit" variant="outline" size="icon-sm" disabled={props.isFirst} aria-label={t('moveUp')}>
                  <ChevronUp />
                </Button>
              </form>
              <form action={down}>
                <Button type="submit" variant="outline" size="icon-sm" disabled={props.isLast} aria-label={t('moveDown')}>
                  <ChevronDown />
                </Button>
              </form>
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
