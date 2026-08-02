import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  createMilestoneSchema,
  reorderMilestonesSchema,
  setMilestoneCompletionSchema,
  updateMilestoneSchema,
  type CreateMilestoneInput,
  type MilestoneItem,
  type ReorderMilestonesInput,
  type SetMilestoneCompletionInput,
  type UpdateMilestoneInput,
} from '@rihlati/shared';
import { CurrentUser, RequireAgencyRole, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody } from '../../common/pipes/zod-validation.pipe';
import { MilestonesService } from './milestones.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

/**
 * The agency-editable programme for one offer. Reading is member-level (an
 * agent needs to see the plan too); writing is `manager` — the same bar as
 * editing the offer itself (see AgencyOffersController).
 */
@Controller('agencies/:agencyId/offers/:offerId/milestones')
export class OfferMilestonesController {
  constructor(
    private readonly milestones: MilestonesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
  ): Promise<MilestoneItem[]> {
    return this.milestones.list(tenant, offerId);
  }

  @RequireAgencyRole('manager')
  @Post()
  create(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(createMilestoneSchema)) input: CreateMilestoneInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<MilestoneItem> {
    return this.milestones.create(tenant, actor.userId, offerId, input, this.meta(req));
  }

  /** Declared before `:milestoneId` so "reorder" is never read as an id. */
  @RequireAgencyRole('manager')
  @Post('reorder')
  reorder(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Body(zodBody(reorderMilestonesSchema)) input: ReorderMilestonesInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<MilestoneItem[]> {
    return this.milestones.reorder(tenant, actor.userId, offerId, input, this.meta(req));
  }

  /**
   * Tick a step off as it actually happens — this is what advances every
   * traveler's "vous êtes ici" marker at once (see Trip Programme.md §7.2).
   *
   * Deliberately NOT `manager`, unlike every other write here. Editing the
   * programme is planning work; ticking it off is bus-side work done by the
   * accompagnateur, who is usually the most junior person on the trip. Gating
   * it on `manager` would mean passing a phone around at 4am — the same
   * reasoning as the manifest. (Open question 3 in the vault, decided this way.)
   *
   * A toggle rather than a set, because the tap that matters after a wrong tap
   * is the undo.
   */
  @Post(':milestoneId/completion')
  setCompletion(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Param('milestoneId', uuidParam()) milestoneId: string,
    @Body(zodBody(setMilestoneCompletionSchema)) input: SetMilestoneCompletionInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<MilestoneItem> {
    return this.milestones.setCompletion(
      tenant,
      actor.userId,
      offerId,
      milestoneId,
      input,
      this.meta(req),
    );
  }

  @RequireAgencyRole('manager')
  @Patch(':milestoneId')
  update(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Param('milestoneId', uuidParam()) milestoneId: string,
    @Body(zodBody(updateMilestoneSchema)) input: UpdateMilestoneInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<MilestoneItem> {
    return this.milestones.update(tenant, actor.userId, offerId, milestoneId, input, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Delete(':milestoneId')
  remove(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
    @Param('milestoneId', uuidParam()) milestoneId: string,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.milestones.remove(tenant, actor.userId, offerId, milestoneId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
