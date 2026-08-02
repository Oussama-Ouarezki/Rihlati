import type { Prisma } from '@prisma/client';
import type { PublicMilestone } from '@rihlati/shared';

/**
 * Turning milestone rows into the shape a CLIENT sees.
 *
 * There are two client audiences and they get different data, so there are two
 * functions rather than one with a flag. The names are the documentation: if
 * you ever wonder "who can see meeting points", grep for `toTravelerMilestone`
 * and the answer is the complete list of call sites.
 */

export const PUBLIC_MILESTONE_SELECT = {
  id: true,
  title: true,
  description: true,
  kind: true,
  dayOffset: true,
  timeOfDay: true,
  locationName: true,
  meetingPoint: true,
  mapUrl: true,
  completedAt: true,
} as const;

type PublicMilestoneRow = Prisma.OfferMilestoneGetPayload<{
  select: typeof PUBLIC_MILESTONE_SELECT;
}>;

function base(row: PublicMilestoneRow): Omit<PublicMilestone, 'meetingPoint' | 'mapUrl'> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    dayOffset: row.dayOffset,
    timeOfDay: row.timeOfDay,
    locationName: row.locationName,
    isDone: row.completedAt !== null,
  };
}

/**
 * For a BUYER browsing the public offer page — somebody who has not booked.
 *
 * They see the shape of the trip: the days, the steps, the hotels, the
 * ziyarat. They do not see where the bus leaves from. A meeting point is
 * operational detail that only matters once you are going, and publishing
 * "parking de l'agence, 4h30, devant l'entrée" on an indexable page hands a
 * competitor the agency's routine and hands anyone else a place to stand.
 * The traveler gets it the moment they have a booking.
 */
export function toBuyerMilestone(row: PublicMilestoneRow): PublicMilestone {
  return {
    ...base(row),
    // Withheld on purpose — not "not selected yet". See the doc comment above.
    meetingPoint: null,
    mapUrl: null,
  };
}

/** For a TRAVELER who has booked this departure. They need to know where to stand. */
export function toTravelerMilestone(row: PublicMilestoneRow): PublicMilestone {
  return {
    ...base(row),
    meetingPoint: row.meetingPoint,
    mapUrl: row.mapUrl,
  };
}
