import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgencyWithUser,
  createOffer,
  createTestApp,
  publishOffer,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

describe('offer analytics', () => {
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

  describe('collection', () => {
    it('counts public page views into the daily series', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      await request(ctx.http).get(`/v1/offers/by-slug/${offer.slug}`).expect(200);
      await request(ctx.http).get(`/v1/offers/by-slug/${offer.slug}`).expect(200);

      const analytics = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers?days=7`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(analytics.body.totals.views).toBe(2);
      // Zero-filled: exactly 7 points, and today's carries the views.
      expect(analytics.body.series).toHaveLength(7);
      expect(analytics.body.series[6].views).toBe(2);
    });

    it('counts WhatsApp and phone taps via the public beacon', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      await request(ctx.http)
        .post(`/v1/offers/${offer.id}/events`)
        .send({ type: 'whatsapp_click' })
        .expect(201);
      await request(ctx.http)
        .post(`/v1/offers/${offer.id}/events`)
        .send({ type: 'phone_click' })
        .expect(201);

      const analytics = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(analytics.body.totals.whatsappClicks).toBe(1);
      expect(analytics.body.totals.phoneClicks).toBe(1);
    });

    it('rejects garbage event types and drafts', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const draft = await createOffer(ctx, agency); // never published

      await request(ctx.http)
        .post(`/v1/offers/${draft.id}/events`)
        .send({ type: 'whatsapp_click' })
        .expect(404); // the beacon must not confirm a draft exists

      const published = await createOffer(ctx, agency, { title: 'Omra publiee pour beacon' });
      await publishOffer(ctx, agency, published.id);
      await request(ctx.http)
        .post(`/v1/offers/${published.id}/events`)
        .send({ type: 'made_up_event' })
        .expect(422);
    });

    it('one inquiry = one tick, even when the traveler double-submits', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const inquiry = {
        offerId: offer.id,
        contactName: 'Traveler',
        contactPhone: '0551234567',
        consent: true,
      };
      await request(ctx.http).post('/v1/inquiries').send(inquiry).expect(201);
      // Same person, same offer, within the 6-hour dedupe window: still one
      // lead in the inbox, so it must be one inquiry on the chart.
      await request(ctx.http).post('/v1/inquiries').send(inquiry).expect(201);

      const analytics = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(analytics.body.totals.inquiries).toBe(1);
      expect(await ctx.prisma.lead.count()).toBe(1);
    });

    it('collects for FREE agencies too — history exists before the upgrade', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      await request(ctx.http).get(`/v1/offers/by-slug/${offer.slug}`).expect(200);

      // The dashboard says pay up…
      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(402);

      // …but the data accrued anyway. Upgrade day starts with a full chart.
      const row = await ctx.prisma.offerMetricDaily.findFirst({
        where: { agencyId: agency.agencyId },
      });
      expect(row?.views).toBe(1);
    });
  });

  describe('the dashboard read', () => {
    it('is plan-gated with a typed error the UI can upsell from', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });

      const response = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`);

      expect(response.status).toBe(402);
      expect(response.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      expect(response.body.error.details).toMatchObject({ feature: 'analytics' });
    });

    it("agency B never sees agency A's numbers", async () => {
      const agencyA = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agencyB = await createAgencyWithUser(ctx, { plan: 'pro' });
      const offer = await createOffer(ctx, agencyA);
      await publishOffer(ctx, agencyA, offer.id);
      await request(ctx.http).get(`/v1/offers/by-slug/${offer.slug}`).expect(200);

      // Through A's path with B's token: the membership guard 404s.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // Through B's own path: B's numbers are zero, not A's.
      const own = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/analytics/offers`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(200);
      expect(own.body.totals.views).toBe(0);

      // And filtering by A's offerId from B's path is a 404, not a leak.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/analytics/offers?offerId=${offer.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);
    });

    it('narrows to one offer with ?offerId=', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const first = await createOffer(ctx, agency, { title: 'Omra premiere pour filtre' });
      const second = await createOffer(ctx, agency, { title: 'Omra seconde pour filtre' });
      await publishOffer(ctx, agency, first.id);
      await publishOffer(ctx, agency, second.id);

      const firstSlug = (await ctx.prisma.offer.findUniqueOrThrow({
        where: { id: first.id }, select: { slug: true },
      })).slug;
      await request(ctx.http).get(`/v1/offers/by-slug/${firstSlug}`).expect(200);

      const narrowed = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/analytics/offers?offerId=${second.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(narrowed.body.totals.views).toBe(0);
      expect(narrowed.body.topOffers).toHaveLength(0);
    });
  });
});
