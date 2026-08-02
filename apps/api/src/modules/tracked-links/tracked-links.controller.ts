import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createTrackedLinkSchema,
  trackedLinkCodeSchema,
  updateTrackedLinkSchema,
  type CreateTrackedLinkInput,
  type TrackedLinkItem,
  type TrackedLinkList,
  type UpdateTrackedLinkInput,
} from '@rihlati/shared';
import { CurrentUser, Public, RequireAgencyRole, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody } from '../../common/pipes/zod-validation.pipe';
import { TrackedLinksService } from './tracked-links.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { Inject } from '@nestjs/common';
import type { RequestMeta } from '../auth/auth.service';

const resolveSchema = z.object({ code: trackedLinkCodeSchema });

@Controller('tracked-links')
export class PublicTrackedLinksController {
  constructor(private readonly links: TrackedLinksService) {}

  /**
   * Resolve a short code to its destination and count the click.
   *
   * POST, not GET, precisely because it changes state — a counting endpoint
   * behind a GET gets fetched by every link previewer and proxy cache in the
   * chain. The public `/l/{code}` URL lives on the WEB app (the domain people
   * see in a Facebook post); that route calls this and issues the redirect.
   *
   * Public and rate limited: anyone holding the link is, by design, anyone.
   */
  @Public()
  @Throttle({ resolve: { limit: 120, ttl: 3_600_000 } })
  @Post('resolve')
  async resolve(@Body(zodBody(resolveSchema)) input: { code: string }): Promise<{ url: string }> {
    return { url: await this.links.resolveAndCount(input.code) };
  }
}

/**
 * The agency's own links. `:agencyId` arms the membership guard; `manager`
 * because a tracked link is a marketing asset, not day-to-day agent work.
 */
@Controller('agencies/:agencyId/tracked-links')
export class AgencyTrackedLinksController {
  constructor(
    private readonly links: TrackedLinksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(@Tenant() tenant: TenantContext): Promise<TrackedLinkList> {
    return this.links.list(tenant);
  }

  @RequireAgencyRole('manager')
  @Post()
  create(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(createTrackedLinkSchema)) input: CreateTrackedLinkInput,
    @Req() req: Request,
  ): Promise<TrackedLinkItem> {
    return this.links.create(tenant, actor.userId, input, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Patch(':linkId')
  update(
    @Tenant() tenant: TenantContext,
    @Param('linkId', uuidParam()) linkId: string,
    @Body(zodBody(updateTrackedLinkSchema)) input: UpdateTrackedLinkInput,
  ): Promise<TrackedLinkItem> {
    return this.links.update(tenant, linkId, input);
  }

  @RequireAgencyRole('manager')
  @Delete(':linkId')
  remove(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('linkId', uuidParam()) linkId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.links.remove(tenant, actor.userId, linkId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
