import { z } from 'zod';

/**
 * OFFER ANALYTICS — the agency's "how are my posts doing?" numbers.
 *
 * Collection happens for EVERY agency from day one, whatever the plan,
 * because time-series data cannot be backfilled — the day an agency upgrades,
 * their history must already exist. Only the DASHBOARD is plan-gated
 * (`analytics` in plans.ts). Collect always, show for paying: an empty chart
 * on upgrade day would make the upgrade feel like a scam.
 */

/**
 * Client-side events the web app reports with a beacon. Views are counted
 * server-side on the offer page fetch; these are the interactions the server
 * cannot see on its own.
 */
export const OFFER_EVENT_TYPES = ['whatsapp_click', 'phone_click'] as const;
export const offerEventSchema = z.object({
  type: z.enum(OFFER_EVENT_TYPES),
});
export type OfferEventInput = z.infer<typeof offerEventSchema>;

export const offerAnalyticsQuerySchema = z.object({
  /** Window size in days, ending today (Algiers time). */
  days: z.coerce.number().int().min(1).max(365).default(30),
  /** Narrow to one offer. Must belong to the requesting agency. */
  offerId: z.string().uuid().optional(),
});
export type OfferAnalyticsQuery = z.infer<typeof offerAnalyticsQuerySchema>;

/** One day in the series. `date` is "2026-08-01" (Algiers calendar day). */
export interface OfferAnalyticsPoint {
  date: string;
  views: number;
  whatsappClicks: number;
  phoneClicks: number;
  inquiries: number;
}

export interface OfferAnalyticsTopOffer {
  offerId: string;
  title: string;
  slug: string;
  views: number;
  whatsappClicks: number;
  phoneClicks: number;
  inquiries: number;
}

export interface OfferAnalytics {
  /** Zero-filled: exactly `days` entries, oldest first. Charts plot it as-is. */
  series: OfferAnalyticsPoint[];
  totals: Omit<OfferAnalyticsPoint, 'date'>;
  /** The agency's offers ranked by views over the window, top 10. */
  topOffers: OfferAnalyticsTopOffer[];
}
