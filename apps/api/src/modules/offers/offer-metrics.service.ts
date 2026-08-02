import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  hasFeature,
  type OfferAnalytics,
  type OfferAnalyticsPoint,
  type OfferAnalyticsQuery,
  type OfferAnalyticsTopOffer,
  type OfferEventInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppLogger } from '../../common/logging/logger';
import type { TenantContext } from '../../common/auth/tenant-context';

type MetricField = 'views' | 'whatsappClicks' | 'phoneClicks' | 'inquiries';
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Time-series counters for offers. See the model comment in schema.prisma for
 * why this is daily rollups and not an event stream.
 *
 * Collection is NOT plan-gated — every agency's history accrues from day one,
 * because the day they upgrade, the chart must already have a past. Only
 * `analytics()` (the read) checks the plan.
 */
@Injectable()
export class OfferMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Count a public page view. Swallows its own failures: a metrics hiccup
   * must never 500 the offer page — the page is the product, the counter is
   * bookkeeping.
   */
  async recordView(agencyId: string, offerId: string): Promise<void> {
    try {
      await this.increment(this.prisma, agencyId, offerId, 'views');
    } catch (error) {
      this.logger.warn('view metric failed', {
        offerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The public beacon: interactions the server cannot see on its own
   * (tapping the WhatsApp or phone button happens entirely in the browser).
   *
   * Anyone can call it, so the numbers are spammable in principle — accepted,
   * because these are trend data for the agency's own eyes, not billing. The
   * rate limit keeps the noise bounded.
   */
  async recordEvent(offerId: string, input: OfferEventInput): Promise<{ ok: true }> {
    const offer = await this.prisma.offer.findFirst({
      // Same visibility rule as the public page: unpublished offers do not
      // exist, and the beacon must not become an existence oracle for drafts.
      where: { id: offerId, status: 'published', deletedAt: null },
      select: { id: true, agencyId: true },
    });
    if (!offer) throw notFound('Offre');

    await this.increment(
      this.prisma,
      offer.agencyId,
      offer.id,
      input.type === 'whatsapp_click' ? 'whatsappClicks' : 'phoneClicks',
    );
    return { ok: true };
  }

  /**
   * Called inside createInquiry's transaction, so a lead and its metric tick
   * commit together. Only real creations count — the 6-hour dedupe path in
   * LeadsService returns before reaching this.
   */
  async recordInquiryInTx(tx: Prisma.TransactionClient, agencyId: string, offerId: string): Promise<void> {
    await this.increment(tx, agencyId, offerId, 'inquiries');
  }

  /** The dashboard read. This is the plan-gated part. */
  async analytics(tenant: TenantContext, query: OfferAnalyticsQuery): Promise<OfferAnalytics> {
    if (!hasFeature(tenant.plan, 'analytics')) {
      throw new AppError(
        'FEATURE_NOT_IN_PLAN',
        'Les statistiques nécessitent un plan supérieur',
        { details: { feature: 'analytics', plan: tenant.plan } },
      );
    }

    // A foreign offerId must be indistinguishable from a nonexistent one.
    if (query.offerId) {
      const owned = await this.prisma.offer.findFirst({
        where: { id: query.offerId, agencyId: tenant.agencyId },
        select: { id: true },
      });
      if (!owned) throw notFound('Offre');
    }

    const today = algiersToday();
    const from = new Date(today.getTime() - (query.days - 1) * 86_400_000);

    const rows = await this.prisma.offerMetricDaily.findMany({
      where: {
        agencyId: tenant.agencyId, // the tenant scope — never from the query
        date: { gte: from },
        ...(query.offerId ? { offerId: query.offerId } : {}),
      },
      select: {
        offerId: true, date: true,
        views: true, whatsappClicks: true, phoneClicks: true, inquiries: true,
      },
    });

    // Zero-fill so the chart never has holes: exactly `days` points.
    const byDay = new Map<string, OfferAnalyticsPoint>();
    for (let i = 0; i < query.days; i += 1) {
      const date = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(date, { date, views: 0, whatsappClicks: 0, phoneClicks: 0, inquiries: 0 });
    }

    const byOffer = new Map<string, Omit<OfferAnalyticsTopOffer, 'title' | 'slug'>>();
    const totals = { views: 0, whatsappClicks: 0, phoneClicks: 0, inquiries: 0 };

    for (const row of rows) {
      const day = byDay.get(row.date.toISOString().slice(0, 10));
      if (day) {
        day.views += row.views;
        day.whatsappClicks += row.whatsappClicks;
        day.phoneClicks += row.phoneClicks;
        day.inquiries += row.inquiries;
      }
      totals.views += row.views;
      totals.whatsappClicks += row.whatsappClicks;
      totals.phoneClicks += row.phoneClicks;
      totals.inquiries += row.inquiries;

      const agg = byOffer.get(row.offerId) ?? {
        offerId: row.offerId, views: 0, whatsappClicks: 0, phoneClicks: 0, inquiries: 0,
      };
      agg.views += row.views;
      agg.whatsappClicks += row.whatsappClicks;
      agg.phoneClicks += row.phoneClicks;
      agg.inquiries += row.inquiries;
      byOffer.set(row.offerId, agg);
    }

    const top = [...byOffer.values()].sort((a, b) => b.views - a.views).slice(0, 10);

    // Titles fetched tenant-scoped, like every offer read.
    const offers = await this.prisma.offer.findMany({
      where: { id: { in: top.map((t) => t.offerId) }, agencyId: tenant.agencyId },
      select: { id: true, title: true, slug: true },
    });
    const titleById = new Map(offers.map((o) => [o.id, o]));

    return {
      series: [...byDay.values()],
      totals,
      topOffers: top.map((t) => ({
        ...t,
        title: titleById.get(t.offerId)?.title ?? '—',
        slug: titleById.get(t.offerId)?.slug ?? '',
      })),
    };
  }

  /**
   * One upsert, atomic at the database (INSERT … ON CONFLICT), so two
   * simultaneous views of the same offer both land — no read-modify-write.
   */
  private async increment(db: Db, agencyId: string, offerId: string, field: MetricField): Promise<void> {
    const date = algiersToday();
    await db.offerMetricDaily.upsert({
      where: { offerId_date: { offerId, date } },
      create: {
        agencyId, offerId, date,
        views: field === 'views' ? 1 : 0,
        whatsappClicks: field === 'whatsappClicks' ? 1 : 0,
        phoneClicks: field === 'phoneClicks' ? 1 : 0,
        inquiries: field === 'inquiries' ? 1 : 0,
      },
      update:
        field === 'views' ? { views: { increment: 1 } }
        : field === 'whatsappClicks' ? { whatsappClicks: { increment: 1 } }
        : field === 'phoneClicks' ? { phoneClicks: { increment: 1 } }
        : { inquiries: { increment: 1 } },
    });
  }
}

/**
 * "Today" on the ALGIERS calendar. Algeria is UTC+1 with no DST, so a fixed
 * one-hour shift is exact — no timezone library needed. Agencies think in
 * local days; a view at 00:30 in Algiers must not count for "yesterday".
 */
function algiersToday(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
