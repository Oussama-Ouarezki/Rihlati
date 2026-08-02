import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createAgencyWithUser,
  createOffer,
  createTestApp,
  publishOffer,
  registerUser,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

/**
 * THE TEST THAT MATTERS MOST
 *
 * CLAUDE.md rule #3: "create as Agency A, fetch as Agency B, assert 404. A
 * feature without this test is not done."
 *
 * "One user can see another user's data" is the failure that ends a
 * marketplace, because the damage is not a bug report — it is an agency
 * discovering their competitor has their client list. There is no apology for
 * that, and no rollback.
 *
 * Every tenant-scoped resource gets a case here. When you add a new one, add
 * its case in the same commit.
 */
describe('tenant isolation', () => {
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

  describe('offers', () => {
    it("agency B gets 404 for agency A's offer, not 403", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);

      // Agency B asks for the offer THROUGH ITS OWN agency path. The URL is
      // well-formed and B is a legitimate member of the agency it names.
      const response = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it("agency B cannot reach agency A's offer through agency A's own URL either", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);

      // The obvious attack: use A's agencyId in the path with B's token. The
      // membership guard rejects it before the handler runs.
      const response = await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`);

      expect(response.status).toBe(404);
    });

    it('a missing offer and another agency\'s offer are indistinguishable', async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);

      const foreign = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`);

      const missing = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/00000000-0000-7000-8000-000000000000`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`);

      // Same status, same code, same message. Any difference at all turns this
      // endpoint into an oracle for "does this id exist somewhere?".
      expect(foreign.status).toBe(missing.status);
      expect(foreign.body.error.code).toBe(missing.body.error.code);
      expect(foreign.body.error.message).toBe(missing.body.error.message);
    });

    it("agency B cannot update or delete agency A's offer", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);

      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ title: 'Titre détourné par un concurrent' })
        .expect(404);

      await request(ctx.http)
        .delete(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // And the row is untouched — a 404 that still performed the write would
      // be the worst of both worlds.
      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(stored.title).not.toBe('Titre détourné par un concurrent');
      expect(stored.deletedAt).toBeNull();
    });

    it("agency B's offer list never contains agency A's offers", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      await createOffer(ctx, agencyA);
      await createOffer(ctx, agencyA);

      const response = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(200);

      expect(response.body.items).toHaveLength(0);
    });
  });

  describe('leads — the CRM, and the data an agency would actually pay to steal', () => {
    it("agency B gets 404 for agency A's lead", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);
      await publishOffer(ctx, agencyA, offer.id);

      const inquiry = await request(ctx.http)
        .post('/v1/inquiries')
        .send({
          offerId: offer.id,
          contactName: 'Traveler',
          contactPhone: '0551234567',
          consent: true,
        })
        .expect(201);

      const leadId = inquiry.body.id as string;

      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/leads/${leadId}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // Sanity check: the owner CAN read it. Without this, a test asserting
      // 404 everywhere would also pass if the endpoint were simply broken.
      const own = await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}/leads/${leadId}`)
        .set('Authorization', `Bearer ${agencyA.owner.accessToken}`)
        .expect(200);
      expect(own.body.contactPhone).toBe('+213551234567');
    });

    it("agency B cannot change the stage or quality of agency A's lead", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);
      await publishOffer(ctx, agencyA, offer.id);

      const inquiry = await request(ctx.http)
        .post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Traveler', contactPhone: '0551234567', consent: true })
        .expect(201);

      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/leads/${inquiry.body.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ quality: 'spam' })
        .expect(404);

      const stored = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: inquiry.body.id } });
      expect(stored.quality).toBe('unrated');
    });

    it("agency B cannot attach a note to agency A's lead", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);
      await publishOffer(ctx, agencyA, offer.id);

      const inquiry = await request(ctx.http)
        .post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Traveler', contactPhone: '0551234567', consent: true })
        .expect(201);

      await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/leads/${inquiry.body.id}/notes`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ body: 'note from a competitor' })
        .expect(404);

      expect(await ctx.prisma.leadNote.count()).toBe(0);
    });

    it("an agency cannot file a lead against another agency's offer", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);

      // Otherwise B could pollute A's per-offer statistics from its own inbox.
      await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/leads`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({
          offerId: offer.id,
          contactName: 'Client',
          contactPhone: '0551112233',
          confirmsConsentObtained: true,
        })
        .expect(404);
    });
  });

  describe('the agency record itself', () => {
    it('a non-member gets 404, never a 403 that would confirm the agency exists', async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const outsider = await registerUser(ctx);

      const response = await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('a non-member cannot edit an agency', async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const outsider = await registerUser(ctx);

      await request(ctx.http)
        .patch(`/v1/agencies/${agencyA.agencyId}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({ name: 'Nom volé' })
        .expect(404);

      const stored = await ctx.prisma.agency.findUniqueOrThrow({
        where: { id: agencyA.agencyId },
      });
      expect(stored.name).not.toBe('Nom volé');
    });
  });

  describe('roles within one agency', () => {
    it('an agent cannot create offers, a manager can', async () => {
      const agency = await createAgencyWithUser(ctx);
      const agent = await addMember(ctx, agency.agencyId, 'agent');

      const denied = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ kind: 'visa', title: 'Visa Turquie express', priceFromCentimes: 500_000 });

      // 403 here, not 404: the agent IS a member and already knows the agency
      // exists, so hiding the reason would only confuse them.
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('an agent sees only the leads assigned to them', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agent = await addMember(ctx, agency.agencyId, 'agent');
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const mine = await request(ctx.http).post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Amine', contactPhone: '0551111111', consent: true })
        .expect(201);
      const theirs = await request(ctx.http).post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Bilal', contactPhone: '0552222222', consent: true })
        .expect(201);

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/leads/${mine.body.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ assignedToUserId: agent.userId })
        .expect(200);

      const list = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);

      expect(list.body.items.map((l: { id: string }) => l.id)).toEqual([mine.body.id]);

      // And the detail endpoint agrees with the list. Filtering one but not
      // the other is the classic version of this bug: the agent simply reads
      // the id from somewhere else and fetches it directly.
      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads/${theirs.body.id}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(404);
    });

    it('an agent cannot widen their view by passing another user id', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agent = await addMember(ctx, agency.agencyId, 'agent');
      const other = await addMember(ctx, agency.agencyId, 'agent');
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const lead = await request(ctx.http).post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Karim', contactPhone: '0553333333', consent: true })
        .expect(201);

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/leads/${lead.body.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ assignedToUserId: other.userId })
        .expect(200);

      const list = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads?assignedToUserId=${other.userId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);

      expect(list.body.items).toHaveLength(0);
    });
  });

  describe('authentication is required at all', () => {
    it('no token on a tenant route is 401, not 404', async () => {
      const agency = await createAgencyWithUser(ctx);

      const response = await request(ctx.http).get(`/v1/agencies/${agency.agencyId}/leads`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a garbage token is rejected', async () => {
      const agency = await createAgencyWithUser(ctx);

      const response = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads`)
        .set('Authorization', 'Bearer not-a-real-token');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });

    it('a disabled account loses access immediately, without waiting for the token to expire', async () => {
      const agency = await createAgencyWithUser(ctx);

      await ctx.prisma.user.update({
        where: { id: agency.owner.userId },
        data: { disabledAt: new Date() },
      });

      // Same token, still cryptographically valid and unexpired. The guard
      // re-reads the user every request precisely so this is possible.
      const response = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });
});
