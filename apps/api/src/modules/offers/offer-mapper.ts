import type { Prisma } from '@prisma/client';
import type {
  OfferDetail,
  OfferForAgency,
  OfferMedia,
  OfferSummary,
} from '@rihlati/shared';
import {
  PUBLIC_MILESTONE_SELECT,
  toBuyerMilestone,
} from '../milestones/milestone-mapper';

/**
 * Turning database rows into API responses.
 *
 * Every field is copied by hand. That is tedious and it is the point: an
 * internal column added to `offers` next month cannot reach a traveler unless
 * somebody edits this file, which is a line a reviewer will see. A `{ ...row }`
 * here would ship it silently.
 */

export const OFFER_AGENCY_SELECT = {
  id: true, slug: true, name: true, logoUrl: true, status: true,
  ratingSum: true, ratingCount: true, wilayaCode: true,
  phone: true, whatsapp: true,
} as const;

export const OFFER_SUMMARY_SELECT = {
  id: true, slug: true, kind: true, title: true, summary: true,
  priceFromCentimes: true, priceToCentimes: true, currency: true,
  departureDate: true, returnDate: true, durationDays: true, isFlexibleDates: true,
  departureWilayaCode: true, destinationCountry: true, destinationCity: true,
  seatsTotal: true, seatsLeft: true, isFeatured: true, media: true,
  publishedAt: true,
  agency: { select: OFFER_AGENCY_SELECT },
} as const;

export const OFFER_DETAIL_SELECT = {
  ...OFFER_SUMMARY_SELECT,
  description: true, attributes: true, createdAt: true, updatedAt: true,
} as const;

/**
 * The public offer page only. Pulls the programme in the same round trip.
 *
 * The agency view deliberately does NOT extend this: an agency reads its
 * programme from the milestones endpoint, which carries the meeting points and
 * checkpoint types that `toBuyerMilestone` strips out.
 */
/**
 * Declared separately because `as const` would make the array readonly and
 * Prisma's `orderBy` input insists on a mutable one. Day first, then the
 * agency's manual order within the day.
 */
const MILESTONE_ORDER: Prisma.OfferMilestoneOrderByWithRelationInput[] = [
  { dayOffset: 'asc' },
  { sortOrder: 'asc' },
];

export const OFFER_PUBLIC_DETAIL_SELECT = {
  ...OFFER_DETAIL_SELECT,
  milestones: {
    where: { deletedAt: null },
    select: PUBLIC_MILESTONE_SELECT,
    orderBy: MILESTONE_ORDER,
    take: 200, // a 200-step programme is not a real trip
  },
} as const;

export const OFFER_AGENCY_VIEW_SELECT = {
  ...OFFER_DETAIL_SELECT,
  status: true, duplicateStatus: true, duplicateOfOfferId: true,
  reportCount: true, qualityScore: true, expiresAt: true, deletedAt: true,
} as const;

type SummaryRow = Prisma.OfferGetPayload<{ select: typeof OFFER_SUMMARY_SELECT }>;
type DetailRow = Prisma.OfferGetPayload<{ select: typeof OFFER_DETAIL_SELECT }>;
type PublicDetailRow = Prisma.OfferGetPayload<{ select: typeof OFFER_PUBLIC_DETAIL_SELECT }>;
type AgencyViewRow = Prisma.OfferGetPayload<{ select: typeof OFFER_AGENCY_VIEW_SELECT }>;

/** Dates are stored as DATE, not timestamp. Only the date half is meaningful. */
function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function parseMedia(value: Prisma.JsonValue): OfferMedia[] {
  if (!Array.isArray(value)) return [];
  return value as unknown as OfferMedia[];
}

function coverImage(media: OfferMedia[]): string | null {
  const images = media.filter((item) => item.kind === 'image');
  if (images.length === 0) return null;
  const sorted = [...images].sort((a, b) => a.order - b.order);
  return sorted[0]?.url ?? null;
}

export function toOfferSummary(row: SummaryRow): OfferSummary {
  const media = parseMedia(row.media);
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    priceFromCentimes: row.priceFromCentimes,
    priceToCentimes: row.priceToCentimes,
    currency: row.currency,
    departureDate: dateOnly(row.departureDate),
    returnDate: dateOnly(row.returnDate),
    durationDays: row.durationDays,
    isFlexibleDates: row.isFlexibleDates,
    departureWilayaCode: row.departureWilayaCode,
    destinationCountry: row.destinationCountry,
    destinationCity: row.destinationCity,
    seatsLeft: row.seatsLeft,
    isFeatured: row.isFeatured,
    coverImageUrl: coverImage(media),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    agency: {
      id: row.agency.id,
      slug: row.agency.slug,
      name: row.agency.name,
      logoUrl: row.agency.logoUrl,
      isVerified: row.agency.status === 'verified',
      rating:
        row.agency.ratingCount === 0
          ? null
          : Math.round((row.agency.ratingSum / row.agency.ratingCount) * 10) / 10,
      ratingCount: row.agency.ratingCount,
      wilayaCode: row.agency.wilayaCode,
      phone: row.agency.phone,
      whatsapp: row.agency.whatsapp,
    },
  };
}

/** Everything both detail shapes share. Neither audience's extras live here. */
function toOfferDetailBase(row: DetailRow): Omit<OfferDetail, 'milestones'> {
  const media = parseMedia(row.media);
  return {
    ...toOfferSummary(row),
    description: row.description,
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    media,
    seatsTotal: row.seatsTotal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOfferDetail(row: PublicDetailRow): OfferDetail {
  return {
    ...toOfferDetailBase(row),
    milestones: row.milestones.map(toBuyerMilestone),
  };
}

export function toOfferForAgency(row: AgencyViewRow): OfferForAgency {
  return {
    ...toOfferDetailBase(row),
    status: row.status,
    // The agency sees its own spam flag. Demoting a seller's listing without
    // telling them is how a marketplace earns a reputation for shadow banning.
    duplicateStatus: row.duplicateStatus,
    duplicateOfOfferId: row.duplicateOfOfferId,
    reportCount: row.reportCount,
    qualityScore: row.qualityScore,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
