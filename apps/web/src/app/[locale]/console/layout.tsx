import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getSession, redirectToLogin } from '@/lib/session';
import { logout } from '@/lib/auth-actions';
import { ConsoleNav, type ConsoleNavLink } from '@/components/console/ConsoleNav';
import { Button } from '@/components/ui/button';

/**
 * The agency console shell. The session check here is UX — the API rejects an
 * unauthenticated request on its own (rule #2); this just spares the user a
 * screen of errors and sends them to login instead.
 */
export default async function ConsoleLayout(props: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) await redirectToLogin();

  const t = await getTranslations('console');
  const tManifest = await getTranslations('manifest');
  const tLinks = await getTranslations('links');
  const tOffers = await getTranslations('offerForm');
  const tAgency = await getTranslations('agencyForm');
  const membership = session!.membership;

  if (!membership) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">{t('noAgencyTitle')}</h1>
        <p className="mt-2 text-slate-600">{t('noAgencyBody')}</p>
        <Button className="mt-6" size="lg" nativeButton={false} render={<Link href="/nouvelle-agence" />}>
          {tAgency('createSubmit')}
        </Button>
      </div>
    );
  }

  const navLinks: ConsoleNavLink[] = [
    { href: '/console/offers', label: tOffers('nav') },
    { href: '/console/leads', label: t('navLeads') },
    { href: '/console/departures', label: tManifest('navDepartures') },
    { href: '/console/links', label: tLinks('nav') },
    { href: '/console/stats', label: t('navStats') },
    { href: '/console/faq', label: t('navFaq') },
    { href: '/console/agence', label: tAgency('nav') },
  ];

  return (
    <div className="space-y-6">
      <header className="-mx-4 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:mx-0 sm:rounded-2xl sm:border sm:shadow-sm">
        <Link href="/console/offers" className="min-w-0 truncate font-bold leading-tight">
          {membership.agencyName}
        </Link>

        <ConsoleNav
          links={navLinks}
          user={{
            displayName: session!.user.displayName,
            email: session!.user.email,
            phone: session!.user.phone,
            avatarUrl: session!.user.avatarUrl,
          }}
          agencyName={membership.agencyName}
          logoutLabel={t('logout')}
          logoutAction={logout}
          openMenuLabel={t('openMenu')}
        />
      </header>

      {props.children}
    </div>
  );
}
