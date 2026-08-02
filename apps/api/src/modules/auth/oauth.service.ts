import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AuthResult,
  GoogleCallbackInput,
  ProviderIdentity,
  SessionMembership,
  SessionUser,
} from '@rihlati/shared';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppLogger } from '../../common/logging/logger';
import { GoogleOAuthClient } from './google-oauth.client';
import { TokenService } from './token.service';
import type { RequestMeta } from './auth.service';

/**
 * WHERE ACCOUNT-LINKING VULNERABILITIES LIVE
 *
 * Three cases, in this order, and the order is the security:
 *
 *   1. We have seen this provider subject before → log that user in.
 *   2. No link yet, but the provider's email matches an existing account AND
 *      the provider says it VERIFIED that email → link them.
 *   3. Otherwise → create a new account.
 *
 * Case 2 is the dangerous one. Linking on an *unverified* email means anyone
 * who can persuade a provider to assert `victim@gmail.com` takes over the
 * victim's Rihlati account — no password needed. That is the single most
 * common OAuth flaw, and the `emailVerified` check below is the whole defence.
 *
 * Everything keys on the provider's stable `sub`, never on the email: people
 * change email addresses, and an address can be reassigned to someone else.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleOAuthClient,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  async signInWithGoogle(input: GoogleCallbackInput, meta: RequestMeta): Promise<AuthResult> {
    const identity = await this.google.exchangeCode(input);
    return this.signInWithIdentity(identity, meta);
  }

  /** Provider-agnostic: Apple and Facebook will reuse this untouched. */
  async signInWithIdentity(identity: ProviderIdentity, meta: RequestMeta): Promise<AuthResult> {
    const existingLink = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: identity.provider,
          providerAccountId: identity.subject,
        },
      },
      select: { id: true, userId: true },
    });

    // --- case 1: known identity -------------------------------------------
    if (existingLink) {
      const user = await this.loadUser(existingLink.userId);
      if (user.disabledAt) throw new AppError('ACCOUNT_DISABLED', 'Ce compte est désactivé');

      await this.prisma.oAuthAccount.update({
        where: { id: existingLink.id },
        data: { lastLoginAt: new Date() },
      });

      return this.finish(user, identity, meta, 'user.logged_in');
    }

    // --- case 2: link to an existing account, but only if verified --------
    if (identity.email) {
      const byEmail = await this.prisma.user.findUnique({
        where: { email: identity.email },
        select: { id: true },
      });

      if (byEmail && !identity.emailVerified) {
        /**
         * The account exists but the provider will not vouch for the address.
         * Refuse rather than link — this is the takeover path.
         *
         * The message is deliberately about the provider, not about whether a
         * Rihlati account exists: "an account exists with this email" would
         * turn Google sign-in into an account-enumeration oracle.
         */
        this.logger.warn('oauth link refused: provider did not verify the email', {
          requestId: meta.requestId,
          provider: identity.provider,
        });
        throw new AppError(
          'FORBIDDEN',
          "Votre fournisseur n'a pas confirmé cette adresse email. Connectez-vous avec votre mot de passe.",
        );
      }

      if (byEmail && identity.emailVerified) {
        const user = await this.loadUser(byEmail.id);
        if (user.disabledAt) throw new AppError('ACCOUNT_DISABLED', 'Ce compte est désactivé');

        await this.prisma.$transaction(async (tx) => {
          await tx.oAuthAccount.create({
            data: {
              userId: user.id,
              provider: identity.provider,
              providerAccountId: identity.subject,
              emailAtLink: identity.email,
              lastLoginAt: new Date(),
            },
          });
          // The provider just proved control of the address, so this is also
          // the moment our own `emailVerifiedAt` becomes true.
          await tx.user.updateMany({
            where: { id: user.id, emailVerifiedAt: null },
            data: { emailVerifiedAt: new Date() },
          });
          await this.audit.record(
            {
              action: 'user.oauth_linked',
              entityType: 'user',
              entityId: user.id,
              actorUserId: user.id,
              after: { provider: identity.provider },
              ipHash: meta.ipHash ?? null,
              requestId: meta.requestId,
            },
            tx,
          );
        });

        return this.finish(user, identity, meta, 'user.logged_in');
      }
    }

    // --- case 3: brand new account ----------------------------------------
    /**
     * A new account needs a VERIFIED email, and the reason is the database:
     * `users_has_identifier` requires an email or a phone, because a user with
     * neither can never be contacted and never recover their account.
     *
     * An unverified address cannot fill that role — storing it would let it
     * squat the unique `email` column and lock out the real owner. So there is
     * nothing left to identify this person by, and the honest answer is to
     * refuse rather than create a ghost account.
     *
     * This makes one principle cover both branches:
     *   an unverified email is never enough to establish an identity.
     *
     * (Found by the CHECK constraint during testing — the alternative,
     * relaxing the constraint to allow identifier-less users, would have
     * weakened a real invariant for everyone to serve a rare case.)
     */
    if (!identity.emailVerified || !identity.email) {
      this.logger.warn('oauth signup refused: no verified email from provider', {
        requestId: meta.requestId,
        provider: identity.provider,
      });
      throw new AppError(
        'IDENTIFIER_REQUIRED',
        "Votre fournisseur n'a pas confirmé d'adresse email. Créez un compte avec un mot de passe.",
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: identity.email,
          emailVerifiedAt: new Date(),
          // No password. `passwordHash` is nullable precisely for this, and
          // login() already treats "no password" as invalid credentials, so
          // an OAuth-only account cannot be password-guessed.
          passwordHash: null,
          displayName: identity.displayName?.slice(0, 80) || 'Utilisateur',
          avatarUrl: identity.avatarUrl,
          oauthAccounts: {
            create: {
              provider: identity.provider,
              providerAccountId: identity.subject,
              emailAtLink: identity.email,
              lastLoginAt: new Date(),
            },
          },
        },
        select: USER_SELECT,
      });

      await this.audit.record(
        {
          action: 'user.registered',
          entityType: 'user',
          entityId: user.id,
          actorUserId: user.id,
          after: { via: identity.provider },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return user;
    });

    return this.finish(created, identity, meta, 'user.registered');
  }

  /** Which providers this user has linked — for "connected accounts" in the UI. */
  async linkedProviders(userId: string) {
    const rows = await this.prisma.oAuthAccount.findMany({
      where: { userId },
      select: { provider: true, emailAtLink: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      provider: row.provider,
      emailAtLink: row.emailAtLink,
      linkedAt: row.createdAt.toISOString(),
    }));
  }

  private async loadUser(userId: string): Promise<UserRow & { disabledAt: Date | null }> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ...USER_SELECT, disabledAt: true },
    });
  }

  private async finish(
    user: UserRow,
    identity: ProviderIdentity,
    meta: RequestMeta,
    action: 'user.logged_in' | 'user.registered',
  ): Promise<AuthResult> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    if (action === 'user.logged_in') {
      await this.audit.record({
        action,
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        after: { via: identity.provider },
        ipHash: meta.ipHash ?? null,
        requestId: meta.requestId,
      });
    }

    const memberships = await this.loadMemberships(user.id);

    return {
      user: toSessionUser(user, memberships),
      tokens: await this.tokens.issueNewSession(user.id, user.isPlatformAdmin, meta),
    };
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
}

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

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** Same allow-list as AuthService — built field by field, never spread. */
function toSessionUser(user: UserRow, memberships: SessionMembership[]): SessionUser {
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
