import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { CheckpointAttendance, MilestoneCheckInItem } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, getSession, redirectToLogin } from '@/lib/session';
import { setCheckpointAttendance } from '@/lib/milestone-actions';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

/**
 * THE CHECKPOINT ATTENDANCE SCREEN — the manifest's check-in screen, scoped
 * to ONE milestone. Same design rules: one hand, bad light, big targets.
 * See obsidian/Backend/Trip Programme.md §6.
 */
export default async function CheckpointAttendancePage(props: {
  params: Promise<{ locale: string; offerId: string; milestoneId: string }>;
}) {
  const { offerId, milestoneId } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const response = await authedFetch(`/v1/agencies/${agencyId}/milestones/${milestoneId}/check-ins`);
  if (response.status === 404) notFound();
  // A milestone with checkpointType "none" answers 422 — there is nothing to show.
  if (response.status === 422) notFound();
  if (!response.ok) throw new Error(`API ${response.status}`);
  const attendance = (await response.json()) as CheckpointAttendance;

  const t = await getTranslations('programme');

  return (
    <div className="space-y-4">
      <Link
        href={`/console/offers/${offerId}/programme/${milestoneId}`}
        className="text-sm text-muted-foreground hover:text-brand-700"
      >
        ← {attendance.milestone.title}
      </Link>

      <Card>
        <CardContent className="space-y-3">
          <div>
            <h2 className="text-lg font-bold">{attendance.milestone.title}</h2>
            <p className="text-sm text-muted-foreground">
              {attendance.milestone.checkpointType === 'mandatory'
                ? t('checkpointMandatoryHint')
                : t('checkpointOptionalHint')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 text-sm font-medium">
            <Badge variant="outline">{t('peopleTotal', { count: attendance.counts.people })}</Badge>
            <Badge variant="outline" className="border-transparent bg-amber-50 text-amber-700">
              🟡 {t('statusExpected')} · {attendance.counts.expectedPeople}
            </Badge>
            <Badge variant="outline" className="border-transparent bg-emerald-50 text-emerald-700">
              🟢 {t('statusCheckedIn')} · {attendance.counts.checkedInPeople}
            </Badge>
            <Badge variant="outline" className="border-transparent bg-red-50 text-red-700">
              🔴 {t('statusNoShow')} · {attendance.counts.noShowPeople}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {attendance.items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground ring-0">
          {t('emptyAttendance')}
        </Card>
      ) : (
        <ul className="space-y-2">
          {attendance.items.map((item) => (
            <AttendanceRow key={item.reservationId} milestoneId={milestoneId} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

const ROW_STYLE: Record<string, string> = {
  expected: 'border-amber-200 bg-amber-50/50',
  checked_in: 'border-emerald-200 bg-emerald-50/60',
  no_show: 'border-red-200 bg-red-50/50',
};

async function AttendanceRow(props: { milestoneId: string; item: MilestoneCheckInItem }) {
  const { milestoneId, item } = props;
  const t = await getTranslations('programme');

  const arrived = setCheckpointAttendance.bind(null, milestoneId, item.reservationId, 'checked_in');
  const absent = setCheckpointAttendance.bind(null, milestoneId, item.reservationId, 'no_show');
  const expected = setCheckpointAttendance.bind(null, milestoneId, item.reservationId, 'expected');

  return (
    <Card className={ROW_STYLE[item.status] ?? ''}>
      <CardContent className="flex flex-wrap items-center gap-3">
        <div className="min-w-40 flex-1">
          <p className="text-base font-bold">
            {item.contactName}
            <span className="ms-2 rounded-full bg-white px-2 py-0.5 text-sm font-semibold text-slate-600">
              ×{item.peopleCount}
            </span>
            {/* A default is a guess, not yet a real tap — say so plainly. */}
            {item.isDefault ? (
              <Badge variant="outline" className="ms-2 border-transparent bg-slate-100 font-normal text-slate-500">
                {t('defaultBadge')}
              </Badge>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground" dir="ltr">
            <a href={`tel:${item.contactPhone}`}>{item.contactPhone}</a>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {item.status !== 'checked_in' ? (
            <form action={arrived}>
              <Button type="submit" size="lg" className="bg-emerald-600 text-white hover:bg-emerald-700">
                {t('markArrived')}
              </Button>
            </form>
          ) : null}
          {item.status === 'expected' ? (
            <form action={absent}>
              <Button type="submit" variant="outline" size="lg" className="text-red-600 ring-1 ring-red-200">
                {t('markAbsent')}
              </Button>
            </form>
          ) : null}
          {item.status !== 'expected' ? (
            <form action={expected}>
              <Button type="submit" variant="outline" size="lg">
                {t('markExpected')}
              </Button>
            </form>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
