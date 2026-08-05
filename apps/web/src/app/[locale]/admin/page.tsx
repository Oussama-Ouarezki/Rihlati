import { getLocale, getTranslations } from 'next-intl/server';
import type { AgencyStatus, Locale } from '@rihlati/shared';
import { getSession, redirectToLogin } from '@/lib/session';
import { listAgenciesForReview, rejectAgency, verifyAgency } from '@/lib/admin-actions';
import { wilayaName } from '@/lib/format';
import { ReviewCard } from '@/components/admin/ReviewCard';
import { Link } from '@/i18n/navigation';

/**
 * RIHLATI'S OWN BACK OFFICE — the verification queue.
 *
 * The `isPlatformAdmin` check below is NOT the security. It spares a traveler
 * who guesses the URL a screen of failed requests, nothing more. The security
 * is `@PlatformAdminOnly()` on the API controller: if this check were deleted,
 * the page would render and every request behind it would still come back 403.
 * That is the arrangement rule #2 asks for — the UI hides, the server refuses.
 */
export default async function AdminPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) await redirectToLogin();

  const t = await getTranslations('admin');
  const locale = (await getLocale()) as Locale;

  if (!session!.user.isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">{t('notAdminTitle')}</h1>
        <p className="mt-2 text-slate-600">{t('notAdminBody')}</p>
        <Link href="/" className="mt-6 inline-block text-sm underline">
          {t('backHome')}
        </Link>
      </div>
    );
  }

  const requested = (await props.searchParams).status;
  const status: AgencyStatus = TABS.includes(requested as AgencyStatus)
    ? (requested as AgencyStatus)
    : 'pending_review';

  const agencies = await listAgenciesForReview(status);

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-slate-600">{t('subtitle')}</p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={`/admin?status=${tab}`}
            className={
              tab === status
                ? 'rounded-full bg-slate-900 px-4 py-1.5 text-sm font-medium text-white'
                : 'rounded-full bg-slate-100 px-4 py-1.5 text-sm font-medium text-slate-700'
            }
          >
            {t(`tab_${tab}`)}
          </Link>
        ))}
      </nav>

      {agencies.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-slate-600">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-4">
          {agencies.map((agency) => (
            <ReviewCard
              key={agency.id}
              agency={agency}
              verifyAction={verifyAgency}
              rejectAction={rejectAgency}
              waitingDays={daysSince(agency.submittedForReviewAt)}
              wilaya={wilayaName(agency.wilayaCode, locale)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The three states worth looking at. `draft` is absent on purpose: an agency
 * that has not asked for review is nobody's work item, and listing it invites
 * approving someone who never applied.
 */
const TABS: AgencyStatus[] = ['pending_review', 'verified', 'rejected'];

/** Whole days, floored — "waiting 6 days" is the number a reviewer acts on. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const elapsed = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}
