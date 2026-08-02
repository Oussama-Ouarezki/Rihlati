import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  agencySearchSchema,
  createAgencySchema,
  createFaqSchema,
  updateAgencySchema,
  updateFaqSchema,
  type AgencyFaqItem,
  type AgencyFaqItemForMember,
  type AgencyForMember,
  type AgencySearchInput,
  type CreateAgencyInput,
  type CreateFaqInput,
  type Page,
  type PublicAgency,
  type UpdateAgencyInput,
  type UpdateFaqInput,
} from '@rihlati/shared';
import {
  CurrentUser,
  Public,
  RequireAgencyRole,
  Tenant,
} from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { slugParam, uuidParam, zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { AgenciesService } from './agencies.service';
import { AgencyFaqService } from './agency-faq.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

/**
 * Two controllers in one file, split by audience:
 *   - `/agencies/...`              public, read-only, verified agencies only
 *   - `/agencies/:agencyId/...`    tenant-scoped; the membership guard fires
 *                                  on the `:agencyId` parameter alone
 */
@Controller('agencies')
export class PublicAgenciesController {
  constructor(
    private readonly agencies: AgenciesService,
    private readonly faq: AgencyFaqService,
  ) {}

  @Public()
  @Get()
  search(@Query(zodQuery(agencySearchSchema)) query: AgencySearchInput): Promise<Page<PublicAgency>> {
    return this.agencies.searchPublic(query);
  }

  /**
   * By slug, not by id. The public URL is /agences/voyages-el-baraka, and slugs
   * are what SEO and shareable links need. Ids stay internal.
   */
  @Public()
  @Get('by-slug/:slug')
  getBySlug(@Param('slug', slugParam()) slug: string): Promise<PublicAgency> {
    return this.agencies.getPublicBySlug(slug);
  }

  /** Enabled FAQ entries of a verified agency. Bounded by the per-agency cap. */
  @Public()
  @Get('by-slug/:slug/faq')
  getFaqBySlug(@Param('slug', slugParam()) slug: string): Promise<AgencyFaqItem[]> {
    return this.faq.listPublicBySlug(slug);
  }
}

@Controller()
export class AgencyMembersController {
  constructor(
    private readonly agencies: AgenciesService,
    private readonly faq: AgencyFaqService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Any logged-in user may create one agency. 3 attempts an hour. */
  @Throttle({ createAgency: { limit: 3, ttl: 3_600_000 } })
  @Post('agencies')
  create(
    @Body(zodBody(createAgencySchema)) input: CreateAgencyInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AgencyForMember> {
    return this.agencies.create(actor.userId, input, this.meta(req));
  }

  /**
   * No decorator needed for tenant safety: the `:agencyId` in the path is what
   * switches the membership guard on. A non-member gets 404 before this method
   * is reached.
   */
  @Get('agencies/:agencyId')
  get(@Tenant() tenant: TenantContext): Promise<AgencyForMember> {
    return this.agencies.getForMember(tenant);
  }

  /** `agent` can read the agency but not rewrite its legal identity. */
  @RequireAgencyRole('manager')
  @Patch('agencies/:agencyId')
  update(
    @Tenant() tenant: TenantContext,
    @Body(zodBody(updateAgencySchema)) input: UpdateAgencyInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AgencyForMember> {
    return this.agencies.update(tenant, actor.userId, input, this.meta(req));
  }

  /** Owner only: verification binds the agency's legal identity to the platform. */
  @RequireAgencyRole('owner')
  @Post('agencies/:agencyId/submit-for-review')
  submitForReview(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ status: string }> {
    return this.agencies.submitForReview(tenant, actor.userId, this.meta(req));
  }

  // ---- FAQ ("questions répétées") — chatbot knowledge base later ----------

  @Get('agencies/:agencyId/faq')
  listFaq(@Tenant() tenant: TenantContext): Promise<AgencyFaqItemForMember[]> {
    return this.faq.listForAgency(tenant);
  }

  @RequireAgencyRole('manager')
  @Post('agencies/:agencyId/faq')
  createFaq(
    @Tenant() tenant: TenantContext,
    @Body(zodBody(createFaqSchema)) input: CreateFaqInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AgencyFaqItemForMember> {
    return this.faq.create(tenant, actor.userId, input, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Patch('agencies/:agencyId/faq/:faqId')
  updateFaq(
    @Tenant() tenant: TenantContext,
    @Param('faqId', uuidParam()) faqId: string,
    @Body(zodBody(updateFaqSchema)) input: UpdateFaqInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AgencyFaqItemForMember> {
    return this.faq.update(tenant, actor.userId, faqId, input, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Delete('agencies/:agencyId/faq/:faqId')
  removeFaq(
    @Tenant() tenant: TenantContext,
    @Param('faqId', uuidParam()) faqId: string,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.faq.remove(tenant, actor.userId, faqId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
