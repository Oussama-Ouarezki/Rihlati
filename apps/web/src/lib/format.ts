import { WILAYAS, formatMoney, type Locale } from '@rihlati/shared';

/** "2027-02-10" → "10 févr. 2027" / "١٠ فيفري ٢٠٢٧" — Algiers wall-clock. */
export function formatDateOnly(iso: string, locale: Locale): string {
  const tag = locale === 'ar' ? 'ar-DZ' : locale === 'en' ? 'en-GB' : 'fr-DZ';
  return new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Algiers',
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** Money display delegates to the shared package — one formatter everywhere. */
export function price(centimes: number, locale: Locale): string {
  return formatMoney(centimes, locale);
}

/** "16" → "Alger" / "الجزائر". Unknown codes fall back to the code itself. */
export function wilayaName(code: string | null, locale: Locale): string | null {
  if (!code) return null;
  const wilaya = WILAYAS.find((w) => w.code === code);
  if (!wilaya) return code;
  return locale === 'ar' ? wilaya.ar : wilaya.fr;
}
