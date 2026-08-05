import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MILESTONE_MAX_PER_OFFER,
  type CopyProgrammeFromOfferInput,
  type CreateMilestoneInput,
  type DuplicateMilestoneDayInput,
  type MilestoneItem,
  type ProgrammeCopySource,
  type ReorderMilestonesInput,
  type SetMilestoneCompletionInput,
  type UpdateMilestoneInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService, type AuditAction } from '../../common/audit/audit.service';
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
      take: MILESTONE_MAX_PER_OFFER, // a 200-step programme is not a real trip
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

  /**
   * DUPLICATE A DAY — copy every step of one day onto another day of the same
   * offer. Omra programmes repeat, and retyping five identical days is the
   * point at which an agency abandons the feature (Trip Programme.md §7.6).
   *
   * Purely additive: copies land after whatever is already on the target day,
   * and no other day is touched or renumbered. Undo is deleting the new rows.
   */
  async duplicateDay(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: DuplicateMilestoneDayInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem[]> {
    await this.requireOwnedOffer(tenant, offerId);

    const sourceRows = await this.prisma.offerMilestone.findMany({
      where: {
        offerId,
        agencyId: tenant.agencyId,
        deletedAt: null,
        dayOffset: input.sourceDayOffset,
      },
      select: MILESTONE_SELECT,
      orderBy: [{ sortOrder: 'asc' }],
    });

    if (sourceRows.length === 0) {
      throw new AppError('VALIDATION_FAILED', "Ce jour ne contient aucune étape à dupliquer");
    }

    return this.appendCopies(tenant, actorUserId, offerId, sourceRows, {
      dayOffset: input.targetDayOffset,
      action: 'offer_milestone.day_duplicated',
      auditAfter: {
        sourceDayOffset: input.sourceDayOffset,
        targetDayOffset: input.targetDayOffset,
        copied: sourceRows.length,
      },
      meta,
    });
  }

  /**
   * COPY A WHOLE PROGRAMME FROM ANOTHER OFFER — next season's Ramadan trip is
   * last season's with new dates.
   *
   * `sourceOfferId` arrives in the request body, pointing at tenant-scoped
   * data. It is therefore re-checked against the session's agency exactly like
   * the target offer: `requireOwnedOffer` on BOTH. Without that second check,
   * any agency could name a competitor's offer id and read their entire
   * programme back out of the response. This is the isolation-critical line of
   * this file (rule #3).
   *
   * Day offsets survive the copy, which is only possible because a milestone
   * stores `dayOffset` and not a date (§4) — the same rows land correctly on a
   * departure date they have never seen.
   */
  async copyFromOffer(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: CopyProgrammeFromOfferInput,
    meta: RequestMeta,
  ): Promise<MilestoneItem[]> {
    await this.requireOwnedOffer(tenant, offerId);
    await this.requireOwnedOffer(tenant, input.sourceOfferId);

    if (input.sourceOfferId === offerId) {
      throw new AppError('VALIDATION_FAILED', 'Une offre ne peut pas copier son propre programme');
    }

    const sourceRows = await this.prisma.offerMilestone.findMany({
      where: { offerId: input.sourceOfferId, agencyId: tenant.agencyId, deletedAt: null },
      select: MILESTONE_SELECT,
      orderBy: [{ dayOffset: 'asc' }, { sortOrder: 'asc' }],
      take: MILESTONE_MAX_PER_OFFER,
    });

    if (sourceRows.length === 0) {
      throw new AppError('VALIDATION_FAILED', "Cette offre n'a pas de programme à copier");
    }

    return this.appendCopies(tenant, actorUserId, offerId, sourceRows, {
      action: 'offer_milestone.programme_copied',
      auditAfter: { sourceOfferId: input.sourceOfferId, copied: sourceRows.length },
      meta,
    });
  }

  /**
   * The agency's OTHER offers that actually have a programme — what the copy
   * picker lists. Offers with no milestones are filtered out server-side
   * rather than shown and disabled: an empty option is a dead end the agency
   * has to read and reject.
   */
  async listCopySources(
    tenant: TenantContext,
    offerId: string,
  ): Promise<ProgrammeCopySource[]> {
    await this.requireOwnedOffer(tenant, offerId);

    const offers = await this.prisma.offer.findMany({
      where: {
        agencyId: tenant.agencyId,
        deletedAt: null,
        id: { not: offerId },
        milestones: { some: { deletedAt: null } },
      },
      select: {
        id: true,
        title: true,
        departureDate: true,
        _count: { select: { milestones: { where: { deletedAt: null } } } },
      },
      // Most recent departure first: the programme worth copying is almost
      // always the last one built, not the oldest.
      orderBy: [{ departureDate: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });

    return offers.map((offer) => ({
      offerId: offer.id,
      title: offer.title,
      departureDate: offer.departureDate?.toISOString() ?? null,
      milestoneCount: offer._count.milestones,
    }));
  }

  /**
   * The shared write behind both bulk operations: clone rows onto the end of
   * one offer's programme and return the new full list.
   *
   * Two things are deliberately NOT carried over:
   *  - `completedAt` / `completedByUserId` — a copied step has not happened.
   *    Inheriting a tick would show travelers a "vous êtes ici" marker parked
   *    somewhere the group has never been.
   *  - check-ins — attendance belongs to a family at a specific stop of a
   *    specific trip, and `MilestoneCheckIn` rows hang off the milestone id,
   *    so the new rows simply start with none.
   *
   * `checkpointType` IS carried over: it is part of the plan being copied, and
   * re-marking which stops need a headcount is exactly the retyping this
   * feature exists to remove.
   */
  private async appendCopies(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    sourceRows: MilestoneRow[],
    options: {
      /** Force every copy onto one day. Omitted keeps each row's own day. */
      dayOffset?: number;
      action: AuditAction;
      auditAfter: Prisma.JsonObject;
      meta: RequestMeta;
    },
  ): Promise<MilestoneItem[]> {
    const existingCount = await this.prisma.offerMilestone.count({
      where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
    });

    if (existingCount + sourceRows.length > MILESTONE_MAX_PER_OFFER) {
      throw new AppError('MILESTONE_LIMIT_REACHED', 'Ce programme a atteint sa limite d’étapes', {
        details: {
          limit: MILESTONE_MAX_PER_OFFER,
          current: existingCount,
          requested: sourceRows.length,
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.offerMilestone.aggregate({
        where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
        _max: { sortOrder: true },
      });
      const firstSortOrder = (last._max.sortOrder ?? -1) + 1;

      await tx.offerMilestone.createMany({
        data: sourceRows.map((row, index) => ({
          agencyId: tenant.agencyId, // the verified tenant, never a copied value
          offerId, // the TARGET offer, never the source's
          title: row.title,
          description: row.description,
          kind: row.kind,
          dayOffset: options.dayOffset ?? row.dayOffset,
          timeOfDay: row.timeOfDay,
          locationName: row.locationName,
          meetingPoint: row.meetingPoint,
          mapUrl: row.mapUrl,
          checkpointType: row.checkpointType,
          sortOrder: firstSortOrder + index,
        })),
      });

      await this.audit.record(
        {
          action: options.action,
          entityType: 'offer_milestone',
          entityId: offerId,
          agencyId: tenant.agencyId,
          actorUserId,
          after: options.auditAfter,
          ipHash: options.meta.ipHash ?? null,
          requestId: options.meta.requestId,
        },
        tx,
      );

      const rows = await tx.offerMilestone.findMany({
        where: { offerId, agencyId: tenant.agencyId, deletedAt: null },
        select: MILESTONE_SELECT,
        orderBy: [{ dayOffset: 'asc' }, { sortOrder: 'asc' }],
        take: MILESTONE_MAX_PER_OFFER,
      });
      return rows.map(toItem);
    });
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
