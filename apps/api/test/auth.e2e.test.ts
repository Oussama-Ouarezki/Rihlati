import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, request, resetDatabase, type TestContext } from './helpers';

describe('authentication', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  describe('registration', () => {
    it('accepts an email OR a phone, but not neither', async () => {
      await request(ctx.http).post('/v1/auth/register')
        .send({ phone: '0551234567', password: 'a-long-enough-password', displayName: 'Amine' })
        .expect(201);

      const neither = await request(ctx.http).post('/v1/auth/register')
        .send({ password: 'a-long-enough-password', displayName: 'Personne' });

      expect(neither.status).toBe(422);
      expect(neither.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('normalizes the phone number to E.164 before storing it', async () => {
      // Every one of these is the same person. Storing them as typed would
      // make one client look like four and break every repeat-inquiry match.
      for (const [index, typed] of ['0551112233', '+213 551 11 22 33', '00213551112233'].entries()) {
        const email = `norm${index}@example.test`;
        await request(ctx.http).post('/v1/auth/register')
          .send({ email, phone: typed, password: 'a-long-enough-password', displayName: 'X Y' })
          .expect(index === 0 ? 201 : 409); // the 2nd and 3rd collide with the 1st
      }

      const stored = await ctx.prisma.user.findMany({ select: { phone: true } });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.phone).toBe('+213551112233');
    });

    it('never stores the password itself', async () => {
      const user = await registerUser(ctx, { password: 'my-secret-password-123' });

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.passwordHash).not.toContain('my-secret-password-123');
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('rejects a password shorter than 10 characters', async () => {
      const response = await request(ctx.http).post('/v1/auth/register')
        .send({ email: 'short@example.test', password: 'abc123', displayName: 'Test' });

      expect(response.status).toBe(422);
      expect(response.body.error.fields.password).toBeDefined();
    });

    it('strips fields the client is not allowed to set', async () => {
      // Mass assignment: the classic "POST isPlatformAdmin: true and become
      // an admin". The schema has no such field, so Zod drops it.
      const response = await request(ctx.http).post('/v1/auth/register')
        .send({
          email: 'sneaky@example.test',
          password: 'a-long-enough-password',
          displayName: 'Sneaky',
          isPlatformAdmin: true,
          emailVerifiedAt: new Date().toISOString(),
        })
        .expect(201);

      const row = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: response.body.user.id },
      });
      expect(row.isPlatformAdmin).toBe(false);
      expect(row.emailVerifiedAt).toBeNull();
    });
  });

  describe('login', () => {
    it('works with either the email or the phone in one field', async () => {
      await request(ctx.http).post('/v1/auth/register')
        .send({
          email: 'both@example.test',
          phone: '0555443322',
          password: 'a-long-enough-password',
          displayName: 'Both',
        })
        .expect(201);

      for (const identifier of ['both@example.test', '0555443322', '+213555443322']) {
        await request(ctx.http).post('/v1/auth/login')
          .send({ identifier, password: 'a-long-enough-password' })
          .expect(201);
      }
    });

    it('gives the same answer for a wrong password and a nonexistent account', async () => {
      await registerUser(ctx, { email: 'real@example.test', password: 'the-real-password' });

      const wrongPassword = await request(ctx.http).post('/v1/auth/login')
        .send({ identifier: 'real@example.test', password: 'not-the-password' });

      const noSuchUser = await request(ctx.http).post('/v1/auth/login')
        .send({ identifier: 'ghost@example.test', password: 'not-the-password' });

      // Identical, so this endpoint cannot be used to ask "does this address
      // have an account?" — a list with real resale value in this market.
      expect(wrongPassword.status).toBe(noSuchUser.status);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(noSuchUser.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
    });

    it('never echoes the password hash back', async () => {
      const response = await request(ctx.http).post('/v1/auth/login')
        .send({ identifier: (await registerUser(ctx)).email, password: 'correct-horse-battery-staple' })
        .expect(201);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('argon2');
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new pair and invalidates the old refresh token', async () => {
      const user = await registerUser(ctx);

      const rotated = await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(201);

      expect(rotated.body.refreshToken).not.toBe(user.refreshToken);
      expect(rotated.body.accessToken).toBeTruthy();

      // The new one works.
      await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(201);
    });

    /**
     * The interesting one.
     *
     * Presenting an already-used refresh token cannot happen in normal
     * operation — a client that rotated has thrown the old one away. So it is
     * treated as evidence of theft, and the whole family dies: the thief and
     * the real user are both logged out, and only the one who knows the
     * password can come back.
     */
    it('revokes the entire session family when a used token is presented again', async () => {
      const user = await registerUser(ctx);

      const second = await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(201);

      // Replay the first token — this is the stolen-token scenario.
      const replay = await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('TOKEN_REUSED');

      // And the legitimate current token is dead too. That is the point: we
      // cannot tell victim from thief, so both are cut off.
      const afterBreach = await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: second.body.refreshToken });

      expect(afterBreach.status).toBe(401);

      const live = await ctx.prisma.refreshToken.count({ where: { revokedAt: null } });
      expect(live).toBe(0);
    });

    it('records the detection in the audit log', async () => {
      const user = await registerUser(ctx);
      await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken }).expect(201);
      await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken }).expect(401);

      const entry = await ctx.prisma.auditLog.findFirst({
        where: { action: 'user.token_reuse_detected' },
      });
      expect(entry).not.toBeNull();
    });

    it('stores refresh tokens hashed, never in plain text', async () => {
      const user = await registerUser(ctx);

      const rows = await ctx.prisma.refreshToken.findMany({ select: { tokenHash: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).not.toBe(user.refreshToken);
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('logout', () => {
    it('kills the session it was called with', async () => {
      const user = await registerUser(ctx);

      await request(ctx.http).post('/v1/auth/logout')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ refreshToken: user.refreshToken })
        .expect(201);

      await request(ctx.http).post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });
  });

  describe('every error response', () => {
    it('carries a requestId the user can quote back to you', async () => {
      const response = await request(ctx.http).post('/v1/auth/login')
        .send({ identifier: 'nobody@example.test', password: 'wrong-password-here' });

      expect(response.body.error.requestId).toBeTruthy();
      expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
    });

    it('echoes an inbound request id so a trace spans client and server', async () => {
      const response = await request(ctx.http)
        .get('/v1/offers')
        .set('X-Request-Id', 'client-generated-id-123');

      expect(response.headers['x-request-id']).toBe('client-generated-id-123');
    });

    it('ignores a malformed inbound request id rather than logging it', async () => {
      // Otherwise a client can inject newlines and forge log lines.
      const response = await request(ctx.http)
        .get('/v1/offers')
        .set('X-Request-Id', 'bad id with spaces and \\n newline');

      expect(response.headers['x-request-id']).not.toContain(' ');
    });

    it('never leaks a stack trace or a table name', async () => {
      const response = await request(ctx.http)
        .get('/v1/agencies/not-a-uuid');

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/at .*\.ts:\d+/);
      expect(serialized).not.toContain('prisma');
      expect(serialized).not.toContain('SELECT');
    });
  });
});
