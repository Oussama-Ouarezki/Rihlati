import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  LEAD_PIPELINE_COLUMNS,
  LEAD_QUALITIES,
  type LeadDetail,
  type Locale,
} from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { authedFetch, getSession, redirectToLogin } from '@/lib/session';
import { addLeadNote, updateLead } from '@/lib/lead-actions';
import { reserveFromLead } from '@/lib/reservation-actions';
import { formatDateOnly } from '@/lib/format';
import { QualityBadge, StageBadge } from '@/components/console/Badges';

export const dynamic = 'force-dynamic';

export default async function LeadDetailPage(props: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await props.params;
  const locale = rawLocale as Locale;

  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const response = await authedFetch(`/v1/agencies/${agencyId}/leads/${id}`);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API ${response.status}`);
  const lead = (await response.json()) as LeadDetail;

  const t = await getTranslations('console');
  const tManifest = await getTranslations('manifest');
  const tStages = await getTranslations('stages');
  const tQualities = await getTranslations('qualities');

  const select =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none';

  const updateAction = updateLead.bind(null, lead.id);
  const reserveAction = reserveFromLead.bind(null, lead.id);
  const noteAction = addLeadNote.bind(null, lead.id);

  return (
    <div className="space-y-6">
      <Link href="/console/leads" className="text-sm text-slate-500 hover:text-brand-700">
        {t('back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">{lead.contactName}</h2>
          <p className="text-slate-500" dir="ltr">
            <a href={`tel:${lead.contactPhone}`} className="hover:text-brand-700">
              {lead.contactPhone}
            </a>
            {lead.contactEmail ? <span> · {lead.contactEmail}</span> : null}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {t('receivedOn', { date: formatDateOnly(lead.createdAt.slice(0, 10), locale) })}
            {lead.peopleCount ? <span> · {t('people', { count: lead.peopleCount })}</span> : null}
          </p>
        </div>
        <div className="flex gap-2">
          <StageBadge stage={lead.stage} label={tStages(lead.stage)} />
          <QualityBadge quality={lead.quality} label={tQualities(lead.quality)} />
        </div>
      </div>

      {lead.offer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-50 px-4 py-2">
          <p className="text-sm text-brand-800">{t('aboutOffer', { title: lead.offer.title })}</p>
          {/* The CRM → manifest bridge: one tap turns a booked client into a
              row on the departure list, contact copied server-side. */}
          <form action={reserveAction}>
            <button
              type="submit"
              className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
            >
              {tManifest('addToDeparture')}
            </button>
          </form>
        </div>
      ) : null}

      {lead.message ? (
        <blockquote className="whitespace-pre-line rounded-xl border-s-4 border-slate-200 bg-slate-50 p-4 text-slate-700">
          {lead.message}
        </blockquote>
      ) : null}

      {/* ---- follow-up: stage + quality ---- */}
      <form action={updateAction} className="rounded-2xl border border-slate-200 p-4">
        <h3 className="mb-3 font-semibold">{t('updateTitle')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('stage')}</span>
            <select name="stage" defaultValue={lead.stage} className={select}>
              {[...LEAD_PIPELINE_COLUMNS, 'lost' as const].map((stage) => (
                <option key={stage} value={stage}>
                  {tStages(stage)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('quality')}</span>
            <select name="quality" defaultValue={lead.quality} className={select}>
              {LEAD_QUALITIES.map((quality) => (
                <option key={quality} value={quality}>
                  {tQualities(quality)}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              className="w-full rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              {t('save')}
            </button>
          </div>
        </div>
      </form>

      {/* ---- notes ---- */}
      <section className="rounded-2xl border border-slate-200 p-4">
        <h3 className="mb-3 font-semibold">{t('notesTitle')}</h3>

        <form action={noteAction} className="mb-4 flex gap-2">
          <input
            name="body"
            placeholder={t('notePlaceholder')}
            className={`${select} flex-1`}
            maxLength={4000}
          />
          <button
            type="submit"
            className="rounded-xl border border-brand-200 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            {t('addNote')}
          </button>
        </form>

        {lead.notes.length === 0 ? (
          <p className="text-sm text-slate-400">{t('notesEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {lead.notes.map((note) => (
              <li key={note.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                <p className="whitespace-pre-line">{note.body}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {formatDateOnly(note.createdAt.slice(0, 10), locale)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- system timeline, read-only ---- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-500">{t('activityTitle')}</h3>
        <ul className="space-y-1 text-xs text-slate-400">
          {lead.activities.map((activity) => (
            <li key={activity.id}>
              {formatDateOnly(activity.createdAt.slice(0, 10), locale)} — {activity.type}
              {typeof activity.payload['to'] === 'string' ? ` → ${activity.payload['to']}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
