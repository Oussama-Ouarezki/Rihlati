import { getTranslations } from 'next-intl/server';
import type { DepartureSummary, Locale } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedGet, getSession, redirectToLogin } from '@/lib/session';
import { formatDateOnly } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DeparturesPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('manifest');
  const departures = await authedGet<DepartureSummary[]>(`/v1/agencies/${agencyId}/departures`);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">{t('title')}</h2>

      {departures.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {departures.map((departure) => (
            <li key={departure.offerId}>
              <Link
                href={`/console/departures/${departure.offerId}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 p-4 hover:bg-slate-50"
              >
                <div className="min-w-52">
                  <p className="font-semibold">{departure.title}</p>
                  <p className="text-sm text-slate-500">
                    {formatDateOnly(departure.departureDate, locale as Locale)}
                    {departure.returnDate
                      ? ` → ${formatDateOnly(departure.returnDate, locale as Locale)}`
                      : ''}
                  </p>
                </div>

                <div className="flex items-center gap-4">
                  {/* The bus math: people, never rows. */}
                  <span className="text-sm font-medium text-slate-700">
                    {departure.seatsTotal
                      ? t('reservedOf', {
                          people: departure.counts.people,
                          seats: departure.seatsTotal,
                        })
                      : t('reservedNoSeats', { people: departure.counts.people })}
                  </span>
                  <span className="flex gap-2 text-sm">
                    <span className="text-amber-600">🟡 {departure.counts.expectedPeople}</span>
                    <span className="text-emerald-600">🟢 {departure.counts.checkedInPeople}</span>
                    <span className="text-red-600">🔴 {departure.counts.noShowPeople}</span>
                  </span>
                  <span className="text-sm font-medium text-brand-700">{t('openManifest')} →</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
