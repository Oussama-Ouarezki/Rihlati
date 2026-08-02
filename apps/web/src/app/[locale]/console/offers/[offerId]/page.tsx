import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { OfferForAgency } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, getSession, redirectToLogin } from '@/lib/session';
import { changeOfferStatus, deleteOffer } from '@/lib/offer-actions';
import { OfferStatusBadge } from '@/components/console/OfferStatusBadge';
import { EditOfferForm } from './EditOfferForm';

export const dynamic = 'force-dynamic';

export default async function EditOfferPage(props: {
  params: Promise<{ locale: string; offerId: string }>;
}) {
  const { offerId } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const response = await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}`);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API ${response.status}`);
  const offer = (await response.json()) as OfferForAgency;

  const t = await getTranslations('offerForm');

  const submit = changeOfferStatus.bind(null, offer.id, 'pending_review');
  const pause = changeOfferStatus.bind(null, offer.id, 'paused');
  const resume = changeOfferStatus.bind(null, offer.id, 'published');
  const archive = changeOfferStatus.bind(null, offer.id, 'archived');
  const remove = deleteOffer.bind(null, offer.id);

  const actionButton =
    'rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50';

  return (
    <div className="space-y-5">
      <Link href="/console/offers" className="text-sm text-slate-500 hover:text-brand-700">
        {t('backToList')}
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{offer.title}</h2>
        <div className="flex items-center gap-3">
          <Link
            href={`/console/offers/${offer.id}/programme`}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            {t('programme')}
          </Link>
          <OfferStatusBadge status={offer.status} />
        </div>
      </div>

      {/* The agency sees its own duplicate flag, with the reason and the
          reassurance that nothing was deleted. Never a silent demotion. */}
      {offer.duplicateStatus === 'suspected' ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠ {t('duplicateWarning')}
        </p>
      ) : null}

      {/* ---- status actions: what this offer can legally do next ---- */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 p-4">
        {offer.status === 'draft' || offer.status === 'rejected' ? (
          <form action={submit}>
            <button type="submit" className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              {t('submitForReview')}
            </button>
          </form>
        ) : null}

        {offer.status === 'published' ? (
          <form action={pause}>
            <button type="submit" className={actionButton}>
              {t('pause')}
            </button>
          </form>
        ) : null}

        {offer.status === 'paused' ? (
          <form action={resume}>
            <button type="submit" className={actionButton}>
              {t('resume')}
            </button>
          </form>
        ) : null}

        {offer.status !== 'archived' ? (
          <form action={archive}>
            <button type="submit" className={actionButton}>
              {t('archive')}
            </button>
          </form>
        ) : null}

        <form action={remove} className="ms-auto">
          <button type="submit" className="rounded-xl border border-red-100 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
            {t('delete')}
          </button>
        </form>
      </div>

      {offer.status === 'pending_review' ? (
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{t('reviewNote')}</p>
      ) : null}

      <EditOfferForm offer={offer} />
    </div>
  );
}
