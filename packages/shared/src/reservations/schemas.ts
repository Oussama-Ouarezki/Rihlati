import { z } from 'zod';
import { algerianPhoneSchema } from '../phone';

/**
 * RESERVATIONS — the trip manifest ("la liste de la rihla")
 *
 * The mapping to the owner's words, colour for colour:
 *
 *   expected    🟡  "coming"      confirmed, not yet at the bus
 *   checked_in  🟢  "came"        physically present, counted
 *   no_show     🔴  "not coming"  didn't show up
 *   cancelled   ⚪  called off before departure day
 *
 * One reservation = one FAMILY with a headcount, because in Algeria one
 * person reserves for everyone. Bus occupancy is sum(peopleCount), never
 * count(rows) — get that wrong and the 52-seat bus "fits" 70 people.
 */
export const RESERVATION_STATUSES = ['expected', 'checked_in', 'no_show', 'cancelled'] as const;
export const reservationStatusSchema = z.enum(RESERVATION_STATUSES);
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Any status may become any status. Deliberate: at a bus at 4am the most
 * common operation after a tap is "oops, wrong row", and a state machine that
 * refuses the undo gets abandoned after one departure. Accountability comes
 * from the audit log (who tapped, when), not from blocking.
 */

/**
 * Create either FROM a lead (the CRM flow: `leadId`, contact copied
 * server-side from the lead) or MANUALLY (the walk-in flow: name + phone).
 * `offerId` is optional when `leadId` is given — it defaults to the lead's
 * own offer.
 */
export const createReservationSchema = z
  .object({
    offerId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    contactName: z.string().trim().min(2, 'Nom trop court').max(80).optional(),
    contactPhone: algerianPhoneSchema.optional(),
    peopleCount: z.number().int().min(1).max(200).default(1),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.leadId) || (Boolean(v.contactName) && Boolean(v.contactPhone)), {
    message: 'Indiquez un client existant, ou un nom et un téléphone',
    path: ['contactName'],
  })
  .refine((v) => Boolean(v.leadId) || Boolean(v.offerId), {
    message: 'Indiquez le départ concerné',
    path: ['offerId'],
  });
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const updateReservationSchema = z.object({
  status: reservationStatusSchema.optional(),
  peopleCount: z.number().int().min(1).max(200).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;

// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------

export interface ReservationItem {
  id: string;
  offerId: string;
  leadId: string | null;
  contactName: string;
  contactPhone: string;
  peopleCount: number;
  status: ReservationStatus;
  checkedInAt: string | null;
  notes: string | null;
  /** How this client arrived: the lead's source when linked, null for manual. */
  source: string | null;
  /**
   * The code for this family's /mon-voyage/{code} page, so the agency can send
   * them the link. Agency-facing only — this list never leaves the console.
   *
   * Null on reservations created before the column existed; the console mints
   * one on demand rather than a migration inventing random values.
   */
  publicCode: string | null;
  createdAt: string;
}

/** People totals by status. The bus math, done server-side once. */
export interface ManifestCounts {
  reservations: number;
  people: number;
  expectedPeople: number;
  checkedInPeople: number;
  noShowPeople: number;
  cancelledPeople: number;
}

/** One row of the departures list. */
export interface DepartureSummary {
  offerId: string;
  title: string;
  slug: string;
  departureDate: string;
  returnDate: string | null;
  seatsTotal: number | null;
  counts: ManifestCounts;
}

/** The check-in screen's whole payload. */
export interface Manifest {
  offer: {
    id: string;
    title: string;
    slug: string;
    departureDate: string | null;
    returnDate: string | null;
    seatsTotal: number | null;
  };
  counts: ManifestCounts;
  /** Ordered for the bus: expected first, then checked-in, then the rest. */
  reservations: ReservationItem[];
}
