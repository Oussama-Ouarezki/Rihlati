import { z } from 'zod';

/**
 * TYPED ERROR CODES
 *
 * Every handled error the API returns carries one of these codes. The message
 * text is for developers; the CODE is what clients switch on to show a
 * translated message (CLAUDE.md rule #4).
 *
 * Why not just send a French sentence? Because the app is Arabic AND French,
 * and the API has no business deciding which one the user reads. The client
 * looks up `errors.OFFER_LIMIT_REACHED` in its own translation file.
 *
 * Rules for adding a code:
 *   - never encode WHO or WHAT in the code beyond what the caller may know
 *   - NOT_FOUND covers "doesn't exist" AND "belongs to another agency". They
 *     must be indistinguishable, or the code becomes an existence oracle.
 */
export const ERROR_CODES = [
  // --- generic ---
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL',
  'RATE_LIMITED',

  // --- authentication (who are you) ---
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'TOKEN_REUSED',
  'ACCOUNT_DISABLED',
  'EMAIL_ALREADY_USED',
  'PHONE_ALREADY_USED',
  'IDENTIFIER_REQUIRED',

  // --- authorization (may you) ---
  'FORBIDDEN',
  'NOT_AGENCY_MEMBER',
  'INSUFFICIENT_ROLE',
  'AGENCY_NOT_VERIFIED',
  'PLATFORM_ADMIN_ONLY',

  // --- business rules ---
  'OFFER_LIMIT_REACHED',
  'SEAT_LIMIT_REACHED',
  'FEATURE_NOT_IN_PLAN',
  'INVALID_STATUS_TRANSITION',
  'DUPLICATE_OFFER_SUSPECTED',
  'ALREADY_REPORTED',
  'CONSENT_REQUIRED',
  'SLUG_TAKEN',
  'AGENCY_ALREADY_EXISTS',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The exact shape of every error response. One shape, always — clients should
 * never have to guess whether `error` is a string or an object today.
 *
 * `requestId` is echoed so a user can paste it into a support message and you
 * can find the exact log line. That is the whole point of rule #4.
 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Developer-facing. Never shown to a user; never contains user data. */
    message: string;
    /** Field-level problems, keyed by dotted path: `{ "attributes.hotelStars": [...] }` */
    fields?: Record<string, string[]>;
    /** Extra machine-readable context, e.g. `{ limit: 5, current: 5 }`. */
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/** HTTP status for each code. Keeping this here stops handlers inventing statuses. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  INTERNAL: 500,
  RATE_LIMITED: 429,

  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  ACCOUNT_DISABLED: 403,
  EMAIL_ALREADY_USED: 409,
  PHONE_ALREADY_USED: 409,
  IDENTIFIER_REQUIRED: 422,

  FORBIDDEN: 403,
  // NOT_AGENCY_MEMBER is 404, not 403, on purpose: a 403 would confirm that the
  // agency id exists. See CLAUDE.md rule #3.
  NOT_AGENCY_MEMBER: 404,
  INSUFFICIENT_ROLE: 403,
  AGENCY_NOT_VERIFIED: 403,
  PLATFORM_ADMIN_ONLY: 403,

  OFFER_LIMIT_REACHED: 409,
  SEAT_LIMIT_REACHED: 409,
  FEATURE_NOT_IN_PLAN: 402,
  INVALID_STATUS_TRANSITION: 409,
  DUPLICATE_OFFER_SUSPECTED: 409,
  ALREADY_REPORTED: 409,
  CONSENT_REQUIRED: 422,
  SLUG_TAKEN: 409,
  AGENCY_ALREADY_EXISTS: 409,
};
