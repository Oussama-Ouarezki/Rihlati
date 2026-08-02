'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Menu } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';
import { isRtl, type Locale } from '@rihlati/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { AccountMenu, type AccountMenuUser } from '@/components/console/AccountMenu';

export interface ConsoleNavLink {
  href: string;
  label: string;
}

/**
 * The console's whole navigation surface — one component so mobile and
 * desktop never drift into two different link lists.
 *
 * Desktop: a plain row of links, plus the account avatar (§AccountMenu) —
 * NOT a language switcher and a logout button loose in the same row. That
 * used to sit at the far end of six links in muted gray text and nobody
 * found it. Mobile: a hamburger opens a drawer with the same links, stacked
 * and thumb-sized; the account avatar sits next to the hamburger, same as
 * desktop, so "where's my account" is answered identically either way.
 */
export function ConsoleNav(props: {
  links: ConsoleNavLink[];
  user: AccountMenuUser;
  agencyName: string;
  logoutLabel: string;
  logoutAction: () => Promise<void>;
  openMenuLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  // The drawer must open from the SCREEN edge the reader starts from — the
  // left in French/English, the right in Arabic. Sheet's `side` is a literal
  // physical value, so the direction is resolved here, once.
  const drawerSide = isRtl(locale) ? 'right' : 'left';

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const accountMenu = (
    <AccountMenu
      user={props.user}
      agencyName={props.agencyName}
      logoutLabel={props.logoutLabel}
      logoutAction={props.logoutAction}
    />
  );

  return (
    <div className="flex items-center gap-3">
      {/* ---- desktop: a plain link row ---- */}
      <nav className="hidden items-center gap-1 md:flex">
        {props.links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              buttonVariants({ variant: isActive(link.href) ? 'secondary' : 'ghost', size: 'sm' }),
              'rounded-full',
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* ---- mobile: one button opens a drawer of just the nav links ---- */}
      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button variant="outline" size="icon" aria-label={props.openMenuLabel} />}
          >
            <Menu />
          </SheetTrigger>
          <SheetContent side={drawerSide} className="w-72">
            <SheetHeader>
              <SheetTitle>Rihlati</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-4 pb-4">
              {props.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    buttonVariants({ variant: isActive(link.href) ? 'secondary' : 'ghost' }),
                    'h-11 justify-start text-base',
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      {accountMenu}
    </div>
  );
}
