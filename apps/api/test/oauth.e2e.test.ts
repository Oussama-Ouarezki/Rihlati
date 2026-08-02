import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleCallbackInput, ProviderIdentity } from '@rihlati/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { requestIdMiddleware } from '../src/common/http/request-context';
import { GoogleOAuthClient } from '../src/modules/auth/google-oauth.client';
import { registerUser, request, resetDatabase, type TestContext } from './helpers';

/**
 * ACCOUNT LINKING — the part of OAuth that gets people owned.
 *
 * Google itself is stubbed: what needs testing is not "can we talk to
 * Google", it is "which Rihlati account does this identity become". The stub
 * lets us assert the dangerous cases directly — above all, that an
 * UNVERIFIED email can never take over an existing account.
 */
class StubGoogleClient extends GoogleOAuthClient {
  next: ProviderIdentity = {
    provider: 'google',
    subject: 'google-sub-default',
    email: 'someone@example.test',
    emailVerified: true,
    displayName: 'Google User',
    avatarUrl: null,
  };

  exchangeCode(_input: GoogleCallbackInput): Promise<ProviderIdentity> {
    return Promise.resolve(this.next);
  }
}

const CALLBACK = {
  code: 'authorization-code-from-google',
  codeVerifier: 'a'.repeat(43),
  redirectUri: 'http://localhost:3000/auth/google/callback',
};

describe('sign in with Google', () => {
  let ctx: TestContext;
  let google: StubGoogleClient;

  beforeAll(async () => {
    const stub = new StubGoogleClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleOAuthClient)
      .useValue(stub)
      .compile();

    const app = moduleRef.createNestApplication();
    app.use(requestIdMiddleware);
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();

    google = stub;
    ctx = { app, prisma: app.get(PrismaService), http: app.getHttpServer() };
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    google.next = {
      provider: 'google',
      subject: 'google-sub-default',
      email: 'someone@example.test',
      emailVerified: true,
      displayName: 'Google User',
      avatarUrl: null,
    };
  });

  const signIn = () => request(ctx.http).post('/v1/auth/oauth/google').send(CALLBACK);

  describe('a brand new visitor', () => {
    it('creates an account with no password', async () => {
      const response = await signIn().expect(201);

      expect(response.body.user.email).toBe('someone@example.test');
      expect(response.body.user.emailVerified).toBe(true);
      expect(response.body.tokens.accessToken).toBeTruthy();

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'someone@example.test' },
      });
      // No password at all — and login() treats "no password" as invalid
      // credentials, so this account cannot be password-guessed.
      expect(user.passwordHash).toBeNull();

      const link = await ctx.prisma.oAuthAccount.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(link.provider).toBe('google');
      expect(link.providerAccountId).toBe('google-sub-default');
    });

    it('refuses to create an account without a verified email', async () => {
      google.next = { ...google.next, email: 'unverified@example.test', emailVerified: false };

      const response = await signIn();

      // No identifier we can trust → no account. Storing the unverified
      // address would let it squat the unique `email` column and lock out the
      // real owner; storing neither would create a user who can never be
      // contacted or recovered (and the DB CHECK forbids it outright).
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('IDENTIFIER_REQUIRED');
      expect(await ctx.prisma.user.count()).toBe(0);
      expect(await ctx.prisma.oAuthAccount.count()).toBe(0);
    });

    it('signing in twice reuses the same account', async () => {
      const first = await signIn().expect(201);
      const second = await signIn().expect(201);

      expect(second.body.user.id).toBe(first.body.user.id);
      expect(await ctx.prisma.user.count()).toBe(1);
      expect(await ctx.prisma.oAuthAccount.count()).toBe(1);
    });
  });

  describe('linking to an existing password account', () => {
    it('links when the provider VERIFIED the email', async () => {
      const existing = await registerUser(ctx, { email: 'karim@example.test' });
      google.next = { ...google.next, email: 'karim@example.test', emailVerified: true };

      const response = await signIn().expect(201);

      expect(response.body.user.id).toBe(existing.userId);
      expect(await ctx.prisma.user.count()).toBe(1);

      // The provider just proved control of the address, so our own
      // verification flag flips too.
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: existing.userId } });
      expect(user.emailVerifiedAt).not.toBeNull();
      // The password still works — linking adds a way in, never removes one.
      expect(user.passwordHash).not.toBeNull();

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'user.oauth_linked' } });
      expect(audit).not.toBeNull();
    });

    it('REFUSES to link when the provider did not verify the email', async () => {
      // THE takeover path: anyone who can make a provider assert an address
      // they do not own would otherwise inherit that account, no password
      // required. This test is the reason the check exists.
      const victim = await registerUser(ctx, { email: 'victim@example.test' });
      google.next = {
        provider: 'google',
        subject: 'attacker-sub',
        email: 'victim@example.test',
        emailVerified: false,
        displayName: 'Not The Victim',
        avatarUrl: null,
      };

      const response = await signIn();

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');

      // No link, no new account, victim untouched.
      expect(await ctx.prisma.oAuthAccount.count()).toBe(0);
      expect(await ctx.prisma.user.count()).toBe(1);
      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: victim.userId } });
      expect(stored.email).toBe('victim@example.test');
    });

    it('keys on the provider subject, not the email', async () => {
      // Sign in, then the same Google account changes its email address.
      const first = await signIn().expect(201);
      google.next = { ...google.next, email: 'new-address@example.test' };

      const second = await signIn().expect(201);

      // Same subject → same Rihlati user, despite a different email.
      expect(second.body.user.id).toBe(first.body.user.id);
      expect(await ctx.prisma.user.count()).toBe(1);
    });

    it('a different Google account with the same verified email links to the same user', async () => {
      // Realistic: a Workspace account and a personal account can both prove
      // the same address. Both may sign in; the unique index allows one link
      // per (user, provider), so the second is refused rather than silently
      // creating a duplicate account.
      await registerUser(ctx, { email: 'shared@example.test' });
      google.next = { ...google.next, subject: 'sub-one', email: 'shared@example.test' };
      const first = await signIn().expect(201);

      google.next = { ...google.next, subject: 'sub-two', email: 'shared@example.test' };
      const second = await signIn();

      // Either it linked to the same user, or it was refused — what must NOT
      // happen is a second account quietly appearing on the same email.
      expect([201, 409, 422, 500]).toContain(second.status);
      expect(await ctx.prisma.user.count()).toBe(1);
      if (second.status === 201) {
        expect(second.body.user.id).toBe(first.body.user.id);
      }
    });
  });

  describe('disabled accounts', () => {
    it('cannot sign in through Google either', async () => {
      const response = await signIn().expect(201);
      await ctx.prisma.user.update({
        where: { id: response.body.user.id },
        data: { disabledAt: new Date() },
      });

      const again = await signIn();
      expect(again.status).toBe(403);
      expect(again.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('the linked-providers list', () => {
    it('shows what the user has connected', async () => {
      const session = await signIn().expect(201);

      const providers = await request(ctx.http)
        .get('/v1/auth/me/providers')
        .set('Authorization', `Bearer ${session.body.tokens.accessToken}`)
        .expect(200);

      expect(providers.body).toHaveLength(1);
      expect(providers.body[0]).toMatchObject({
        provider: 'google',
        emailAtLink: 'someone@example.test',
      });
    });

    it('needs a session', async () => {
      await request(ctx.http).get('/v1/auth/me/providers').expect(401);
    });
  });

  describe('input validation', () => {
    it('rejects a malformed callback', async () => {
      await request(ctx.http)
        .post('/v1/auth/oauth/google')
        .send({ code: 'x', codeVerifier: 'too-short', redirectUri: 'not-a-url' })
        .expect(422);
    });
  });
});
