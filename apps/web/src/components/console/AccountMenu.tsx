'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
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
 */
export function AccountMenu(props: {
  user: AccountMenuUser;
  agencyName: string;
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
        <DropdownMenuLabel className="flex flex-col items-start gap-0.5 font-normal">
          <span className="text-sm font-semibold text-foreground">{props.user.displayName}</span>
          <span className="text-xs text-muted-foreground" dir="ltr">
            {props.user.email ?? props.user.phone}
          </span>
          <span className="text-xs text-muted-foreground">{props.agencyName}</span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <div className="px-1.5 py-1">
          <LanguageSwitcher />
        </div>

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
