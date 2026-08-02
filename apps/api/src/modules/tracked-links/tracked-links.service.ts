import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PLAN_LIMITS,
  TRACKED_LINK_CODE_LENGTH,
  conversionRate,
  type CreateTrackedLinkInput,
  type TrackedLinkItem,
  type TrackedLinkList,
  type UpdateTrackedLinkInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import type { TenantContext } from '../../common/auth/tenant-context';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

/**
 * Named short links an agency pastes under its social posts, and the
 * click→inquiry attribution that answers "which post brings clients?".
 */
@Injectable()
export class TrackedLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(tenant: TenantContext): Promise<TrackedLinkList> {
    const rows = await this.prisma.trackedLink.findMany({
      where: { agencyId: tenant.agencyId, deletedAt: null },
      select: LINK_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      items: rows.map((row) => this.toItem(row)),
      limit: PLAN_LIMITS[tenant.plan].maxTrackedLinks,
      used: rows.length,
    };
  }

  async create(
    tenant: TenantContext,
    actorUserId: string,
    input: CreateTrackedLinkInput,
    meta: RequestMeta,
  ): Promise<TrackedLinkItem> {
    // The plan gate. Counted from the database, never from the request.
    const limit = PLAN_LIMITS[tenant.plan].maxTrackedLinks;
    if (limit !== null) {
      const used = await this.prisma.trackedLink.count({
        where: { agencyId: tenant.agencyId, deletedAt: null },
      });
      if (used >= limit) {
        throw new AppError(
          'FEATURE_NOT_IN_PLAN',
          `Limite de ${limit} liens de suivi atteinte pour le plan « ${tenant.plan} »`,
          { details: { feature: 'maxTrackedLinks', plan: tenant.plan, limit, current: used } },
        );
      }
    }

    if (input.offerId) {
      // The offer must be OURS — otherwise an agency could mint links that
      // drive its followers to a competitor's page and count the clicks.
      const offer = await this.prisma.offer.findFirst({
        where: { id: input.offerId, agencyId: tenant.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!offer) throw notFound('Offre');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.trackedLink.create({
        data: {
          agencyId: tenant.agencyId, // verified tenant, never the body
          offerId: input.offerId ?? null,
          code: await this.uniqueCode(tx),
          label: input.label,
        },
        select: LINK_SELECT,
      });

      await this.audit.record(
        {
          action: 'tracked_link.created',
          entityType: 'tracked_link',
          entityId: row.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { label: row.label, offerId: row.offerId },
          requestId: meta.requestId,
        },
        tx,
      );

      return row;
    });

    return this.toItem(created);
  }

  /** Renaming only — the code is the published URL and never changes. */
  async update(
    tenant: TenantContext,
    linkId: string,
    input: UpdateTrackedLinkInput,
  ): Promise<TrackedLinkItem> {
    const result = await this.prisma.trackedLink.updateMany({
      where: { id: linkId, agencyId: tenant.agencyId, deletedAt: null },
      data: { label: input.label },
    });
    if (result.count === 0) throw notFound('Lien');

    const row = await this.prisma.trackedLink.findFirstOrThrow({
      where: { id: linkId, agencyId: tenant.agencyId },
      select: LINK_SELECT,
    });
    return this.toItem(row);
  }

  /**
   * Soft delete. The link stops counting and frees a plan slot, but leads
   * already attributed to it keep pointing at it — deleting the row would
   * silently rewrite history in the inbox.
   */
  async remove(
    tenant: TenantContext,
    actorUserId: string,
    linkId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const result = await this.prisma.trackedLink.updateMany({
      where: { id: linkId, agencyId: tenant.agencyId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw notFound('Lien');

    await this.audit.record({
      action: 'tracked_link.deleted',
      entityType: 'tracked_link',
      entityId: linkId,
      agencyId: tenant.agencyId,
      actorUserId,
      requestId: meta.requestId,
    });

    return { ok: true };
  }

  // =========================================================================
  // PUBLIC
  // =========================================================================

  /**
   * `/l/{code}` — count the click, return where to send the traveler.
   *
   * An unknown or retired code sends the visitor to the home page rather than
   * a 404: the link is printed in someone's Facebook post forever, and a dead
   * end there is a lost customer. A broken link should still land on the
   * marketplace.
   */
  async resolveAndCount(code: string): Promise<string> {
    /**
     * One of the few legitimate unscoped reads: the code is globally unique
     * and the caller is an anonymous traveler who has no tenant. Nothing
     * tenant-owned is returned — only where to redirect.
     */
    // eslint-disable-next-line no-restricted-syntax -- public code lookup, see above
    const link = await this.prisma.trackedLink.findUnique({
      where: { code },
      select: {
        id: true,
        offer: { select: { slug: true, status: true, deletedAt: true } },
        agency: { select: { slug: true, status: true } },
        deletedAt: true,
      },
    });

    if (!link || link.deletedAt) return this.config.WEB_URL;

    // Counting is best-effort: a metrics failure must never break a redirect
    // a real traveler is waiting on.
    try {
      await this.prisma.trackedLink.updateMany({
        where: { id: link.id },
        data: { clickCount: { increment: 1 } },
      });
    } catch (error) {
      this.logger.warn('tracked link click count failed', {
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const ref = `ref=${encodeURIComponent(code)}`;

    // The offer page, when the offer is still visible…
    if (link.offer && link.offer.status === 'published' && !link.offer.deletedAt) {
      return `${this.config.WEB_URL}/offres/${link.offer.slug}?${ref}`;
    }
    // …otherwise the agency's catalogue, so a paused trip still lands
    // somewhere useful instead of nowhere.
    if (link.agency.status === 'verified') {
      return `${this.config.WEB_URL}/?agency=${encodeURIComponent(link.agency.slug)}&${ref}`;
    }
    return this.config.WEB_URL;
  }

  /**
   * Turns the `ref` code a traveler carried through into a link id, for the
   * lead being created. Returns null on anything suspicious rather than
   * throwing: attribution is a nice-to-have, and an inquiry must never fail
   * because a marketing code was stale.
   *
   * The agency check is the important line — a code belonging to agency B
   * must not attribute a lead that belongs to agency A.
   */
  async resolveForAttribution(code: string | undefined, agencyId: string): Promise<string | null> {
    if (!code) return null;
    try {
      // Scoped by agencyId in the WHERE clause rather than fetched and
      // compared afterwards: a foreign code simply finds nothing, so the
      // check cannot be forgotten by a later edit. (The lint rule for rule #3
      // flagged the compare-afterwards version — it was right.)
      const link = await this.prisma.trackedLink.findFirst({
        where: { code, agencyId },
        select: { id: true },
      });
      return link?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Called inside the inquiry transaction, so lead and counter agree. */
  async countInquiryInTx(tx: Prisma.TransactionClient, linkId: string): Promise<void> {
    await tx.trackedLink.updateMany({
      where: { id: linkId },
      data: { inquiryCount: { increment: 1 } },
    });
  }

  // =========================================================================

  /**
   * A short random code. Retries on collision rather than counting up: a
   * sequential code would let anyone enumerate every agency's campaigns.
   */
  private async uniqueCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomBytes(16)
        .toString('base64url')
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, TRACKED_LINK_CODE_LENGTH);
      // Global uniqueness check, like the offer slug: codes must not collide
      // across agencies, so this one cannot be tenant-scoped.
      // eslint-disable-next-line no-restricted-syntax -- global uniqueness, see above
      const taken = await tx.trackedLink.findUnique({ where: { code }, select: { id: true } });
      if (!taken && code.length === TRACKED_LINK_CODE_LENGTH) return code;
    }
    throw new AppError('INTERNAL', 'Impossible de générer un code de lien');
  }

  private toItem(row: LinkRow): TrackedLinkItem {
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      url: `${this.config.WEB_URL}/l/${row.code}`,
      offerId: row.offerId,
      offerTitle: row.offer?.title ?? null,
      clickCount: row.clickCount,
      inquiryCount: row.inquiryCount,
      conversionRate: conversionRate(row.clickCount, row.inquiryCount),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

const LINK_SELECT = {
  id: true, code: true, label: true, offerId: true,
  clickCount: true, inquiryCount: true, createdAt: true,
  offer: { select: { title: true } },
} as const;

type LinkRow = Prisma.TrackedLinkGetPayload<{ select: typeof LINK_SELECT }>;
