import type { DuplicateStatus, OfferKind, OfferStatus } from '../enums';
import type { PublicMilestone } from '../milestones/schemas';
import type { OfferMedia } from './schemas';

/**
 * OFFER RESPONSE SHAPES
 *
 * These are allow-lists, not mirrors of the database row. The API builds them
 * field by field.
 *
 * That is deliberate and it is a security control: if a response were built by
 * spreading the Prisma row, then the day someone adds an internal column —
 * a cost, a supplier's name, a moderation note — it would ship to every
 * traveler in the next deploy with nobody noticing.
 */

export interface OfferAgencySummary {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  isVerified: boolean;
  rating: number | null;
  ratingCount: number;
  wilayaCode: string | null;
  /**
   * Public contact channels, E.164. Already public on the agency page —
   * repeated here so the offer page can render its WhatsApp/call buttons
   * without a second request. In Algeria the WhatsApp button IS the
   * conversion path for half the audience.
   */
  phone: string | null;
  whatsapp: string | null;
}

/** What a traveler sees in a search result. */
export interface OfferSummary {
  id: string;
  slug: string;
  kind: OfferKind;
  title: string;
  summary: string | null;
  priceFromCentimes: number;
  priceToCentimes: number | null;
  currency: string;
  departureDate: string | null;
  returnDate: string | null;
  durationDays: number | null;
  isFlexibleDates: boolean;
  departureWilayaCode: string | null;
  destinationCountry: string | null;
  destinationCity: string | null;
  seatsLeft: number | null;
  isFeatured: boolean;
  coverImageUrl: string | null;
  agency: OfferAgencySummary;
  publishedAt: string | null;
}

/** The offer detail page. Adds the long text and the kind-specific attributes. */
export interface OfferDetail extends OfferSummary {
  description: string | null;
  attributes: Record<string, unknown>;
  media: OfferMedia[];
  seatsTotal: number | null;
  /**
   * The programme, rendered as the node map on the offer page. Buyer-shaped:
   * no meeting points (see `toBuyerMilestone`). Empty when the agency has not
   * built one — a programme is not required to publish.
   */
  milestones: PublicMilestone[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The same offer as its own agency sees it. Adds the operational fields a
 * traveler must never see: review status, quality score, and the spam flags.
 *
 * The agency DOES see its own `duplicateStatus`. Flagging a listing without
 * telling the seller is how a marketplace acquires a reputation for shadow
 * banning — they must be able to see it and contest it.
 */
export interface OfferForAgency extends Omit<OfferDetail, 'milestones'> {
  /**
   * `milestones` is dropped rather than inherited: the agency reads its own
   * programme from GET .../offers/:offerId/milestones, which carries the
   * meeting points and checkpoint types this buyer-shaped list strips out.
   * Leaving the weaker field here would invite reading it by accident and
   * concluding the meeting points were lost.
   */
  status: OfferStatus;
  duplicateStatus: DuplicateStatus;
  duplicateOfOfferId: string | null;
  reportCount: number;
  qualityScore: number;
  expiresAt: string | null;
  deletedAt: string | null;
}
