import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Clock, MapPin, Navigation, Phone } from 'lucide-react';
import type { Locale, PublicMilestone } from '@rihlati/shared';
import { getTripByCode } from '@/lib/api';
import { formatDateOnly } from '@/lib/format';
import { ProgrammeMap } from '@/components/ProgrammeMap';

export const dynamic = 'force-dynamic';

/**
 * Never indexed, never previewed. The URL *is* the credential, and a search
 * engine or a link-unfurling bot that follows it would publish a family's
 * itinerary. This is the one page on the site where being findable is a bug.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

const KIND_ICON: Record<string, string> = {
  meeting: '📍',
  transport: '🚌',
  flight: '✈️',
  hotel: '🏨',
  ritual: '🕋',
  ziyara: '🕌',
  meal: '🍽️',
  free_time: '🕐',
  other: '•',
};

/**
 * THE TRAVELER'S TRIP PAGE — /mon-voyage/{code}
 *
 * The client-facing half of the trip programme. An agency opens the console
 * and sees an editor; a family opens this link and sees where they have to be.
 * Same milestones, deliberately different product.
 *
 * The page answers one question first — "what happens next, and where do I
 * stand" — and only then shows the whole journey as a map. See
 * obsidian/Backend/Trip Programme.md §7.2.
 */
export default async function TripPage(props: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale: rawLocale, code } = await props.params;
  const locale = rawLocale as Locale;
  const t = await getTranslations('trip');

  const trip = await getTripByCode(code);

  // A wrong code, a cancelled booking or a closed agency all arrive here
  // identically — the API refuses to say which. For the person holding the
  // link the useful message is the same in every case.
  if (!trip) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-5xl" aria-hidden>
          🧭
        </p>
        <h1 className="mt-4 text-xl font-bold">{t('invalidTitle')}</h1>
        <p className="mt-2 text-slate-600">{t('invalidBody')}</p>
      </div>
    );
  }

  const current = trip.milestones.find((m) => m.id === trip.currentMilestoneId) ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* ---- whose trip this is ---- */}
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {t('greeting', { name: trip.contactName })}
        </p>
        <h1 className="text-2xl font-bold text-slate-900">{trip.offer.title}</h1>
        <p className="text-sm text-slate-500">
          {trip.agency.name}
          {trip.offer.departureDate ? (
            <> · {formatDateOnly(trip.offer.departureDate, locale)}</>
          ) : null}
          {' · '}
          {t('people', { count: trip.peopleCount })}
        </p>
      </header>

      {/* ---- the whole point of the page ----
          One step, large, above everything else. A traveler opens this at 4am
          in the dark to answer exactly one question. */}
      {current ? (
        <NextStepCard milestone={current} departureDate={trip.offer.departureDate} locale={locale} />
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-3xl" aria-hidden>
            🏁
          </p>
          <p className="mt-2 font-semibold">{t('tripOver')}</p>
        </div>
      )}

      {/* ---- reaching a human ----
          Kept close to the top on purpose: when the programme does not match
          reality, the agency's phone number is the feature. */}
      {trip.agency.whatsapp || trip.agency.phone ? (
        <div className="flex flex-wrap gap-2">
          {trip.agency.whatsapp ? (
            <a
              href={`https://wa.me/${trip.agency.whatsapp.replace('+', '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 rounded-xl bg-emerald-600 px-5 py-3 text-center font-semibold text-white"
            >
              {t('whatsappAgency')}
            </a>
          ) : null}
          {trip.agency.phone ? (
            <a
              href={`tel:${trip.agency.phone}`}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700"
            >
              <Phone className="size-4" aria-hidden />
              {t('callAgency')}
            </a>
          ) : null}
        </div>
      ) : null}

      {/* ---- the map ----
          Same component the offer page uses. The only difference is that this
          one knows where the group is. */}
      {trip.milestones.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t('fullProgramme')}</h2>
          <ProgrammeMap
            milestones={trip.milestones}
            currentMilestoneId={trip.currentMilestoneId}
            departureDate={trip.offer.departureDate}
          />
        </section>
      ) : null}
    </div>
  );
}

async function NextStepCard(props: {
  milestone: PublicMilestone;
  departureDate: string | null;
  locale: Locale;
}) {
  const { milestone } = props;
  const t = await getTranslations('trip');
  const tMap = await getTranslations('programmeMap');

  const date = stepDate(props.departureDate, milestone.dayOffset);

  return (
    <section className="rounded-2xl border-2 border-brand-200 bg-brand-50/50 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
        {t('nextStep')}
      </p>

      <h2 className="mt-2 flex items-start gap-3 text-xl font-bold text-slate-900">
        <span aria-hidden className="text-3xl leading-none">
          {KIND_ICON[milestone.kind] ?? '•'}
        </span>
        <span>{milestone.title}</span>
      </h2>

      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
        <span>
          {tMap('dayLabel', { day: milestone.dayOffset + 1 })}
          {date ? ` · ${formatDateOnly(date, props.locale)}` : ''}
        </span>
        {milestone.timeOfDay ? (
          <span className="flex items-center gap-1 font-semibold text-slate-900">
            <Clock className="size-4" aria-hidden />
            {milestone.timeOfDay}
          </span>
        ) : null}
      </p>

      {milestone.description ? (
        <p className="mt-3 whitespace-pre-line leading-relaxed text-slate-700">
          {milestone.description}
        </p>
      ) : null}

      {/* The sentence that matters. Bigger than the description on purpose. */}
      {milestone.meetingPoint ? (
        <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-brand-100">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-800">
            <MapPin className="size-4" aria-hidden />
            {tMap('meetingPoint')}
          </p>
          <p className="mt-1 text-lg font-medium leading-snug text-slate-900">
            {milestone.meetingPoint}
          </p>
          {milestone.locationName ? (
            <p className="mt-0.5 text-sm text-slate-500">{milestone.locationName}</p>
          ) : null}
        </div>
      ) : null}

      {milestone.mapUrl ? (
        <a
          href={milestone.mapUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 font-semibold text-white"
        >
          <Navigation className="size-4" aria-hidden />
          {tMap('openMap')}
        </a>
      ) : null}
    </section>
  );
}

/** Same arithmetic as the map: dayOffset + departure date, never stored. */
function stepDate(departureDate: string | null, dayOffset: number): string | null {
  if (!departureDate) return null;
  const date = new Date(`${departureDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}
