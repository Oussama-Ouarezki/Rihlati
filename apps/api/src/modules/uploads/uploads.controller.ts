import { Controller, Delete, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, RequireAgencyRole, Tenant } from '../../common/auth/auth.decorators';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { AuthenticatedActor } from '../../common/http/request-context';
import { clientIp, userAgent } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { RequestMeta } from '../auth/auth.service';
import { MAX_UPLOAD_BYTES } from './image.service';
import { UploadsService, type UploadedImage } from './uploads.service';

/**
 * `memoryStorage`, not multer's default disk storage.
 *
 * Disk storage writes the client's bytes to a temp file *before* anything has
 * checked what they are, and cleaning those up on every error path is a leak
 * waiting to happen. Held in memory the buffer is bounded by `fileSize` and
 * disappears when the request ends. It is only ever written to storage after
 * `ImageService` has decoded and re-encoded it.
 *
 * `files: 1` matters as much as the size cap: without it, one request can carry
 * a thousand 5 MB parts.
 */
const singleImage = (): MethodDecorator =>
  UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
    }),
  );

/** No prefix here: `setGlobalPrefix('v1')` in `main.ts` already adds it. */
@Controller()
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Your own profile picture. No `:userId` in the path — the id comes from the
   * access token, so there is nothing here to tamper with.
   *
   * Rate limited because this is the most expensive endpoint in the API: each
   * call decodes and re-encodes an image, which is CPU a stranger should not be
   * able to buy 100 of per second.
   */
  @Throttle({ upload: { limit: 20, ttl: 3_600_000 } })
  @singleImage()
  @Post('auth/me/avatar')
  setAvatar(
    @CurrentUser() actor: AuthenticatedActor,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<{ avatarUrl: string }> {
    return this.uploads.setAvatar(actor.userId, file, this.meta(req));
  }

  @Delete('auth/me/avatar')
  removeAvatar(
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ avatarUrl: null }> {
    return this.uploads.removeAvatar(actor.userId, this.meta(req));
  }

  /**
   * The agency logo. `:agencyId` in the path is what switches the membership
   * guard on — a non-member gets 404 before this method runs.
   *
   * `manager` and above: a logo is the agency's public face, and swapping it is
   * the cheapest way to embarrass a business. An `agent` handles clients.
   */
  @Throttle({ upload: { limit: 20, ttl: 3_600_000 } })
  @RequireAgencyRole('manager')
  @singleImage()
  @Post('agencies/:agencyId/logo')
  setAgencyLogo(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<{ logoUrl: string }> {
    return this.uploads.setAgencyLogo(tenant, actor.userId, file, this.meta(req));
  }

  @RequireAgencyRole('manager')
  @Delete('agencies/:agencyId/logo')
  removeAgencyLogo(
    @Tenant() tenant: TenantContext,
    @CurrentUser() actor: AuthenticatedActor,
    @Req() req: Request,
  ): Promise<{ logoUrl: null }> {
    return this.uploads.removeAgencyLogo(tenant, actor.userId, this.meta(req));
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
