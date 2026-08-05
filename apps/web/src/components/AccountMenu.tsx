'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Link } from '@/i18n/navigation';
import { LogOut } from 'lucide-react';

export interface AccountMenuUser {
  displayName: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
}

/**
 * The single entry point for "who am I / what agency / what language / sign
 * out" — one avatar button instead of those living as loose items in the nav
 * row, where a logout button in plain gray text at the end of six links was
 * easy to never notice. This is the pattern every booking/marketplace app
 * uses for exactly that reason.
 *
 * No "security" section yet (no password-change endpoint exists — see
 * obsidian/Backend/Auth Flow.md open questions). Adding a menu item for a
 * page that doesn't exist would be worse than not having the menu.
 *
 * The same component serves the public site header and the console header, so
 * "where do I sign out" has one answer everywhere. What differs is passed in:
 * the console already shows the agency name and the language switcher in its
 * header, the public site puts the links inside the menu.
 */
export function AccountMenu(props: {
  user: AccountMenuUser;
  /** Shown under the name. Absent for a traveler with no agency. */
  agencyName?: string;
  /** Menu entries above the sign-out row — account page, agency console, … */
  links?: { href: string; label: string }[];
  /** Off when the surrounding header already shows the switcher on its own. */
  showLanguageSwitcher?: boolean;
  logoutLabel: string;
  logoutAction: () => Promise<void>;
}) {
  const initials = props.user.displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Avatar>
          {props.user.avatarUrl ? <AvatarImage src={props.user.avatarUrl} alt="" /> : null}
          <AvatarFallback>{initials || '?'}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        {/* The Group wrapper is not decoration: Base UI's GroupLabel reads a
            context only Menu.Group provides, and throws at render without it. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col items-start gap-0.5 font-normal">
            <span className="text-sm font-semibold text-foreground">{props.user.displayName}</span>
            <span className="text-xs text-muted-foreground" dir="ltr">
              {props.user.email ?? props.user.phone}
            </span>
            {props.agencyName ? (
              <span className="text-xs text-muted-foreground">{props.agencyName}</span>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        {props.links?.length ? (
          <>
            <DropdownMenuSeparator />
            {props.links.map((link) => (
              <DropdownMenuItem
                key={link.href}
                nativeButton={false}
                render={<Link href={link.href} />}
              >
                {link.label}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}

        {props.showLanguageSwitcher === false ? null : (
          <>
            <DropdownMenuSeparator />
            <div className="px-1.5 py-1">
              <LanguageSwitcher />
            </div>
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            void props.logoutAction();
          }}
        >
          <LogOut />
          {props.logoutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
