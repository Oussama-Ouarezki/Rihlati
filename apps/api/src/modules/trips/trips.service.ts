import { Injectable } from '@nestjs/common';
import type { TravelerTripView } from '@rihlati/shared';
import { notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PUBLIC_MILESTONE_SELECT,
  toTravelerMilestone,
} from '../milestones/milestone-mapper';

/**
 * The booked traveler's own trip page, behind a capability URL.
 * See obsidian/Backend/Trip Programme.md §5 for the security reasoning.
 */
@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService) {}

  async getByPublicCode(code: string): Promise<TravelerTripView> {
    /*
     * READ THIS BEFORE COPYING THIS QUERY.
     *
     * Every other query in this codebase is scoped by `agencyId` from the
     * session (CLAUDE.md rule #3). This one is not, and it is not an
     * oversight: there is no session. The caller is a family with a WhatsApp
     * link and no account.
     *
     * What replaces the tenant scope is the code itself. `publicCode` is 128
     * random bits and globally unique, so it *names exactly one reservation
     * across every agency* — there is no id to swap for a neighbour's and no
     * tenant to confuse. The code is the authorization.
     *
     * That only holds while two things stay true, and both are enforced here:
     *
     *   1. The endpoint is rate limited (see the controller). Without that,
     *      "unguessable" becomes "unguessable at this rate", and the rate is
     *      whatever the attacker's bandwidth allows.
     *   2. The response is a hand-built allow-list. Not `...reservation`.
     *      The day someone adds a `costCentimes` column, it must not appear
     *      on a page that anyone with a forwarded link can open.
     *
     * `findFirst`, not `findUnique`, because we also require `deletedAt: null`
     * — a cancelled booking's link must stop working, not keep showing the
     * programme.
     */
    const reservation = await this.prisma.reservation.findFirst({
      where: { publicCode: code, deletedAt: null },
      select: {
        contactName: true,
        peopleCount: true,
        offer: {
          select: {
            title: true,
            departureDate: true,
            returnDate: true,
            destinationCity: true,
            destinationCountry: true,
            deletedAt: true,
            milestones: {
              where: { deletedAt: null },
              select: PUBLIC_MILESTONE_SELECT,
              orderBy: [{ dayOffset: 'asc' }, { sortOrder: 'asc' }],
              take: 200,
            },
          },
        },
        agency: {
          select: { name: true, phone: true, whatsapp: true, logoUrl: true, deletedAt: true },
        },
      },
    });

    // A wrong code, a cancelled booking, a deleted offer and a closed agency
    // are all the same 404. Distinguishing them would turn this endpoint into
    // an oracle that confirms which codes exist.
    if (!reservation || reservation.offer.deletedAt || reservation.agency.deletedAt) {
      throw notFound('Voyage');
    }

    const milestones = reservation.offer.milestones.map(toTravelerMilestone);

    return {
      contactName: reservation.contactName,
      peopleCount: reservation.peopleCount,
      offer: {
        title: reservation.offer.title,
        departureDate: dateOnly(reservation.offer.departureDate),
        returnDate: dateOnly(reservation.offer.returnDate),
        destinationCity: reservation.offer.destinationCity,
        destinationCountry: reservation.offer.destinationCountry,
      },
      agency: {
        name: reservation.agency.name,
        phone: reservation.agency.phone,
        whatsapp: reservation.agency.whatsapp,
        logoUrl: reservation.agency.logoUrl,
      },
      milestones,
      // The first step the agency has not ticked. Milestones arrive already
      // ordered by day then position, so "first not done" is the group's
      // position on the map without any date arithmetic.
      currentMilestoneId: milestones.find((milestone) => !milestone.isDone)?.id ?? null,
    };
  }
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
