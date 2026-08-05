import { z } from 'zod';

/**
 * TRIP PROGRAMME — milestones & per-checkpoint attendance
 * (see obsidian/Backend/Trip Programme.md)
 *
 * These mirror the enums in apps/api/prisma/schema.prisma — when you add a
 * value in Prisma, add it here too.
 */

export const MILESTONE_KINDS = [
  'meeting',
  'transport',
  'flight',
  'hotel',
  'ritual',
  'ziyara',
  'meal',
  'free_time',
  'other',
] as const;
export const milestoneKindSchema = z.enum(MILESTONE_KINDS);
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/**
 * Whether — and how strictly — attendance is tracked at a milestone.
 *
 *   none      informational only, no attendance tracked (most milestones)
 *   mandatory checked in fresh every time; never defaults to no_show, because
 *             a wrong default here can mean a family left behind on a flight
 *   optional  attendance tracked; a no_show here is allowed to default
 *             forward to the next optional checkpoint — people who skip one
 *             excursion often skip the next, and re-marking the same absent
 *             family at every stop is needless work for the guide
 */
export const CHECKPOINT_TYPES = ['none', 'mandatory', 'optional'] as const;
export const checkpointTypeSchema = z.enum(CHECKPOINT_TYPES);
export type CheckpointType = (typeof CHECKPOINT_TYPES)[number];

// ---------------------------------------------------------------------------
// MILESTONES — the agency-editable programme
// ---------------------------------------------------------------------------

/** "04:30". Free text on purpose — see Trip Programme.md §4 on timezones. */
const timeOfDaySchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.timeFormat')
  .optional();

/**
 * A milestone title has to fit on a node tile in the traveler's programme map
 * (see Trip Programme.md §7), which is roughly two short lines on a phone.
 * The limit is deliberately tight: a title long enough to need truncating is
 * a title nobody can read while walking through an airport. Anything longer
 * belongs in `description`, which the traveler opens on tap.
 *
 * Imported by the console form so the input's `maxLength` and the server's
 * rule are one number, not two that drift.
 */
export const MILESTONE_TITLE_MAX = 60;

/**
 * A ceiling on one offer's programme. Not a plan limit and not a sales lever —
 * a sanity bound, so that the two bulk operations below (which write many rows
 * from one tap) cannot grow a programme without end. A 200-step trip is not a
 * real trip; the API's list read is capped at the same number, so a programme
 * past this point would silently stop rendering in full.
 */
export const MILESTONE_MAX_PER_OFFER = 200;

export const createMilestoneSchema = z.object({
  title: z.string().trim().min(2, 'validation.titleTooShort').max(MILESTONE_TITLE_MAX),
  description: z.string().trim().max(1000).optional(),
  kind: milestoneKindSchema.default('other'),
  dayOffset: z.number().int().min(0).max(365).default(0),
  timeOfDay: timeOfDaySchema,
  locationName: z.string().trim().max(200).optional(),
  meetingPoint: z.string().trim().max(500).optional(),
  mapUrl: z.string().trim().url('validation.urlInvalid').max(2048).optional(),
  checkpointType: checkpointTypeSchema.default('none'),
});
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

/** Everything from create, but nothing required — a real PATCH. */
export const updateMilestoneSchema = createMilestoneSchema.partial();
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

/**
 * The full ordered list of a programme's milestone ids. The service rewrites
 * `sortOrder` from this order and rejects anything that isn't exactly the
 * offer's current milestone set — no partial reorders, no smuggled ids.
 */
export const reorderMilestonesSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderMilestonesInput = z.infer<typeof reorderMilestonesSchema>;

/**
 * Ticking a step off as the trip happens. `isDone: false` is the undo, which
 * is the tap that matters most right after a wrong one.
 *
 * Note what this is NOT: per-family attendance. The group can move on to the
 * next step while one family is still being chased down — those are two
 * different questions and two different tables. See Trip Programme.md §6.
 */
export const setMilestoneCompletionSchema = z.object({
  isDone: z.boolean(),
});
export type SetMilestoneCompletionInput = z.infer<typeof setMilestoneCompletionSchema>;

// ---------------------------------------------------------------------------
// THE TWO BULK OPERATIONS — see Trip Programme.md §7.6
//
// Both exist for the same reason: an Omra programme is repetitive, and typing
// the same five steps out again is the point at which an agency stops using
// the feature and goes back to a paragraph of prose. Both are ADDITIVE — they
// only ever append rows, never move or delete an existing one. Undoing an
// unwanted copy is deleting the rows it made; undoing a copy that had silently
// rewritten the programme underneath it would be impossible.
// ---------------------------------------------------------------------------

/**
 * Copy every step of one day onto another day of the SAME offer.
 *
 * `targetDayOffset` is explicit rather than "the next day" because agencies do
 * not build programmes strictly in order — day 6 gets duplicated onto day 9
 * after the middle is filled in. The console defaults it to the day after the
 * source, which is the common case, but the server never assumes it.
 *
 * Copies land after anything already on the target day. Other days are never
 * shifted: a bulk action that renumbered the rest of the trip would be a
 * destructive edit wearing a convenience label.
 */
export const duplicateMilestoneDaySchema = z.object({
  sourceDayOffset: z.number().int().min(0).max(365),
  targetDayOffset: z.number().int().min(0).max(365),
});
export type DuplicateMilestoneDayInput = z.infer<typeof duplicateMilestoneDaySchema>;

/**
 * Copy another offer's whole programme into this one — next season's Ramadan
 * trip is last season's with new dates.
 *
 * `sourceOfferId` is a client-sent id pointing at tenant-scoped data, so the
 * server re-checks that it belongs to the caller's agency; a foreign id is a
 * 404 like everywhere else (rule #3). This is the field to look at first if
 * this endpoint is ever reviewed for isolation bugs.
 *
 * Day offsets and relative order are preserved. Because `dayOffset` is a
 * relative number and not a date (§4), the copied programme lands correctly on
 * a departure date it has never heard of.
 */
export const copyProgrammeFromOfferSchema = z.object({
  sourceOfferId: z.string().uuid(),
});
export type CopyProgrammeFromOfferInput = z.infer<typeof copyProgrammeFromOfferSchema>;

/**
 * One candidate in the "copy from another offer" picker. `milestoneCount` is
 * here so the agency can tell last season's full 14-day programme from the
 * two-step draft without opening either.
 */
export interface ProgrammeCopySource {
  offerId: string;
  title: string;
  departureDate: string | null;
  milestoneCount: number;
}

export interface MilestoneItem {
  id: string;
  offerId: string;
  title: string;
  description: string | null;
  kind: MilestoneKind;
  dayOffset: number;
  timeOfDay: string | null;
  locationName: string | null;
  meetingPoint: string | null;
  mapUrl: string | null;
  sortOrder: number;
  checkpointType: CheckpointType;
  completedAt: string | null;
  createdAt: string;
}

/**
 * A milestone as a CLIENT sees it — the public offer page and the booked
 * traveler's page. Deliberately NOT `MilestoneItem`.
 *
 * What is missing is the point. `sortOrder` and `offerId` are plumbing.
 * `checkpointType` and `completedByUserId` are the agency's internal
 * operations — a traveler learning that this stop is where the guide counts
 * heads, or which employee ticked it, tells them nothing and leaks how the
 * agency runs. `completedAt` collapses to a boolean because the client only
 * asks "has this happened", never "at 14:07:33".
 *
 * `meetingPoint` and `mapUrl` are populated ONLY for someone who has booked.
 * See Trip Programme.md §5 and the mapper that fills them.
 */
export interface PublicMilestone {
  id: string;
  title: string;
  description: string | null;
  kind: MilestoneKind;
  dayOffset: number;
  timeOfDay: string | null;
  locationName: string | null;
  meetingPoint: string | null;
  mapUrl: string | null;
  /** Ticked by the agency as the trip happens. Drives the "you are here" node. */
  isDone: boolean;
}

// ---------------------------------------------------------------------------
// CHECKPOINT ATTENDANCE — per-family presence at ONE checkpoint milestone
// ---------------------------------------------------------------------------

/**
 * Deliberately a subset of ReservationStatus: `cancelled` describes the whole
 * booking (Reservation.status), never a single checkpoint. A family cannot be
 * "cancelled" at one ziyara and booked everywhere else.
 */
export const CHECKPOINT_ATTENDANCE_STATUSES = ['expected', 'checked_in', 'no_show'] as const;
export const checkpointAttendanceStatusSchema = z.enum(CHECKPOINT_ATTENDANCE_STATUSES);
export type CheckpointAttendanceStatus = (typeof CHECKPOINT_ATTENDANCE_STATUSES)[number];

export const setCheckpointAttendanceSchema = z.object({
  status: checkpointAttendanceStatusSchema,
});
export type SetCheckpointAttendanceInput = z.infer<typeof setCheckpointAttendanceSchema>;

export interface MilestoneCheckInItem {
  reservationId: string;
  contactName: string;
  contactPhone: string;
  peopleCount: number;
  status: CheckpointAttendanceStatus;
  checkedInAt: string | null;
  /**
   * True when this row reflects a saved `MilestoneCheckIn`. False means the
   * status shown is a computed DEFAULT (fresh `expected`, or a carried-forward
   * `no_show` per Trip Programme.md §6) — nobody has tapped this family at
   * this checkpoint yet.
   */
  isDefault: boolean;
}

export interface CheckpointAttendanceCounts {
  people: number;
  expectedPeople: number;
  checkedInPeople: number;
  noShowPeople: number;
}

export interface CheckpointAttendance {
  milestone: {
    id: string;
    title: string;
    kind: MilestoneKind;
    checkpointType: CheckpointType;
  };
  counts: CheckpointAttendanceCounts;
  /** Ordered like the manifest: expected first — who's missing is the question. */
  items: MilestoneCheckInItem[];
}
