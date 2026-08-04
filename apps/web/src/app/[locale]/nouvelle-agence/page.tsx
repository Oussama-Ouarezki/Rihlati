import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { getSession, redirectToLogin } from '@/lib/session';
import { createAgency } from '@/lib/agency-actions';
import { Card, CardContent } from '@/components/ui/card';
import { AgencyForm } from '@/components/account/AgencyForm';

/**
 * Agency self-signup — the step that used to require Rihlati to run SQL by hand.
 *
 * It sits OUTSIDE `/console` deliberately. The console layout renders a nav
 * built from the current agency, so every page under it presumes one exists —
 * and this is precisely the page for someone who has none yet.
 */
export default async function NewAgencyPage() {
  const session = await getSession();
  if (!session) await redirectToLogin();

  // One agency per person for now (a spam control — see AgenciesService.create).
  // Sending them to the settings page is friendlier than an error they can do
  // nothing about; the API would refuse anyway.
  if (session!.membership) {
    redirect({ href: '/console/agence', locale: await getLocale() });
  }

  const t = await getTranslations('agencyForm');

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <div>
        <h1 className="text-2xl font-bold">{t('createTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('createSubtitle')}</p>
      </div>

      <div className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900">
        {t('reviewNotice')}
      </div>

      <Card>
        <CardContent className="pt-6">
          <AgencyForm action={createAgency} submitLabel={t('createSubmit')} />
        </CardContent>
      </Card>
    </div>
  );
}
