import { getTranslations } from 'next-intl/server';
import { getSession, redirectToLogin } from '@/lib/session';
import { getMyAgency, submitAgencyForReview, updateAgency } from '@/lib/agency-actions';
import { removeAgencyLogo, updateAgencyLogo } from '@/lib/account-actions';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ImageUploader } from '@/components/account/ImageUploader';
import { AgencyForm } from '@/components/account/AgencyForm';

/**
 * The agency's own profile — its logo, description, contact details and wilaya.
 *
 * This page is also, in practice, the search page: the wilaya, the city and the
 * description are what a traveler filters and searches on, and a verified badge
 * is what makes them click. An agency that skips this is invisible.
 */
export default async function AgencySettingsPage() {
  const session = await getSession();
  if (!session) await redirectToLogin();

  const t = await getTranslations('agencyForm');
  const agency = await getMyAgency();
  if (!agency) return <p className="py-10 text-slate-600">{t('errGeneric')}</p>;

  // Only the owner may ask for verification; the API enforces this too, and it
  // is the API's answer that counts. Hiding the button is just tidiness.
  const isOwner = agency.yourRole === 'owner';
  const canSubmit = isOwner && (agency.status === 'draft' || agency.status === 'rejected');

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('settingsTitle')}</h1>
        <StatusBadge status={agency.status} label={t(`status_${agency.status}`)} />
      </div>

      {agency.status === 'rejected' && agency.rejectionReason ? (
        <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-900">
          {t('rejectedReason', { reason: agency.rejectionReason })}
        </p>
      ) : null}

      {canSubmit ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('verifyTitle')}</CardTitle>
            <CardDescription>{t('verifyBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={submitAgencyForReview}>
              <Button type="submit">{t('verifySubmit')}</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('logoTitle')}</CardTitle>
          <CardDescription>{t('logoSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ImageUploader
            action={updateAgencyLogo}
            removeAction={removeAgencyLogo}
            currentUrl={agency.logoUrl}
            fallback={agency.name.slice(0, 1).toUpperCase()}
            shape="square"
            label={agency.logoUrl ? t('changeLogo') : t('addLogo')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <AgencyForm action={updateAgency} agency={agency} submitLabel={t('saveSubmit')} />
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge(props: { status: string; label: string }) {
  const variant =
    props.status === 'verified' ? 'default'
    : props.status === 'rejected' || props.status === 'suspended' ? 'destructive'
    : 'secondary';
  return <Badge variant={variant}>{props.label}</Badge>;
}
