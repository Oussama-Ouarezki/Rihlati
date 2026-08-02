import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@rihlati/shared';
import {
  createAgencyWithUser,
  createOffer,
  createTestApp,
  publishOffer,
  registerUser,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

describe('offers', () => {
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

  describe('publishing is not self-service', () => {
    it('an agency cannot publish its own offer', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'pending_review' })
        .expect(200);

      const selfPublish = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'published' });

      expect(selfPublish.status).toBe(403);
      expect(selfPublish.body.error.code).toBe('FORBIDDEN');
    });

    it('cannot jump straight from draft to published, even as staff', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);

      // draft -> published is not in OFFER_STATUS_TRANSITIONS, so the review
      // step cannot be skipped by anyone.
      const response = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'published' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('an unverified agency cannot move an offer towards publication', async () => {
      const agency = await createAgencyWithUser(ctx, { verified: false });
      const offer = await createOffer(ctx, agency);

      const response = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'pending_review' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AGENCY_NOT_VERIFIED');
    });
  });

  describe('plan quotas — where the paid tier comes from', () => {
    it('a free agency stops at its published-offer limit', async () => {
      const limit = PLAN_LIMITS.free.maxPublishedOffers!;
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });

      for (let i = 0; i < limit; i += 1) {
        const offer = await createOffer(ctx, agency, { title: `Omra offre numero ${i}` });
        const published = await publishOffer(ctx, agency, offer.id);
        expect(published.status).toBe(200);
      }

      const oneTooMany = await createOffer(ctx, agency, { title: 'Omra offre de trop' });
      const rejected = await publishOffer(ctx, agency, oneTooMany.id);

      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe('OFFER_LIMIT_REACHED');
      // The client gets the numbers so the UI can say "5 of 5 used, upgrade".
      expect(rejected.body.error.details).toMatchObject({ limit, current: limit, plan: 'free' });
    });

    it('drafts do not count against the quota', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });

      // Ten drafts, nothing published. An agency must be able to prepare its
      // whole catalogue before deciding what to put live.
      for (let i = 0; i < 10; i += 1) {
        await createOffer(ctx, agency, { title: `Brouillon numero ${i} Omra` });
      }

      const offer = await createOffer(ctx, agency, { title: 'Omra a publier maintenant' });
      expect((await publishOffer(ctx, agency, offer.id)).status).toBe(200);
    });

    it('a paid plan raises the limit, and an admin override beats the plan', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });

      await ctx.prisma.agency.update({
        where: { id: agency.agencyId },
        data: { publishedOfferLimitOverride: 1 },
      });

      const first = await createOffer(ctx, agency, { title: 'Omra premiere offre ici' });
      expect((await publishOffer(ctx, agency, first.id)).status).toBe(200);

      const second = await createOffer(ctx, agency, { title: 'Omra deuxieme offre ici' });
      expect((await publishOffer(ctx, agency, second.id)).status).toBe(409);
    });

    it('reports live usage against the limit', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'free' });
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const response = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      expect(response.body.limits.publishedOffers).toEqual({ used: 1, limit: 5 });
      expect(response.body.limits.seats).toEqual({ used: 1, limit: 2 });
    });
  });

  describe('duplicate control — flag and demote, never delete', () => {
    it('flags a re-post of the same trip instead of blocking it', async () => {
      const agency = await createAgencyWithUser(ctx);

      const original = await createOffer(ctx, agency, { title: 'Omra Ramadan 2027 depuis Alger' });
      // Same trip, reworded and repriced. Both are creatable — refusing would
      // stop an agency listing two genuine tiers of one trip.
      const repost = await createOffer(ctx, agency, {
        title: 'OMRA RAMADAN 2027 — Départ Alger !!!',
        priceFromCentimes: 31_000_000,
      });

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: repost.id } });
      expect(stored.duplicateStatus).toBe('suspected');
      expect(stored.duplicateOfOfferId).toBe(original.id);

      // Nothing was deleted. Both rows exist.
      expect(await ctx.prisma.offer.count({ where: { deletedAt: null } })).toBe(2);
    });

    it('changing only the price does not create a phantom new offer', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency, { title: 'Omra Chaabane 2027 Constantine' });
      const before = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ priceFromCentimes: 29_000_000 })
        .expect(200);

      const after = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      // Price is deliberately excluded from the fingerprint. Editing a price is
      // the most common change an agency makes; it must not look like a new
      // listing. (This is Decision 006 — an earlier price-bucketing attempt had
      // exactly this bug at the band boundaries.)
      expect(after.fingerprint).toBe(before.fingerprint);
    });

    it('a suspected duplicate is still listed publicly, just lower', async () => {
      const agency = await createAgencyWithUser(ctx);
      const first = await createOffer(ctx, agency, { title: 'Omra Rajab 2027 depuis Oran' });
      const second = await createOffer(ctx, agency, { title: 'Omra Rajab 2027 — Oran' });

      await publishOffer(ctx, agency, first.id);
      await publishOffer(ctx, agency, second.id);

      const results = await request(ctx.http).get('/v1/offers').expect(200);
      const ids = results.body.items.map((o: { id: string }) => o.id);

      expect(ids).toContain(second.id);
      // Demoted, not hidden: the clean one ranks above the flagged one.
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    });

    it('a confirmed duplicate leaves the listing but stays reachable by direct link', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      await ctx.prisma.offer.update({
        where: { id: offer.id },
        data: { duplicateStatus: 'confirmed' },
      });

      const listing = await request(ctx.http).get('/v1/offers').expect(200);
      expect(listing.body.items.map((o: { id: string }) => o.id)).not.toContain(offer.id);

      // Still there. The agency's link in a WhatsApp group keeps working, and
      // nothing an automated signal did is unrecoverable.
      await request(ctx.http).get(`/v1/offers/by-slug/${offer.slug}`).expect(200);
    });
  });

  describe('reports', () => {
    it('records a report but never hides the offer', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      for (let i = 0; i < 5; i += 1) {
        const reporter = await registerUser(ctx);
        await request(ctx.http)
          .post(`/v1/offers/${offer.id}/reports`)
          .set('Authorization', `Bearer ${reporter.accessToken}`)
          .send({ reason: 'duplicate_spam' })
          .expect(201);
      }

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(stored.reportCount).toBe(5);
      // Five reports and it is still published. Organising five reports in this
      // market is one phone call, so no count may auto-hide a listing.
      expect(stored.status).toBe('published');

      const listing = await request(ctx.http).get('/v1/offers').expect(200);
      expect(listing.body.items.map((o: { id: string }) => o.id)).toContain(offer.id);
    });

    it('one report per person per offer', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      const reporter = await registerUser(ctx);

      await request(ctx.http).post(`/v1/offers/${offer.id}/reports`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'scam_suspicion' }).expect(201);

      const second = await request(ctx.http).post(`/v1/offers/${offer.id}/reports`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'scam_suspicion' });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('ALREADY_REPORTED');
    });
  });

  describe('search filters', () => {
    it('filters by price, destination and departure window', async () => {
      const agency = await createAgencyWithUser(ctx);

      const cheap = await createOffer(ctx, agency, {
        title: 'Omra economique depuis Alger 2027',
        priceFromCentimes: 20_000_000,
        departureDate: '2027-03-01',
        returnDate: '2027-03-15',
      });
      const expensive = await createOffer(ctx, agency, {
        title: 'Omra premium cinq etoiles 2027',
        priceFromCentimes: 60_000_000,
        departureDate: '2027-09-01',
        returnDate: '2027-09-15',
      });
      await publishOffer(ctx, agency, cheap.id);
      await publishOffer(ctx, agency, expensive.id);

      const byPrice = await request(ctx.http)
        .get('/v1/offers?maxPriceCentimes=30000000').expect(200);
      expect(byPrice.body.items.map((o: { id: string }) => o.id)).toEqual([cheap.id]);

      const byWindow = await request(ctx.http)
        .get('/v1/offers?departureFrom=2027-08-01&departureTo=2027-10-01').expect(200);
      expect(byWindow.body.items.map((o: { id: string }) => o.id)).toEqual([expensive.id]);

      const byCountry = await request(ctx.http)
        .get('/v1/offers?destinationCountry=TR').expect(200);
      expect(byCountry.body.items).toHaveLength(0);
    });

    it('hides unverified agencies by default and honours ?verifiedAgenciesOnly=false', async () => {
      const verified = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, verified);
      await publishOffer(ctx, verified, offer.id);

      // Un-verify after publishing: the offer row is untouched, only the
      // agency's status changes.
      await ctx.prisma.agency.update({
        where: { id: verified.agencyId },
        data: { status: 'pending_review' },
      });

      const strict = await request(ctx.http).get('/v1/offers').expect(200);
      expect(strict.body.items).toHaveLength(0);

      // The literal string "false" must mean false. `z.coerce.boolean()` would
      // turn it into `true` and silently invert this filter.
      const loose = await request(ctx.http)
        .get('/v1/offers?verifiedAgenciesOnly=false').expect(200);
      expect(loose.body.items).toHaveLength(1);
    });

    it('rejects a nonsense boolean instead of guessing', async () => {
      const response = await request(ctx.http).get('/v1/offers?verifiedAgenciesOnly=maybe');
      expect(response.status).toBe(422);
    });

    it('text search does not resurrect departed trips', async () => {
      // Regression test. The departed-trips filter and the free-text filter
      // are both OR-groups, and an object literal cannot hold two `OR` keys —
      // the second silently replaced the first, so any search with `q` used
      // to bring back offers whose departure had already passed.
      const agency = await createAgencyWithUser(ctx);
      const departed = await createOffer(ctx, agency, {
        title: 'Omra Moharram promotion zebra unique',
        departureDate: '2020-01-01',
        returnDate: '2020-01-15',
      });
      await publishOffer(ctx, agency, departed.id);

      const plain = await request(ctx.http).get('/v1/offers').expect(200);
      expect(plain.body.items.map((o: { id: string }) => o.id)).not.toContain(departed.id);

      // The case that used to fail:
      const searched = await request(ctx.http).get('/v1/offers?q=zebra').expect(200);
      expect(searched.body.items.map((o: { id: string }) => o.id)).not.toContain(departed.id);
    });

    it('never exposes internal fields to a traveler', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const detail = await request(ctx.http)
        .get(`/v1/offers/by-slug/${offer.slug}`).expect(200);

      // The response is built field by field in offer-mapper.ts precisely so
      // this list cannot silently grow.
      expect(detail.body).not.toHaveProperty('qualityScore');
      expect(detail.body).not.toHaveProperty('duplicateStatus');
      expect(detail.body).not.toHaveProperty('reportCount');
      expect(detail.body).not.toHaveProperty('fingerprint');
      expect(detail.body.agency).not.toHaveProperty('nif');
      expect(detail.body.agency).not.toHaveProperty('registreCommerce');
    });
  });

  describe('input the client must not control', () => {
    it('ignores agencyId, status, isFeatured and qualityScore in the body', async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);

      const response = await request(ctx.http)
        .post(`/v1/agencies/${agencyA.agencyId}/offers`)
        .set('Authorization', `Bearer ${agencyA.owner.accessToken}`)
        .send({
          kind: 'visa',
          title: 'Visa Schengen dossier complet',
          priceFromCentimes: 1_500_000,
          attributes: { visaType: 'schengen', targetCountry: 'FR' },
          // All of these are absent from createOfferSchema, so Zod drops them.
          agencyId: agencyB.agencyId,
          status: 'published',
          isFeatured: true,
          qualityScore: 100,
        })
        .expect(201);

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(stored.agencyId).toBe(agencyA.agencyId);
      expect(stored.status).toBe('draft');
      expect(stored.isFeatured).toBe(false);
      expect(stored.qualityScore).not.toBe(100);
    });
  });
});
