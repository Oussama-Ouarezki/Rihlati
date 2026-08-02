import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthTokens } from '@rihlati/shared';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../../common/crypto/hashing';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * TOKENS: WHY TWO OF THEM
 *
 * The access token is a signed JWT, valid ~15 minutes, sent on every request.
 * It is checked with maths alone — no database lookup — which is what makes it
 * fast. The cost of that speed is that it cannot be cancelled: once issued, it
 * works until it expires. That is the entire reason it is short-lived.
 *
 * The refresh token is a long random string, valid 30 days, sent only to
 * `/auth/refresh`. It lives in the database, so it CAN be cancelled instantly.
 *
 * ROTATION AND FAMILIES — the part that is genuinely clever
 *
 * Every refresh consumes the old token and issues a new one. So a refresh token
 * is single-use. All tokens descended from one login share a `familyId`.
 *
 * Now suppose someone steals a refresh token. Two things can happen:
 *   - the thief uses it first. The real user's next refresh presents a token
 *     that is already revoked.
 *   - the real user uses it first. The thief presents an already-revoked token.
 *
 * Either way, a REVOKED token gets presented — and that never happens in
 * normal use. So it is treated as proof of theft: the whole family is revoked
 * and both parties are logged out. The user re-enters their password (which
 * the thief does not have) and the thief is locked out.
 *
 * Without rotation, a stolen refresh token is 30 days of silent access with
 * nothing anywhere indicating anything is wrong.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** First tokens after a successful password login: starts a new family. */
  async issueNewSession(
    userId: string,
    isPlatformAdmin: boolean,
    meta: { userAgent?: string; ipHash?: string | null },
  ): Promise<AuthTokens> {
    return this.issue(userId, isPlatformAdmin, randomUUID(), meta);
  }

  /**
   * Swap a refresh token for a fresh pair.
   *
   * Everything here happens in one transaction: revoking the old token and
   * creating the new one must both succeed, or a crash between them would log
   * the user out and lose the family.
   */
  async rotate(
    presentedToken: string,
    meta: { userAgent?: string; ipHash?: string | null; requestId?: string },
  ): Promise<AuthTokens> {
    const presentedHash = hashToken(presentedToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: presentedHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { disabledAt: true, isPlatformAdmin: true } },
      },
    });

    // Never issued by us, or the database was wiped. Nothing to reason about.
    if (!stored) throw new AppError('TOKEN_INVALID', 'Token de rafraîchissement invalide');

    if (stored.revokedAt) {
      /**
       * A revoked token was presented. In normal operation this cannot happen:
       * a client that just rotated has thrown the old one away. So either it
       * was stolen, or the legitimate user's client is retrying — and we
       * cannot tell which, so we assume the worse case.
       *
       * Revoke the entire family. Both the thief and the user are logged out;
       * the user recovers with their password, the thief cannot.
       */
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      this.logger.warn('refresh token reuse detected — family revoked', {
        requestId: meta.requestId,
        userId: stored.userId,
        familyId: stored.familyId,
      });

      await this.audit.record({
        action: 'user.token_reuse_detected',
        entityType: 'user',
        entityId: stored.userId,
        actorUserId: stored.userId,
        after: { familyId: stored.familyId },
        ipHash: meta.ipHash ?? null,
        requestId: meta.requestId ?? null,
      });

      throw new AppError('TOKEN_REUSED', 'Session invalidée pour raison de sécurité');
    }

    if (stored.expiresAt <= new Date()) {
      throw new AppError('TOKEN_EXPIRED', 'Session expirée, reconnectez-vous');
    }

    if (stored.user.disabledAt) {
      throw new AppError('ACCOUNT_DISABLED', 'Ce compte est désactivé');
    }

    const refreshToken = generateOpaqueToken();

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: hashToken(refreshToken),
          // Same family: this is a continuation of the original login, and
          // that is what makes reuse detectable across the whole chain.
          familyId: stored.familyId,
          expiresAt: this.refreshExpiry(),
          userAgent: meta.userAgent ?? null,
          ipHash: meta.ipHash ?? null,
        },
      }),
    ]);

    return {
      accessToken: await this.signAccessToken(
        stored.userId,
        stored.familyId,
        stored.user.isPlatformAdmin,
      ),
      refreshToken,
      expiresIn: this.accessTtlSeconds(),
      tokenType: 'Bearer',
    };
  }

  /** Log out. `allDevices` revokes every family, not just this one. */
  async revoke(
    userId: string,
    options: { refreshToken?: string; familyId?: string; allDevices: boolean },
  ): Promise<void> {
    const now = new Date();

    if (options.allDevices) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return;
    }

    if (options.refreshToken) {
      // Scoped by userId as well as by hash: without it, anyone holding any
      // token string could revoke a session belonging to somebody else.
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash: hashToken(options.refreshToken), revokedAt: null },
        data: { revokedAt: now },
      });
      return;
    }

    if (options.familyId) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, familyId: options.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
  }

  private async issue(
    userId: string,
    isPlatformAdmin: boolean,
    familyId: string,
    meta: { userAgent?: string; ipHash?: string | null },
  ): Promise<AuthTokens> {
    const refreshToken = generateOpaqueToken();

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: this.refreshExpiry(),
        userAgent: meta.userAgent ?? null,
        ipHash: meta.ipHash ?? null,
      },
    });

    return {
      accessToken: await this.signAccessToken(userId, familyId, isPlatformAdmin),
      refreshToken,
      expiresIn: this.accessTtlSeconds(),
      tokenType: 'Bearer',
    };
  }

  /**
   * The payload is deliberately tiny: user id, family id, admin flag.
   *
   * No email, no name, no agency, no role. A JWT is signed, not encrypted —
   * anyone holding it can read every claim in it. And every claim is a snapshot
   * that goes stale the moment the database changes.
   */
  private signAccessToken(userId: string, familyId: string, isPlatformAdmin: boolean): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, fam: familyId, adm: isPlatformAdmin },
      // Seconds, not "15m". `parseDuration` is already the one place that
      // reads the config string, so the JWT library never sees two formats.
      { secret: this.config.JWT_ACCESS_SECRET, expiresIn: this.accessTtlSeconds() },
    );
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + parseDuration(this.config.JWT_REFRESH_TTL) * 1000);
  }

  private accessTtlSeconds(): number {
    return parseDuration(this.config.JWT_ACCESS_TTL);
  }
}

/** "15m" -> 900. Supports s/m/h/d, which is all the config needs. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Durée invalide: "${value}". Attendu par ex. "15m", "30d".`);
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
  return amount * multiplier;
}
