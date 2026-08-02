import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('reservations — the trip manifest', () => {
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

  async function reserve(
    agency: Awaited<ReturnType<typeof createAgencyWithUser>>,
    offerId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/reservations`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({
        offerId,
        contactName: 'Famille Benali',
        contactPhone: '0551234500',
        peopleCount: 4,
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string };
  }

  describe('tenant isolation — the non-optional test', () => {
    it("agency B gets 404 for agency A's manifest and reservations", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);
      const reservation = await reserve(agencyA, offer.id);

      // A's manifest through B's own path: the offer id is foreign → 404.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/manifest`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // B cannot check A's family in.
      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/reservations/${reservation.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ status: 'checked_in' })
        .expect(404);

      const stored = await ctx.prisma.reservation.findFirst({ where: { id: reservation.id } });
      expect(stored?.status).toBe('expected');

      // B cannot create a reservation INTO A's departure.
      await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/reservations`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ offerId: offer.id, contactName: 'Intrus', contactPhone: '0551234501' })
        .expect(404);

      // And no token at all is 401.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}/departures`)
        .expect(401);
    });

    it("an agent cannot reserve from a colleague's lead", async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agent = await addMember(ctx, agency.agencyId, 'agent');
      const other = await addMember(ctx, agency.agencyId, 'agent');
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const inquiry = await request(ctx.http).post('/v1/inquiries')
        .send({ offerId: offer.id, contactName: 'Amine', contactPhone: '0551234502', consent: true })
        .expect(201);

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/leads/${inquiry.body.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ assignedToUserId: other.userId })
        .expect(200);

      // The same visibility rule as the inbox: not your lead, not your client.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/reservations`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ leadId: inquiry.body.id })
        .expect(404);
    });
  });

  describe('the CRM → manifest flow', () => {
    it('creating from a lead copies the contact, links both ways, and refuses a double', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      await publishOffer(ctx, agency, offer.id);

      const inquiry = await request(ctx.http).post('/v1/inquiries')
        .send({
          offerId: offer.id,
          contactName: 'Fatima Zerrouki',
          contactPhone: '0551234503',
          peopleCount: 3,
          consent: true,
        })
        .expect(201);

      const created = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/reservations`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ leadId: inquiry.body.id, peopleCount: 3 })
        .expect(201);

      // Contact snapshotted from the lead, offer inferred from the lead.
      expect(created.body.contactName).toBe('Fatima Zerrouki');
      expect(created.body.contactPhone).toBe('+213551234503');
      expect(created.body.offerId).toBe(offer.id);
      expect(created.body.source).toBe('marketplace_inquiry');

      // One reservation per lead — a family reserved twice is a bus counted wrong.
      const double = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/reservations`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ leadId: inquiry.body.id })
        .expect(422);
      expect(double.body.error.code).toBe('VALIDATION_FAILED');

      // The lead's timeline shows the conversion.
      const activity = await ctx.prisma.leadActivity.findFirst({
        where: { leadId: inquiry.body.id, type: 'reservation_created' },
      });
      expect(activity).not.toBeNull();
    });
  });

  describe('the bus math', () => {
    it('counts PEOPLE, not rows, and orders the manifest for the bus', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);

      const familyA = await reserve(agency, offer.id, {
        contactName: 'Famille Amrani', contactPhone: '0551234504', peopleCount: 4,
      });
      await reserve(agency, offer.id, {
        contactName: 'Famille Ziani', contactPhone: '0551234505', peopleCount: 2,
      });
      const solo = await reserve(agency, offer.id, {
        contactName: 'Yacine Seul', contactPhone: '0551234506', peopleCount: 1,
      });

      // Check one family in, mark the solo a no-show.
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/reservations/${familyA.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'checked_in' })
        .expect(200);
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/reservations/${solo.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'no_show' })
        .expect(200);

      const manifest = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/manifest`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      // 3 rows, 7 people — sum(peopleCount), never count(rows).
      expect(manifest.body.counts).toMatchObject({
        reservations: 3,
        people: 7,
        expectedPeople: 2,
        checkedInPeople: 4,
        noShowPeople: 1,
        cancelledPeople: 0,
      });

      // Bus order: who's missing first (expected), then arrived, then no-shows.
      expect(
        manifest.body.reservations.map((r: { status: string }) => r.status),
      ).toEqual(['expected', 'checked_in', 'no_show']);
    });

    it('check-in stamps who and when; undo clears the stamp', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      const reservation = await reserve(agency, offer.id);

      const checked = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/reservations/${reservation.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'checked_in' })
        .expect(200);
      expect(checked.body.checkedInAt).not.toBeNull();

      const row = await ctx.prisma.reservation.findFirst({ where: { id: reservation.id } });
      expect(row?.checkedInByUserId).toBe(agency.owner.userId);

      // "Oops, wrong row" — the undo must leave no phantom count.
      const undone = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/reservations/${reservation.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'expected' })
        .expect(200);
      expect(undone.body.checkedInAt).toBeNull();

      // Both taps are in the audit log — accountability without blocking.
      const audits = await ctx.prisma.auditLog.count({
        where: { action: 'reservation.status_changed', entityId: reservation.id },
      });
      expect(audits).toBe(2);
    });
  });

  describe('the departures list', () => {
    it('shows dated offers with their people totals', async () => {
      const agency = await createAgencyWithUser(ctx);
      const dated = await createOffer(ctx, agency, { seatsTotal: 40 });
      await createOffer(ctx, agency, {
        title: 'Visa sans date de depart aucune',
        kind: 'visa',
        departureDate: undefined,
        returnDate: undefined,
        attributes: { visaType: 'schengen', targetCountry: 'FR' },
      });
      await reserve(agency, dated.id, { peopleCount: 5 });

      const departures = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/departures`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      // Only the dated offer is a departure; the visa service is not a bus.
      expect(departures.body).toHaveLength(1);
      expect(departures.body[0].offerId).toBe(dated.id);
      expect(departures.body[0].counts.people).toBe(5);
      expect(departures.body[0].seatsTotal).toBe(40);
    });
  });
});
