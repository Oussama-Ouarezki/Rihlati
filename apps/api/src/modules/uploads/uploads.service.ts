import { Injectable } from '@nestjs/common';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';
import { AVATAR_VARIANT, ImageService, LOGO_VARIANT } from './image.service';

export interface UploadedImage {
  buffer: Buffer;
  size: number;
}

/**
 * PICTURES ARE UPLOADED AS BYTES, NEVER AS A URL
 *
 * There is no `PATCH { avatarUrl }` anywhere in this API, and that absence is
 * deliberate. If a client could name the URL, it could point a profile picture
 * at a server it controls — every page rendering that avatar becomes a request
 * to a stranger's log, which is a tracking beacon on our users, and the picture
 * can be swapped for something else after moderation has looked at it.
 *
 * So the client sends bytes, and the server picks the name.
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImageService,
    private readonly audit: AuditService,
  ) {}

  /** Replace the caller's own profile picture. The id comes from the token. */
  async setAvatar(
    userId: string,
    file: UploadedImage | undefined,
    meta: RequestMeta,
  ): Promise<{ avatarUrl: string }> {
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    if (!before) throw notFound('Utilisateur');

    // Store the new file FIRST. If this throws, the old picture is still
    // there — the opposite order leaves the user with no picture and an error.
    const { url } = await this.images.storeImage(file, AVATAR_VARIANT);

    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: url } });
    await this.images.removeByUrl(before.avatarUrl);

    await this.audit.record({
      action: 'user.avatar_changed',
      entityType: 'user',
      entityId: userId,
      agencyId: null,
      actorUserId: userId,
      after: { hasAvatar: true },
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { avatarUrl: url };
  }

  async removeAvatar(userId: string, meta: RequestMeta): Promise<{ avatarUrl: null }> {
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    if (!before) throw notFound('Utilisateur');

    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    await this.images.removeByUrl(before.avatarUrl);

    await this.audit.record({
      action: 'user.avatar_changed',
      entityType: 'user',
      entityId: userId,
      agencyId: null,
      actorUserId: userId,
      after: { hasAvatar: false },
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { avatarUrl: null };
  }

  /**
   * Replace an agency's logo.
   *
   * Scoped by `tenant.agencyId` — the membership guard proved it, so this is
   * never the raw `:agencyId` from the URL. `findFirst` with the tenant in the
   * `where`, not `findUnique` by id, is the rule (CLAUDE.md #3).
   */
  async setAgencyLogo(
    tenant: TenantContext,
    userId: string,
    file: UploadedImage | undefined,
    meta: RequestMeta,
  ): Promise<{ logoUrl: string }> {
    const before = await this.prisma.agency.findFirst({
      where: { id: tenant.agencyId, deletedAt: null },
      select: { logoUrl: true },
    });
    if (!before) throw notFound('Agence');

    const { url } = await this.images.storeImage(file, LOGO_VARIANT);

    await this.prisma.agency.updateMany({
      where: { id: tenant.agencyId, deletedAt: null },
      data: { logoUrl: url },
    });
    await this.images.removeByUrl(before.logoUrl);

    await this.audit.record({
      action: 'agency.logo_changed',
      entityType: 'agency',
      entityId: tenant.agencyId,
      agencyId: tenant.agencyId,
      actorUserId: userId,
      before: { hasLogo: before.logoUrl !== null },
      after: { hasLogo: true },
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { logoUrl: url };
  }

  async removeAgencyLogo(
    tenant: TenantContext,
    userId: string,
    meta: RequestMeta,
  ): Promise<{ logoUrl: null }> {
    const before = await this.prisma.agency.findFirst({
      where: { id: tenant.agencyId, deletedAt: null },
      select: { logoUrl: true },
    });
    if (!before) throw notFound('Agence');

    await this.prisma.agency.updateMany({
      where: { id: tenant.agencyId, deletedAt: null },
      data: { logoUrl: null },
    });
    await this.images.removeByUrl(before.logoUrl);

    await this.audit.record({
      action: 'agency.logo_changed',
      entityType: 'agency',
      entityId: tenant.agencyId,
      agencyId: tenant.agencyId,
      actorUserId: userId,
      before: { hasLogo: before.logoUrl !== null },
      after: { hasLogo: false },
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return { logoUrl: null };
  }
}

/**
 * Multer rejects an oversized file with its own error long before our handler
 * runs. Translating it here keeps the client's contract intact: every failure
 * is still `{ error: { code, message } }` with a typed code (rule #4).
 */
export function translateMulterError(error: { code?: string }): AppError {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return new AppError('VALIDATION_FAILED', 'Fichier trop volumineux', {
      fields: { file: ['validation.imageTooLarge'] },
    });
  }
  return new AppError('VALIDATION_FAILED', 'Envoi de fichier invalide', {
    fields: { file: ['validation.fileInvalid'] },
  });
}
