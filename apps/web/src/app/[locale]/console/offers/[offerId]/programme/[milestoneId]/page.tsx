import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { MilestoneItem } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedGet, getSession, redirectToLogin } from '@/lib/session';
import { deleteMilestone, updateMilestone } from '@/lib/milestone-actions';
import { MilestoneForm } from '@/components/console/MilestoneForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function EditMilestonePage(props: {
  params: Promise<{ locale: string; offerId: string; milestoneId: string }>;
}) {
  const { offerId, milestoneId } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  // No single-item GET yet — the list is capped and cheap, and this is an
  // internal console page, so finding the row here beats a new endpoint.
  const milestones = await authedGet<MilestoneItem[]>(
    `/v1/agencies/${agencyId}/offers/${offerId}/milestones`,
  );
  const milestone = milestones.find((m) => m.id === milestoneId);
  if (!milestone) notFound();

  const t = await getTranslations('programme');
  const updateAction = updateMilestone.bind(null, offerId, milestoneId);
  const remove = deleteMilestone.bind(null, offerId, milestoneId);

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/console/offers/${offerId}/programme`} className="text-sm text-muted-foreground hover:text-brand-700">
          ← {t('title')}
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">{milestone.title}</h2>
          {milestone.checkpointType !== 'none' ? (
            <Button nativeButton={false} render={<Link href={`/console/offers/${offerId}/programme/${milestone.id}/check-ins`} />}>
              {t('attendance')}
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent>
          <MilestoneForm action={updateAction} milestone={milestone} submitLabel={t('save')} />
        </CardContent>
      </Card>

      <form action={remove}>
        <Button type="submit" variant="destructive">
          {t('delete')}
        </Button>
      </form>
    </div>
  );
}
