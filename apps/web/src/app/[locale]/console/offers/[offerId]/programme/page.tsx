import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { MilestoneItem, OfferForAgency } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, authedGet, getSession, redirectToLogin } from '@/lib/session';
import { createMilestone } from '@/lib/milestone-actions';
import { MilestoneForm } from '@/components/console/MilestoneForm';
import { MilestoneDragList } from '@/components/console/MilestoneDragList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/**
 * THE PROGRAMME EDITOR — the milestone list an agency builds for one offer.
 * See obsidian/Backend/Trip Programme.md.
 *
 * A dense, editable LIST, deliberately not the road map that clients get. The
 * agency is arranging a schedule and needs every field at once; a traveller is
 * reading a journey and needs one step. Same rows, two products.
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

  const t = await getTranslations('programme');
  const createAction = createMilestone.bind(null, offerId);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/console/offers/${offerId}`}
          className="text-sm text-muted-foreground hover:text-brand-700"
        >
          ← {offer.title}
        </Link>
        <h2 className="mt-1 text-xl font-bold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {milestones.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground ring-0">{t('empty')}</Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('dragHint')}</p>
          <MilestoneDragList offerId={offerId} milestones={milestones} />
        </>
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
