import { z } from 'zod';

/**
 * Phone numbers are stored in ONE format: E.164, e.g. "+213551234567".
 *
 * This matters more than it looks. Users will type 0551234567, 0551 23 45 67,
 * +213 551 234 567 and 00213551234567 — all the same person. If you store what
 * they typed, you can never deduplicate a client, never match a repeat inquiry
 * to an existing lead, and never reliably send an SMS.
 */

export const ALGERIA_COUNTRY_CODE = '213';
export const ALGERIA_DIAL_PREFIX = `+${ALGERIA_COUNTRY_CODE}`;

/** Algerian mobile national numbers start with 5, 6 or 7 and are 9 digits. */
const MOBILE_RE = /^[567]\d{8}$/;
/** Landlines are 8 digits after the trunk 0 (e.g. Alger 021 XX XX XX). */
const LANDLINE_RE = /^[1-4]\d{7}$/;

/**
 * Turns anything a user might type into E.164, or returns null if it cannot be
 * a valid Algerian number. Only handles +213 — add other countries when you
 * actually need them.
 */
export function normalizeAlgerianPhone(input: string): string | null {
  if (!input) return null;

  // Keep digits and a single leading +.
  const cleaned = input.trim().replace(/[\s.\-()‎‏]/g, '');
  let digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) return null;

  // 00213... -> 213...
  if (digits.startsWith('00' + ALGERIA_COUNTRY_CODE)) {
    digits = digits.slice(2);
  }
  // 213... -> national significant number
  if (digits.startsWith(ALGERIA_COUNTRY_CODE)) {
    digits = digits.slice(ALGERIA_COUNTRY_CODE.length);
  }
  // Trunk prefix: 0551234567 -> 551234567
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!MOBILE_RE.test(digits) && !LANDLINE_RE.test(digits)) return null;

  return `${ALGERIA_DIAL_PREFIX}${digits}`;
}

export function isMobile(e164: string): boolean {
  if (!e164.startsWith(ALGERIA_DIAL_PREFIX)) return false;
  return MOBILE_RE.test(e164.slice(ALGERIA_DIAL_PREFIX.length));
}

/**
 * Use this in every schema that accepts a phone number. It normalizes as part
 * of validation, so handlers downstream can only ever see E.164.
 */
export const algerianPhoneSchema = z
  .string()
  .min(9)
  .max(24)
  .transform((value, ctx) => {
    const normalized = normalizeAlgerianPhone(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Numéro de téléphone algérien invalide',
      });
      return z.NEVER;
    }
    return normalized;
  });

/** For display: +213551234567 -> 0551 23 45 67 */
export function formatPhoneForDisplay(e164: string): string {
  if (!e164.startsWith(ALGERIA_DIAL_PREFIX)) return e164;
  const nsn = e164.slice(ALGERIA_DIAL_PREFIX.length);
  if (MOBILE_RE.test(nsn)) {
    return `0${nsn.slice(0, 3)} ${nsn.slice(3, 5)} ${nsn.slice(5, 7)} ${nsn.slice(7, 9)}`;
  }
  return `0${nsn.slice(0, 2)} ${nsn.slice(2, 4)} ${nsn.slice(4, 6)} ${nsn.slice(6, 8)}`;
}

/**
 * Logs and error reports must never contain a full phone number (rule #4).
 * +213551234567 -> +213•••••4567
 */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return '•••';
  return `${e164.slice(0, 4)}${'•'.repeat(Math.max(0, e164.length - 8))}${e164.slice(-4)}`;
}
