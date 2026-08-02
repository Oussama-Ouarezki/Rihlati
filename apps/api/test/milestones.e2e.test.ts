import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createAgencyWithUser,
  createOffer,
  createTestApp,
  request,
  resetDatabase,
  type TestAgency,
  type TestContext,
} from './helpers';

describe('trip programme — milestones & checkpoint attendance', () => {
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

  async function addMilestone(
    agency: TestAgency,
    offerId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/offers/${offerId}/milestones`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({ title: 'Étape', kind: 'other', dayOffset: 0, ...overrides })
      .expect(201);
    return response.body as { id: string; sortOrder: number };
  }

  async function reserve(
    agency: TestAgency,
    offerId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/reservations`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({
        offerId,
        contactName: 'Famille Amrani',
        contactPhone: '0551234500',
        peopleCount: 4,
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string };
  }

  describe('tenant isolation — the non-optional test', () => {
    it("agency B gets 404 for agency A's milestones and checkpoints", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agencyA);
      const milestone = await addMilestone(agencyA, offer.id, {
        title: 'Départ', checkpointType: 'mandatory',
      });
      const reservation = await reserve(agencyA, offer.id);

      // B cannot list A's programme through A's offer id.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/milestones`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // B cannot create into A's offer.
      await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/milestones`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ title: 'Intrus', kind: 'other', dayOffset: 0 })
        .expect(404);

      // B cannot edit or delete A's milestone.
      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/milestones/${milestone.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ title: 'Modifié' })
        .expect(404);
      await request(ctx.http)
        .delete(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/milestones/${milestone.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // B cannot read or write A's checkpoint attendance.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/milestones/${milestone.id}/check-ins`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);
      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/milestones/${milestone.id}/check-ins/${reservation.id}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ status: 'checked_in' })
        .expect(404);

      const stored = await ctx.prisma.offerMilestone.findFirst({ where: { id: milestone.id } });
      expect(stored?.title).toBe('Départ');
      const checkIns = await ctx.prisma.milestoneCheckIn.count({ where: { milestoneId: milestone.id } });
      expect(checkIns).toBe(0);

      // No token at all is 401.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyA.agencyId}/offers/${offer.id}/milestones`)
        .expect(401);
    });

    it('an agent cannot edit the programme, but CAN check families in', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agent = await addMember(ctx, agency.agencyId, 'agent');
      const offer = await createOffer(ctx, agency);
      const milestone = await addMilestone(agency, offer.id, {
        title: 'Départ', checkpointType: 'mandatory',
      });
      const reservation = await reserve(agency, offer.id);

      // Editing the programme needs `manager`.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ title: 'Intrus', kind: 'other', dayOffset: 0 })
        .expect(403);

      // Checking a family in at a checkpoint is agent work — no role gate.
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/milestones/${milestone.id}/check-ins/${reservation.id}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ status: 'checked_in' })
        .expect(200);
    });
  });

  describe('the agency-editable programme', () => {
    it('creates, orders by day then sort order, updates, reorders and soft-deletes', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);

      const arrival = await addMilestone(agency, offer.id, { title: 'Arrivée', dayOffset: 1 });
      const departure = await addMilestone(agency, offer.id, { title: 'Départ', dayOffset: 0 });
      const omra = await addMilestone(agency, offer.id, { title: 'Omra', dayOffset: 2 });

      const listed = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(listed.body.map((m: { title: string }) => m.title)).toEqual([
        'Départ', 'Arrivée', 'Omra',
      ]);

      const updated = await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${departure.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ timeOfDay: '04:30', meetingPoint: 'Porte 3' })
        .expect(200);
      expect(updated.body.timeOfDay).toBe('04:30');
      expect(updated.body.meetingPoint).toBe('Porte 3');

      // Manually reorder Omra before Arrivée despite the day offsets.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/reorder`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ orderedIds: [departure.id, omra.id, arrival.id] })
        .expect(201);

      // A reorder that doesn't name the exact current set is rejected.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/reorder`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ orderedIds: [departure.id, omra.id] })
        .expect(422);

      await request(ctx.http)
        .delete(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${arrival.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);

      const afterDelete = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(afterDelete.body.map((m: { title: string }) => m.title)).toEqual(['Départ', 'Omra']);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'offer_milestone' },
        select: { action: true },
      });
      expect(audits.map((a) => a.action).sort()).toEqual(
        ['offer_milestone.created', 'offer_milestone.created', 'offer_milestone.created',
         'offer_milestone.deleted', 'offer_milestone.reordered', 'offer_milestone.updated'].sort(),
      );
    });
  });

  describe('checkpoint attendance — the mandatory/optional default rule', () => {
    it('a mandatory checkpoint never defaults to no_show', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      const informational = await addMilestone(agency, offer.id, { title: 'Repas' }); // checkpointType: none
      const departure = await addMilestone(agency, offer.id, {
        title: 'Départ', checkpointType: 'mandatory',
      });
      const family = await reserve(agency, offer.id);

      // An informational milestone tracks no attendance at all.
      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${informational.id}/check-ins`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(422);

      const fresh = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${departure.id}/check-ins`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(fresh.body.items).toHaveLength(1);
      expect(fresh.body.items[0]).toMatchObject({
        reservationId: family.id, status: 'expected', isDefault: true,
      });
    });

    it('a no_show at one optional checkpoint defaults forward, and can be pushed back', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      const departure = await addMilestone(agency, offer.id, {
        title: 'Départ', dayOffset: 0, checkpointType: 'mandatory',
      });
      const ziyaraQuba = await addMilestone(agency, offer.id, {
        title: 'Ziyara Quba', dayOffset: 2, checkpointType: 'optional',
      });
      const ziyaraUhud = await addMilestone(agency, offer.id, {
        title: 'Ziyara Uhud', dayOffset: 3, checkpointType: 'optional',
      });
      const retour = await addMilestone(agency, offer.id, {
        title: 'Retour', dayOffset: 10, checkpointType: 'mandatory',
      });
      const family = await reserve(agency, offer.id);
      const auth = `Bearer ${agency.owner.accessToken}`;

      // Checked in for departure — a mandatory checkpoint's status must not
      // leak into the next checkpoint's default either.
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/milestones/${departure.id}/check-ins/${family.id}`)
        .set('Authorization', auth).send({ status: 'checked_in' }).expect(200);

      // Missed the first ziyara.
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/milestones/${ziyaraQuba.id}/check-ins/${family.id}`)
        .set('Authorization', auth).send({ status: 'no_show' }).expect(200);

      // The second ziyara defaults to no_show too, without anyone tapping it.
      const uhud = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${ziyaraUhud.id}/check-ins`)
        .set('Authorization', auth).expect(200);
      expect(uhud.body.items[0]).toMatchObject({
        reservationId: family.id, status: 'no_show', isDefault: true,
      });
      expect(uhud.body.counts).toMatchObject({ people: 4, noShowPeople: 4, expectedPeople: 0 });

      // "Push them back" — they actually showed up this time.
      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/milestones/${ziyaraUhud.id}/check-ins/${family.id}`)
        .set('Authorization', auth).send({ status: 'checked_in' }).expect(200);
      const uhudAfter = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${ziyaraUhud.id}/check-ins`)
        .set('Authorization', auth).expect(200);
      expect(uhudAfter.body.items[0]).toMatchObject({ status: 'checked_in', isDefault: false });

      // The mandatory return NEVER inherits — always starts fresh, even after
      // two straight optional no-shows.
      const retourCheckIns = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${retour.id}/check-ins`)
        .set('Authorization', auth).expect(200);
      expect(retourCheckIns.body.items[0]).toMatchObject({ status: 'expected', isDefault: true });

      // Every real tap is audited — "who counted this family, at which stop".
      const audits = await ctx.prisma.auditLog.count({
        where: { action: 'milestone_check_in.status_changed' },
      });
      expect(audits).toBe(3); // departure checked_in, quba no_show, uhud checked_in
    });

    it('cancelled reservations never appear on a checkpoint list', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);
      const departure = await addMilestone(agency, offer.id, {
        title: 'Départ', checkpointType: 'mandatory',
      });
      const family = await reserve(agency, offer.id);

      await request(ctx.http)
        .patch(`/v1/agencies/${agency.agencyId}/reservations/${family.id}`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ status: 'cancelled' })
        .expect(200);

      const attendance = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/milestones/${departure.id}/check-ins`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(attendance.body.items).toHaveLength(0);
    });
  });
});
