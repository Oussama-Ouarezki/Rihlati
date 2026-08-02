import { getTranslations } from 'next-intl/server';
import { LEAD_PIPELINE_COLUMNS, type LeadSummary, type Locale, type Page } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { getSession, authedGet, redirectToLogin } from '@/lib/session';
import { formatDateOnly } from '@/lib/format';
import { QualityBadge, StageBadge } from '@/components/console/Badges';

export const dynamic = 'force-dynamic';

export default async function LeadsPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ stage?: string; cursor?: string }>;
}) {
  const { locale } = await props.params;
  const { stage, cursor } = await props.searchParams;
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('console');
  const tStages = await getTranslations('stages');

  const query = new URLSearchParams({ limit: '30' });
  if (stage) query.set('stage', stage);
  if (cursor) query.set('cursor', cursor);

  const page = await authedGet<Page<LeadSummary>>(
    `/v1/agencies/${agencyId}/leads?${query.toString()}`,
  );

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">{t('inboxTitle')}</h2>

      {/* Stage tabs — plain links, so the filter is in the URL like everywhere */}
      <nav className="flex flex-wrap gap-1">
        <StageTab href="/console/leads" active={!stage} label={t('allStages')} />
        {[...LEAD_PIPELINE_COLUMNS, 'lost' as const].map((column) => (
          <StageTab
            key={column}
            href={`/console/leads?stage=${column}`}
            active={stage === column}
            label={tStages(column)}
          />
        ))}
      </nav>

      {page.items.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
          {t('inboxEmpty')}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {page.items.map((lead) => (
            <li key={lead.id}>
              <Link
                href={`/console/leads/${lead.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-slate-50"
              >
                <div className="min-w-40 flex-1">
                  <p className="font-semibold">{lead.contactName}</p>
                  {/* The phone stays LTR even in Arabic — numbers read one way */}
                  <p className="text-sm text-slate-500" dir="ltr">
                    {lead.contactPhone}
                  </p>
                </div>

                {lead.offer ? (
                  <p className="hidden max-w-60 truncate text-sm text-slate-400 md:block">
                    {lead.offer.title}
                  </p>
                ) : null}

                {/* Where this client came from — the tracked link's own name. */}
                {lead.sourceLabel ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    ↗ {lead.sourceLabel}
                  </span>
                ) : null}

                {lead.peopleCount ? (
                  <span className="text-sm text-slate-500">
                    {t('people', { count: lead.peopleCount })}
                  </span>
                ) : null}

                <StageBadge stage={lead.stage} label={tStages(lead.stage)} />
                <QualityBadge quality={lead.quality} />

                <span className="text-xs text-slate-400">
                  {formatDateOnly(lead.createdAt.slice(0, 10), locale as Locale)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={`/console/leads?${stage ? `stage=${stage}&` : ''}cursor=${page.nextCursor}`}
            className="rounded-full border border-brand-200 px-6 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function StageTab(props: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={props.href}
      className={
        props.active
          ? 'rounded-full bg-brand-600 px-3 py-1 text-sm font-medium text-white'
          : 'rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 hover:bg-slate-200'
      }
    >
      {props.label}
    </Link>
  );
}
