import { getLocale, getTranslations } from 'next-intl/server';
import { OFFER_KINDS, WILAYAS } from '@rihlati/shared';

/**
 * The filter row: a plain GET form, no JavaScript.
 *
 * Deliberate: filters land in the URL, so every search is shareable and
 * back-button friendly — someone pastes "Omra under 300 000 from Oran" into a
 * family WhatsApp group and everyone opens the same results. Client-side
 * filter state would be smoother and would lose exactly that.
 */

const COUNTRY_CODES = ['SA', 'TR', 'TN', 'MA', 'EG', 'AE', 'QA', 'FR', 'ES', 'IT'] as const;
const SORTS = ['relevance', 'price_asc', 'price_desc', 'departure_soon', 'newest'] as const;

const SORT_LABEL_KEY: Record<(typeof SORTS)[number], string> = {
  relevance: 'sortRelevance',
  price_asc: 'sortPriceAsc',
  price_desc: 'sortPriceDesc',
  departure_soon: 'sortDeparture',
  newest: 'sortNewest',
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export async function FilterBar(props: {
  current: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslations('search');
  const tKinds = await getTranslations('kinds');
  const tCountries = await getTranslations('countries');
  const locale = await getLocale();
  const { current } = props;

  const input =
    'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none';

  return (
    <form method="get" className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-3">
      <input
        type="search"
        name="q"
        defaultValue={first(current['q'])}
        placeholder={t('searchPlaceholder')}
        className={`${input} min-w-40 flex-1`}
        aria-label={t('searchPlaceholder')}
      />

      <select name="kind" defaultValue={first(current['kind'])} className={input} aria-label={t('kind')}>
        <option value="">{t('allKinds')}</option>
        {OFFER_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {tKinds(kind)}
          </option>
        ))}
      </select>

      <select name="country" defaultValue={first(current['country'])} className={input} aria-label={t('destination')}>
        <option value="">{t('allDestinations')}</option>
        {COUNTRY_CODES.map((code) => (
          <option key={code} value={code}>
            {tCountries(code)}
          </option>
        ))}
      </select>

      <select name="wilaya" defaultValue={first(current['wilaya'])} className={input} aria-label={t('departureWilaya')}>
        <option value="">{t('allWilayas')}</option>
        {WILAYAS.map((wilaya) => (
          <option key={wilaya.code} value={wilaya.code}>
            {locale === 'ar' ? wilaya.ar : wilaya.fr}
          </option>
        ))}
      </select>

      <input
        type="number"
        name="min"
        min={0}
        step={1000}
        defaultValue={first(current['min'])}
        placeholder={t('priceMin')}
        className={`${input} w-32`}
        aria-label={t('priceMin')}
      />
      <input
        type="number"
        name="max"
        min={0}
        step={1000}
        defaultValue={first(current['max'])}
        placeholder={t('priceMax')}
        className={`${input} w-32`}
        aria-label={t('priceMax')}
      />

      <label className="flex flex-col gap-1 text-xs text-slate-500">
        {t('dateFrom')}
        <input type="date" name="from" defaultValue={first(current['from'])} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500">
        {t('dateTo')}
        <input type="date" name="to" defaultValue={first(current['to'])} className={input} />
      </label>

      <select name="sort" defaultValue={first(current['sort']) || 'relevance'} className={input} aria-label={t('sort')}>
        {SORTS.map((sort) => (
          <option key={sort} value={sort}>
            {t(SORT_LABEL_KEY[sort])}
          </option>
        ))}
      </select>

      <button
        type="submit"
        className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {t('apply')}
      </button>
    </form>
  );
}
