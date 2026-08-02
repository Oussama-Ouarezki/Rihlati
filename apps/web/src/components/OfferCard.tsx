import { getTranslations } from 'next-intl/server';
import type { Locale, OfferSummary } from '@rihlati/shared';
import { formatDateOnly, price, wilayaName } from '@/lib/format';
import { Link } from '@/i18n/navigation';

/**
 * One card in the marketplace grid — the layout the owner picked (photo-first,
 * Facebook-Marketplace-familiar). Photos sell trips; everything else on the
 * card exists to answer the two questions a traveler asks before tapping:
 * "combien?" and "c'est qui?".
 */
export async function OfferCard(props: { offer: OfferSummary; locale: Locale }) {
  const { offer, locale } = props;
  const t = await getTranslations('offer');
  const tCommon = await getTranslations('common');
  const tKinds = await getTranslations('kinds');

  const departure = wilayaName(offer.departureWilayaCode, locale);

  return (
    <Link
      href={`/offres/${offer.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[4/3] bg-slate-100">
        {offer.coverImageUrl ? (
          // Plain <img>: agency photos live on arbitrary hosts until uploads
          // move to our bucket — see next.config.ts.
          <img
            src={offer.coverImageUrl}
            alt={offer.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-4xl text-slate-300">✈</div>
        )}
        <span className="absolute start-2 top-2 rounded-full bg-white/95 px-2 py-0.5 text-xs font-medium text-slate-700">
          {tKinds(offer.kind)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-slate-800">{offer.title}</h3>

        <p className="text-base font-bold text-brand-700">
          <span className="me-1 text-xs font-normal text-slate-500">{tCommon('from')}</span>
          {price(offer.priceFromCentimes, locale)}
        </p>

        <p className="mt-auto flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          {offer.agency.rating !== null ? (
            <span className="text-amber-600">★ {offer.agency.rating}</span>
          ) : null}
          <span className="truncate">{offer.agency.name}</span>
          {offer.agency.isVerified ? (
            <span title={tCommon('verified')} className="text-brand-600">
              ✓
            </span>
          ) : null}
        </p>

        <p className="flex flex-wrap gap-x-2 text-xs text-slate-400">
          {departure ? <span>{departure}</span> : null}
          {offer.departureDate ? <span>{formatDateOnly(offer.departureDate, locale)}</span> : null}
          {offer.seatsLeft !== null && offer.seatsLeft <= 10 ? (
            <span className="text-orange-600">{t('seatsLeft', { count: offer.seatsLeft })}</span>
          ) : null}
        </p>
      </div>
    </Link>
  );
}
