import { z } from 'zod';

/**
 * These mirror the enums in apps/api/prisma/schema.prisma.
 *
 * They are declared here (not imported from @prisma/client) because the web and
 * mobile apps must never depend on the database client. When you add a value in
 * Prisma, add it here too — `npm run typecheck` will fail loudly if the two ever
 * disagree, because the API cross-checks them at startup.
 */

export const LOCALES = ['ar', 'fr', 'en'] as const;
export const localeSchema = z.enum(LOCALES);
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'fr';
/** Locales that render right-to-left. Drives `dir="rtl"` and logical CSS. */
export const RTL_LOCALES: readonly Locale[] = ['ar'];
export const isRtl = (locale: Locale): boolean => RTL_LOCALES.includes(locale);

// ---------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------

export const AGENCY_STATUSES = [
  'draft',
  'pending_review',
  'verified',
  'rejected',
  'suspended',
] as const;
export const agencyStatusSchema = z.enum(AGENCY_STATUSES);
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];

/** Only these agencies are visible to the public. */
export const PUBLICLY_VISIBLE_AGENCY_STATUSES: readonly AgencyStatus[] = ['verified'];

export const AGENCY_ROLES = ['owner', 'manager', 'agent'] as const;
export const agencyRoleSchema = z.enum(AGENCY_ROLES);
export type AgencyRole = (typeof AGENCY_ROLES)[number];

/**
 * Role ranking. `manager` can do everything `agent` can, and so on.
 * Used by the roles guard: `rank[actual] >= rank[required]`.
 */
export const AGENCY_ROLE_RANK: Record<AgencyRole, number> = {
  agent: 1,
  manager: 2,
  owner: 3,
};

export const AGENCY_PLANS = ['free', 'pro', 'business'] as const;
export const agencyPlanSchema = z.enum(AGENCY_PLANS);
export type AgencyPlan = (typeof AGENCY_PLANS)[number];

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const OFFER_KINDS = [
  'omra',
  'hajj',
  'package',
  'visa',
  'flight',
  'hotel',
  'transport',
] as const;
export const offerKindSchema = z.enum(OFFER_KINDS);
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_STATUSES = [
  'draft',
  'pending_review',
  'published',
  'paused',
  'archived',
  'rejected',
] as const;
export const offerStatusSchema = z.enum(OFFER_STATUSES);
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const PUBLICLY_VISIBLE_OFFER_STATUSES: readonly OfferStatus[] = ['published'];

/**
 * Which status changes are allowed. Anything not listed is rejected by the
 * service layer — this is what stops an offer jumping from `draft` straight to
 * `published` without review.
 */
export const OFFER_STATUS_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  draft: ['pending_review', 'archived'],
  pending_review: ['published', 'rejected', 'draft'],
  published: ['paused', 'archived'],
  paused: ['published', 'archived'],
  rejected: ['draft', 'archived'],
  archived: ['draft'],
};

// ---------------------------------------------------------------------------
// Duplicate / spam control
// ---------------------------------------------------------------------------

/**
 * The goal here is stopping an agency from flooding the marketplace with
 * near-identical listings to occupy more space. It is NOT deduplication.
 *
 * No status deletes or merges anything. Every flagged offer is still reachable
 * by its direct link — the flag only affects the default listing.
 */
export const DUPLICATE_STATUSES = ['none', 'suspected', 'confirmed', 'dismissed'] as const;
export const duplicateStatusSchema = z.enum(DUPLICATE_STATUSES);
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

/** Kept out of the default public listing. A human decided this. */
export const HIDDEN_FROM_DEFAULT_LISTING: readonly DuplicateStatus[] = ['confirmed'];

/** Still listed, but pushed down the ranking. Automatic signal. */
export const DEMOTED_DUPLICATE_STATUSES: readonly DuplicateStatus[] = ['suspected'];

/** How far a suspected duplicate falls in the ranking score. */
export const SUSPECTED_DUPLICATE_RANK_PENALTY = 40;

export const OFFER_REPORT_REASONS = [
  'duplicate_spam',
  'misleading_price',
  'scam_suspicion',
  'wrong_information',
  'expired',
  'inappropriate',
  'other',
] as const;
export const offerReportReasonSchema = z.enum(OFFER_REPORT_REASONS);
export type OfferReportReason = (typeof OFFER_REPORT_REASONS)[number];

export const REPORT_STATUSES = ['pending', 'actioned', 'dismissed'] as const;
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * A report never hides an offer on its own, at any count. Rival agencies can
 * report each other, and a brigade of ten reports is easier to organize than
 * it looks. Reports order the admin queue; a human takes the action.
 */
export const REPORTS_BEFORE_PRIORITY_REVIEW = 3;

// ---------------------------------------------------------------------------
// Leads / CRM
// ---------------------------------------------------------------------------

export const LEAD_STAGES = [
  'new',
  'contacted',
  'quoted',
  'negotiating',
  'booked',
  'paid',
  'travelled',
  'lost',
] as const;
export const leadStageSchema = z.enum(LEAD_STAGES);
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Stages that mean the lead is finished, either way. */
export const TERMINAL_LEAD_STAGES: readonly LeadStage[] = ['travelled', 'lost'];

/** Order shown as columns in the pipeline board. `lost` is not a column. */
export const LEAD_PIPELINE_COLUMNS: readonly LeadStage[] = [
  'new',
  'contacted',
  'quoted',
  'negotiating',
  'booked',
  'paid',
  'travelled',
];

/**
 * How serious the client is. Agencies triage with this; later it also feeds
 * lead pricing and abuse detection.
 *
 * `spam`/`troll` are negative signals: marking a lead as either is a report
 * about the *person*, so it is auditable and can trigger a platform-wide block.
 */
export const LEAD_QUALITIES = [
  'unrated',
  'spam',
  'troll',
  'cold',
  'warm',
  'serious',
  'vip',
] as const;
export const leadQualitySchema = z.enum(LEAD_QUALITIES);
export type LeadQuality = (typeof LEAD_QUALITIES)[number];

export const NEGATIVE_LEAD_QUALITIES: readonly LeadQuality[] = ['spam', 'troll'];

/** Rough numeric weight, used for sorting an inbox by "worth calling first". */
export const LEAD_QUALITY_WEIGHT: Record<LeadQuality, number> = {
  spam: -2,
  troll: -1,
  unrated: 0,
  cold: 1,
  warm: 2,
  serious: 3,
  vip: 4,
};

export const LEAD_SOURCES = [
  'marketplace_inquiry',
  'direct_call',
  'walk_in',
  'whatsapp',
  'referral',
  'import',
] as const;
export const leadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = (typeof LEAD_SOURCES)[number];

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const REVIEW_STATUSES = ['pending', 'published', 'rejected'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MIN_RATING = 1;
export const MAX_RATING = 5;
export const ratingSchema = z.number().int().min(MIN_RATING).max(MAX_RATING);
