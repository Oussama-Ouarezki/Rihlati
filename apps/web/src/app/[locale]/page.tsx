import { getTranslations } from 'next-intl/server';
import type { Locale } from '@rihlati/shared';
import { searchOffers } from '@/lib/api';
import { FilterBar } from '@/components/FilterBar';
import { OfferCard } from '@/components/OfferCard';
import { Link } from '@/i18n/navigation';
import { RefCapture } from '@/components/RefCapture';

// The search always reflects live inventory — never a build-time snapshot.
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

/**
 * URL params are human units (DZD, dates); the API speaks centimes. The
 * translation happens here, in one place, so a shareable URL like
 * `?max=300000&country=SA` stays readable to a person.
 */
function toApiQuery(params: Search): URLSearchParams {
  const query = new URLSearchParams();
  const q = first(params['q']);
  const kind = first(params['kind']);
  const country = first(params['country']);
  const wilaya = first(params['wilaya']);
  const min = Number(first(params['min']));
  const max = Number(first(params['max']));
  const from = first(params['from']);
  const to = first(params['to']);
  const sort = first(params['sort']);
  const cursor = first(params['cursor']);
  const agency = first(params['agency']);

  if (q) query.set('q', q);
  if (kind) query.set('kind', kind);
  if (country) query.set('destinationCountry', country);
  if (wilaya) query.set('departureWilayaCode', wilaya);
  if (Number.isFinite(min) && min > 0) query.set('minPriceCentimes', String(Math.round(min * 100)));
  if (Number.isFinite(max) && max > 0) query.set('maxPriceCentimes', String(Math.round(max * 100)));
  if (from) query.set('departureFrom', from);
  if (to) query.set('departureTo', to);
  if (sort) query.set('sort', sort);
  if (cursor) query.set('cursor', cursor);
  // Agency-wide tracked links land here, filtered to that agency's catalogue.
  if (agency) query.set('agencySlug', agency);
  query.set('limit', '24');
  return query;
}

export default async function SearchPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Search>;
}) {
  const { locale } = await props.params;
  const searchParams = await props.searchParams;
  const t = await getTranslations('search');
  const tCommon = await getTranslations('common');

  const page = await searchOffers(toApiQuery(searchParams));
  const items = page?.items ?? [];

  // Keep the current filters on the "see more" link — only the cursor moves.
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    const v = first(value);
    if (v && key !== 'cursor') nextParams.set(key, v);
  }
  if (page?.nextCursor) nextParams.set('cursor', page.nextCursor);

  return (
    <div className="space-y-6">
      <RefCapture code={first(searchParams['ref']) ?? null} />
      <p className="text-sm text-slate-500">{tCommon('tagline')}</p>

      <FilterBar current={searchParams} />

      {items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-10 text-center">
          <p className="font-medium text-slate-700">{t('empty')}</p>
          <p className="mt-1 text-sm text-slate-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {items.map((offer) => (
            <OfferCard key={offer.id} offer={offer} locale={locale as Locale} />
          ))}
        </div>
      )}

      {page?.nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={`/?${nextParams.toString()}`}
            className="rounded-full border border-brand-200 px-6 py-2 font-medium text-brand-700 hover:bg-brand-50"
          >
            {tCommon('seeMore')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
