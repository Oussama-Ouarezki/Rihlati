import type { PublicMilestone } from '../milestones/schemas';

/**
 * THE TRAVELER'S TRIP PAGE — /mon-voyage/{code}
 *
 * A family that booked has usually not got an account, and that is deliberate:
 * a lead becomes a reservation without anybody signing up. So this page cannot
 * sit behind a login. It sits behind a capability URL instead — a 128-bit
 * random code the agency sends once by WhatsApp on confirmation.
 *
 * That trade has a hard consequence: **whoever holds the link, has access.**
 * Links get forwarded to the family group chat, screenshotted, and pasted into
 * places nobody intended. So the rule for this type is not "what would be nice
 * to show" but "what is safe in the hands of a stranger":
 *
 *   ALLOWED     this family's own name and headcount; the programme, which is
 *               already public; the agency's already-public contact details.
 *   NEVER       the passenger list or any other family's name or phone; the
 *               price paid; the reservation's internal status; operational
 *               notes; anything from the CRM — imagine a traveler reading that
 *               the agency has labelled them a time-waster.
 *
 * If this page ever needs to show more than the list above, it needs real
 * authentication instead, not a longer code. See Trip Programme.md §5.
 */
export interface TravelerTripView {
  /** This family's own booking. Nothing here identifies anyone else. */
  contactName: string;
  peopleCount: number;

  offer: {
    title: string;
    /** ISO date, no time. Anchors `dayOffset` to real calendar days. */
    departureDate: string | null;
    returnDate: string | null;
    destinationCity: string | null;
    destinationCountry: string | null;
  };

  /** Already public on the offer page — this is not new exposure. */
  agency: {
    name: string;
    phone: string | null;
    whatsapp: string | null;
    logoUrl: string | null;
  };

  /** Traveler-shaped: meeting points included, because they booked. */
  milestones: PublicMilestone[];

  /**
   * The first step the agency has not ticked off yet — "you are here" on the
   * map, and the step the page leads with. Null when every step is done: the
   * trip is over, and inventing a "next" step would be a lie.
   *
   * Derived server-side from `completedAt`, never from the clock. A programme
   * says 04:30 but the bus leaves when the bus leaves, and the agency ticking
   * a step is a deliberate act; a clock would confidently announce that a
   * delayed group had already boarded.
   */
  currentMilestoneId: string | null;
}
