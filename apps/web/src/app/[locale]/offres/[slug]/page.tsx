import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, getTranslations } from 'next-intl/server';
import type { Locale } from '@rihlati/shared';
import { getAgencyFaq, getOfferBySlug } from '@/lib/api';
import { formatDateOnly, price, wilayaName } from '@/lib/format';
import { ContactButtons } from '@/components/ContactButtons';
import { InquiryForm } from '@/components/InquiryForm';
import { AttributeList } from '@/components/AttributeList';
import { ProgrammeMap } from '@/components/ProgrammeMap';
import { RefCapture } from '@/components/RefCapture';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const offer = await getOfferBySlug(slug);
  if (!offer) return {};
  return {
    title: `${offer.title} — ${offer.agency.name} | Rihlati`,
    description: offer.summary ?? offer.title,
  };
}

export default async function OfferPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ ref?: string }>;
}) {
  const { locale: rawLocale, slug } = await props.params;
  const { ref } = await props.searchParams;
  const locale = rawLocale as Locale;

  const offer = await getOfferBySlug(slug);
  if (!offer) notFound();

  const t = await getTranslations('offer');
  const tCommon = await getTranslations('common');
  const tKinds = await getTranslations('kinds');
  const messages = await getMessages();

  // The agency's FAQ, straight onto the offer page — the same entries the
  // chatbot will answer from later. A failed fetch renders nothing: FAQ is
  // garnish, never a reason for the page to 500.
  const faq = await getAgencyFaq(offer.agency.slug).catch(() => null);

  const cover = offer.media.find((m) => m.kind === 'image');
  const departure = wilayaName(offer.departureWilayaCode, locale);

  return (
    <article className="mx-auto max-w-4xl space-y-8">
      {/* Remembers which tracked link brought this visitor, for the form. */}
      <RefCapture code={ref ?? null} />

      {/* ---- hero ---- */}
      <div className="overflow-hidden rounded-2xl border border-slate-200">
        <div className="relative aspect-[2/1] bg-slate-100">
          {cover ? (
              <img src={cover.url} alt={cover.alt ?? offer.title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-6xl text-slate-300">✈</div>
          )}
          <span className="absolute start-3 top-3 rounded-full bg-white/95 px-3 py-1 text-sm font-medium">
            {tKinds(offer.kind)}
          </span>
        </div>

        <div className="space-y-4 p-5">
          <h1 className="text-2xl font-bold text-slate-900">{offer.title}</h1>
          {offer.summary ? <p className="text-slate-600">{offer.summary}</p> : null}

          <div className="flex flex-wrap items-end justify-between gap-4">
            <p>
              <span className="me-2 text-sm text-slate-500">{tCommon('from')}</span>
              <span className="text-3xl font-bold text-brand-700">
                {price(offer.priceFromCentimes, locale)}
              </span>
              {offer.priceToCentimes ? (
                <span className="ms-2 text-sm text-slate-500">
                  — {price(offer.priceToCentimes, locale)}
                </span>
              ) : null}
              <span className="ms-2 block text-xs text-slate-400">{t('priceNote')}</span>
            </p>

            <ContactButtons
              offerId={offer.id}
              offerTitle={offer.title}
              whatsapp={offer.agency.whatsapp}
              phone={offer.agency.phone}
            />
          </div>

          {/* ---- key facts ---- */}
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-4">
            {offer.departureDate ? (
              <Fact label={t('departure')} value={formatDateOnly(offer.departureDate, locale)} />
            ) : null}
            {offer.returnDate ? (
              <Fact label={t('return')} value={formatDateOnly(offer.returnDate, locale)} />
            ) : null}
            {offer.durationDays ? (
              <Fact label={t('duration')} value={t('days', { count: offer.durationDays })} />
            ) : null}
            {departure ? <Fact label={t('departureFrom')} value={departure} /> : null}
            {offer.isFlexibleDates ? <Fact label="" value={t('flexibleDates')} /> : null}
            {offer.seatsLeft !== null ? (
              <Fact label="" value={t('seatsLeft', { count: offer.seatsLeft })} highlight />
            ) : null}
          </dl>
        </div>
      </div>

      {/* ---- programme ----
          The description stays as the prose introduction; the map underneath
          is the structured programme. A buyer gets no "you are here" marker —
          the trip has not started — and no meeting points, which the API
          withholds until they have actually booked. */}
      {offer.description || offer.milestones.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t('program')}</h2>
          {offer.description ? (
            <p className="mb-6 whitespace-pre-line leading-relaxed text-slate-700">
              {offer.description}
            </p>
          ) : null}
          <ProgrammeMap milestones={offer.milestones} departureDate={offer.departureDate} />
        </section>
      ) : null}

      {/* ---- kind-specific details ---- */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">{t('details')}</h2>
        <AttributeList attributes={offer.attributes} messages={messages} />
      </section>

      {/* ---- the agency ---- */}
      <section className="rounded-2xl border border-slate-200 p-5">
        <h2 className="mb-3 text-lg font-semibold">{t('aboutAgency')}</h2>
        <div className="flex items-center gap-3">
          {offer.agency.logoUrl ? (
              <img src={offer.agency.logoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 font-bold text-brand-700">
              {offer.agency.name.slice(0, 1)}
            </div>
          )}
          <div>
            <p className="flex items-center gap-2 font-semibold">
              {offer.agency.name}
              {offer.agency.isVerified ? (
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                  ✓ {tCommon('verified')}
                </span>
              ) : null}
            </p>
            <p className="text-sm text-slate-500">
              {offer.agency.rating !== null ? <span className="text-amber-600">★ {offer.agency.rating} · </span> : null}
              {t('reviews', { count: offer.agency.ratingCount })}
              {wilayaName(offer.agency.wilayaCode, locale) ? (
                <span> · {wilayaName(offer.agency.wilayaCode, locale)}</span>
              ) : null}
            </p>
          </div>
        </div>

        {faq && faq.length > 0 ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-600">{t('faqTitle')}</h3>
            <div className="space-y-2">
              {faq.map((entry) => (
                <details key={entry.id} className="rounded-lg bg-slate-50 p-3">
                  <summary className="cursor-pointer text-sm font-medium">{entry.question}</summary>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{entry.answer}</p>
                </details>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* ---- the conversion event ---- */}
      <section id="inquiry" className="rounded-2xl border-2 border-brand-100 bg-brand-50/40 p-5">
        <InquiryForm offerId={offer.id} />
      </section>
    </article>
  );
}

function Fact(props: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      {props.label ? <dt className="text-xs text-slate-400">{props.label}</dt> : null}
      <dd className={props.highlight ? 'font-medium text-orange-600' : 'font-medium'}>
        {props.value}
      </dd>
    </div>
  );
}
