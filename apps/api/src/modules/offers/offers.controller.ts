import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createOfferSchema,
  createOfferReportSchema,
  offerAnalyticsQuerySchema,
  offerEventSchema,
  offerSearchSchema,
  offerStatusChangeSchema,
  paginationSchema,
  updateOfferSchema,
  type CreateOfferInput,
  type CreateOfferReportInput,
  type OfferAnalytics,
  type OfferAnalyticsQuery,
  type OfferDetail,
  type OfferEventInput,
  type OfferForAgency,
  type OfferSearchInput,
  type OfferStatusChangeInput,
  type OfferSummary,
  type Page,
  type UpdateOfferInput,
} from '@rihlati/shared';
import {
  CurrentUser,
  OptionalUser,
  Public,
  RequireAgencyRole,
  RequireVerifiedAgency,
  Tenant,
} from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { slugParam, uuidParam, zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { OffersService } from './offers.service';
import { OfferReportsService } from './offer-reports.service';
import { OfferMetricsService } from './offer-metrics.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

@Controller('offers')
export class PublicOffersController {
  constructor(
    private readonly offers: OffersService,
    private readonly reports: OfferReportsService,
    private readonly metrics: OfferMetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The marketplace search. Public, and the busiest endpoint in the app. */
  @Public()
  @Get()
  search(@Query(zodQuery(offerSearchSchema)) query: OfferSearchInput): Promise<Page<OfferSummary>> {
    return this.offers.search(query);
  }

  @Public()
  @Get('by-slug/:slug')
  getBySlug(@Param('slug', slugParam()) slug: string): Promise<OfferDetail> {
    return this.offers.getPublicBySlug(slug);
  }

  /**
   * The metrics beacon: the browser reports taps on the WhatsApp/phone
   * buttons, which the server cannot observe on its own. Public and
   * deliberately boring — it can only increment two counters on a published
   * offer, so the worst abuse is flattering an agency's own chart.
   */
  @Public()
  @Throttle({ beacon: { limit: 120, ttl: 3_600_000 } })
  @Post(':offerId/events')
  recordEvent(
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(offerEventSchema)) input: OfferEventInput,
  ): Promise<{ ok: true }> {
    return this.metrics.recordEvent(offerId, input);
  }

  /**
   * Report an offer. Public so a traveler can flag a scam without signing up —
   * the people most likely to spot one are the ones who have not committed to
   * an account yet.
   *
   * Anonymous reports are deduplicated by hashed IP, which is weak, and that is
   * accepted: reports never hide anything on their own, so the cost of a false
   * report is a queue entry, not a lost listing.
   */
  @Public()
  @Throttle({ report: { limit: 10, ttl: 3_600_000 } })
  @Post(':offerId/reports')
  report(
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(createOfferReportSchema)) input: CreateOfferReportInput,
    @OptionalUser() actor: AuthenticatedActor | null,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.reports.create(offerId, input, actor?.userId ?? null, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}

const agencyOfferListSchema = paginationSchema.extend({
  status: z
    .enum(['draft', 'pending_review', 'published', 'paused', 'archived', 'rejected'])
    .optional(),
});

/**
 * The agency's analytics dashboard data. `:agencyId` in the path arms the
 * membership guard as usual; the PLAN gate (`analytics` feature) lives in the
 * service, where it reads the plan from the verified tenant context.
 */
@Controller('agencies/:agencyId/analytics')
export class AgencyAnalyticsController {
  constructor(private readonly metrics: OfferMetricsService) {}

  @Get('offers')
  offers(
    @Tenant() tenant: TenantContext,
    @Query(zodQuery(offerAnalyticsQuerySchema)) query: OfferAnalyticsQuery,
  ): Promise<OfferAnalytics> {
    return this.metrics.analytics(tenant, query);
  }
}

/**
 * The agency's own catalogue.
 *
 * Every path carries `:agencyId`, which is what arms AgencyMembershipGuard.
 * There is no way to write a route in this controller that is not tenant
 * scoped — the scoping is a property of the URL, not of the author's memory.
 */
@Controller('agencies/:agencyId/offers')
export class AgencyOffersController {
  constructor(
    private readonly offers: OffersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(
    @Tenant() tenant: TenantContext,
    @Query(zodQuery(agencyOfferListSchema)) query: z.infer<typeof agencyOfferListSchema>,
  ): Promise<Page<OfferForAgency>> {
    return this.offers.listForAgency(tenant, query);
  }

  @Get(':offerId')
  get(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
  ): Promise<OfferForAgency> {
    return this.offers.getForAgency(tenant, offerId);
  }

  /**
   * `agent` cannot create offers — an agent works leads. Drafting is allowed
   * before verification: an agency should be able to prepare its catalogue
   * while Rihlati checks its licence. `@RequireVerifiedAgency()` sits on the
   * publish route instead, where it actually matters.
   */
  @RequireAgencyRole('manager')
  @Post()
  create(
    @Tenant() tenant: TenantContext,
    @Body(zodBody(createOfferSchema)) input: CreateOfferInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<OfferForAgency> {
    return this.offers.create(tenant, actor.userId, input, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Patch(':offerId')
  update(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(updateOfferSchema)) input: UpdateOfferInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<OfferForAgency> {
    return this.offers.update(tenant, actor.userId, offerId, input, this.meta(req));
  }

  /**
   * Status changes, including "submit for review". The plan's published-offer
   * quota is enforced inside the service, in a transaction.
   *
   * Verified-only: an unverified agency may draft, but nothing it wrote may
   * take a step towards being seen by a traveler.
   */
  @RequireAgencyRole('manager')
  @RequireVerifiedAgency()
  @Patch(':offerId/status')
  changeStatus(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(offerStatusChangeSchema)) input: OfferStatusChangeInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<OfferForAgency> {
    return this.offers.changeStatus(tenant, actor.userId, offerId, input, this.meta(req));
  }

  /** Soft delete — the row survives so existing leads keep their context. */
  @RequireAgencyRole('manager')
  @Delete(':offerId')
  remove(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.offers.softDelete(tenant, actor.userId, offerId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
