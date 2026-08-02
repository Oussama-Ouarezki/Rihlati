import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CURRENT_CONSENT_VERSION,
  LEAD_QUALITY_WEIGHT,
  NEGATIVE_LEAD_QUALITIES,
  TERMINAL_LEAD_STAGES,
  buildPage,
  hasFeature,
  maskPhone,
  type CreateInquiryInput,
  type CreateLeadInput,
  type CreateLeadNoteInput,
  type InquiryReceipt,
  type LeadDetail,
  type LeadSearchInput,
  type LeadSummary,
  type Page,
  type UpdateLeadInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import { OfferMetricsService } from '../offers/offer-metrics.service';
import { TrackedLinksService } from '../tracked-links/tracked-links.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    private readonly metrics: OfferMetricsService,
    private readonly trackedLinks: TrackedLinksService,
  ) {}

  // =========================================================================
  // PUBLIC — a traveler contacts an agency
  // =========================================================================

  /**
   * The marketplace's one conversion event.
   *
   * Three things here are deliberate and load-bearing:
   *
   * 1. `agencyId` is read from the OFFER, never from the request. If the client
   *    could name the agency, anyone could post leads into any agency's inbox —
   *    including a competitor's, filled with garbage.
   *
   * 2. Contact details are SNAPSHOTTED onto the lead rather than referenced
   *    through a user account. The inquiry must survive the traveler deleting
   *    their account, and must work when they never had one.
   *
   * 3. The consent trail is written in the same insert. It cannot be added
   *    later, because "we asked them in March" is not something you can
   *    reconstruct in June.
   */
  async createInquiry(
    input: CreateInquiryInput,
    travelerUserId: string | null,
    meta: RequestMeta,
  ): Promise<InquiryReceipt> {
    const offer = await this.prisma.offer.findFirst({
      where: {
        id: input.offerId,
        status: 'published',
        deletedAt: null,
        agency: { status: 'verified', deletedAt: null },
      },
      select: {
        id: true,
        title: true,
        agencyId: true,
        agency: { select: { name: true } },
      },
    });
    // An unpublished offer, an unverified agency and a nonexistent id all give
    // the same answer. Otherwise this endpoint reports which agencies are
    // pending verification.
    if (!offer) throw notFound('Offre');

    /**
     * The same person asking the same agency about the same offer twice is one
     * lead, not two. Agencies pay attention per lead; duplicating them wastes
     * the agency's time and, later, would double-charge for one introduction.
     *
     * A 6-hour window: a genuine second question the next day is a real new
     * conversation and should reopen one.
     */
    const recent = await this.prisma.lead.findFirst({
      where: {
        agencyId: offer.agencyId,
        offerId: offer.id,
        contactPhone: input.contactPhone,
        createdAt: { gte: new Date(Date.now() - 6 * 3_600_000) },
        deletedAt: null,
      },
      select: { id: true, createdAt: true },
    });

    if (recent) {
      // Reported as success. The traveler did what was asked; telling them
      // "duplicate" would just make them submit again through another route.
      return {
        id: recent.id,
        createdAt: recent.createdAt.toISOString(),
        agencyName: offer.agency.name,
      };
    }

    // Attribution: the code the traveler carried through from a tracked link.
    // Returns null for unknown or foreign codes — never an error, because a
    // stale marketing code must not cost the agency an inquiry.
    const trackedLinkId = await this.trackedLinks.resolveForAttribution(
      input.ref,
      offer.agencyId,
    );

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          agencyId: offer.agencyId, // derived, never sent
          trackedLinkId,
          offerId: offer.id,
          contactName: input.contactName,
          contactPhone: input.contactPhone, // already E.164 from the schema
          contactEmail: input.contactEmail ?? null,
          travelerUserId,
          message: input.message ?? null,
          peopleCount: input.peopleCount ?? null,
          preferredDepartureDate: input.preferredDepartureDate
            ? new Date(`${input.preferredDepartureDate}T00:00:00Z`)
            : null,
          budgetCentimes: input.budgetCentimes ?? null,

          // The legal basis for this agency phoning this person.
          consentGivenAt: new Date(),
          consentTextVersion: CURRENT_CONSENT_VERSION,
          consentIpHash: meta.ipHash ?? null,
          consentUserAgent: meta.userAgent ?? null,

          source: 'marketplace_inquiry',
          activities: {
            create: {
              agencyId: offer.agencyId,
              type: 'lead_created',
              payload: { offerTitle: offer.title, source: 'marketplace_inquiry' },
            },
          },
        },
        select: { id: true, createdAt: true },
      });

      await this.audit.record(
        {
          action: 'lead.created',
          entityType: 'lead',
          entityId: created.id,
          agencyId: offer.agencyId,
          actorUserId: travelerUserId,
          after: { offerId: offer.id, consentVersion: CURRENT_CONSENT_VERSION },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      // The offer's daily analytics tick, in the SAME transaction as the lead
      // so the chart and the inbox can never disagree by one. The 6-hour
      // dedupe path above returns before reaching here, so a repeated
      // submission is one inquiry in both places.
      await this.metrics.recordInquiryInTx(tx, offer.agencyId, offer.id);

      // The link's conversion counter, in the same transaction as the lead —
      // "40 clicks, 3 clients" must never be able to disagree with the inbox.
      if (trackedLinkId) {
        await this.trackedLinks.countInquiryInTx(tx, trackedLinkId);
      }

      return created;
    });

    // Masked. Rule #4: a full phone number never reaches a log line.
    this.logger.info('inquiry received', {
      requestId: meta.requestId,
      leadId: lead.id,
      agencyId: offer.agencyId,
      phone: maskPhone(input.contactPhone),
    });

    return {
      id: lead.id,
      createdAt: lead.createdAt.toISOString(),
      agencyName: offer.agency.name,
    };
  }

  // =========================================================================
  // AGENCY — the CRM inbox
  // =========================================================================

  async list(
    tenant: TenantContext,
    actorUserId: string,
    query: LeadSearchInput,
  ): Promise<Page<LeadSummary>> {
    /**
     * An `agent` sees only the leads assigned to them; `manager` and `owner`
     * see the whole agency.
     *
     * Written LAST in the object so it overwrites any `assignedToUserId` the
     * caller supplied — an agent passing `?assignedToUserId=<colleague>` must
     * not be able to widen their own view. Order matters here; putting the
     * caller's filter after this line would undo it.
     */
    const assigneeFilter: Prisma.LeadWhereInput =
      tenant.role === 'agent'
        ? { assignedToUserId: actorUserId }
        : query.assignedToUserId
          ? { assignedToUserId: query.assignedToUserId }
          : {};

    const where: Prisma.LeadWhereInput = {
      // The tenant scope. Not optional, not derived from the query string.
      agencyId: tenant.agencyId,
      deletedAt: null,
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.quality ? { quality: query.quality } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.offerId ? { offerId: query.offerId } : {}),
      ...(query.dueOnly ? { nextActionAt: { lte: new Date() } } : {}),
      ...(query.q
        ? {
            OR: [
              { contactName: { contains: query.q, mode: 'insensitive' } },
              { contactPhone: { contains: query.q } },
              { contactEmail: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...assigneeFilter,
    };

    const rows = await this.prisma.lead.findMany({
      where,
      select: LEAD_SUMMARY_SELECT,
      orderBy: this.orderFor(query.sort),
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const page = buildPage(rows, query.limit);
    const items = page.items.map(toLeadSummary);

    return {
      // See orderFor(): Postgres cannot rank the quality enum the way an
      // agency needs, so that one sort is finished in memory, per page.
      items: query.sort === 'quality_desc' ? sortByQuality(items) : items,
      nextCursor: page.nextCursor,
    };
  }

  async get(tenant: TenantContext, actorUserId: string, leadId: string): Promise<LeadDetail> {
    const lead = await this.prisma.lead.findFirst({
      // id AND agencyId. The pair is what makes another agency's lead a 404.
      //
      // The agent restriction is repeated here, not just in list(): otherwise
      // an agent who saw a lead id once — in a URL, in a screenshot — could
      // fetch any colleague's lead directly. Filtering the list without
      // filtering the detail is the classic version of this bug.
      where: {
        id: leadId,
        agencyId: tenant.agencyId,
        deletedAt: null,
        ...(tenant.role === 'agent' ? { assignedToUserId: actorUserId } : {}),
      },
      select: {
        ...LEAD_DETAIL_SELECT,
        notes: {
          where: { deletedAt: null },
          select: { id: true, body: true, authorUserId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        activities: {
          select: { id: true, type: true, actorUserId: true, payload: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
      },
    });
    if (!lead) throw notFound('Contact');

    return {
      ...toLeadSummary(lead),
      message: lead.message,
      preferredDepartureDate: lead.preferredDepartureDate?.toISOString().slice(0, 10) ?? null,
      actualValueCentimes: lead.actualValueCentimes,
      lostReason: lead.lostReason,
      closedAt: lead.closedAt?.toISOString() ?? null,
      consent: {
        givenAt: lead.consentGivenAt.toISOString(),
        textVersion: lead.consentTextVersion,
      },
      notes: lead.notes.map((note) => ({
        id: note.id,
        body: note.body,
        authorUserId: note.authorUserId,
        createdAt: note.createdAt.toISOString(),
      })),
      activities: lead.activities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        actorUserId: activity.actorUserId,
        payload: (activity.payload ?? {}) as Record<string, unknown>,
        createdAt: activity.createdAt.toISOString(),
      })),
    };
  }

  /** A lead the agency entered itself — a phone call, a walk-in. */
  async create(
    tenant: TenantContext,
    actorUserId: string,
    input: CreateLeadInput,
    meta: RequestMeta,
  ): Promise<LeadSummary> {
    if (input.offerId) {
      // The offer must belong to THIS agency. Otherwise an agency could attach
      // its leads to a competitor's offer and pollute their statistics.
      const offer = await this.prisma.offer.findFirst({
        where: { id: input.offerId, agencyId: tenant.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!offer) throw notFound('Offre');
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          agencyId: tenant.agencyId,
          offerId: input.offerId ?? null,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          contactEmail: input.contactEmail ?? null,
          message: input.message ?? null,
          peopleCount: input.peopleCount ?? null,
          preferredDepartureDate: input.preferredDepartureDate
            ? new Date(`${input.preferredDepartureDate}T00:00:00Z`)
            : null,
          budgetCentimes: input.budgetCentimes ?? null,
          source: input.source,

          /**
           * Consent asserted by the agency, not collected by us.
           *
           * The version string records exactly that. If a complaint ever
           * arrives about this contact, the record says "the agency stated it
           * had permission" and names the staff member who said so — which is
           * a different, weaker claim than a traveler ticking a box, and the
           * data should not pretend otherwise.
           */
          consentGivenAt: new Date(),
          consentTextVersion: `agency-asserted-v1:${actorUserId}`,
          consentIpHash: meta.ipHash ?? null,

          activities: {
            create: {
              agencyId: tenant.agencyId,
              type: 'lead_created',
              actorUserId,
              payload: { source: input.source },
            },
          },
        },
        select: LEAD_SUMMARY_SELECT,
      });

      await this.audit.record(
        {
          action: 'lead.created',
          entityType: 'lead',
          entityId: created.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { source: input.source, consentAssertedBy: actorUserId },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return created;
    });

    return toLeadSummary(lead);
  }

  async update(
    tenant: TenantContext,
    actorUserId: string,
    leadId: string,
    input: UpdateLeadInput,
    meta: RequestMeta,
  ): Promise<LeadSummary> {
    const before = await this.prisma.lead.findFirst({
      where: { id: leadId, agencyId: tenant.agencyId, deletedAt: null },
      select: {
        ...LEAD_SUMMARY_SELECT,
        firstRespondedAt: true,
        assignedToUserId: true,
      },
    });
    if (!before) throw notFound('Contact');

    // Assigning leads to staff is a paid feature. The check is server-side —
    // hiding the dropdown in the UI is not a limit, it is a suggestion.
    if (input.assignedToUserId !== undefined && !hasFeature(tenant.plan, 'leadAssignment')) {
      throw new AppError(
        'FEATURE_NOT_IN_PLAN',
        "L'attribution des contacts nécessite un plan supérieur",
        { details: { feature: 'leadAssignment', plan: tenant.plan } },
      );
    }

    // The assignee must be a member of this agency. Without this check an
    // agency could assign its leads to a user id belonging to someone else,
    // and that person's inbox query would then return rows from a tenant they
    // do not belong to.
    if (input.assignedToUserId) {
      const member = await this.prisma.membership.findUnique({
        where: {
          userId_agencyId: { userId: input.assignedToUserId, agencyId: tenant.agencyId },
        },
        select: { userId: true },
      });
      if (!member) throw notFound('Membre');
    }

    const now = new Date();
    const movingOffNew = input.stage !== undefined && input.stage !== 'new' && before.stage === 'new';

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.updateMany({
        where: { id: leadId, agencyId: tenant.agencyId, deletedAt: null },
        data: {
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.assignedToUserId !== undefined
            ? { assignedToUserId: input.assignedToUserId }
            : {}),
          ...(input.estimatedValueCentimes !== undefined
            ? { estimatedValueCentimes: input.estimatedValueCentimes }
            : {}),
          ...(input.actualValueCentimes !== undefined
            ? { actualValueCentimes: input.actualValueCentimes }
            : {}),
          ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
          ...(input.nextActionAt !== undefined
            ? { nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : null }
            : {}),

          // Response time is the number agencies are sold on, so it is measured
          // rather than self-reported: first move off `new` stamps the clock,
          // once, and nothing can set it back.
          ...(movingOffNew && !before.firstRespondedAt ? { firstRespondedAt: now } : {}),
          ...(input.stage !== undefined && TERMINAL_LEAD_STAGES.includes(input.stage)
            ? { closedAt: now }
            : {}),
        },
      });
      if (result.count === 0) throw notFound('Contact');

      // The activity timeline is what the agency reads; the audit log is what
      // you read during an investigation. Both, on purpose.
      const activities: Prisma.LeadActivityCreateManyInput[] = [];
      if (input.stage !== undefined && input.stage !== before.stage) {
        activities.push({
          leadId,
          agencyId: tenant.agencyId,
          type: 'stage_changed',
          actorUserId,
          payload: { from: before.stage, to: input.stage },
        });
      }
      if (input.quality !== undefined && input.quality !== before.quality) {
        activities.push({
          leadId,
          agencyId: tenant.agencyId,
          type: 'quality_changed',
          actorUserId,
          payload: { from: before.quality, to: input.quality },
        });
      }
      if (input.assignedToUserId !== undefined && input.assignedToUserId !== before.assignedToUserId) {
        activities.push({
          leadId,
          agencyId: tenant.agencyId,
          type: 'assigned',
          actorUserId,
          payload: { to: input.assignedToUserId },
        });
      }
      if (activities.length > 0) {
        await tx.leadActivity.createMany({ data: activities });
      }

      /**
       * Marking someone `spam` or `troll` is a judgement about a real person
       * that can later cost them access to the platform. It is audited
       * separately from an ordinary edit, with who and when, because the day
       * an agency mass-labels a competitor's customers you need to be able to
       * prove it.
       */
      if (input.quality !== undefined && input.quality !== before.quality) {
        await this.audit.record(
          {
            action: 'lead.quality_changed',
            entityType: 'lead',
            entityId: leadId,
            agencyId: tenant.agencyId,
            actorUserId,
            before: { quality: before.quality },
            after: {
              quality: input.quality,
              negative: NEGATIVE_LEAD_QUALITIES.includes(input.quality),
            },
            ipHash: meta.ipHash ?? null,
            requestId: meta.requestId,
          },
          tx,
        );
      }

      if (input.stage !== undefined && input.stage !== before.stage) {
        await this.audit.record(
          {
            action: 'lead.stage_changed',
            entityType: 'lead',
            entityId: leadId,
            agencyId: tenant.agencyId,
            actorUserId,
            before: { stage: before.stage },
            after: { stage: input.stage },
            requestId: meta.requestId,
          },
          tx,
        );
      }

      return tx.lead.findFirstOrThrow({
        where: { id: leadId, agencyId: tenant.agencyId },
        select: LEAD_SUMMARY_SELECT,
      });
    });

    return toLeadSummary(updated);
  }

  async addNote(
    tenant: TenantContext,
    actorUserId: string,
    leadId: string,
    input: CreateLeadNoteInput,
    meta: RequestMeta,
  ): Promise<{ id: string; createdAt: string }> {
    // Verify the lead is ours BEFORE writing a note that references it.
    // Skipping this would let anyone attach notes to another agency's leads.
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) throw notFound('Contact');

    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.leadNote.create({
        data: {
          leadId,
          // Denormalized so a note can be tenant-scoped without joining leads.
          agencyId: tenant.agencyId,
          authorUserId: actorUserId,
          body: input.body,
        },
        select: { id: true, createdAt: true },
      });

      await tx.leadActivity.create({
        data: {
          leadId,
          agencyId: tenant.agencyId,
          type: 'note_added',
          actorUserId,
          payload: { noteId: created.id },
        },
      });

      return created;
    });

    this.logger.debug('lead note added', {
      requestId: meta.requestId,
      leadId,
      agencyId: tenant.agencyId,
    });

    return { id: note.id, createdAt: note.createdAt.toISOString() };
  }

  private orderFor(sort: LeadSearchInput['sort']): Prisma.LeadOrderByWithRelationInput[] {
    const tiebreak: Prisma.LeadOrderByWithRelationInput[] = [{ id: 'desc' }];
    switch (sort) {
      case 'oldest':
        return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'next_action':
        // nulls last: a lead with no scheduled follow-up is not urgent.
        return [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, ...tiebreak];
      case 'value_desc':
        return [{ estimatedValueCentimes: { sort: 'desc', nulls: 'last' } }, ...tiebreak];
      case 'quality_desc':
        /**
         * Postgres orders an enum by its DECLARATION order, and LeadQuality is
         * declared unrated, spam, troll, cold, warm, serious, vip — which is
         * almost the ranking we want but puts `unrated` above `spam`.
         *
         * Close enough is not good enough for the list an agency works from
         * top to bottom, so sorting is done in memory below, using the
         * LEAD_QUALITY_WEIGHT table that is the single source of truth.
         */
        return [{ createdAt: 'desc' }, ...tiebreak];
      case 'newest':
      default:
        return [{ createdAt: 'desc' }, ...tiebreak];
    }
  }
}

/** Exported for the inbox: sorts a page by quality using the shared weights. */
export function sortByQuality<T extends { quality: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (LEAD_QUALITY_WEIGHT[b.quality as keyof typeof LEAD_QUALITY_WEIGHT] ?? 0) -
      (LEAD_QUALITY_WEIGHT[a.quality as keyof typeof LEAD_QUALITY_WEIGHT] ?? 0),
  );
}

const LEAD_SUMMARY_SELECT = {
  id: true, contactName: true, contactPhone: true, contactEmail: true,
  stage: true, quality: true, source: true, peopleCount: true,
  budgetCentimes: true, estimatedValueCentimes: true,
  assignedToUserId: true, nextActionAt: true, firstRespondedAt: true,
  createdAt: true, updatedAt: true,
  offer: { select: { id: true, title: true, slug: true } },
  trackedLink: { select: { label: true } },
} as const;

const LEAD_DETAIL_SELECT = {
  ...LEAD_SUMMARY_SELECT,
  message: true, preferredDepartureDate: true, actualValueCentimes: true,
  lostReason: true, closedAt: true,
  consentGivenAt: true, consentTextVersion: true,
} as const;

type LeadSummaryRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SUMMARY_SELECT }>;

function toLeadSummary(row: LeadSummaryRow): LeadSummary {
  return {
    id: row.id,
    sourceLabel: row.trackedLink?.label ?? null,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    stage: row.stage,
    quality: row.quality,
    source: row.source,
    peopleCount: row.peopleCount,
    budgetCentimes: row.budgetCentimes,
    estimatedValueCentimes: row.estimatedValueCentimes,
    offer: row.offer ? { id: row.offer.id, title: row.offer.title, slug: row.offer.slug } : null,
    assignedToUserId: row.assignedToUserId,
    nextActionAt: row.nextActionAt?.toISOString() ?? null,
    firstRespondedAt: row.firstRespondedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
