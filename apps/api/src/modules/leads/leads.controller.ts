import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  createInquirySchema,
  createLeadNoteSchema,
  createLeadSchema,
  leadSearchSchema,
  updateLeadSchema,
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
import { CurrentUser, OptionalUser, Public, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { LeadsService } from './leads.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

@Controller('inquiries')
export class InquiriesController {
  constructor(
    private readonly leads: LeadsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * A traveler contacts an agency. PUBLIC — requiring an account here would
   * kill the marketplace's only conversion event.
   *
   * 5 per hour per IP. Enough for someone comparing several agencies for the
   * same trip, far too few to fill an agency's inbox with junk.
   */
  @Public()
  @Throttle({ inquiry: { limit: 5, ttl: 3_600_000 } })
  @Post()
  create(
    @Body(zodBody(createInquirySchema)) input: CreateInquiryInput,
    @OptionalUser() actor: AuthenticatedActor | null,
    @Req() req: Request,
  ): Promise<InquiryReceipt> {
    return this.leads.createInquiry(input, actor?.userId ?? null, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}

/**
 * The CRM. Every path has `:agencyId`, so AgencyMembershipGuard runs on all of
 * them and `tenant` is proven before any handler executes.
 *
 * No `@RequireAgencyRole` here: an `agent` is supposed to work leads, that is
 * the job. The narrowing that DOES apply to agents — seeing only their own
 * assigned leads — lives in the service's WHERE clauses, because a role
 * decorator can only say yes or no to a whole endpoint, not scope a query.
 */
@Controller('agencies/:agencyId/leads')
export class AgencyLeadsController {
  constructor(
    private readonly leads: LeadsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodQuery(leadSearchSchema)) query: LeadSearchInput,
  ): Promise<Page<LeadSummary>> {
    return this.leads.list(tenant, actor.userId, query);
  }

  @Get(':leadId')
  get(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('leadId', uuidParam()) leadId: string,
  ): Promise<LeadDetail> {
    return this.leads.get(tenant, actor.userId, leadId);
  }

  @Post()
  create(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(createLeadSchema)) input: CreateLeadInput,
    @Req() req: Request,
  ): Promise<LeadSummary> {
    return this.leads.create(tenant, actor.userId, input, this.meta(req));
  }

  /** Stage, quality label, assignment, values. Contact details are not editable. */
  @Patch(':leadId')
  update(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('leadId', uuidParam()) leadId: string,
    @Body(zodBody(updateLeadSchema)) input: UpdateLeadInput,
    @Req() req: Request,
  ): Promise<LeadSummary> {
    return this.leads.update(tenant, actor.userId, leadId, input, this.meta(req));
  }

  @Post(':leadId/notes')
  addNote(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('leadId', uuidParam()) leadId: string,
    @Body(zodBody(createLeadNoteSchema)) input: CreateLeadNoteInput,
    @Req() req: Request,
  ): Promise<{ id: string; createdAt: string }> {
    return this.leads.addNote(tenant, actor.userId, leadId, input, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
