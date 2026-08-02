import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DUPLICATE_REVIEW_THRESHOLD,
  OFFER_STATUS_TRANSITIONS,
  buildPage,
  canPublishAnotherOffer,
  offerFingerprintSource,
  resolvePublishedOfferLimit,
  titleSimilarity,
  validateOfferAttributesForKind,
  type CreateOfferInput,
  type FingerprintInput,
  type OfferDetail,
  type OfferForAgency,
  type OfferSearchInput,
  type OfferStatusChangeInput,
  type OfferSummary,
  type Page,
  type UpdateOfferInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import { OfferMetricsService } from './offer-metrics.service';
import { sha256Hex } from '../../common/crypto/hashing';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';
import {
  OFFER_AGENCY_VIEW_SELECT,
  OFFER_PUBLIC_DETAIL_SELECT,
  OFFER_SUMMARY_SELECT,
  toOfferDetail,
  toOfferForAgency,
  toOfferSummary,
} from './offer-mapper';

@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    private readonly metrics: OfferMetricsService,
  ) {}

  // =========================================================================
  // PUBLIC SEARCH
  // =========================================================================

  /**
   * The marketplace's search.
   *
   * Every filter maps to an indexed column — that is the entire reason the
   * column-vs-`attributes` split exists. A filter over JSON cannot use an
   * index, so it degrades from 5 ms to a full table scan the moment there are
   * real numbers of offers.
   */
  async search(query: OfferSearchInput): Promise<Page<OfferSummary>> {
    /**
     * Two independent OR-groups must be joined with an explicit AND.
     *
     * A JS object cannot hold two `OR` keys — the second one silently
     * REPLACES the first. That was a real bug here, found in review:
     * searching with `q` dropped the "hide departed trips" condition,
     * so free-text results resurrected trips that had already left.
     * No error, just wrong results. The regression test pins it.
     */
    const andFilters: Prisma.OfferWhereInput[] = [
      // An offer whose departure has passed is noise, not inventory.
      { OR: [{ departureDate: null }, { departureDate: { gte: startOfToday() } }] },
    ];
    if (query.q) {
      andFilters.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { summary: { contains: query.q, mode: 'insensitive' } },
          { destinationCity: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.OfferWhereInput = {
      status: 'published',
      deletedAt: null,

      // Confirmed spam re-posts leave the default listing but are NOT deleted
      // and stay reachable by direct link. `suspected` still appears here,
      // demoted by the ordering below.
      ...(query.includeFlaggedDuplicates ? {} : { duplicateStatus: { not: 'confirmed' } }),

      AND: andFilters,

      agency: {
        deletedAt: null,
        ...(query.verifiedAgenciesOnly ? { status: 'verified' } : {}),
        ...(query.agencySlug ? { slug: query.agencySlug } : {}),
      },

      ...(query.kind ? { kind: { in: query.kind } } : {}),
      ...(query.destinationCountry ? { destinationCountry: query.destinationCountry } : {}),
      ...(query.destinationCity
        ? { destinationCity: { contains: query.destinationCity, mode: 'insensitive' } }
        : {}),
      ...(query.departureWilayaCode ? { departureWilayaCode: query.departureWilayaCode } : {}),

      /**
       * Price filtering compares against `priceFromCentimes`, the "from" price.
       *
       * A traveler asking for "under 300 000 DZD" means "show me trips I might
       * afford", so an offer whose range STARTS below their ceiling belongs in
       * the results even if its top tier is higher. Filtering on the top price
       * would hide every offer that has a premium option.
       */
      ...(query.minPriceCentimes !== undefined || query.maxPriceCentimes !== undefined
        ? {
            priceFromCentimes: {
              ...(query.minPriceCentimes !== undefined ? { gte: query.minPriceCentimes } : {}),
              ...(query.maxPriceCentimes !== undefined ? { lte: query.maxPriceCentimes } : {}),
            },
          }
        : {}),

      ...(query.departureFrom || query.departureTo
        ? {
            departureDate: {
              ...(query.departureFrom ? { gte: new Date(`${query.departureFrom}T00:00:00Z`) } : {}),
              ...(query.departureTo ? { lte: new Date(`${query.departureTo}T00:00:00Z`) } : {}),
            },
          }
        : {}),

      ...(query.minDurationDays !== undefined || query.maxDurationDays !== undefined
        ? {
            durationDays: {
              ...(query.minDurationDays !== undefined ? { gte: query.minDurationDays } : {}),
              ...(query.maxDurationDays !== undefined ? { lte: query.maxDurationDays } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.offer.findMany({
      where,
      select: OFFER_SUMMARY_SELECT,
      orderBy: this.orderFor(query.sort),
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const page = buildPage(rows, query.limit);
    return { items: page.items.map(toOfferSummary), nextCursor: page.nextCursor };
  }

  /**
   * `duplicateStatus: 'asc'` first on every sort puts `none` (and `dismissed`)
   * above `suspected` — that IS the demotion. Doing it in the ORDER BY rather
   * than by subtracting points from a score keeps it inside the index.
   */
  private orderFor(sort: OfferSearchInput['sort']): Prisma.OfferOrderByWithRelationInput[] {
    // `id` last, always: ids are UUIDv7 and therefore time-ordered, which gives
    // the cursor a stable tiebreak. Without it, two offers with equal prices
    // can swap places between pages and a row is shown twice or skipped.
    const tiebreak: Prisma.OfferOrderByWithRelationInput[] = [{ id: 'asc' }];

    switch (sort) {
      case 'price_asc':
        return [{ duplicateStatus: 'asc' }, { priceFromCentimes: 'asc' }, ...tiebreak];
      case 'price_desc':
        return [{ duplicateStatus: 'asc' }, { priceFromCentimes: 'desc' }, ...tiebreak];
      case 'departure_soon':
        return [{ duplicateStatus: 'asc' }, { departureDate: 'asc' }, ...tiebreak];
      case 'newest':
        return [{ duplicateStatus: 'asc' }, { publishedAt: 'desc' }, ...tiebreak];
      case 'rating_desc':
        return [
          { duplicateStatus: 'asc' },
          { agency: { ratingCount: 'desc' } },
          ...tiebreak,
        ];
      case 'relevance':
      default:
        /**
         * "Relevance" with no search engine: promoted first, then listing
         * quality, then freshness. Honest about what it is. Real relevance
         * ranking needs full-text search and click data, neither of which
         * exists yet — and a fake relevance score is worse than an obvious
         * ordering, because nobody can tell it is broken.
         */
        return [
          { duplicateStatus: 'asc' },
          { isFeatured: 'desc' },
          { qualityScore: 'desc' },
          { publishedAt: 'desc' },
          ...tiebreak,
        ];
    }
  }

  /** Public offer page. Reachable even when flagged — flags demote, never erase. */
  async getPublicBySlug(slug: string): Promise<OfferDetail> {
    const offer = await this.prisma.offer.findFirst({
      where: {
        slug,
        status: 'published',
        deletedAt: null,
        agency: { deletedAt: null },
      },
      select: OFFER_PUBLIC_DETAIL_SELECT,
    });
    if (!offer) throw notFound('Offre');

    // The page view is the first point of the agency's time series. Awaited
    // (it is one atomic upsert) but failure-proof — recordView swallows its
    // own errors, because bookkeeping must never break the page.
    await this.metrics.recordView(offer.agency.id, offer.id);

    return toOfferDetail(offer);
  }

  // =========================================================================
  // AGENCY-SIDE
  // =========================================================================

  async listForAgency(
    tenant: TenantContext,
    query: { cursor?: string; limit: number; status?: string },
  ): Promise<Page<OfferForAgency>> {
    const rows = await this.prisma.offer.findMany({
      // agencyId first: this is the tenant scope, and it is not optional.
      where: {
        agencyId: tenant.agencyId,
        deletedAt: null,
        ...(query.status ? { status: query.status as Prisma.EnumOfferStatusFilter['equals'] } : {}),
      },
      select: OFFER_AGENCY_VIEW_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const page = buildPage(rows, query.limit);
    return { items: page.items.map(toOfferForAgency), nextCursor: page.nextCursor };
  }

  async getForAgency(tenant: TenantContext, offerId: string): Promise<OfferForAgency> {
    const offer = await this.prisma.offer.findFirst({
      // findFirst with BOTH id and agencyId — never findUnique({ id }).
      // This single line is what makes Agency B's request for Agency A's offer
      // return 404 instead of the offer. CLAUDE.md rule #3.
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: OFFER_AGENCY_VIEW_SELECT,
    });
    if (!offer) throw notFound('Offre');
    return toOfferForAgency(offer);
  }

  async create(
    tenant: TenantContext,
    actorUserId: string,
    input: CreateOfferInput,
    meta: RequestMeta,
  ): Promise<OfferForAgency> {
    // Re-validated here even though the Zod schema already checked it: the
    // service is callable from a seed script and a future import job, neither
    // of which passes through the HTTP pipe.
    validateOfferAttributesForKind(input.kind, input.attributes ?? {});

    const fingerprint = this.fingerprintFor(tenant.agencyId, {
      kind: input.kind,
      title: input.title,
      departureDate: input.departureDate ?? null,
      destinationCountry: input.destinationCountry ?? null,
      destinationCity: input.destinationCity ?? null,
      departureWilayaCode: input.departureWilayaCode ?? null,
    });

    /**
     * Creating a near-identical offer is allowed. It is FLAGGED, not blocked.
     *
     * Blocking would be wrong: two genuinely different tiers of the same trip
     * share every field in the fingerprint, and an agency that cannot list its
     * own inventory leaves. Flagging demotes the copy and shows the agency a
     * badge asking whether they meant to edit the original.
     */
    const twin = await this.prisma.offer.findFirst({
      where: {
        agencyId: tenant.agencyId,
        fingerprint,
        deletedAt: null,
        duplicateStatus: { not: 'dismissed' },
      },
      select: { id: true },
    });

    const offer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.offer.create({
        data: {
          // agencyId comes from the VERIFIED tenant context, never from input.
          // `createOfferSchema` has no agencyId field at all, so there is
          // nothing to accidentally spread in.
          agencyId: tenant.agencyId,
          kind: input.kind,
          status: 'draft', // publishing is a separate, checked transition
          title: input.title,
          slug: await this.uniqueSlug(tx, input.title),
          summary: input.summary ?? null,
          description: input.description ?? null,
          priceFromCentimes: input.priceFromCentimes,
          priceToCentimes: input.priceToCentimes ?? null,
          currency: input.currency,
          departureDate: toDate(input.departureDate),
          returnDate: toDate(input.returnDate),
          durationDays: input.durationDays ?? null,
          isFlexibleDates: input.isFlexibleDates,
          departureWilayaCode: input.departureWilayaCode ?? null,
          destinationCountry: input.destinationCountry ?? null,
          destinationCity: input.destinationCity ?? null,
          seatsTotal: input.seatsTotal ?? null,
          seatsLeft: input.seatsTotal ?? null,
          attributes: (input.attributes ?? {}),
          media: input.media,
          fingerprint,
          duplicateStatus: twin ? 'suspected' : 'none',
          duplicateOfOfferId: twin?.id ?? null,
          qualityScore: computeQualityScore(input),
        },
        select: OFFER_AGENCY_VIEW_SELECT,
      });

      if (twin) {
        await tx.agency.update({
          where: { id: tenant.agencyId },
          data: { suspectedDuplicateCount: { increment: 1 } },
        });
        await this.audit.record(
          {
            action: 'offer.duplicate_flagged',
            entityType: 'offer',
            entityId: created.id,
            agencyId: tenant.agencyId,
            actorUserId,
            after: { duplicateOfOfferId: twin.id, reason: 'identical_fingerprint' },
            requestId: meta.requestId,
          },
          tx,
        );
      }

      await this.audit.record(
        {
          action: 'offer.created',
          entityType: 'offer',
          entityId: created.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { title: created.title, kind: created.kind, price: created.priceFromCentimes },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return created;
    });

    // Cross-agency similarity is only ever a suggestion for a human. Two
    // agencies reselling the same wholesaler package at different prices is
    // the comparison this marketplace exists to provide — never merge it.
    void this.queueCrossAgencyCandidates(offer.id, tenant.agencyId, input.title, meta.requestId);

    return toOfferForAgency(offer);
  }

  async update(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: UpdateOfferInput,
    meta: RequestMeta,
  ): Promise<OfferForAgency> {
    const before = await this.prisma.offer.findFirst({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: OFFER_AGENCY_VIEW_SELECT,
    });
    if (!before) throw notFound('Offre');

    // `kind` cannot change, so attributes are re-validated against the STORED
    // kind — merged over the existing ones, since a partial update of a JSON
    // column that replaced the whole object would silently drop fields.
    const mergedAttributes =
      input.attributes === undefined
        ? (before.attributes as Record<string, unknown>)
        : { ...(input.attributes as Record<string, unknown>) };
    validateOfferAttributesForKind(before.kind, mergedAttributes);

    const fingerprint = this.fingerprintFor(tenant.agencyId, {
      kind: before.kind,
      title: input.title ?? before.title,
      departureDate: input.departureDate ?? dateOnlyString(before.departureDate),
      destinationCountry: input.destinationCountry ?? before.destinationCountry,
      destinationCity: input.destinationCity ?? before.destinationCity,
      departureWilayaCode: input.departureWilayaCode ?? before.departureWilayaCode,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.offer.updateMany({
        // updateMany, not update: `update({ where: { id } })` cannot also
        // require agencyId, so it would happily edit another agency's offer.
        where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priceFromCentimes !== undefined
            ? { priceFromCentimes: input.priceFromCentimes }
            : {}),
          ...(input.priceToCentimes !== undefined ? { priceToCentimes: input.priceToCentimes } : {}),
          ...(input.departureDate !== undefined ? { departureDate: toDate(input.departureDate) } : {}),
          ...(input.returnDate !== undefined ? { returnDate: toDate(input.returnDate) } : {}),
          ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
          ...(input.isFlexibleDates !== undefined ? { isFlexibleDates: input.isFlexibleDates } : {}),
          ...(input.departureWilayaCode !== undefined
            ? { departureWilayaCode: input.departureWilayaCode }
            : {}),
          ...(input.destinationCountry !== undefined
            ? { destinationCountry: input.destinationCountry }
            : {}),
          ...(input.destinationCity !== undefined ? { destinationCity: input.destinationCity } : {}),
          ...(input.seatsTotal !== undefined ? { seatsTotal: input.seatsTotal } : {}),
          ...(input.attributes !== undefined
            ? { attributes: mergedAttributes as Prisma.InputJsonValue }
            : {}),
          ...(input.media !== undefined
            ? { media: input.media }
            : {}),
          fingerprint,
        },
      });
      if (result.count === 0) throw notFound('Offre');

      const after = await tx.offer.findFirstOrThrow({
        where: { id: offerId, agencyId: tenant.agencyId },
        select: OFFER_AGENCY_VIEW_SELECT,
      });

      const diff = AuditService.diff(before, input);
      await this.audit.record(
        {
          action: 'offer.updated',
          entityType: 'offer',
          entityId: offerId,
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

    return toOfferForAgency(updated);
  }

  /**
   * PUBLISHING — where the plan quota is enforced.
   *
   * This is the one endpoint that turns "limited offers, paid unlimited tier"
   * from a marketing sentence into a rule. Note the count comes from the
   * database, inside the transaction, and the limit comes from the plan table
   * in @rihlati/shared. Neither is ever read from the request.
   */
  async changeStatus(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    input: OfferStatusChangeInput,
    meta: RequestMeta,
  ): Promise<OfferForAgency> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      select: { id: true, status: true, title: true, publishedAt: true },
    });
    if (!offer) throw notFound('Offre');

    const allowed = OFFER_STATUS_TRANSITIONS[offer.status];
    if (!allowed.includes(input.status)) {
      throw new AppError(
        'INVALID_STATUS_TRANSITION',
        `Impossible de passer de « ${offer.status} » à « ${input.status} »`,
        { details: { from: offer.status, to: input.status, allowed } },
      );
    }

    /**
     * Only Rihlati staff may set `published` or `rejected`.
     *
     * An agency asks for review (`pending_review`); a human decides. Without
     * this, "verified agency" is self-service and the badge is worthless.
     */
    if (['published', 'rejected'].includes(input.status) && !tenant.actingAsPlatformAdmin) {
      throw new AppError(
        'FORBIDDEN',
        'Seul Rihlati peut publier une offre. Soumettez-la à la validation.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.status === 'published') {
        // Counted inside the transaction so two concurrent publishes cannot
        // both read "4 of 5" and both succeed.
        const published = await tx.offer.count({
          where: { agencyId: tenant.agencyId, status: 'published', deletedAt: null },
        });
        const limit = resolvePublishedOfferLimit(tenant.plan, tenant.publishedOfferLimitOverride);

        if (!canPublishAnotherOffer(published, limit)) {
          throw new AppError(
            'OFFER_LIMIT_REACHED',
            `Limite de ${limit} offres publiées atteinte pour le plan « ${tenant.plan} »`,
            { details: { plan: tenant.plan, limit, current: published } },
          );
        }
      }

      const result = await tx.offer.updateMany({
        where: { id: offerId, agencyId: tenant.agencyId, status: offer.status },
        data: {
          status: input.status,
          // Set once, on first publication. Re-publishing after a pause must
          // not make an old offer look new in the "newest" sort.
          ...(input.status === 'published' && !offer.publishedAt
            ? { publishedAt: new Date() }
            : {}),
        },
      });
      // 0 rows means someone changed the status between our read and our
      // write. Failing is right — the transition we validated is no longer
      // the one being made.
      if (result.count === 0) {
        throw new AppError('INVALID_STATUS_TRANSITION', 'Le statut a changé, réessayez');
      }

      await this.audit.record(
        {
          action: 'offer.status_changed',
          entityType: 'offer',
          entityId: offerId,
          agencyId: tenant.agencyId,
          actorUserId,
          before: { status: offer.status },
          after: {
            status: input.status,
            reason: input.reason ?? null,
            byPlatformAdmin: tenant.actingAsPlatformAdmin,
          },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return tx.offer.findFirstOrThrow({
        where: { id: offerId, agencyId: tenant.agencyId },
        select: OFFER_AGENCY_VIEW_SELECT,
      });
    });

    return toOfferForAgency(updated);
  }

  /**
   * Soft delete. The row stays.
   *
   * Leads point at offers, and a traveler's inquiry must keep making sense
   * ("about: Omra Ramadan 2026") after the agency removes the listing. A hard
   * delete would either destroy that context or cascade into the lead itself.
   */
  async softDelete(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const result = await this.prisma.offer.updateMany({
      where: { id: offerId, agencyId: tenant.agencyId, deletedAt: null },
      data: { deletedAt: new Date(), status: 'archived' },
    });
    if (result.count === 0) throw notFound('Offre');

    await this.audit.record({
      action: 'offer.deleted',
      entityType: 'offer',
      entityId: offerId,
      agencyId: tenant.agencyId,
      actorUserId,
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { ok: true };
  }

  // =========================================================================
  // INTERNALS
  // =========================================================================

  /**
   * The fingerprint is a hash of "who is selling what trip, from where, on
   * what date". Price is deliberately not in it — see the long note in
   * packages/shared/src/offers/dedup.ts, and Decision 006 in the vault.
   */
  private fingerprintFor(agencyId: string, input: Omit<FingerprintInput, 'agencyId'>): string {
    return sha256Hex(offerFingerprintSource({ agencyId, ...input }));
  }

  /**
   * Slugs are globally unique because they are the public URL. Collisions get
   * a short random suffix rather than `-2`, `-3`: a counter needs a read of
   * every existing sibling and still races two simultaneous creates.
   */
  private async uniqueSlug(tx: Prisma.TransactionClient, title: string): Promise<string> {
    const base =
      title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'offre';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      /**
       * One of the few legitimate unscoped reads.
       *
       * A slug is the public URL, so it must be unique across the WHOLE
       * marketplace, not within one agency. Scoping this lookup by agencyId
       * would let two agencies claim the same URL and the unique index would
       * then reject the insert with a 500 instead of a retry.
       *
       * Nothing from the row is used except whether it exists.
       */
      // eslint-disable-next-line no-restricted-syntax -- global uniqueness check, see above
      const taken = await tx.offer.findUnique({ where: { slug: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    return `${base}-${randomSuffix()}${randomSuffix()}`;
  }

  /**
   * Cross-agency near-duplicates: recorded for a human to look at, never acted
   * on automatically.
   *
   * Runs after the response is sent (fire and forget) because the traveler
   * waiting on the request should not pay for a moderation nicety. A failure
   * here is logged and dropped — it must never fail the offer creation.
   */
  private async queueCrossAgencyCandidates(
    offerId: string,
    agencyId: string,
    title: string,
    requestId: string,
  ): Promise<void> {
    try {
      const recent = await this.prisma.offer.findMany({
        where: {
          agencyId: { not: agencyId },
          status: 'published',
          deletedAt: null,
          createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
        },
        select: { id: true, title: true },
        take: 200,
        orderBy: { createdAt: 'desc' },
      });

      for (const other of recent) {
        const similarity = titleSimilarity(title, other.title);
        if (similarity < DUPLICATE_REVIEW_THRESHOLD) continue;

        // Ordered pair, so the unique index catches the same pair from both
        // directions instead of storing it twice.
        const [leftOfferId, rightOfferId] =
          offerId < other.id ? [offerId, other.id] : [other.id, offerId];

        await this.prisma.offerDuplicateCandidate
          .create({
            data: {
              leftOfferId,
              rightOfferId,
              similarity,
              reason: `title_similarity=${similarity.toFixed(2)}`,
            },
          })
          .catch(() => undefined); // already queued; nothing to do
      }
    } catch (error) {
      this.logger.warn('cross-agency duplicate scan failed', {
        requestId,
        offerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Listing completeness, 0-100. Used for ordering, never shown to travelers.
 *
 * It rewards effort, not quality — a photo and a description mean somebody
 * actually filled the form in. Deliberately not a "trust score": inferring
 * trust from form completeness would be a lie a scammer can farm in ten
 * minutes.
 */
function computeQualityScore(input: CreateOfferInput): number {
  let score = 0;
  if (input.summary) score += 10;
  if (input.description && input.description.length > 200) score += 25;
  if (input.media.length > 0) score += 20;
  if (input.media.length >= 3) score += 10;
  if (input.departureDate) score += 10;
  if (input.durationDays) score += 5;
  if (input.destinationCity) score += 10;
  if (input.priceToCentimes) score += 5;
  if (input.seatsTotal) score += 5;
  return Math.min(100, score);
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toDate(value: string | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

function dateOnlyString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}
