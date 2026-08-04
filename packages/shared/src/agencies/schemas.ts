import { z } from 'zod';
import { agencyRoleSchema, agencyStatusSchema, localeSchema, type Locale } from '../enums';
import { algerianPhoneSchema } from '../phone';
import { wilayaCodeSchema } from '../wilayas';
import { paginationSchema } from '../pagination';

/**
 * AGENCY REQUEST SHAPES
 *
 * An agency is created by a logged-in user, who becomes its `owner`. It starts
 * in `draft` and is invisible to travelers until a human at Rihlati verifies
 * the RC / NIF / tourism licence.
 *
 * That manual check is slow on purpose. "Verified agency" is the only thing
 * this marketplace really sells to a traveler handing over 400 000 DZD for an
 * Omra — if it can be self-granted through the API it is worth nothing.
 */

export const agencySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'validation.slugTooShort')
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'validation.slugFormat');

/**
 * Reserved because they collide with real or planned URL paths, or because
 * they let an agency impersonate the platform. Checked before uniqueness so
 * the message is useful.
 */
export const RESERVED_AGENCY_SLUGS: readonly string[] = [
  'admin', 'api', 'app', 'auth', 'rihlati', 'support', 'help', 'about',
  'search', 'offers', 'agencies', 'leads', 'login', 'register', 'account',
  'settings', 'billing', 'new', 'www', 'static', 'assets', 'null', 'undefined',
];

/**
 * Note what is absent (CLAUDE.md rule #2): no `status`, no `verifiedAt`, no
 * `plan`, no `publishedOfferLimitOverride`, no rating counters. An agency that
 * could send `status: "verified"` could verify itself.
 */
export const createAgencySchema = z.object({
  name: z.string().trim().min(2, 'validation.nameTooShort').max(120),
  slug: agencySlugSchema,
  legalName: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),

  phone: algerianPhoneSchema.optional(),
  whatsapp: algerianPhoneSchema.optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  websiteUrl: z.string().trim().url().max(500).optional(),

  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  wilayaCode: wilayaCodeSchema.optional(),

  // Verification documents. Free-form strings: formats vary by wilaya and by
  // year, and rejecting a valid RC because of an over-strict regex costs a real
  // agency. A human reads these anyway.
  registreCommerce: z.string().trim().max(60).optional(),
  nif: z.string().trim().max(60).optional(),
  tourismLicence: z.string().trim().max(60).optional(),
});
export type CreateAgencyInput = z.infer<typeof createAgencySchema>;

/** `slug` is absent: it is the public URL, and changing it breaks every link. */
export const updateAgencySchema = createAgencySchema.omit({ slug: true }).partial();
export type UpdateAgencyInput = z.infer<typeof updateAgencySchema>;

/** Submit for verification. Separate endpoint so the transition is auditable. */
export const submitAgencyForReviewSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// STAFF
// ---------------------------------------------------------------------------

/**
 * Invite by email or phone — the person may not have an account yet.
 * `owner` is not invitable: ownership transfers through its own flow, so
 * "invite a colleague" can never create a second person who can delete the
 * agency and its billing.
 */
export const inviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: algerianPhoneSchema.optional(),
    role: z.enum(['manager', 'agent']),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: 'validation.emailOrPhoneRequired',
    path: ['email'],
  });
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(['manager', 'agent']),
});

// ---------------------------------------------------------------------------
// FAQ — "repeated questions", answered once
// ---------------------------------------------------------------------------

/**
 * An agency answers its recurring questions once. Two consumers:
 *   1. today: an FAQ section on the public agency page
 *   2. later: the knowledge base the per-agency chatbot answers from
 *      (see obsidian/Backend/Agency Chatbot.md)
 *
 * Capped at MAX_FAQ_ENTRIES per agency — that cap is also why the FAQ list
 * endpoints don't need pagination.
 */
export const MAX_FAQ_ENTRIES = 50;

export const createFaqSchema = z.object({
  question: z.string().trim().min(5, 'validation.questionTooShort').max(300),
  answer: z.string().trim().min(1, 'validation.answerEmpty').max(2000),
  /** The language the entry is written in — not who may see it. */
  locale: localeSchema.default('fr'),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type CreateFaqInput = z.infer<typeof createFaqSchema>;

export const updateFaqSchema = createFaqSchema.partial();
export type UpdateFaqInput = z.infer<typeof updateFaqSchema>;

export interface AgencyFaqItem {
  id: string;
  question: string;
  answer: string;
  locale: Locale;
  sortOrder: number;
}

/** The member view adds what the public one must not show. */
export interface AgencyFaqItemForMember extends AgencyFaqItem {
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// PUBLIC LISTING
// ---------------------------------------------------------------------------

export const agencySearchSchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  wilayaCode: wilayaCodeSchema.optional(),
  minRating: z.coerce.number().min(1).max(5).optional(),
});
export type AgencySearchInput = z.infer<typeof agencySearchSchema>;

// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------

/**
 * What a traveler may see. Built field by field, never spread from the row —
 * `nif`, `registreCommerce` and the moderation counters are internal.
 */
export interface PublicAgency {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  isVerified: boolean;
  verifiedAt: string | null;
  city: string | null;
  wilayaCode: string | null;
  phone: string | null;
  whatsapp: string | null;
  websiteUrl: string | null;
  /** null until there is at least one published review. */
  rating: number | null;
  ratingCount: number;
  publishedOfferCount: number;
  createdAt: string;
}

/** What a member of the agency sees about their own agency — adds the private parts. */
export interface AgencyForMember extends PublicAgency {
  status: z.infer<typeof agencyStatusSchema>;
  rejectionReason: string | null;
  legalName: string | null;
  email: string | null;
  addressLine: string | null;
  registreCommerce: string | null;
  nif: string | null;
  tourismLicence: string | null;
  plan: string;
  yourRole: z.infer<typeof agencyRoleSchema>;
  limits: {
    publishedOffers: { used: number; limit: number | null };
    seats: { used: number; limit: number | null };
  };
}
