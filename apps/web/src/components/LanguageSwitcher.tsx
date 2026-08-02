'use client';

import { useLocale } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { routing, type AppLocale } from '@/i18n/routing';

/**
 * Language names are written in THEIR OWN language, never translated: an
 * Arabic speaker lost on the French site must be able to recognise "العربية".
 * This is the one place hardcoded strings are correct — they are proper
 * nouns, identical in every locale.
 */
const NATIVE_NAMES: Record<AppLocale, string> = {
  fr: 'Français',
  ar: 'العربية',
  en: 'English',
};

export function LanguageSwitcher() {
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 text-sm">
      {routing.locales.map((locale) => (
        <Link
          key={locale}
          href={pathname}
          locale={locale}
          className={
            locale === current
              ? 'rounded-full bg-brand-50 px-3 py-1 font-semibold text-brand-700'
              : 'rounded-full px-3 py-1 text-slate-500 hover:bg-slate-100'
          }
        >
          {NATIVE_NAMES[locale]}
        </Link>
      ))}
    </nav>
  );
}
