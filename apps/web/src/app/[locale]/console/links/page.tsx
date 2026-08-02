import { getTranslations } from 'next-intl/server';
import type { OfferForAgency, Page, TrackedLinkList } from '@rihlati/shared';
import { authedGet, getSession, redirectToLogin } from '@/lib/session';
import { createTrackedLink, deleteTrackedLink } from '@/lib/link-actions';
import { CopyButton } from '@/components/console/CopyButton';

export const dynamic = 'force-dynamic';

/**
 * "Which of my posts actually brings clients?"
 *
 * Clicks are shown, but quietly — `clients` is the number in brand colour,
 * because an agency optimising for clicks optimises for the wrong thing.
 */
export default async function LinksPage() {
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('links');

  const [links, offers] = await Promise.all([
    authedGet<TrackedLinkList>(`/v1/agencies/${agencyId}/tracked-links`),
    authedGet<Page<OfferForAgency>>(`/v1/agencies/${agencyId}/offers?limit=100`),
  ]);

  const atLimit = links.limit !== null && links.used >= links.limit;
  const input =
    'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{t('title')}</h2>
          <p className="max-w-2xl text-sm text-slate-500">{t('intro')}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
          {links.limit === null
            ? t('usedUnlimited', { used: links.used })
            : t('used', { used: links.used, limit: links.limit })}
        </span>
      </div>

      {links.items.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {links.items.map((link) => {
            const removeAction = deleteTrackedLink.bind(null, link.id);
            return (
              <li key={link.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-52 flex-1">
                    <p className="font-semibold">{link.label}</p>
                    <p className="text-xs text-slate-400">
                      {link.offerTitle ?? t('wholeCatalogue')}
                    </p>
                    <code className="mt-1 block text-xs text-slate-500" dir="ltr">
                      {link.url}
                    </code>
                  </div>

                  <div className="flex items-center gap-5 text-center">
                    <div>
                      <p className="text-lg font-semibold text-slate-500">{link.clickCount}</p>
                      <p className="text-xs text-slate-400">{t('clicks')}</p>
                    </div>
                    {/* The number that matters, in brand colour. */}
                    <div>
                      <p className="text-2xl font-bold text-brand-700">{link.inquiryCount}</p>
                      <p className="text-xs text-slate-500">{t('clients')}</p>
                    </div>
                    <div className="min-w-20">
                      <p className="text-sm font-medium text-emerald-700">
                        {link.conversionRate === null
                          ? '—'
                          : `${Math.round(link.conversionRate * 100)}%`}
                      </p>
                      <p className="text-xs text-slate-400">
                        {link.conversionRate === null ? t('noClicksYet') : t('conversion')}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <CopyButton value={link.url} label={t('copy')} />
                    <form action={removeAction}>
                      <button
                        type="submit"
                        className="rounded-full border border-red-100 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        {t('delete')}
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {atLimit ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{t('limitReached')}</p>
      ) : (
        <form action={createTrackedLink} className="flex flex-wrap items-end gap-2 rounded-2xl border border-dashed border-slate-300 p-4">
          <label className="min-w-52 flex-1">
            <span className="mb-1 block text-xs text-slate-500">{t('label')}</span>
            <input name="label" required minLength={2} maxLength={80} placeholder={t('labelPlaceholder')} className={`${input} w-full`} />
          </label>
          <label>
            <span className="mb-1 block text-xs text-slate-500">{t('targetOffer')}</span>
            <select name="offerId" defaultValue="" className={input}>
              <option value="">{t('wholeCatalogue')}</option>
              {offers.items.map((offer) => (
                <option key={offer.id} value={offer.id}>
                  {offer.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('create')}
          </button>
        </form>
      )}
    </div>
  );
}
