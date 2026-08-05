import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createAgencyWithUser,
  createPlatformAdmin,
  createTestApp,
  makePlatformAdmin,
  registerUser,
  request,
  resetDatabase,
  type TestAgency,
  type TestContext,
} from './helpers';

/**
 * THE MOST DANGEROUS ENDPOINTS IN THE CODEBASE.
 *
 * Every other suite asks "can agency B reach agency A's row?" — and the answer
 * is enforced by `agencyId` sitting in a `where` clause. These endpoints have
 * no `agencyId` to scope by: they are meant to read every agency on the
 * platform. The only thing separating a logged-in traveler from every
 * agency's RC, NIF and owner's phone number is one boolean check.
 *
 * So the isolation test here is not "another tenant gets 404". It is
 * "everyone who is not staff gets shut out", tested from every direction a
 * real caller can come from: no token, a traveler, an agency owner, and an
 * agency owner who is a member of the very agency in the queue.
 */
describe('admin — agency verification queue', () => {
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

  /** An agency sitting in the queue, put there through the real endpoint. */
  async function pendingAgency(): Promise<TestAgency> {
    const agency = await createAgencyWithUser(ctx, { verified: false });
    await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/submit-for-review`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .expect(201);
    return agency;
  }

  const CHECKED = 'RC et agrément lus, adresse cohérente avec la wilaya, téléphone répondu.';

  // -------------------------------------------------------------------------

  describe('who is shut out', () => {
    it('rejects an anonymous caller with 401', async () => {
      await request(ctx.http).get('/v1/admin/agencies').expect(401);
    });

    it('rejects an ordinary logged-in user with 403', async () => {
      const traveler = await registerUser(ctx);

      const response = await request(ctx.http)
        .get('/v1/admin/agencies')
        .set('Authorization', `Bearer ${traveler.accessToken}`)
        .expect(403);

      expect(response.body.error.code).toBe('PLATFORM_ADMIN_ONLY');
    });

    it('rejects an agency owner — owning an agency is not being staff', async () => {
      const agency = await pendingAgency();

      await request(ctx.http)
        .get('/v1/admin/agencies')
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(403);

      // And they cannot verify themselves, which is the whole ballgame.
      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(403);

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agency.agencyId },
      });
      expect(stored.status).toBe('pending_review');
      expect(stored.verifiedByUserId).toBeNull();
    });

    it('rejects a manager of another agency', async () => {
      const other = await createAgencyWithUser(ctx);
      const manager = await addMember(ctx, other.agencyId, 'manager');

      await request(ctx.http)
        .post(`/v1/admin/agencies/${other.agencyId}/reject`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ reason: 'Documents illisibles, merci de renvoyer un scan net.' })
        .expect(403);
    });

    /**
     * Demotion has to bite immediately. `JwtAuthGuard` reads `isPlatformAdmin`
     * from the database on every request rather than from the token's `adm`
     * claim, and this is the test that proves it — with a token claim, a
     * removed admin would keep full cross-tenant read access until it expired.
     */
    it('shuts out a demoted admin holding a still-valid token', async () => {
      const admin = await createPlatformAdmin(ctx);
      await request(ctx.http)
        .get('/v1/admin/agencies')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      await ctx.prisma.user.update({
        where: { id: admin.userId },
        data: { isPlatformAdmin: false },
      });

      await request(ctx.http)
        .get('/v1/admin/agencies')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('the queue', () => {
    it('lists agencies awaiting review, oldest first, with what a reviewer needs', async () => {
      const first = await pendingAgency();
      const second = await pendingAgency();
      // A draft that never asked, and a verified one: neither belongs in the queue.
      await createAgencyWithUser(ctx, { verified: false });
      await createAgencyWithUser(ctx);
      const admin = await createPlatformAdmin(ctx);

      const response = await request(ctx.http)
        .get('/v1/admin/agencies')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
        first.agencyId,
        second.agencyId,
      ]);

      const [row] = response.body.items;
      expect(row.registreCommerce).toBe('16/00-1234567B25');
      expect(row.nif).toBe('000216001234567');
      expect(row.submittedForReviewAt).not.toBeNull();
      // The person legally answerable — the review is partly "ring them".
      expect(row.owner.userId).toBe(first.owner.userId);
      expect(row.owner.email).toBe(first.owner.email);
    });

    it('filters by status and paginates', async () => {
      await pendingAgency();
      await pendingAgency();
      const verified = await createAgencyWithUser(ctx);
      const admin = await createPlatformAdmin(ctx);

      const page = await request(ctx.http)
        .get('/v1/admin/agencies?limit=1')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).not.toBeNull();

      const verifiedPage = await request(ctx.http)
        .get('/v1/admin/agencies?status=verified')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(verifiedPage.body.items.map((i: { id: string }) => i.id)).toEqual([verified.agencyId]);
    });
  });

  // -------------------------------------------------------------------------

  describe('verifying', () => {
    it('grants the badge and records who granted it', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(201);

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agency.agencyId },
      });
      expect(stored.status).toBe('verified');
      expect(stored.verifiedAt).not.toBeNull();
      // The point of the whole slice: the badge is attributable to a person.
      expect(stored.verifiedByUserId).toBe(admin.userId);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'agency.verified', entityId: agency.agencyId },
      });
      expect(entry.actorUserId).toBe(admin.userId);
      expect(entry.after).toMatchObject({ checkedNote: CHECKED });
    });

    it('refuses without a note saying what was checked', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: 'ok' })
        .expect(422);

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agency.agencyId },
      });
      expect(stored.status).toBe('pending_review');
    });

    it('refuses an agency that never asked to be reviewed', async () => {
      const draft = await createAgencyWithUser(ctx, { verified: false });
      const admin = await createPlatformAdmin(ctx);

      const response = await request(ctx.http)
        .post(`/v1/admin/agencies/${draft.agencyId}/verify`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(409);

      expect(response.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('refuses a second decision on an agency already handled', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);
      const url = `/v1/admin/agencies/${agency.agencyId}/verify`;

      await request(ctx.http).post(url)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(201);

      await request(ctx.http).post(url)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(409);
    });

    /**
     * An admin who also owns an agency must not sign off on it. Not because we
     * expect staff to cheat — because a badge granted by its own owner is
     * worthless as evidence afterwards, which is the only thing the badge is
     * for.
     */
    it('refuses to let an admin verify an agency they belong to', async () => {
      const agency = await pendingAgency();
      await makePlatformAdmin(ctx, agency.owner.userId);

      const response = await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(403);

      expect(response.body.error.details.reason).toBe('self_review');

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agency.agencyId },
      });
      expect(stored.status).toBe('pending_review');
    });

    it('404s on an agency that does not exist', async () => {
      const admin = await createPlatformAdmin(ctx);

      await request(ctx.http)
        .post('/v1/admin/agencies/0193f0a0-0000-7000-8000-000000000000/verify')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('rejecting', () => {
    it('records the reason and shows it to the owner, but keeps the note private', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);
      const reason = "L'agrément fourni a expiré en 2024. Envoyez le renouvellement.";

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/reject`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason, internalNote: 'Deuxième tentative, surveiller.' })
        .expect(201);

      // What the owner sees on /console/agence.
      const asOwner = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(asOwner.body.status).toBe('rejected');
      expect(asOwner.body.rejectionReason).toBe(reason);
      // The private note must not travel with it, in any field.
      expect(JSON.stringify(asOwner.body)).not.toContain('surveiller');

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'agency.rejected', entityId: agency.agencyId },
      });
      expect(entry.after).toMatchObject({ internalNote: 'Deuxième tentative, surveiller.' });
    });

    it('refuses a rejection with no usable reason', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/reject`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'non' })
        .expect(422);
    });

    /**
     * A rejected agency fixes its paperwork and asks again. The second review
     * must start clean — an old refusal still showing in the banner after a
     * fresh approval would be its own support ticket.
     */
    it('lets a rejected agency resubmit, and clears the banner on approval', async () => {
      const agency = await pendingAgency();
      const admin = await createPlatformAdmin(ctx);

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/reject`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'Le NIF ne correspond pas au registre de commerce fourni.' })
        .expect(201);

      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/submit-for-review`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(201);

      await request(ctx.http)
        .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ checkedNote: CHECKED })
        .expect(201);

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agency.agencyId },
      });
      expect(stored.status).toBe('verified');
      expect(stored.rejectionReason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  /**
   * Verification is what makes an agency visible to travelers, so the two ends
   * of the slice are worth joining up once: nobody could find this agency
   * before the decision, and anybody can after it.
   */
  it('is what puts an agency in front of travelers', async () => {
    const agency = await pendingAgency();
    const admin = await createPlatformAdmin(ctx);

    await request(ctx.http).get(`/v1/agencies/by-slug/${agency.slug}`).expect(404);

    await request(ctx.http)
      .post(`/v1/admin/agencies/${agency.agencyId}/verify`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ checkedNote: CHECKED })
      .expect(201);

    const publicView = await request(ctx.http)
      .get(`/v1/agencies/by-slug/${agency.slug}`)
      .expect(200);

    expect(publicView.body.isVerified).toBe(true);
    // The legal identifiers stay internal even once the agency is public.
    expect(publicView.body.registreCommerce).toBeUndefined();
    expect(publicView.body.nif).toBeUndefined();
  });
});
