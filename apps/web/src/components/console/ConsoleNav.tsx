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

export interface ConsoleNavLink {
  href: string;
  label: string;
}

/**
 * The console's whole navigation surface — one component so mobile and
 * desktop never drift into two different link lists.
 *
 * Desktop: a plain row of links. Mobile: a hamburger opens a drawer with the
 * same links, stacked and thumb-sized.
 *
 * No account avatar here — the site header sits directly above this one on
 * every console page and already carries it (§SiteAccountNav). Two avatars
 * stacked ten pixels apart is worse than one, and "where do I sign out" must
 * have exactly one answer.
 */
export function ConsoleNav(props: {
  links: ConsoleNavLink[];
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
    </div>
  );
}
