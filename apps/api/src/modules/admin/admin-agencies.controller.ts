import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  adminAgencyQueueSchema,
  rejectAgencySchema,
  verifyAgencySchema,
  type AdminAgencyDecision,
  type AdminAgencyListItem,
  type AdminAgencyQueueInput,
  type Page,
  type RejectAgencyInput,
  type VerifyAgencyInput,
} from '@rihlati/shared';
import { CurrentUser, PlatformAdminOnly } from '../../common/auth/auth.decorators';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';
import { AdminAgenciesService } from './admin-agencies.service';

/**
 * `@PlatformAdminOnly()` sits on the CLASS, not on each method.
 *
 * Deliberate: a method added to this controller later is protected by
 * default, and protecting it is not something the next person has to remember.
 * The failure mode of per-method decorators is always the same — the fifth
 * endpoint, added in a hurry, without one.
 *
 * ---
 *
 * Read the path parameter name carefully: it is `:id`, NOT `:agencyId`.
 *
 * That is not a style choice. `AgencyMembershipGuard` switches itself on for
 * any route containing `:agencyId`, and for a platform admin it would hand
 * back a TenantContext with `role: 'owner'` — that is, it would frame this
 * request as "staff acting AS the agency", which is right for support work
 * (fixing a locked-out owner's offer) and wrong for judging them. A reviewer
 * is not acting on the agency's behalf; they are acting on Rihlati's.
 *
 * So this is the one route family in the codebase where the guard staying
 * silent is intended. It is also why `AdminAgenciesService` re-checks
 * membership itself, in `loadForDecision` — with the guard off, nothing else
 * would notice an admin reviewing their own agency.
 */
@PlatformAdminOnly()
@Controller('admin/agencies')
export class AdminAgenciesController {
  constructor(
    private readonly admin: AdminAgenciesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The review queue. Defaults to `pending_review`; paginated like everything else. */
  @Get()
  list(
    @Query(zodQuery(adminAgencyQueueSchema)) query: AdminAgencyQueueInput,
  ): Promise<Page<AdminAgencyListItem>> {
    return this.admin.listAgencies(query);
  }

  @Post(':id/verify')
  verify(
    @Param('id', uuidParam()) id: string,
    @Body(zodBody(verifyAgencySchema)) input: VerifyAgencyInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AdminAgencyDecision> {
    return this.admin.verify(actor.userId, id, input, this.meta(req));
  }

  @Post(':id/reject')
  reject(
    @Param('id', uuidParam()) id: string,
    @Body(zodBody(rejectAgencySchema)) input: RejectAgencyInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<AdminAgencyDecision> {
    return this.admin.reject(actor.userId, id, input, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
