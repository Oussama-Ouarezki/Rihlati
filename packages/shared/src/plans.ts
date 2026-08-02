import { z } from 'zod';
import { AGENCY_PLANS, type AgencyPlan } from './enums';

/**
 * What each plan allows. This table is the ONLY place plan rules live — the API
 * reads it, the UI reads it, and nothing hardcodes "5 offers" anywhere else.
 *
 * v1 charges nobody. The limits are still enforced from day one, because a
 * limit introduced later is a takeaway, and takeaways make agencies leave.
 * Starting limited and raising the cap is a gift; starting unlimited and
 * capping is a betrayal.
 *
 * `null` means unlimited.
 */
export interface PlanLimits {
  /** Simultaneously PUBLISHED offers. Drafts never count against this. */
  maxPublishedOffers: number | null;
  /** Staff accounts attached to the agency. */
  maxSeats: number | null;
  /**
   * Leads received per calendar month.
   *
   * Deliberately unlimited on every plan. Capping leads caps the thing the
   * agency is actually paying for, and worse, it strands the traveler whose
   * inquiry silently goes nowhere. Sell capacity (offers, seats) and
   * convenience (export, analytics, promotion) — never sell fewer customers.
   *
   * The field exists so the decision stays yours, not so it stays unused.
   */
  maxLeadsPerMonth: number | null;

  // --- feature gates: the "premium gestion des clients" tier ---
  /** Kanban pipeline board, not just a flat list. */
  crmPipelineBoard: boolean;
  /** Assign leads to specific staff members. */
  leadAssignment: boolean;
  /** Response-time and conversion dashboards. */
  analytics: boolean;
  /** CSV export of leads. */
  leadExport: boolean;
  /** Eligible to buy promoted placement in search. */
  promotedListings: boolean;
  /** Custom tags beyond the built-in quality labels. */
  customTags: boolean;
  /**
   * Named tracked links for Facebook/Instagram posts. Capped rather than
   * boolean: one link proves the idea, a campaign per post is the paid use.
   * `null` = unlimited.
   */
  maxTrackedLinks: number | null;
  /**
   * The per-agency AI chatbot (answers from the agency's offers + FAQ,
   * confirms reservations). Not built yet — the flag exists so gating it is a
   * product decision, not a schema change. Design: obsidian/Backend/Agency
   * Chatbot.md. Currently pro+business; if it should anchor the business tier
   * instead, flip one word below.
   */
  chatbot: boolean;
}

export const PLAN_LIMITS: Record<AgencyPlan, PlanLimits> = {
  free: {
    maxPublishedOffers: 5,
    maxSeats: 2,
    maxLeadsPerMonth: null,
    crmPipelineBoard: false,
    leadAssignment: false,
    analytics: false,
    leadExport: false,
    promotedListings: false,
    customTags: false,
    maxTrackedLinks: 2,
    chatbot: false,
  },
  pro: {
    maxPublishedOffers: 30,
    maxSeats: 8,
    maxLeadsPerMonth: null,
    crmPipelineBoard: true,
    leadAssignment: true,
    analytics: true,
    leadExport: true,
    promotedListings: true,
    customTags: true,
    maxTrackedLinks: 50,
    chatbot: true,
  },
  business: {
    maxPublishedOffers: null,
    maxSeats: null,
    maxLeadsPerMonth: null,
    crmPipelineBoard: true,
    leadAssignment: true,
    analytics: true,
    leadExport: true,
    promotedListings: true,
    customTags: true,
    maxTrackedLinks: null,
    chatbot: true,
  },
};

export type PlanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never;
}[keyof PlanLimits];

/**
 * The agency-specific override wins over the plan default. Used for partner
 * deals and for agencies you are courting. Platform admins only — an agency
 * must never be able to set its own override (CLAUDE.md rule #2).
 */
export function resolvePublishedOfferLimit(
  plan: AgencyPlan,
  override?: number | null,
): number | null {
  if (override !== null && override !== undefined) return override;
  return PLAN_LIMITS[plan].maxPublishedOffers;
}

/**
 * Can this agency publish ONE MORE offer?
 *
 * `currentlyPublished` must be a fresh count from the database, never a value
 * the client sent. Note the strict `<`: at the limit you are full, not "one
 * more allowed".
 */
export function canPublishAnotherOffer(
  currentlyPublished: number,
  limit: number | null,
): boolean {
  if (limit === null) return true;
  return currentlyPublished < limit;
}

export function hasFeature(plan: AgencyPlan, feature: PlanFeature): boolean {
  return PLAN_LIMITS[plan][feature];
}

/** The cheapest plan that includes a given feature — powers "upgrade to X to unlock". */
export function cheapestPlanWith(feature: PlanFeature): AgencyPlan | null {
  for (const plan of AGENCY_PLANS) {
    if (PLAN_LIMITS[plan][feature]) return plan;
  }
  return null;
}

export const planLimitsSchema = z.object({
  maxPublishedOffers: z.number().int().min(0).nullable(),
  maxSeats: z.number().int().min(1).nullable(),
  maxLeadsPerMonth: z.number().int().min(0).nullable(),
  crmPipelineBoard: z.boolean(),
  leadAssignment: z.boolean(),
  analytics: z.boolean(),
  leadExport: z.boolean(),
  promotedListings: z.boolean(),
  customTags: z.boolean(),
  maxTrackedLinks: z.number().int().min(0).nullable(),
  chatbot: z.boolean(),
});
