import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { IS_PUBLIC_KEY, PLATFORM_ADMIN_KEY } from './auth.decorators';

/**
 * The claims we put in an access token, and the ONLY claims we trust from it.
 *
 * Parsed with Zod rather than cast: a JWT's signature proves we issued it, not
 * that its contents still match what this version of the code expects. A token
 * issued before a field was renamed is signed and valid and wrong.
 */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  fam: z.string().uuid(),
  adm: z.boolean().default(false),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/**
 * GLOBAL AUTH GUARD — registered in AppModule, runs on every request.
 *
 * Deny by default: no `@Public()` means a valid access token is required.
 *
 * Note the freshness check at the bottom. The token says who you are; the
 * database says whether that account is still allowed to exist. Without it,
 * disabling an abusive account would take up to 15 minutes to bite.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const isPublic = this.readFlag(context, IS_PUBLIC_KEY);
    const token = this.extractToken(req);

    if (!token) {
      if (isPublic) return true;
      throw new AppError('UNAUTHENTICATED', 'Authentification requise');
    }

    let claims: AccessTokenClaims;
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.JWT_ACCESS_SECRET,
      });
      claims = accessTokenClaimsSchema.parse(payload);
    } catch (error) {
      // On a public route, an unreadable token is simply "not logged in" —
      // an expired token must not break browsing the marketplace.
      if (isPublic) return true;
      if (error instanceof TokenExpiredError) {
        throw new AppError('TOKEN_EXPIRED', 'Session expirée');
      }
      throw new AppError('TOKEN_INVALID', 'Token invalide');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, disabledAt: true, isPlatformAdmin: true },
    });

    if (!user || user.disabledAt) {
      if (isPublic) return true;
      throw new AppError('ACCOUNT_DISABLED', 'Ce compte est désactivé');
    }

    req.auth = {
      userId: user.id,
      // From the DATABASE, not from the token's `adm` claim. Promotion and
      // demotion must take effect now, and a stale claim must never grant it.
      isPlatformAdmin: user.isPlatformAdmin,
      sessionFamilyId: claims.fam,
    };

    if (this.readFlag(context, PLATFORM_ADMIN_KEY) && !user.isPlatformAdmin) {
      throw new AppError('PLATFORM_ADMIN_ONLY', 'Réservé aux administrateurs');
    }

    return true;
  }

  /** Method-level metadata wins over controller-level. */
  private readFlag(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  private extractToken(req: Request): string | null {
    const header = req.header('authorization');
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
    return value.trim() || null;
  }
}
