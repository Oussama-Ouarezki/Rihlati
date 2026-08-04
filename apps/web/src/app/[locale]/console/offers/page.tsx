import { getTranslations } from 'next-intl/server';
import type { AgencyForMember, Locale, OfferForAgency, Page } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedGet, getSession, redirectToLogin } from '@/lib/session';
import { price } from '@/lib/format';
import { OfferStatusBadge } from '@/components/console/OfferStatusBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function OffersPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('offerForm');
  const tKinds = await getTranslations('kinds');

  const [offers, agency] = await Promise.all([
    authedGet<Page<OfferForAgency>>(`/v1/agencies/${agencyId}/offers?limit=100`),
    authedGet<AgencyForMember>(`/v1/agencies/${agencyId}`),
  ]);

  const quota = agency.limits.publishedOffers;
  const full = quota.limit !== null && quota.used >= quota.limit;

  return (
    <div className="space-y-4">
      {/* ---- one obvious primary action: create an offer ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{t('title')}</h2>
        <Button nativeButton={false} render={<Link href="/console/offers/new" />} disabled={full}>
          {t('new')}
        </Button>
      </div>

      <Badge variant="outline" className={full ? 'border-amber-200 bg-amber-50 text-amber-800' : ''}>
        {quota.limit === null
          ? t('quotaUnlimited', { used: quota.used })
          : t('quota', { used: quota.used, limit: quota.limit })}
      </Badge>

      {full ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{t('quotaFull')}</p>
      ) : null}

      {offers.items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500 ring-0">{t('empty')}</Card>
      ) : (
        <div className="space-y-2">
          {offers.items.map((offer) => (
            <Link key={offer.id} href={`/console/offers/${offer.id}`} className="block">
              <Card className="flex-row flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-slate-50">
                <div className="min-w-52 flex-1">
                  <p className="font-semibold">{offer.title}</p>
                  <p className="text-xs text-slate-400">
                    {tKinds(offer.kind)}
                    {offer.departureDate ? ` · ${offer.departureDate}` : ''}
                  </p>
                </div>

                <span className="text-sm font-medium text-brand-700">
                  {price(offer.priceFromCentimes, locale as Locale)}
                </span>

                {/* The agency sees its own spam flag — never a shadow ban. */}
                {offer.duplicateStatus === 'suspected' ? (
                  <Badge variant="outline" className="border-transparent bg-amber-50 text-amber-700">
                    ⚠
                  </Badge>
                ) : null}

                <OfferStatusBadge status={offer.status} />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
