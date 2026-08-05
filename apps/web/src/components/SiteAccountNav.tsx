import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getSession } from '@/lib/session';
import { logout } from '@/lib/auth-actions';
import { AccountMenu } from '@/components/AccountMenu';
import { Button } from '@/components/ui/button';

/**
 * The account corner of the public header — signed out it invites you in,
 * signed in it is your avatar. It reads the session server-side, so the two
 * states are decided where the token actually lives; the browser never gets a
 * "logged in" flag it could flip. (Hiding or showing this changes nothing
 * about permissions — every API route authorizes itself. Rule #2.)
 *
 * The agency console link only appears for someone who is in an agency. A
 * traveler seeing "Espace agence" would click it and land on an invitation to
 * create an agency they never wanted.
 */
export async function SiteAccountNav() {
  const session = await getSession();
  const t = await getTranslations('nav');
  const tSignup = await getTranslations('signup');
  const tAccount = await getTranslations('account');
  const tConsole = await getTranslations('console');

  if (!session) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/connexion" />}>
          {tSignup('signIn')}
        </Button>
        <Button
          size="sm"
          className="hidden sm:inline-flex"
          nativeButton={false}
          render={<Link href="/inscription" />}
        >
          {tSignup('createAccount')}
        </Button>
      </div>
    );
  }

  const links = [
    { href: '/compte', label: tAccount('title') },
    ...(session.membership ? [{ href: '/console', label: t('agencySpace') }] : []),
  ];

  return (
    <AccountMenu
      user={{
        displayName: session.user.displayName,
        email: session.user.email,
        phone: session.user.phone,
        avatarUrl: session.user.avatarUrl,
      }}
      {...(session.membership ? { agencyName: session.membership.agencyName } : {})}
      links={links}
      showLanguageSwitcher={false}
      logoutLabel={tConsole('logout')}
      logoutAction={logout}
    />
  );
}
