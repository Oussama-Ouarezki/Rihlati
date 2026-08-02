import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@rihlati/shared';
import {
  addMember,
  createAgencyWithUser,
  createOffer,
  createTestApp,
  publishOffer,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

describe('tracked links', () => {
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

  async function createLink(
    agency: Awaited<ReturnType<typeof createAgencyWithUser>>,
    body: Record<string, unknown> = {},
  ) {
    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/tracked-links`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({ label: 'post Facebook Ramadan', ...body })
      .expect(201);
    return response.body as { id: string; code: string; url: string };
  }

  describe('tenant isolation — the non-optional test', () => {
    it("agency B cannot see, rename or delete agency A's links", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const link = await createLink(agencyA);

      const list = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/tracked-links`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(200);
      expect(list.body.items).toHaveLength(0);

      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/tracked-links/${link.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ label: 'détourné' })
        .expect(404);

      await request(ctx.http)
        .delete(`/v1/agencies/${agencyB.agencyId}/tracked-links/${link.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      const stored = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { id: link.id } });
      expect(stored.label).toBe('post Facebook Ramadan');
      expect(stored.deletedAt).toBeNull();
    });

    it("an agency cannot point a link at another agency's offer", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offerA = await createOffer(ctx, agencyA);

      // Otherwise B could drive its followers to A's page and count the clicks.
      await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/tracked-links`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ label: 'lien vers le concurrent', offerId: offerA.id })
        .expect(404);
    });

    it('an agent cannot create links (403), no token is 401', async () => {
      const agency = await createAgencyWithUser(ctx);
      const agent = await addMember(ctx, agency.agencyId, 'agent');

      const denied = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/tracked-links`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ label: 'tentative' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');

      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/tracked-links`)
        .expect(401);
    });
  });

  describe('the click → client chain', () => {
    it('counts the click, carries the ref, and attributes the inquiry', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);
      const link = await createLink(agency, { offerId: offer.id });

      // 1. Someone taps the link in a Facebook post.
      const resolved = await request(ctx.http)
        .post('/v1/tracked-links/resolve')
        .send({ code: link.code })
        .expect(201);

      // It points at the offer page and carries the ref through.
      expect(resolved.body.url).toContain(`/offres/${offer.slug}`);
      expect(resolved.body.url).toContain(`ref=${link.code}`);

      // 2. They submit the inquiry form, which passes the ref back.
      await request(ctx.http)
        .post('/v1/inquiries')
        .send({
          offerId: offer.id,
          contactName: 'Amine Bouzid',
          contactPhone: '0551239900',
          ref: link.code,
          consent: true,
        })
        .expect(201);

      // 3. The agency sees both numbers, and the lead names its source.
      const list = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/tracked-links`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(list.body.items[0]).toMatchObject({
        clickCount: 1,
        inquiryCount: 1,
        conversionRate: 1,
        label: 'post Facebook Ramadan',
      });

      const leads = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/leads`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(leads.body.items[0].sourceLabel).toBe('post Facebook Ramadan');
    });

    it("ignores a foreign agency's ref instead of mis-attributing", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offerA = await createOffer(ctx, agencyA);
      await publishOffer(ctx, agencyA, offerA.id);
      const linkB = await createLink(agencyB);

      // B's code on A's inquiry: the lead is created, attribution dropped.
      await request(ctx.http)
        .post('/v1/inquiries')
        .send({
          offerId: offerA.id,
          contactName: 'Traveler',
          contactPhone: '0551239901',
          ref: linkB.code,
          consent: true,
        })
        .expect(201);

      const stored = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { id: linkB.id } });
      expect(stored.inquiryCount).toBe(0);

      const lead = await ctx.prisma.lead.findFirstOrThrow({ where: { agencyId: agencyA.agencyId } });
      expect(lead.trackedLinkId).toBeNull();
    });

    it('a garbage ref never costs the agency the inquiry', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      await request(ctx.http)
        .post('/v1/inquiries')
        .send({
          offerId: offer.id,
          contactName: 'Traveler',
          contactPhone: '0551239902',
          ref: 'nexistepas',
          consent: true,
        })
        .expect(201);

      expect(await ctx.prisma.lead.count()).toBe(1);
    });

    it('a retired or unknown code lands on the home page, never a dead end', async () => {
      const agency = await createAgencyWithUser(ctx);
      const link = await createLink(agency);

      await request(ctx.http)
        .delete(`/v1/agencies/${agency.agencyId}/tracked-links/${link.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      // The link is printed in someone's post forever; a 404 there is a lost
      // customer, so a dead code still reaches the marketplace.
      const dead = await request(ctx.http)
        .post('/v1/tracked-links/resolve')
        .send({ code: link.code })
        .expect(201);
      expect(dead.body.url).not.toContain('ref=');

      const unknown = await request(ctx.http)
        .post('/v1/tracked-links/resolve')
        .send({ code: 'zzzzzzzz' })
        .expect(201);
      expect(unknown.body.url).toBeTruthy();
    });

    it('an agency-wide link points at the filtered catalogue', async () => {
      const agency = await createAgencyWithUser(ctx);
      const link = await createLink(agency, { label: 'bio Instagram' });

      const resolved = await request(ctx.http)
        .post('/v1/tracked-links/resolve')
        .send({ code: link.code })
        .expect(201);

      expect(resolved.body.url).toContain(`agency=${agency.slug}`);
      expect(resolved.body.url).toContain(`ref=${link.code}`);
    });
  });

  describe('plan limits', () => {
    it('a free agency stops at its link cap, with upsell details', async () => {
      const limit = PLAN_LIMITS.free.maxTrackedLinks!;
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });

      for (let i = 0; i < limit; i += 1) {
        await createLink(agency, { label: `campagne ${i}` });
      }

      const refused = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/tracked-links`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ label: 'une de trop' });

      expect(refused.status).toBe(402);
      expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      expect(refused.body.error.details).toMatchObject({ limit, current: limit, plan: 'free' });
    });

    it('deleting a link frees a slot', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });
      const first = await createLink(agency, { label: 'campagne A' });
      await createLink(agency, { label: 'campagne B' });

      await request(ctx.http)
        .delete(`/v1/agencies/${agency.agencyId}/tracked-links/${first.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      await createLink(agency, { label: 'campagne C' });
    });
  });

  it('conversionRate is null before the first click, not zero', async () => {
    const agency = await createAgencyWithUser(ctx);
    await createLink(agency);

    const list = await request(ctx.http)
      .get(`/v1/agencies/${agency.agencyId}/tracked-links`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .expect(200);

    // 0% on a brand-new link would make it look like a failure.
    expect(list.body.items[0].conversionRate).toBeNull();
  });
});
