import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthResult,
  LoginInput,
  RegisterInput,
  SessionMembership,
  SessionUser,
} from '@rihlati/shared';
import { normalizeAlgerianPhone } from '@rihlati/shared';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import { fakeVerifyPassword, hashPassword, verifyPassword } from '../../common/crypto/hashing';
import { TokenService } from './token.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';

export interface RequestMeta {
  requestId: string;
  userAgent?: string;
  ipHash?: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(input: RegisterInput, meta: RequestMeta): Promise<AuthResult> {
    // `email` and `phone` arrive already normalized by the Zod schema —
    // lowercased and E.164 respectively. That matters: without it, two accounts
    // could exist for "Ali@x.com" and "ali@x.com", and the unique index would
    // not stop it.
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(input.email ? [{ email: input.email }] : []),
          ...(input.phone ? [{ phone: input.phone }] : []),
        ],
      },
      select: { id: true, email: true, phone: true },
    });

    if (existing) {
      /**
       * This DOES tell an attacker that an address is registered.
       *
       * That is a deliberate trade, and the standard one: the alternative —
       * pretending to succeed and sending a "you already have an account"
       * email — needs working email delivery, which does not exist yet, and
       * leaves a user who typed their own address staring at a form that
       * silently did nothing. Signup and password-reset are already
       * enumerable through "forgot password" in almost every real product.
       *
       * Rate limiting is what actually makes bulk enumeration impractical
       * here, and it is applied to this route.
       */
      throw existing.email === input.email
        ? new AppError('EMAIL_ALREADY_USED', 'Un compte existe déjà avec cet email')
        : new AppError('PHONE_ALREADY_USED', 'Un compte existe déjà avec ce numéro');
    }

    const user = await this.prisma.user.create({
      data: {
        email: input.email ?? null,
        phone: input.phone ?? null,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
        locale: input.locale,
      },
      select: USER_SELECT,
    });

    await this.audit.record({
      action: 'user.registered',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    this.logger.info('user registered', { requestId: meta.requestId, userId: user.id });

    return {
      user: this.toSessionUser(user, []),
      tokens: await this.tokens.issueNewSession(user.id, user.isPlatformAdmin, meta),
    };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const identifier = input.identifier.trim();

    /**
     * One field for email or phone. We try to read it as a phone first, since
     * a normalized phone is unambiguous; if it does not normalize, it is
     * treated as an email.
     */
    const asPhone = normalizeAlgerianPhone(identifier);
    const where = asPhone ? { phone: asPhone } : { email: identifier.toLowerCase() };

    const user = await this.prisma.user.findUnique({
      where,
      select: { ...USER_SELECT, passwordHash: true, disabledAt: true },
    });

    /**
     * The same answer for "no such user", "no password set" and "wrong
     * password", taking the same amount of time. Anything else turns this
     * endpoint into a way to ask "does this phone number have an account?" —
     * and in a country where the phone number IS the identity, that list has
     * real resale value.
     */
    if (!user?.passwordHash) {
      await fakeVerifyPassword(input.password);
      throw new AppError('INVALID_CREDENTIALS', 'Identifiants invalides');
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      this.logger.warn('failed login', { requestId: meta.requestId, userId: user.id });
      await this.audit.record({
        action: 'user.login_failed',
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        ipHash: meta.ipHash ?? null,
        requestId: meta.requestId,
      });
      throw new AppError('INVALID_CREDENTIALS', 'Identifiants invalides');
    }

    // Checked AFTER the password, on purpose: otherwise "this account is
    // disabled" is returned to anyone who guesses the address, which reveals
    // both that it exists and that it was banned.
    if (user.disabledAt) {
      throw new AppError('ACCOUNT_DISABLED', 'Ce compte est désactivé');
    }

    const memberships = await this.loadMemberships(user.id);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      action: 'user.logged_in',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      ipHash: meta.ipHash ?? null,
      requestId: meta.requestId,
    });

    return {
      user: this.toSessionUser(user, memberships),
      tokens: await this.tokens.issueNewSession(user.id, user.isPlatformAdmin, meta),
    };
  }

  /** `GET /auth/me` — who am I, and which agencies can I act for. */
  async me(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    // The guard already proved this user exists; a miss means it was deleted
    // between the guard and here, which is a 404 either way.
    if (!user) throw new AppError('NOT_FOUND', 'Utilisateur introuvable');

    return this.toSessionUser(user, await this.loadMemberships(userId));
  }

  private async loadMemberships(userId: string): Promise<SessionMembership[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId, agency: { deletedAt: null } },
      select: {
        role: true,
        agency: { select: { id: true, slug: true, name: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      agencyId: row.agency.id,
      agencySlug: row.agency.slug,
      agencyName: row.agency.name,
      role: row.role,
      agencyStatus: row.agency.status,
    }));
  }

  /**
   * Builds the response field by field.
   *
   * Never `return { ...user }`. The day someone adds a column — a moderation
   * note, an internal score, a password reset token — spreading would ship it
   * to every client on the next deploy, silently. This function is the
   * allow-list, and it fails to compile if the shape drifts.
   */
  private toSessionUser(user: UserRow, memberships: SessionMembership[]): SessionUser {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      displayName: user.displayName,
      locale: user.locale,
      avatarUrl: user.avatarUrl,
      isPlatformAdmin: user.isPlatformAdmin,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      memberships,
    };
  }
}

/** The only columns of `users` any auth response is built from. */
const USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  displayName: true,
  locale: true,
  avatarUrl: true,
  isPlatformAdmin: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
} as const;

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  locale: string;
  avatarUrl: string | null;
  isPlatformAdmin: boolean;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
}
