import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  setCheckpointAttendanceSchema,
  type CheckpointAttendance,
  type MilestoneCheckInItem,
  type SetCheckpointAttendanceInput,
} from '@rihlati/shared';
import { CurrentUser, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { uuidParam, zodBody } from '../../common/pipes/zod-validation.pipe';
import { CheckpointAttendanceService } from './checkpoint-attendance.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';

/**
 * Attendance at ONE checkpoint milestone. Member-level (no role decorator),
 * same reasoning as ReservationsController: this is the accompagnateur's
 * bus-side work, not a manager privilege.
 */
@Controller('agencies/:agencyId/milestones/:milestoneId/check-ins')
export class CheckpointAttendanceController {
  constructor(
    private readonly attendance: CheckpointAttendanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  get(
    @Tenant() tenant: TenantContext,
    @Param('milestoneId', uuidParam()) milestoneId: string,
  ): Promise<CheckpointAttendance> {
    return this.attendance.getAttendance(tenant, milestoneId);
  }

  @Patch(':reservationId')
  set(
    @Tenant() tenant: TenantContext,
    @Param('milestoneId', uuidParam()) milestoneId: string,
    @Param('reservationId', uuidParam()) reservationId: string,
    @Body(zodBody(setCheckpointAttendanceSchema)) input: SetCheckpointAttendanceInput,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<MilestoneCheckInItem> {
    return this.attendance.setAttendance(
      tenant,
      actor.userId,
      milestoneId,
      reservationId,
      input,
      this.meta(req),
    );
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
