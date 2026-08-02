import { z } from 'zod';
import { offerReportReasonSchema } from '../enums';

/**
 * REPORTING AN OFFER
 *
 * Anyone can report — travelers and rival agencies alike. Both are useful
 * signals and both are equally capable of abusing the button, which is why a
 * report never hides anything by itself at any count. Reports order the admin
 * review queue; a human takes the action.
 *
 * See `obsidian/Backend/Duplicate and Spam Control.md`.
 */
export const createOfferReportSchema = z.object({
  reason: offerReportReasonSchema,
  details: z.string().trim().max(1000).optional(),
});
export type CreateOfferReportInput = z.infer<typeof createOfferReportSchema>;

/**
 * The admin verdict on a report.
 *
 * `actioned` means the report was right and something was done to the offer.
 * `dismissed` means it was not. There is deliberately no "delete the offer"
 * option here — moderating a listing and destroying it are different powers,
 * and the second one is not recoverable.
 */
export const reviewOfferReportSchema = z.object({
  status: z.enum(['actioned', 'dismissed']),
  reviewNote: z.string().trim().max(1000).optional(),
});
export type ReviewOfferReportInput = z.infer<typeof reviewOfferReportSchema>;

/**
 * A human's verdict on a suspected duplicate.
 *
 * `confirmed` drops the offer out of the default listing but leaves it
 * reachable by direct link. `dismissed` marks the pair as legitimately
 * distinct and it is never auto-flagged again — without that, the same
 * false positive comes back every time the agency edits the offer.
 */
export const resolveDuplicateSchema = z.object({
  verdict: z.enum(['confirmed', 'dismissed']),
  note: z.string().trim().max(1000).optional(),
});
export type ResolveDuplicateInput = z.infer<typeof resolveDuplicateSchema>;
