import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type CreateReservationInput,
  type DepartureSummary,
  type Manifest,
  type ManifestCounts,
  type ReservationItem,
  type ReservationStatus,
  type UpdateReservationInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { generateCapabilityCode } from '../../common/crypto/hashing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

/**
 * The trip manifest. Everything here is member-level on purpose: check-in at
 * the bus is AGENT work — a roles gate on the operational tool would just
 * mean the owner's phone gets passed around at 4am.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The departures list: every offer with a date, from a week back (the trip
   * that left yesterday still needs its no-shows recorded) onwards, with the
   * people-math done here so the page renders numbers, not queries.
   */
  async listDepartures(tenant: TenantContext): Promise<DepartureSummary[]> {
    const horizon = new Date(Date.now() - 7 * 86_400_000);

    const offers = await this.prisma.offer.findMany({
      where: {
        agencyId: tenant.agencyId,
        deletedAt: null,
        departureDate: { not: null, gte: horizon },
      },
      select: {
        id: true, title: true, slug: true,
        departureDate: true, returnDate: true, seatsTotal: true,
      },
      orderBy: { departureDate: 'asc' },
      take: 100, // bounded: a hundred dated departures at once is not a real agency
    });

    if (offers.length === 0) return [];

    const grouped = await this.prisma.reservation.groupBy({
      by: ['offerId', 'status'],
      where: {
        agencyId: tenant.agencyId,
        offerId: { in: offers.map((offer) => offer.id) },
        deletedAt: null,
      },
      _count: { _all: true },
      _sum: { peopleCount: true },
    });

    return offers.map((offer) => ({
      offerId: offer.id,
      title: offer.title,
      slug: offer.slug,
      departureDate: offer.departureDate?.toISOString().slice(0, 10) ?? '',
      returnDate: offer.returnDate?.toISOString().slice(0, 10) ?? null,
      seatsTotal: offer.seatsTotal,
      counts: countsFor(grouped.filter((row) => row.offerId === offer.id)),
    }));
  }

  /** The check-in screen's payload: one departure, all its families. */
  async getManifest(tenant: TenantContext, offerId: string): Promise<Manifest> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: {
        id: true, title: true, slug: true,
        departureDate: true, returnDate: true, seatsTotal: true,
      },
    });
    if (!offer) throw notFound('Départ');

    const rows = await this.prisma.reservation.findMany({
      where: { agencyId: tenant.agencyId, offerId, deletedAt: null },
      select: RESERVATION_SELECT,
      // Postgres orders the enum by declaration: expected, checked_in,
      // no_show, cancelled — which is exactly the bus order (who's missing
      // first). Name second so a list of 40 families is scannable.
      orderBy: [{ status: 'asc' }, { contactName: 'asc' }],
      take: 500,
    });

    const grouped = await this.prisma.reservation.groupBy({
      by: ['offerId', 'status'],
      where: { agencyId: tenant.agencyId, offerId, deletedAt: null },
      _count: { _all: true },
      _sum: { peopleCount: true },
    });

    return {
      offer: {
        id: offer.id,
        title: offer.title,
        slug: offer.slug,
        departureDate: offer.departureDate?.toISOString().slice(0, 10) ?? null,
        returnDate: offer.returnDate?.toISOString().slice(0, 10) ?? null,
        seatsTotal: offer.seatsTotal,
      },
      counts: countsFor(grouped),
      reservations: rows.map(toItem),
    };
  }

  async create(
    tenant: TenantContext,
    actorUserId: string,
    input: CreateReservationInput,
    meta: RequestMeta,
  ): Promise<ReservationItem> {
    let offerId = input.offerId ?? null;
    let contactName = input.contactName ?? null;
    let contactPhone = input.contactPhone ?? null;
    let leadId: string | null = null;

    if (input.leadId) {
      // The CRM flow. The lead must be visible to THIS actor — the agent
      // scoping is the same as the inbox, or an agent could read a colleague's
      // client by "reserving" them.
      const lead = await this.prisma.lead.findFirst({
        where: {
          id: input.leadId,
          agencyId: tenant.agencyId,
          deletedAt: null,
          ...(tenant.role === 'agent' ? { assignedToUserId: actorUserId } : {}),
        },
        select: {
          id: true, contactName: true, contactPhone: true,
          peopleCount: true, offerId: true,
        },
      });
      if (!lead) throw notFound('Contact');

      leadId = lead.id;
      contactName = contactName ?? lead.contactName;
      contactPhone = contactPhone ?? lead.contactPhone;
      offerId = offerId ?? lead.offerId;
    }

    if (!offerId || !contactName || !contactPhone) {
      // The Zod refinements make this unreachable over HTTP; it guards direct
      // service calls (seed scripts, the future chatbot tool).
      throw new AppError('VALIDATION_FAILED', 'Réservation incomplète');
    }

    // The offer must be OURS. A foreign offer id is a 404, as everywhere.
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!offer) throw notFound('Départ');

    if (leadId) {
      const existing = await this.prisma.reservation.findFirst({
        where: { leadId, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Ce client a déjà une réservation sur un départ',
          { details: { reservationId: existing.id } },
        );
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.reservation.create({
        data: {
          agencyId: tenant.agencyId, // verified tenant, never the body
          offerId,
          leadId,
          contactName,
          contactPhone,
          peopleCount: input.peopleCount,
          notes: input.notes ?? null,
          // Minted here so the link exists the moment the booking does — the
          // agency confirms and sends it in the same WhatsApp message.
          publicCode: generateCapabilityCode(),
        },
        select: RESERVATION_SELECT,
      });

      if (leadId) {
        await tx.leadActivity.create({
          data: {
            leadId,
            agencyId: tenant.agencyId,
            type: 'reservation_created',
            actorUserId,
            payload: { reservationId: row.id, offerId },
          },
        });
      }

      await this.audit.record(
        {
          action: 'reservation.created',
          entityType: 'reservation',
          entityId: row.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { offerId, peopleCount: input.peopleCount, fromLead: Boolean(leadId) },
          requestId: meta.requestId,
        },
        tx,
      );

      return row;
    });

    return toItem(created);
  }

  /**
   * Status changes, headcount fixes, notes. The check-in tap lands here:
   * `status: 'checked_in'` stamps who and when — the answer to "who counted
   * this family?" months later.
   */
  async update(
    tenant: TenantContext,
    actorUserId: string,
    reservationId: string,
    input: UpdateReservationInput,
    meta: RequestMeta,
  ): Promise<ReservationItem> {
    const before = await this.prisma.reservation.findFirst({
      where: { id: reservationId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!before) throw notFound('Réservation');

    const statusChanging = input.status !== undefined && input.status !== before.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.reservation.updateMany({
        where: { id: reservationId, agencyId: tenant.agencyId, deletedAt: null },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.peopleCount !== undefined ? { peopleCount: input.peopleCount } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          // Entering checked_in stamps the tap; leaving it clears the stamp,
          // so an undone mistake leaves no phantom "was counted at 04:12".
          ...(statusChanging && input.status === 'checked_in'
            ? { checkedInAt: new Date(), checkedInByUserId: actorUserId }
            : {}),
          ...(statusChanging && input.status !== 'checked_in'
            ? { checkedInAt: null, checkedInByUserId: null }
            : {}),
        },
      });
      if (result.count === 0) throw notFound('Réservation');

      if (statusChanging) {
        await this.audit.record(
          {
            action: 'reservation.status_changed',
            entityType: 'reservation',
            entityId: reservationId,
            agencyId: tenant.agencyId,
            actorUserId,
            before: { status: before.status },
            after: { status: input.status },
            requestId: meta.requestId,
          },
          tx,
        );
      }

      return tx.reservation.findFirstOrThrow({
        where: { id: reservationId, agencyId: tenant.agencyId },
        select: RESERVATION_SELECT,
      });
    });

    return toItem(updated);
  }

  /**
   * Give this reservation a /mon-voyage code if it has none, and return it.
   *
   * Deliberately never rotates an existing code. Rotation would silently break
   * a link the family already has in a WhatsApp thread, and the failure would
   * land at 4am on the person who needs it most. Revoking a leaked link is a
   * separate, explicit action if it is ever needed.
   */
  async ensureTripLink(
    tenant: TenantContext,
    actorUserId: string,
    reservationId: string,
    meta: RequestMeta,
  ): Promise<ReservationItem> {
    const existing = await this.prisma.reservation.findFirst({
      where: { id: reservationId, agencyId: tenant.agencyId, deletedAt: null },
      select: RESERVATION_SELECT,
    });
    if (!existing) throw notFound('Réservation');
    if (existing.publicCode) return toItem(existing);

    const updated = await this.prisma.$transaction(async (tx) => {
      // updateMany, not update: it is the only form that can also require
      // agencyId. Re-checking `publicCode: null` makes two concurrent taps
      // safe — the loser updates nothing and re-reads the winner's code.
      await tx.reservation.updateMany({
        where: {
          id: reservationId,
          agencyId: tenant.agencyId,
          deletedAt: null,
          publicCode: null,
        },
        data: { publicCode: generateCapabilityCode() },
      });

      await this.audit.record(
        {
          action: 'reservation.trip_link_issued',
          entityType: 'reservation',
          entityId: reservationId,
          agencyId: tenant.agencyId,
          actorUserId,
          // The code itself is a credential and never goes in the audit log.
          requestId: meta.requestId,
        },
        tx,
      );

      return tx.reservation.findFirstOrThrow({
        where: { id: reservationId, agencyId: tenant.agencyId },
        select: RESERVATION_SELECT,
      });
    });

    return toItem(updated);
  }
}

const RESERVATION_SELECT = {
  id: true, offerId: true, leadId: true,
  contactName: true, contactPhone: true, peopleCount: true,
  status: true, checkedInAt: true, notes: true, createdAt: true,
  publicCode: true,
  lead: { select: { source: true } },
} as const;

type ReservationRow = Prisma.ReservationGetPayload<{ select: typeof RESERVATION_SELECT }>;

function toItem(row: ReservationRow): ReservationItem {
  return {
    id: row.id,
    offerId: row.offerId,
    leadId: row.leadId,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    peopleCount: row.peopleCount,
    status: row.status,
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    notes: row.notes,
    source: row.lead?.source ?? null,
    publicCode: row.publicCode,
    createdAt: row.createdAt.toISOString(),
  };
}

type GroupedRow = {
  status: ReservationStatus;
  _count: { _all: number };
  _sum: { peopleCount: number | null };
};

function countsFor(rows: Array<GroupedRow & { offerId?: string }>): ManifestCounts {
  const people = (status: ReservationStatus) =>
    rows.find((row) => row.status === status)?._sum.peopleCount ?? 0;

  return {
    reservations: rows.reduce((sum, row) => sum + row._count._all, 0),
    people: rows.reduce((sum, row) => sum + (row._sum.peopleCount ?? 0), 0),
    expectedPeople: people('expected'),
    checkedInPeople: people('checked_in'),
    noShowPeople: people('no_show'),
    cancelledPeople: people('cancelled'),
  };
}
