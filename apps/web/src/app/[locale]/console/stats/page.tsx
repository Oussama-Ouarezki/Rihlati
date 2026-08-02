import { getTranslations } from 'next-intl/server';
import type { OfferAnalytics } from '@rihlati/shared';
import { authedFetch, getSession, redirectToLogin } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The analytics dashboard — the read side of the time series the API has been
 * collecting since day one. Charts are plain flexbox bars: at 30 daily points
 * a charting library would be 100 kB of JavaScript to draw 30 divs.
 */
export default async function StatsPage() {
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('console');

  const response = await authedFetch(`/v1/agencies/${agencyId}/analytics/offers?days=30`);

  // 402 = FEATURE_NOT_IN_PLAN. The data exists — the view is what's gated —
  // so this page IS the upsell, and it says so honestly.
  if (response.status === 402) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-brand-200 bg-brand-50/40 p-10 text-center">
        <p className="text-lg font-semibold text-brand-800">{t('statsLockedTitle')}</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">{t('statsLockedBody')}</p>
      </div>
    );
  }
  if (!response.ok) throw new Error(`API ${response.status}`);
  const analytics = (await response.json()) as OfferAnalytics;

  const cards = [
    { label: t('views'), value: analytics.totals.views },
    { label: t('whatsapp'), value: analytics.totals.whatsappClicks },
    { label: t('calls'), value: analytics.totals.phoneClicks },
    { label: t('inquiries'), value: analytics.totals.inquiries },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">{t('statsTitle')}</h2>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-slate-200 p-4">
            <p className="text-2xl font-bold text-brand-700">{card.value}</p>
            <p className="text-sm text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>

      <BarChart
        title={t('viewsPerDay')}
        points={analytics.series.map((point) => ({ date: point.date, value: point.views }))}
        color="bg-brand-600"
      />
      <BarChart
        title={t('inquiriesPerDay')}
        points={analytics.series.map((point) => ({ date: point.date, value: point.inquiries }))}
        color="bg-emerald-600"
      />

      {analytics.topOffers.length > 0 ? (
        <section>
          <h3 className="mb-2 font-semibold">{t('topOffers')}</h3>
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
            {analytics.topOffers.map((offer) => (
              <li key={offer.offerId} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
                <span className="truncate">{offer.title}</span>
                <span className="flex shrink-0 gap-4 text-slate-500">
                  <span>👁 {offer.views}</span>
                  <span>💬 {offer.whatsappClicks}</span>
                  <span>✉ {offer.inquiries}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function BarChart(props: {
  title: string;
  points: Array<{ date: string; value: number }>;
  color: string;
}) {
  const max = Math.max(1, ...props.points.map((point) => point.value));

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-slate-500">{props.title}</h3>
      <div className="flex h-28 items-end gap-0.5 rounded-2xl border border-slate-200 p-3">
        {props.points.map((point) => (
          <div
            key={point.date}
            title={`${point.date}: ${point.value}`}
            className={`min-w-0 flex-1 rounded-t ${point.value > 0 ? props.color : 'bg-slate-100'}`}
            // 4% floor so a zero day is still a visible tick, not a hole.
            style={{ height: `${Math.max(4, (point.value / max) * 100)}%` }}
          />
        ))}
      </div>
    </section>
  );
}
