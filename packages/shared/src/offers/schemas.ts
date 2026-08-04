import { z } from 'zod';
import { offerKindSchema, type OfferKind } from '../enums';
import { MAX_PRICE_CENTIMES, centimesSchema, currencySchema } from '../money';
import { wilayaCodeSchema } from '../wilayas';
import { paginationSchema } from '../pagination';
import { offerAttributeSchemas } from './attributes';

/**
 * Request/response shapes for offers. The API validates with these; the web and
 * mobile apps build their forms from the same objects, so a field can never
 * exist on the client and not the server.
 */

/** Date-only, "2026-03-14". Trips have dates, not timestamps. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.dateFormat')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), { message: 'validation.dateInvalid' });

/** ISO-3166 alpha-2 country code. */
export const countryCodeSchema = z.string().trim().length(2).toUpperCase();

export const offerMediaSchema = z.object({
  url: z.string().url().max(2048),
  kind: z.enum(['image', 'video']).default('image'),
  alt: z.string().trim().max(200).optional(),
  order: z.number().int().min(0).max(50).default(0),
});
export type OfferMedia = z.infer<typeof offerMediaSchema>;

/**
 * Query strings give us either `?kind=omra&kind=hajj` or `?kind=omra,hajj`
 * depending on the client. Accept both and normalize to an array.
 */
function multiValue<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((value): unknown => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value as unknown[];
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return value;
  }, z.array(inner).min(1).max(20).optional());
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off', '']);

/**
 * Booleans from a query string.
 *
 * Do NOT use `z.coerce.boolean()` here — it is `Boolean(value)`, so the string
 * "false" becomes `true`, as does "0", "no", and every other non-empty string.
 * `?verifiedAgenciesOnly=false` would silently mean the opposite of what the
 * user asked for, and the failure is invisible: no error, just wrong results.
 *
 * Garbage that is neither truthy nor falsy is a validation error, not a guess.
 */
function queryBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (TRUTHY.has(normalized)) return true;
      if (FALSY.has(normalized)) return false;
      return value; // falls through to z.boolean() and fails loudly
    }
    return value;
  }, z.boolean());
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

export const OFFER_SORTS = [
  'relevance',
  'price_asc',
  'price_desc',
  'departure_soon',
  'newest',
  'rating_desc',
] as const;
export const offerSortSchema = z.enum(OFFER_SORTS);
export type OfferSort = (typeof OFFER_SORTS)[number];

/**
 * Every field here maps to an indexed COLUMN, never to `attributes`. That is
 * the whole reason the column/JSON split exists — see ./attributes.ts.
 *
 * If you want to add a filter for something currently in `attributes`, promote
 * it to a column first.
 */
export const offerSearchSchema = paginationSchema
  .extend({
    /** Free-text over title/summary/destination. */
    q: z.string().trim().max(120).optional(),

    kind: multiValue(offerKindSchema),

    // --- price ---
    // Bounded by MAX_PRICE_CENTIMES, not just `.min(0)`: an unbounded number
    // reaches Postgres as an INT4 comparison and overflows into a 500. A
    // nonsense filter must be a 422 the caller can read, never a crash.
    minPriceCentimes: z.coerce.number().int().min(0).max(MAX_PRICE_CENTIMES).optional(),
    maxPriceCentimes: z.coerce.number().int().min(0).max(MAX_PRICE_CENTIMES).optional(),

    // --- destination ---
    destinationCountry: countryCodeSchema.optional(),
    destinationCity: z.string().trim().max(80).optional(),

    // --- departure ---
    departureWilayaCode: wilayaCodeSchema.optional(),

    // --- dates: a window the traveler can travel in, not one exact day ---
    departureFrom: dateOnlySchema.optional(),
    departureTo: dateOnlySchema.optional(),
    minDurationDays: z.coerce.number().int().min(1).max(365).optional(),
    maxDurationDays: z.coerce.number().int().min(1).max(365).optional(),

    agencySlug: z.string().trim().max(120).optional(),

    /**
     * Defaults to true: unverified agencies are invisible by default.
     * Trust is the product — the safe default is the strict one.
     */
    verifiedAgenciesOnly: queryBoolean(true),

    /**
     * By default the listing excludes offers a human confirmed as spam
     * re-posts (`duplicateStatus = 'confirmed'`). Suspected ones still appear,
     * just demoted. Nothing is ever deleted — see offers/dedup.ts.
     *
     * Set true to see everything (used by the admin back-office).
     */
    includeFlaggedDuplicates: queryBoolean(false),

    sort: offerSortSchema.default('relevance'),
  })
  .refine(
    (v) =>
      v.minPriceCentimes === undefined ||
      v.maxPriceCentimes === undefined ||
      v.minPriceCentimes <= v.maxPriceCentimes,
    { message: 'validation.priceMinAboveMax', path: ['minPriceCentimes'] },
  )
  .refine(
    (v) => v.departureFrom === undefined || v.departureTo === undefined || v.departureFrom <= v.departureTo,
    { message: 'validation.startAfterEnd', path: ['departureFrom'] },
  )
  .refine(
    (v) =>
      v.minDurationDays === undefined ||
      v.maxDurationDays === undefined ||
      v.minDurationDays <= v.maxDurationDays,
    { message: 'validation.durationMinAboveMax', path: ['minDurationDays'] },
  );

export type OfferSearchInput = z.infer<typeof offerSearchSchema>;

// ---------------------------------------------------------------------------
// CREATE / UPDATE
// ---------------------------------------------------------------------------

/**
 * Note what is ABSENT here, deliberately (CLAUDE.md rule #2):
 *   - no `agencyId`  — taken from the session, never from the request
 *   - no `status`    — an agency cannot publish itself past review
 *   - no `isFeatured`/`qualityScore` — platform-controlled ranking
 *   - no `id`, `slug`, `fingerprint` — derived server-side
 *
 * If a field were accepted here, any agency could publish an unreviewed offer
 * or feature itself for free by calling the API directly.
 */
export const offerBaseSchema = z.object({
  kind: offerKindSchema,

  title: z.string().trim().min(8, 'validation.titleTooShort').max(140),
  summary: z.string().trim().max(300).optional(),
  description: z.string().trim().max(8000).optional(),

  priceFromCentimes: centimesSchema,
  priceToCentimes: centimesSchema.optional(),
  currency: currencySchema.default('DZD'),

  departureDate: dateOnlySchema.optional(),
  returnDate: dateOnlySchema.optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  isFlexibleDates: z.boolean().default(false),

  departureWilayaCode: wilayaCodeSchema.optional(),
  destinationCountry: countryCodeSchema.optional(),
  destinationCity: z.string().trim().max(80).optional(),

  seatsTotal: z.number().int().min(1).max(10_000).optional(),

  /**
   * Unknown at this level on purpose — it is validated against the schema for
   * `kind` in the refinement below, which is what makes one endpoint able to
   * accept seven different offer shapes safely.
   */
  attributes: z.unknown().optional(),

  media: z.array(offerMediaSchema).max(20).default([]),
});

/** Cross-field checks shared by create and update. */
function refineOffer(
  value: {
    kind?: OfferKind;
    attributes?: unknown;
    priceFromCentimes?: number;
    priceToCentimes?: number;
    departureDate?: string;
    returnDate?: string;
  },
  ctx: z.RefinementCtx,
  kindForAttributes?: OfferKind,
): void {
  const kind = value.kind ?? kindForAttributes;

  // 1. attributes must match the offer kind
  if (kind && value.attributes !== undefined) {
    const result = offerAttributeSchemas[kind].safeParse(value.attributes ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ['attributes', ...issue.path],
        });
      }
    }
  }

  // 2. price range must be coherent
  if (
    value.priceFromCentimes !== undefined &&
    value.priceToCentimes !== undefined &&
    value.priceToCentimes < value.priceFromCentimes
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'validation.priceMaxBelowMin',
      path: ['priceToCentimes'],
    });
  }

  // 3. you cannot return before you leave
  if (value.departureDate && value.returnDate && value.returnDate < value.departureDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'validation.returnBeforeDeparture',
      path: ['returnDate'],
    });
  }
}

export const createOfferSchema = offerBaseSchema.superRefine((value, ctx) => {
  refineOffer(value, ctx);
});

export type CreateOfferInput = z.infer<typeof createOfferSchema>;

/**
 * `kind` is not updatable: changing it would invalidate every stored attribute.
 * Changing an offer's type means creating a new offer.
 *
 * The service layer merges this over the stored row and re-validates the result
 * with `validateOfferAttributesForKind`, using the kind already in the database.
 */
export const updateOfferSchema = offerBaseSchema
  .omit({ kind: true })
  .partial()
  .superRefine((value, ctx) => {
    refineOffer(value, ctx);
  });

export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

/** Used by the service after merging an update onto the stored offer. */
export function validateOfferAttributesForKind(kind: OfferKind, attributes: unknown): void {
  offerAttributeSchemas[kind].parse(attributes ?? {});
}

/**
 * Status changes go through their own endpoint, not the update endpoint, so the
 * allowed-transitions table in ../enums.ts is enforced in exactly one place.
 */
export const offerStatusChangeSchema = z.object({
  status: z.enum(['pending_review', 'published', 'paused', 'archived', 'draft', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});
export type OfferStatusChangeInput = z.infer<typeof offerStatusChangeSchema>;
