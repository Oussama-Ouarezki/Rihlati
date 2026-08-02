import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  createReservationSchema,
  updateReservationSchema,
  type CreateReservationInput,
  type DepartureSummary,
  type Manifest,
  type ReservationItem,
  type UpdateReservationInput,
} from '@rihlati/shared';
import { CurrentUser, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody } from '../../common/pipes/zod-validation.pipe';
import { ReservationsService } from './reservations.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

/**
 * All member-level (no role decorator): the manifest is the OPERATIONAL tool,
 * and check-in at the bus is agent work by definition. `:agencyId` in every
 * path arms the membership guard as usual.
 */
@Controller('agencies/:agencyId')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('departures')
  departures(@Tenant() tenant: TenantContext): Promise<DepartureSummary[]> {
    return this.reservations.listDepartures(tenant);
  }

  @Get('offers/:offerId/manifest')
  manifest(
    @Tenant() tenant: TenantContext,
    @Param('offerId', uuidParam()) offerId: string,
  ): Promise<Manifest> {
    return this.reservations.getManifest(tenant, offerId);
  }

  @Post('reservations')
  create(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(createReservationSchema)) input: CreateReservationInput,
    @Req() req: Request,
  ): Promise<ReservationItem> {
    return this.reservations.create(tenant, actor.userId, input, this.meta(req));
  }

  @Patch('reservations/:reservationId')
  update(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('reservationId', uuidParam()) reservationId: string,
    @Body(zodBody(updateReservationSchema)) input: UpdateReservationInput,
    @Req() req: Request,
  ): Promise<ReservationItem> {
    return this.reservations.update(tenant, actor.userId, reservationId, input, this.meta(req));
  }

  /**
   * Mint this family's /mon-voyage link if it hasn't got one — reservations
   * created before the column existed. Idempotent: calling it twice returns
   * the same code rather than rotating it, because the first code may already
   * be in a WhatsApp thread and silently breaking it is worse than nothing.
   *
   * A POST, not a GET, because on a reservation without a code this creates a
   * credential. Member-level like the rest of the manifest: sending a family
   * their own itinerary is agent work.
   */
  @Post('reservations/:reservationId/trip-link')
  tripLink(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Param('reservationId', uuidParam()) reservationId: string,
    @Req() req: Request,
  ): Promise<ReservationItem> {
    return this.reservations.ensureTripLink(tenant, actor.userId, reservationId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
