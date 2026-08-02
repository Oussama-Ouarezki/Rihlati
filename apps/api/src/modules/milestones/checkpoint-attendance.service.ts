import { Injectable } from '@nestjs/common';
import {
  type CheckpointAttendance,
  type CheckpointAttendanceStatus,
  type CheckpointType,
  type MilestoneCheckInItem,
  type MilestoneKind,
  type ReservationStatus,
  type SetCheckpointAttendanceInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

interface CheckpointMilestone {
  id: string;
  offerId: string;
  title: string;
  kind: MilestoneKind;
  checkpointType: CheckpointType;
  dayOffset: number;
  sortOrder: number;
}

/**
 * Per-family attendance at ONE checkpoint milestone. See
 * obsidian/Backend/Trip Programme.md §6 for the full design, in particular
 * why a `no_show` at an OPTIONAL checkpoint defaults forward to the next one
 * while a MANDATORY checkpoint never inherits a default.
 *
 * Member-level throughout, same as ReservationsService: checking a family in
 * at a checkpoint is the accompagnateur's job, not a manager's.
 */
@Injectable()
export class CheckpointAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAttendance(tenant: TenantContext, milestoneId: string): Promise<CheckpointAttendance> {
    const milestone = await this.requireCheckpoint(tenant, milestoneId);

    const reservations = await this.prisma.reservation.findMany({
      where: {
        offerId: milestone.offerId,
        agencyId: tenant.agencyId,
        deletedAt: null,
        status: { not: 'cancelled' },
      },
      select: { id: true, contactName: true, contactPhone: true, peopleCount: true },
      take: 500,
    });

    const existing = await this.prisma.milestoneCheckIn.findMany({
      where: { milestoneId, agencyId: tenant.agencyId },
      select: { reservationId: true, status: true, checkedInAt: true },
    });
    const existingByReservation = new Map(existing.map((row) => [row.reservationId, row]));

    const defaults = await this.defaultStatusesFor(
      tenant,
      milestone,
      reservations.map((r) => r.id).filter((id) => !existingByReservation.has(id)),
    );

    const items: MilestoneCheckInItem[] = reservations.map((reservation) => {
      const saved = existingByReservation.get(reservation.id);
      const status = saved ? asAttendanceStatus(saved.status) : (defaults.get(reservation.id) ?? 'expected');
      return {
        reservationId: reservation.id,
        contactName: reservation.contactName,
        contactPhone: reservation.contactPhone,
        peopleCount: reservation.peopleCount,
        status,
        checkedInAt: saved?.checkedInAt?.toISOString() ?? null,
        isDefault: !saved,
      };
    });

    // Same order as the manifest: who's missing first, then arrived, then no-shows.
    const rank: Record<CheckpointAttendanceStatus, number> = {
      expected: 0, checked_in: 1, no_show: 2,
    };
    items.sort((a, b) => rank[a.status] - rank[b.status] || a.contactName.localeCompare(b.contactName));

    return {
      milestone: {
        id: milestone.id,
        title: milestone.title,
        kind: milestone.kind,
        checkpointType: milestone.checkpointType,
      },
      counts: {
        people: sumPeople(items),
        expectedPeople: sumPeople(items, 'expected'),
        checkedInPeople: sumPeople(items, 'checked_in'),
        noShowPeople: sumPeople(items, 'no_show'),
      },
      items,
    };
  }

  /**
   * The check-in tap. Any status to any status, exactly like the manifest —
   * "push them back" is just calling this again with `checked_in`.
   */
  async setAttendance(
    tenant: TenantContext,
    actorUserId: string,
    milestoneId: string,
    reservationId: string,
    input: SetCheckpointAttendanceInput,
    meta: RequestMeta,
  ): Promise<MilestoneCheckInItem> {
    const milestone = await this.requireCheckpoint(tenant, milestoneId);

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: reservationId,
        offerId: milestone.offerId,
        agencyId: tenant.agencyId,
        deletedAt: null,
        status: { not: 'cancelled' },
      },
      select: { id: true, contactName: true, contactPhone: true, peopleCount: true },
    });
    if (!reservation) throw notFound('Réservation');

    const existing = await this.prisma.milestoneCheckIn.findUnique({
      where: { milestoneId_reservationId: { milestoneId, reservationId } },
      select: { status: true },
    });
    const before = existing
      ? asAttendanceStatus(existing.status)
      : ((await this.defaultStatusesFor(tenant, milestone, [reservationId])).get(reservationId) ?? 'expected');

    const checkedIn = input.status === 'checked_in';

    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.milestoneCheckIn.upsert({
        where: { milestoneId_reservationId: { milestoneId, reservationId } },
        update: {
          status: input.status,
          checkedInAt: checkedIn ? new Date() : null,
          checkedInByUserId: checkedIn ? actorUserId : null,
        },
        create: {
          agencyId: tenant.agencyId,
          milestoneId,
          reservationId,
          status: input.status,
          checkedInAt: checkedIn ? new Date() : null,
          checkedInByUserId: checkedIn ? actorUserId : null,
        },
        select: { status: true, checkedInAt: true },
      });

      if (before !== input.status) {
        await this.audit.record(
          {
            action: 'milestone_check_in.status_changed',
            entityType: 'milestone_check_in',
            entityId: `${milestoneId}:${reservationId}`,
            agencyId: tenant.agencyId,
            actorUserId,
            before: { status: before },
            after: { status: input.status },
            ipHash: meta.ipHash ?? null,
            requestId: meta.requestId,
          },
          tx,
        );
      }

      return row;
    });

    return {
      reservationId: reservation.id,
      contactName: reservation.contactName,
      contactPhone: reservation.contactPhone,
      peopleCount: reservation.peopleCount,
      status: asAttendanceStatus(saved.status),
      checkedInAt: saved.checkedInAt?.toISOString() ?? null,
      isDefault: false,
    };
  }

  /** The milestone must be OURS, and it must actually track attendance. */
  private async requireCheckpoint(
    tenant: TenantContext,
    milestoneId: string,
  ): Promise<CheckpointMilestone> {
    const milestone = await this.prisma.offerMilestone.findFirst({
      where: { id: milestoneId, agencyId: tenant.agencyId, deletedAt: null },
      select: {
        id: true, offerId: true, title: true, kind: true,
        checkpointType: true, dayOffset: true, sortOrder: true,
      },
    });
    if (!milestone) throw notFound('Étape');
    if (milestone.checkpointType === 'none') {
      throw new AppError('VALIDATION_FAILED', 'Cette étape ne suit pas de présence');
    }
    return milestone;
  }

  /**
   * `mandatory` never inherits — always `expected`. `optional` inherits
   * `no_show` from the immediately preceding checkpoint milestone, for
   * reservations with no saved row of their own yet. See Trip Programme §6.
   */
  private async defaultStatusesFor(
    tenant: TenantContext,
    milestone: CheckpointMilestone,
    reservationIds: string[],
  ): Promise<Map<string, CheckpointAttendanceStatus>> {
    const defaults = new Map<string, CheckpointAttendanceStatus>();
    if (reservationIds.length === 0 || milestone.checkpointType !== 'optional') {
      for (const id of reservationIds) defaults.set(id, 'expected');
      return defaults;
    }

    const previous = await this.prisma.offerMilestone.findFirst({
      where: {
        offerId: milestone.offerId,
        agencyId: tenant.agencyId,
        deletedAt: null,
        checkpointType: { not: 'none' },
        id: { not: milestone.id },
        OR: [
          { dayOffset: { lt: milestone.dayOffset } },
          { dayOffset: milestone.dayOffset, sortOrder: { lt: milestone.sortOrder } },
        ],
      },
      orderBy: [{ dayOffset: 'desc' }, { sortOrder: 'desc' }],
      select: { id: true },
    });

    const previousStatuses = previous
      ? await this.prisma.milestoneCheckIn.findMany({
          where: {
            milestoneId: previous.id,
            agencyId: tenant.agencyId,
            reservationId: { in: reservationIds },
          },
          select: { reservationId: true, status: true },
        })
      : [];
    const previousByReservation = new Map(previousStatuses.map((row) => [row.reservationId, row.status]));

    for (const id of reservationIds) {
      defaults.set(id, previousByReservation.get(id) === 'no_show' ? 'no_show' : 'expected');
    }
    return defaults;
  }
}

/**
 * `MilestoneCheckIn.status` shares its Prisma enum with `Reservation.status`
 * (see the schema comment), but this endpoint only ever writes the 3-value
 * subset — `cancelled` describes a whole booking, never a single checkpoint.
 * This narrows the type at the one seam where a Prisma row is read back, and
 * would only ever throw if something outside this service wrote `cancelled`
 * into the table directly.
 */
function asAttendanceStatus(status: ReservationStatus): CheckpointAttendanceStatus {
  if (status === 'cancelled') {
    throw new Error('MilestoneCheckIn.status is cancelled — that is a Reservation-level state only');
  }
  return status;
}

function sumPeople(items: MilestoneCheckInItem[], status?: CheckpointAttendanceStatus): number {
  return items
    .filter((item) => status === undefined || item.status === status)
    .reduce((sum, item) => sum + item.peopleCount, 0);
}
