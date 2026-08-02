import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type CreateMilestoneInput,
  type MilestoneItem,
  type ReorderMilestonesInput,
  type SetMilestoneCompletionInput,
  type UpdateMilestoneInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

/**
 * The agency-editable programme: add / reorder / edit / delete the milestones
 * that make up an offer's timeline. See obsidian/Backend/Trip Programme.md.
 */
@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, offerId: string): Promise<MilestoneItem[]> {
    await this.requireOwnedOffer(tenant, offerId);

    const rows = await this.prisma.offerMilestone.findMany({
      where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: MILESTONE_SELECT,
      orderBy: [{ dayOffset: 'asc' }, { sortOrder: 'asc' }],
      take: 200, // a 200-step programme is not a real trip
    });

    return rows.map(toItem);
  }

  async create(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: CreateMilestoneInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem> {
    await this.requireOwnedOffer(tenant, offerId);

    const created = await this.prisma.$transaction(async (tx) => {
      // New milestones land at the end of the list. Explicit ordering is what
      // the reorder endpoint is for, not a client-sent sortOrder here.
      const last = await tx.offerMilestone.aggregate({
        where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
        _max: { sortOrder: true },
      });

      const row = await tx.offerMilestone.create({
        data: {
          agencyId: tenant.agencyId, // verified tenant, never the body
          offerId,
          title: input.title,
          description: input.description ?? null,
          kind: input.kind,
          dayOffset: input.dayOffset,
          timeOfDay: input.timeOfDay ?? null,
          locationName: input.locationName ?? null,
          meetingPoint: input.meetingPoint ?? null,
          mapUrl: input.mapUrl ?? null,
          checkpointType: input.checkpointType,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
        select: MILESTONE_SELECT,
      });

      await this.audit.record(
        {
          action: 'offer_milestone.created',
          entityType: 'offer_milestone',
          entityId: row.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { offerId, title: row.title, checkpointType: row.checkpointType },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return row;
    });

    return toItem(created);
  }

  async update(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    milestoneId: string,
    input: UpdateMilestoneInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem> {
    const before = await this.prisma.offerMilestone.findFirst({
      where: { id: milestoneId, offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: MILESTONE_SELECT,
    });
    if (!before) throw notFound('Étape');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.offerMilestone.updateMany({
        // updateMany, not update: `update({ where: { id } })` cannot also
        // require agencyId, so it would happily edit another agency's row.
        where: { id: milestoneId, offerId, agencyId: tenant.agencyId, deletedAt: null },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.dayOffset !== undefined ? { dayOffset: input.dayOffset } : {}),
          ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay ?? null } : {}),
          ...(input.locationName !== undefined ? { locationName: input.locationName ?? null } : {}),
          ...(input.meetingPoint !== undefined ? { meetingPoint: input.meetingPoint ?? null } : {}),
          ...(input.mapUrl !== undefined ? { mapUrl: input.mapUrl ?? null } : {}),
          ...(input.checkpointType !== undefined ? { checkpointType: input.checkpointType } : {}),
        },
      });
      if (result.count === 0) throw notFound('Étape');

      const after = await tx.offerMilestone.findFirstOrThrow({
        where: { id: milestoneId, agencyId: tenant.agencyId },
        select: MILESTONE_SELECT,
      });

      const diff = AuditService.diff(before, input);
      await this.audit.record(
        {
          action: 'offer_milestone.updated',
          entityType: 'offer_milestone',
          entityId: milestoneId,
          agencyId: tenant.agencyId,
          actorUserId,
          before: diff.before,
          after: diff.after,
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return after;
    });

    return toItem(updated);
  }

  /**
   * Tick a step off, or untick it. This is the write behind every traveler's
   * "vous êtes ici" marker: the trip page shows the first milestone with no
   * `completedAt`, so one tap here advances every family's map at once.
   *
   * Stamps who and when, like the manifest check-in — months later "who said
   * the bus had left?" is a real question.
   */
  async setCompletion(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    milestoneId: string,
    input: SetMilestoneCompletionInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem> {
    const updated = await this.prisma.$transaction(async (tx) => {
      // updateMany, not update: it is the only form that can also require
      // agencyId, so a milestone id from another agency touches nothing.
      const result = await tx.offerMilestone.updateMany({
        where: { id: milestoneId, offerId, agencyId: tenant.agencyId, deletedAt: null },
        data: input.isDone
          ? { completedAt: new Date(), completedByUserId: actorUserId }
          : { completedAt: null, completedByUserId: null },
      });
      if (result.count === 0) throw notFound('Étape');

      await this.audit.record(
        {
          action: 'offer_milestone.completion_changed',
          entityType: 'offer_milestone',
          entityId: milestoneId,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { isDone: input.isDone },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return tx.offerMilestone.findFirstOrThrow({
        where: { id: milestoneId, agencyId: tenant.agencyId },
        select: MILESTONE_SELECT,
      });
    });

    return toItem(updated);
  }

  /** Soft delete — matches Offer/Lead: the row survives for anything that references it. */
  async remove(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    milestoneId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const result = await this.prisma.offerMilestone.updateMany({
      where: { id: milestoneId, offerId, agencyId: tenant.agencyId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw notFound('Étape');

    await this.audit.record({
      action: 'offer_milestone.deleted',
      entityType: 'offer_milestone',
      entityId: milestoneId,
      agencyId: tenant.agencyId,
      actorUserId,
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { ok: true };
  }

  /**
   * Rewrites `sortOrder` from a full ordered id list. Rejected unless it is
   * EXACTLY the offer's current, non-deleted milestone set — a partial list
   * would silently push the missing rows to the back, and a smuggled id from
   * another offer would let one agency reorder another's programme.
   */
  async reorder(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: ReorderMilestonesInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem[]> {
    await this.requireOwnedOffer(tenant, offerId);

    const existing = await this.prisma.offerMilestone.findMany({
      where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((row) => row.id));
    const providedIds = new Set(input.orderedIds);

    const sameSet =
      existingIds.size === providedIds.size &&
      [...existingIds].every((id) => providedIds.has(id));
    if (!sameSet) {
      throw new AppError('VALIDATION_FAILED', "La liste ne correspond pas au programme de l'offre");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        input.orderedIds.map((id, index) =>
          tx.offerMilestone.updateMany({
            where: { id, offerId, agencyId: tenant.agencyId, deletedAt: null },
            data: { sortOrder: index },
          }),
        ),
      );

      await this.audit.record(
        {
          action: 'offer_milestone.reordered',
          entityType: 'offer_milestone',
          entityId: offerId,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { orderedIds: input.orderedIds },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return tx.offerMilestone.findMany({
        where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
        select: MILESTONE_SELECT,
        orderBy: [{ dayOffset: 'asc' }, { sortOrder: 'asc' }],
      });
    });

    return updated.map(toItem);
  }

  /** The offer must be OURS. A foreign offer id is a 404, as everywhere. */
  private async requireOwnedOffer(tenant: TenantContext, offerId: string): Promise<void> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!offer) throw notFound('Offre');
  }
}

export const MILESTONE_SELECT = {
  id: true, offerId: true, title: true, description: true, kind: true,
  dayOffset: true, timeOfDay: true, locationName: true, meetingPoint: true, mapUrl: true,
  sortOrder: true, checkpointType: true, completedAt: true, createdAt: true,
} as const;

type MilestoneRow = Prisma.OfferMilestoneGetPayload<{ select: typeof MILESTONE_SELECT }>;

function toItem(row: MilestoneRow): MilestoneItem {
  return {
    id: row.id,
    offerId: row.offerId,
    title: row.title,
    description: row.description,
    kind: row.kind,
    dayOffset: row.dayOffset,
    timeOfDay: row.timeOfDay,
    locationName: row.locationName,
    meetingPoint: row.meetingPoint,
    mapUrl: row.mapUrl,
    sortOrder: row.sortOrder,
    checkpointType: row.checkpointType,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
