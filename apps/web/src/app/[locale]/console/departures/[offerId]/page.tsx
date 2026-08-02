import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Locale, Manifest, ReservationItem } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, getSession, redirectToLogin } from '@/lib/session';
import { formatDateOnly } from '@/lib/format';
import {
  createManualReservation,
  issueTripLink,
  setReservationStatus,
} from '@/lib/reservation-actions';

export const dynamic = 'force-dynamic';

/**
 * Where the traveler's page lives. Not a secret — it is the same address the
 * family's browser will hit — so a NEXT_PUBLIC_ variable is the right home
 * for it (rule #1: those ship to the browser, so they must never hold one).
 */
const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000';

/**
 * THE CHECK-IN SCREEN — designed for a phone held in one hand next to a bus
 * at 4am: rows the height of a thumb, one tap per family, colour legible in
 * bad light. Everything else in the console can be dense; this page cannot.
 */
export default async function ManifestPage(props: {
  params: Promise<{ locale: string; offerId: string }>;
}) {
  const { locale: rawLocale, offerId } = await props.params;
  const locale = rawLocale as Locale;

  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const response = await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}/manifest`);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API ${response.status}`);
  const manifest = (await response.json()) as Manifest;

  const t = await getTranslations('manifest');
  const input =
    'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none';

  const addAction = createManualReservation.bind(null, manifest.offer.id);

  return (
    <div className="space-y-4">
      <Link href="/console/departures" className="text-sm text-slate-500 hover:text-brand-700">
        ← {t('title')}
      </Link>

      {/* ---- header: the numbers the accompagnateur actually needs ---- */}
      <div className="rounded-2xl border border-slate-200 p-4">
        <h2 className="text-lg font-bold">{manifest.offer.title}</h2>
        <p className="text-sm text-slate-500">
          {manifest.offer.departureDate
            ? formatDateOnly(manifest.offer.departureDate, locale)
            : null}
        </p>

        <div className="mt-3 flex flex-wrap gap-2 text-sm font-medium">
          <span className="rounded-full bg-slate-100 px-3 py-1">
            {manifest.offer.seatsTotal
              ? t('reservedOf', { people: manifest.counts.people, seats: manifest.offer.seatsTotal })
              : t('reservedNoSeats', { people: manifest.counts.people })}
          </span>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">
            🟡 {t('statusExpected')} · {manifest.counts.expectedPeople}
          </span>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
            🟢 {t('statusCheckedIn')} · {manifest.counts.checkedInPeople}
          </span>
          <span className="rounded-full bg-red-50 px-3 py-1 text-red-700">
            🔴 {t('statusNoShow')} · {manifest.counts.noShowPeople}
          </span>
        </div>
      </div>

      {/* ---- the list ---- */}
      {manifest.reservations.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
          {t('emptyManifest')}
        </p>
      ) : (
        <ul className="space-y-2">
          {manifest.reservations.map((reservation) => (
            <ManifestRow key={reservation.id} reservation={reservation} locale={locale} />
          ))}
        </ul>
      )}

      {/* ---- walk-in add ---- */}
      <form action={addAction} className="space-y-3 rounded-2xl border border-dashed border-slate-300 p-4">
        <h3 className="text-sm font-semibold text-slate-600">{t('addReservation')}</h3>
        <div className="flex flex-wrap gap-2">
          <input name="name" placeholder={t('name')} required minLength={2} className={`${input} min-w-40 flex-1`} />
          <input name="phone" type="tel" dir="ltr" placeholder={t('phone')} required className={`${input} w-40`} />
          <input
            name="people"
            type="number"
            min={1}
            max={200}
            defaultValue={1}
            aria-label={t('peopleShort')}
            className={`${input} w-20`}
          />
          <input name="notes" placeholder={t('notes')} className={`${input} min-w-40 flex-1`} />
          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('add')}
          </button>
        </div>
      </form>
    </div>
  );
}

const ROW_STYLE: Record<string, string> = {
  expected: 'border-amber-200 bg-amber-50/50',
  checked_in: 'border-emerald-200 bg-emerald-50/60',
  no_show: 'border-red-200 bg-red-50/50',
  cancelled: 'border-slate-200 bg-slate-50 opacity-60',
};

async function ManifestRow(props: { reservation: ReservationItem; locale: Locale }) {
  const { reservation } = props;
  const t = await getTranslations('manifest');

  const arrived = setReservationStatus.bind(null, reservation.id, 'checked_in');
  const absent = setReservationStatus.bind(null, reservation.id, 'no_show');
  const expected = setReservationStatus.bind(null, reservation.id, 'expected');

  const bigButton = 'rounded-xl px-4 py-3 text-sm font-bold'; // thumb-sized

  return (
    <li className={`rounded-2xl border p-3 ${ROW_STYLE[reservation.status] ?? ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-40 flex-1">
          <p className="text-base font-bold">
            {reservation.contactName}
            <span className="ms-2 rounded-full bg-white px-2 py-0.5 text-sm font-semibold text-slate-600">
              ×{reservation.peopleCount}
            </span>
          </p>
          <p className="text-sm text-slate-500" dir="ltr">
            <a href={`tel:${reservation.contactPhone}`}>{reservation.contactPhone}</a>
          </p>
          {reservation.notes ? (
            <p className="text-xs text-slate-500">📝 {reservation.notes}</p>
          ) : null}
          {reservation.checkedInAt ? (
            <p className="text-xs text-emerald-700">
              {t('checkedInAt', {
                // hourCycle forced: fr-DZ defaults to a 12-hour clock in
                // Node's ICU, and "01:26" for a 13:26 check-in reads as 4am.
                time: new Intl.DateTimeFormat('fr-DZ', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                  timeZone: 'Africa/Algiers',
                }).format(new Date(reservation.checkedInAt)),
              })}
            </p>
          ) : null}

          <TripLink reservation={reservation} />
        </div>

        <div className="flex gap-2">
          {reservation.status !== 'checked_in' ? (
            <form action={arrived}>
              <button type="submit" className={`${bigButton} bg-emerald-600 text-white hover:bg-emerald-700`}>
                {t('markArrived')}
              </button>
            </form>
          ) : null}
          {reservation.status === 'expected' ? (
            <form action={absent}>
              <button type="submit" className={`${bigButton} bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50`}>
                {t('markAbsent')}
              </button>
            </form>
          ) : null}
          {reservation.status !== 'expected' ? (
            // The undo — the most common tap after a wrong tap.
            <form action={expected}>
              <button type="submit" className={`${bigButton} bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50`}>
                {t('markExpected')}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The family's own /mon-voyage link, ready to paste into WhatsApp.
 *
 * This is the delivery mechanism for the whole traveler-facing programme: the
 * page exists, but nobody reaches it unless the agency sends the link. So it
 * lives on the manifest, next to the family it belongs to, rather than behind
 * a menu.
 */
async function TripLink(props: { reservation: ReservationItem }) {
  const { reservation } = props;
  const t = await getTranslations('manifest');

  if (!reservation.publicCode) {
    // A reservation from before the column existed. One tap mints a code.
    const issue = issueTripLink.bind(null, reservation.id);
    return (
      <form action={issue}>
        <button type="submit" className="mt-1 text-xs font-medium text-brand-700 hover:underline">
          {t('issueTripLink')}
        </button>
      </form>
    );
  }

  const url = `${SITE_URL}/mon-voyage/${reservation.publicCode}`;
  const message = t('tripLinkMessage', { name: reservation.contactName, url });

  return (
    <p className="mt-1 flex flex-wrap items-center gap-3 text-xs">
      <a
        href={`https://wa.me/${reservation.contactPhone.replace('+', '')}?text=${encodeURIComponent(message)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-emerald-700 hover:underline"
      >
        {t('sendTripLink')}
      </a>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-slate-400 hover:text-brand-700 hover:underline"
      >
        {t('previewTripLink')}
      </a>
    </p>
  );
}
