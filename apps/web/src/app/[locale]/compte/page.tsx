import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getSession, redirectToLogin } from '@/lib/session';
import { removeAvatar, updateAvatar } from '@/lib/account-actions';
import { logout } from '@/lib/auth-actions';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ImageUploader } from '@/components/account/ImageUploader';
import { ProfileForm } from '@/components/account/ProfileForm';

/**
 * The account page — for everyone, traveler or agency staff, because there is
 * one kind of account (see obsidian/Backend/Auth Flow.md).
 *
 * A server component: it reads the session on the server and hands plain data
 * to the two client components that need interactivity. No token reaches the
 * browser.
 */
export default async function AccountPage() {
  const session = await getSession();
  if (!session) await redirectToLogin();

  const t = await getTranslations('account');
  const user = session!.user;
  const membership = session!.membership;

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('photoTitle')}</CardTitle>
          <CardDescription>{t('photoSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ImageUploader
            action={updateAvatar}
            removeAction={removeAvatar}
            currentUrl={user.avatarUrl}
            fallback={initials(user.displayName)}
            shape="circle"
            label={user.avatarUrl ? t('changePhoto') : t('addPhoto')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('detailsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ProfileForm
            displayName={user.displayName}
            locale={user.locale}
            email={user.email}
            phone={user.phone}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('agencyTitle')}</CardTitle>
          <CardDescription>
            {membership ? t('agencyLinked', { name: membership.agencyName }) : t('agencyNone')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            nativeButton={false} render={<Link href={membership ? '/console/agence' : '/nouvelle-agence'} />}
          >
            {membership ? t('agencyManage') : t('agencyCreate')}
          </Button>
        </CardContent>
      </Card>

      <form action={logout}>
        <Button type="submit" variant="ghost" className="text-destructive">
          {t('logout')}
        </Button>
      </form>
    </div>
  );
}

/** "Amina Benali" → "AB". Falls back to one letter rather than rendering empty. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
