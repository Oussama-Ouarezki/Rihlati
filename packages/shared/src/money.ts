import { z } from 'zod';

/**
 * MONEY IS ALWAYS AN INTEGER NUMBER OF CENTIMES.
 *
 * 150 000,00 DZD is stored as 15_000_000.
 *
 * Never use a float for money: 0.1 + 0.2 !== 0.3 in every language with
 * floating point, and the error compounds over thousands of rows. The database
 * columns are `Int`, the API speaks centimes, and only the display layer
 * divides by 100.
 */

export const DEFAULT_CURRENCY = 'DZD' as const;
export const SUPPORTED_CURRENCIES = ['DZD'] as const;
export const currencySchema = z.enum(SUPPORTED_CURRENCIES);
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Ceiling for any money value, in centimes.
 *
 * MUST fit in a 32-bit signed integer: the Postgres columns are `Int` (INT4),
 * which stops at 2 147 483 647. An earlier value of 100 million DZD
 * (10 000 000 000 centimes) was four times too large — an offer priced near it
 * could not be stored, and a search filter using it crashed the query with a
 * 500 instead of a validation error. Playwright found that on its first run.
 *
 * 20 million DZD is ~65× the price of an Omra and still leaves 7% headroom
 * inside INT4. If a real product ever needs more, widen the columns to BigInt
 * FIRST — this constant is downstream of the database, not the other way round.
 */
export const MAX_PRICE_CENTIMES = 2_000_000_000; // 20 million DZD

export const centimesSchema = z
  .number()
  .int('validation.amountNotInteger')
  .min(0)
  .max(MAX_PRICE_CENTIMES);

export function dzdToCentimes(dzd: number): number {
  return Math.round(dzd * 100);
}

export function centimesToDzd(centimes: number): number {
  return centimes / 100;
}

/**
 * Formats for display. Only call this in the UI — never store the result,
 * and never parse it back.
 */
export function formatMoney(
  centimes: number,
  locale: 'ar' | 'fr' | 'en' = 'fr',
  currency: Currency = DEFAULT_CURRENCY,
): string {
  const bcp47 = locale === 'ar' ? 'ar-DZ' : locale === 'en' ? 'en-DZ' : 'fr-DZ';
  return new Intl.NumberFormat(bcp47, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(centimesToDzd(centimes));
}

/*
 * NOTE — there is deliberately no `priceBucket()` here.
 *
 * An earlier version bucketed prices into 5 000 DZD bands to decide whether two
 * offers were "the same price". It looked reasonable and was wrong: 149 000 and
 * 150 000 DZD fall either side of a band boundary, so a 1 000 DZD edit made an
 * offer look brand new. Every fixed bucketing has boundaries, so no band width
 * fixes it — the idea itself was unsound.
 *
 * Duplicate detection now ignores price entirely (see offers/dedup.ts).
 * If price ranges are ever needed for search facets, compute them from the
 * actual data distribution, not from a hardcoded width.
 */
