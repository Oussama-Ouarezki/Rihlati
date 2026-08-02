import { defineRouting } from 'next-intl/routing';

/**
 * French is the default (owner's decision, Decision 018 in the vault) and
 * lives at the bare URL: `/` is French, `/ar` is Arabic, `/en` is English.
 *
 * The locale is IN THE URL, not in a cookie — so every language version has a
 * shareable, indexable address. A cookie-only locale gives Google exactly one
 * language and a WhatsApp-forwarded link the sender's language, not the
 * reader's choice.
 */
export const routing = defineRouting({
  locales: ['fr', 'ar', 'en'],
  defaultLocale: 'fr',
  localePrefix: 'as-needed',
});

export type AppLocale = (typeof routing.locales)[number];
