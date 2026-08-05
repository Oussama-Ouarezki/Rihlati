import { z } from 'zod';
import { agencyStatusSchema, type AgencyStatus } from '../enums';
import { paginationSchema } from '../pagination';

/**
 * THE PLATFORM ADMIN SURFACE
 *
 * Everything here is for Rihlati's own staff, and it is the first part of the
 * API that is deliberately NOT scoped to one agency. Every other endpoint
 * answers "what may this agency see"; these answer "what may Rihlati see",
 * which is everything.
 *
 * That inversion is why these schemas live in their own file rather than being
 * mixed into agencies/schemas.ts. A reviewer opening this file should know
 * immediately that they are looking at cross-tenant code.
 */

// ---------------------------------------------------------------------------
// THE REVIEW QUEUE
// ---------------------------------------------------------------------------

/**
 * `status` defaults to `pending_review` — the queue is the whole point, and a
 * missing filter must not silently mean "list every agency on the platform".
 */
export const adminAgencyQueueSchema = paginationSchema.extend({
  status: agencyStatusSchema.default('pending_review'),
  q: z.string().trim().max(120).optional(),
});
export type AdminAgencyQueueInput = z.infer<typeof adminAgencyQueueSchema>;

// ---------------------------------------------------------------------------
// THE TWO DECISIONS
// ---------------------------------------------------------------------------

/**
 * Note what is NOT here: no `status`, no `verifiedAt`, no `verifiedByUserId`.
 * The admin says "verify this", not "set this row's status to verified" — the
 * server decides what that means and who gets recorded as having done it.
 *
 * `checkedNote` is required on purpose, and it is the most opinionated line in
 * this file. The badge is a promise to a traveler about to transfer 400 000
 * DZD, and `Agency Verification.md` is built around one worry: that the badge
 * claims more than was actually done. A required sentence means the answer to
 * "what exactly did you verify?" was written down at the moment it was
 * decided, by the person who decided it — instead of being reconstructed a
 * year later from memory, during a complaint.
 *
 * It is private. It goes to the audit log, never to the agency.
 */
export const verifyAgencySchema = z.object({
  checkedNote: z
    .string()
    .trim()
    .min(10, 'validation.checkedNoteTooShort')
    .max(2000),
});
export type VerifyAgencyInput = z.infer<typeof verifyAgencySchema>;

/**
 * Rejection has two texts, and keeping them apart is the point.
 *
 * `reason` is shown VERBATIM to the agency owner in the red banner on
 * /console/agence. It has to be something you would be comfortable reading
 * aloud to them, because that is effectively what it is.
 *
 * `internalNote` is never sent to the agency. It is where "the licence looks
 * photoshopped, watch this one" belongs. Before this field existed there was
 * only `reason`, which meant a private suspicion had nowhere to go except the
 * text the applicant reads.
 */
export const rejectAgencySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'validation.rejectionReasonTooShort')
    .max(1000),
  internalNote: z.string().trim().max(2000).optional(),
});
export type RejectAgencyInput = z.infer<typeof rejectAgencySchema>;

// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------

/**
 * One row of the queue — everything a human needs to make the decision,
 * on one screen, without a second request.
 *
 * The legal identifiers and the owner's contact details are here because they
 * ARE the review: you read the RC, you check the wilaya matches the address,
 * and you ring the number to see whether a travel agency answers. This is the
 * one response shape in the codebase that deliberately carries data no
 * traveler may ever see, which is why it is only ever returned from a route
 * behind `@PlatformAdminOnly()`.
 */
export interface AdminAgencyListItem {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  status: AgencyStatus;

  /** null for agencies that never asked (drafts), or that predate the column. */
  submittedForReviewAt: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;

  // What is being checked.
  registreCommerce: string | null;
  nif: string | null;
  tourismLicence: string | null;

  // Where they say they are, and how to reach them.
  addressLine: string | null;
  city: string | null;
  wilayaCode: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  websiteUrl: string | null;

  /** The person legally answerable for this agency. Null only if data is broken. */
  owner: {
    userId: string;
    displayName: string;
    email: string | null;
    phone: string | null;
  } | null;
}

/** What the queue returns after a decision, so the page can update the row. */
export interface AdminAgencyDecision {
  id: string;
  status: AgencyStatus;
}
