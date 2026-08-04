import { z } from 'zod';

/**
 * TRACKED LINKS — "which of my posts actually brings clients?"
 *
 * The agency creates a named link, pastes it under its Facebook or Instagram
 * post, and Rihlati counts two numbers: clicks, and — the one that matters —
 * how many of those clicks became real inquiries.
 *
 * Clicks alone are vanity. `inquiryCount` is the number an agency can act on,
 * and the pair together is also Rihlati's own sales pitch: proof the platform
 * sends real people, not impressions.
 */

/** The public key in `/l/{code}`. Kept short — it goes in a social post. */
export const TRACKED_LINK_CODE_LENGTH = 8;
export const trackedLinkCodeSchema = z
  .string()
  .trim()
  .min(4)
  .max(24)
  .regex(/^[A-Za-z0-9]+$/, 'validation.codeInvalid');

/**
 * `offerId` absent = the link points at the agency's whole catalogue (an
 * Instagram bio link), rather than one trip.
 *
 * Note what the client CANNOT send: `code` (generated server-side, or two
 * agencies could claim the same one), and both counters.
 */
export const createTrackedLinkSchema = z.object({
  label: z.string().trim().min(2, 'validation.linkLabelRequired').max(80),
  offerId: z.string().uuid().optional(),
});
export type CreateTrackedLinkInput = z.infer<typeof createTrackedLinkSchema>;

export const updateTrackedLinkSchema = z.object({
  label: z.string().trim().min(2).max(80),
});
export type UpdateTrackedLinkInput = z.infer<typeof updateTrackedLinkSchema>;

export interface TrackedLinkItem {
  id: string;
  code: string;
  label: string;
  /** The full URL to paste into a post. Built server-side from the code. */
  url: string;
  offerId: string | null;
  offerTitle: string | null;
  clickCount: number;
  inquiryCount: number;
  /** inquiries / clicks, 0..1. null when nobody has clicked yet. */
  conversionRate: number | null;
  createdAt: string;
}

export interface TrackedLinkList {
  items: TrackedLinkItem[];
  limit: number | null;
  used: number;
}

/**
 * Conversion rate, or null when there is no denominator.
 *
 * `null` rather than 0 on purpose: "no clicks yet" and "clicks that converted
 * nobody" are different facts, and showing 0% for an unclicked link would
 * make a brand-new link look like a failure.
 */
export function conversionRate(clicks: number, inquiries: number): number | null {
  if (clicks <= 0) return null;
  return Math.min(1, inquiries / clicks);
}
