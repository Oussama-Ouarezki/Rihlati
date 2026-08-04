import { z } from 'zod';
import { leadQualitySchema, leadSourceSchema, leadStageSchema } from '../enums';
import { centimesSchema } from '../money';
import { algerianPhoneSchema } from '../phone';
import { paginationSchema } from '../pagination';
import { dateOnlySchema } from '../offers/schemas';

/**
 * LEADS — the CRM ("gestion des clients")
 *
 * A lead is one traveler asking one agency about one trip. It is the most
 * valuable row in the database: it is what agencies pay for, and it holds a
 * real person's phone number.
 *
 * Two consequences that shape every schema below:
 *   1. every read is scoped to one agency, always (CLAUDE.md rule #3)
 *   2. the consent trail is captured once, at creation, and is never editable
 */

/**
 * The version string of the consent text the traveler actually agreed to.
 *
 * Bump this whenever the wording changes. Storing the version rather than a
 * bare `true` is what lets you answer "what exactly did this person agree to
 * in March?" — which is the entire question in a data-protection complaint
 * under Algeria's Law 18-07.
 *
 * VERIFY WITH A LAWYER before launch: what the text must say, how long you may
 * keep it, and what the person can demand you delete. I am not a source of
 * Algerian legal fact.
 */
export const CURRENT_CONSENT_VERSION = 'inquiry-consent-v1';

/**
 * Submitting an inquiry. This endpoint is PUBLIC — a traveler must be able to
 * contact an agency without making an account first. Requiring signup here
 * would kill the marketplace's only conversion event.
 *
 * Because it is public it is rate limited, and `agencyId` is NOT accepted:
 * the server derives it from the offer. Otherwise anyone could post leads into
 * any agency's inbox.
 */
export const createInquirySchema = z.object({
  offerId: z.string().uuid(),

  contactName: z.string().trim().min(2, 'validation.nameTooShort').max(80),
  contactPhone: algerianPhoneSchema,
  contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),

  message: z.string().trim().max(2000).optional(),
  peopleCount: z.number().int().min(1).max(200).optional(),
  preferredDepartureDate: dateOnlySchema.optional(),
  budgetCentimes: centimesSchema.optional(),

  /**
   * The tracked-link code the traveler arrived through, if any. Attribution
   * only — an unknown or foreign code is ignored silently server-side, never
   * an error: a stale marketing code must not cost the agency an inquiry.
   */
  ref: z.string().trim().max(24).optional(),

  /**
   * Must be exactly `true`. `z.boolean()` would accept `false` and leave the
   * check to a handler someone later deletes; `z.literal(true)` makes an
   * unconsented inquiry impossible to express.
   */
  consent: z.literal(true, {
    errorMap: () => ({ message: 'validation.consentRequired' }),
  }),
});
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;

/**
 * A lead created by the agency itself — someone who phoned or walked in.
 * Separate from the inquiry schema because the consent story is different:
 * here the agency asserts it obtained consent offline, and that assertion is
 * recorded against the staff member who made it.
 */
export const createLeadSchema = z.object({
  offerId: z.string().uuid().optional(),
  contactName: z.string().trim().min(2).max(80),
  contactPhone: algerianPhoneSchema,
  contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  message: z.string().trim().max(2000).optional(),
  peopleCount: z.number().int().min(1).max(200).optional(),
  preferredDepartureDate: dateOnlySchema.optional(),
  budgetCentimes: centimesSchema.optional(),
  source: leadSourceSchema.default('direct_call'),
  confirmsConsentObtained: z.literal(true, {
    errorMap: () => ({ message: 'validation.clientConsentRequired' }),
  }),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * What agency staff may change on a lead.
 *
 * Absent on purpose: `contactPhone`, `contactName`, `contactEmail`, every
 * consent field, `agencyId`, `createdAt`. The contact details are the
 * traveler's own submission — an agency editing them would destroy the record
 * of who actually asked, and with it the consent trail's meaning.
 */
export const updateLeadSchema = z.object({
  stage: leadStageSchema.optional(),
  quality: leadQualitySchema.optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  estimatedValueCentimes: centimesSchema.nullable().optional(),
  actualValueCentimes: centimesSchema.nullable().optional(),
  lostReason: z.string().trim().max(500).nullable().optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const createLeadNoteSchema = z.object({
  body: z.string().trim().min(1, 'validation.noteEmpty').max(4000),
});
export type CreateLeadNoteInput = z.infer<typeof createLeadNoteSchema>;

// ---------------------------------------------------------------------------
// INBOX QUERY
// ---------------------------------------------------------------------------

export const LEAD_SORTS = [
  'newest',
  'oldest',
  'next_action',
  'quality_desc',
  'value_desc',
] as const;
export const leadSortSchema = z.enum(LEAD_SORTS);
export type LeadSort = (typeof LEAD_SORTS)[number];

/**
 * `agencyId` is NOT a filter here — it comes from the verified membership, and
 * accepting it as a query parameter is exactly how cross-tenant reads happen.
 */
export const leadSearchSchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  stage: leadStageSchema.optional(),
  quality: leadQualitySchema.optional(),
  source: leadSourceSchema.optional(),
  offerId: z.string().uuid().optional(),
  assignedToUserId: z.string().uuid().optional(),
  /** Leads with `nextActionAt` today or overdue — the "à rappeler" list. */
  dueOnly: z
    .preprocess((v) => (v === undefined ? false : v === true || v === 'true' || v === '1'), z.boolean())
    .default(false),
  sort: leadSortSchema.default('newest'),
});
export type LeadSearchInput = z.infer<typeof leadSearchSchema>;

// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------

export interface LeadSummary {
  id: string;
  /** The named link this client came through, e.g. "post Facebook Ramadan". */
  sourceLabel: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  stage: string;
  quality: string;
  source: string;
  peopleCount: number | null;
  budgetCentimes: number | null;
  estimatedValueCentimes: number | null;
  offer: { id: string; title: string; slug: string } | null;
  assignedToUserId: string | null;
  nextActionAt: string | null;
  firstRespondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail extends LeadSummary {
  message: string | null;
  preferredDepartureDate: string | null;
  actualValueCentimes: number | null;
  lostReason: string | null;
  closedAt: string | null;
  /** Proof of what the traveler agreed to. Read-only, forever. */
  consent: { givenAt: string; textVersion: string };
  notes: Array<{
    id: string;
    body: string;
    authorUserId: string | null;
    createdAt: string;
  }>;
  activities: Array<{
    id: string;
    type: string;
    actorUserId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

/** The only thing a public inquiry returns. Never echo the lead back. */
export interface InquiryReceipt {
  id: string;
  createdAt: string;
  agencyName: string;
}
