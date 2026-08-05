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

    /**
     * The isolation case specific to copy-from-offer: `sourceOfferId` is a
     * client-sent id for tenant data, and it is READ, so a missing scope here
     * would not just be an unauthorised write — it would hand agency B a copy
     * of agency A's entire programme in the response body.
     */
    it("agency B cannot copy agency A's programme by naming its offer id", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const offerA = await createOffer(ctx, agencyA);
      const offerB = await createOffer(ctx, agencyB);
      await addMilestone(agencyA, offerA.id, { title: 'Secret de A', dayOffset: 0 });

      const attempt = await request(ctx.http)
        .post(`/v1/agencies/${agencyB.agencyId}/offers/${offerB.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ sourceOfferId: offerA.id })
        .expect(404);

      // Not merely refused — nothing about A's programme came back.
      expect(JSON.stringify(attempt.body)).not.toContain('Secret de A');

      // And nothing was written into B's offer.
      const copied = await ctx.prisma.offerMilestone.count({ where: { offerId: offerB.id } });
      expect(copied).toBe(0);

      // A's own offer is not a copy source that B may even see listed.
      await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offerA.id}/milestones/copy-sources`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      const sources = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/offers/${offerB.id}/milestones/copy-sources`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(200);
      expect(sources.body).toEqual([]);
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

  describe('the two bulk copies — what saves an agency from retyping', () => {
    it('duplicates one day onto another without disturbing the rest', async () => {
      const agency = await createAgencyWithUser(ctx);
      const offer = await createOffer(ctx, agency);

      const wake = await addMilestone(agency, offer.id, {
        title: 'Fajr', dayOffset: 1, timeOfDay: '05:00', checkpointType: 'optional',
      });
      await addMilestone(agency, offer.id, { title: 'Ziyara', dayOffset: 1, timeOfDay: '09:00' });
      await addMilestone(agency, offer.id, { title: 'Retour', dayOffset: 9 });

      // Day 1 already happened — the copies must NOT inherit that tick, or
      // every traveler's "vous êtes ici" marker jumps to a day 2 nobody has
      // reached yet.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${wake.id}/completion`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ isDone: true })
        .expect(201);

      const after = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/duplicate-day`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceDayOffset: 1, targetDayOffset: 2 })
        .expect(201);

      const body = after.body as {
        title: string; dayOffset: number; timeOfDay: string | null;
        checkpointType: string; completedAt: string | null;
      }[];

      // Day 9 was never renumbered — a bulk convenience must not silently
      // rewrite the rest of the trip.
      expect(body.map((m) => [m.dayOffset, m.title])).toEqual([
        [1, 'Fajr'], [1, 'Ziyara'], [2, 'Fajr'], [2, 'Ziyara'], [9, 'Retour'],
      ]);

      const copies = body.filter((m) => m.dayOffset === 2);
      expect(copies.map((m) => m.timeOfDay)).toEqual(['05:00', '09:00']);
      // The plan is copied…
      expect(copies[0]?.checkpointType).toBe('optional');
      // …the history is not.
      expect(copies.every((m) => m.completedAt === null)).toBe(true);

      // A day with nothing on it is a mistake, not an empty copy.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/duplicate-day`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceDayOffset: 5, targetDayOffset: 6 })
        .expect(422);
    });

    it("copies another offer's whole programme, days and order intact", async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const lastSeason = await createOffer(ctx, agency, {
        title: 'Omra Ramadan 2026', departureDate: '2026-03-01', returnDate: '2026-03-15',
      });
      const nextSeason = await createOffer(ctx, agency, {
        title: 'Omra Ramadan 2027', departureDate: '2027-03-01', returnDate: '2027-03-15',
      });

      const flight = await addMilestone(agency, lastSeason.id, {
        title: 'Vol Alger', dayOffset: 0, checkpointType: 'mandatory',
      });
      await addMilestone(agency, lastSeason.id, { title: 'Installation', dayOffset: 0 });
      await addMilestone(agency, lastSeason.id, { title: 'Omra', dayOffset: 1 });

      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${lastSeason.id}/milestones/${flight.id}/completion`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ isDone: true })
        .expect(201);

      // The picker offers last season, with a count, and never the offer you
      // are standing in.
      const sources = await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/offers/${nextSeason.id}/milestones/copy-sources`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .expect(200);
      expect(sources.body).toEqual([
        expect.objectContaining({ offerId: lastSeason.id, milestoneCount: 3 }),
      ]);

      const copied = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${nextSeason.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceOfferId: lastSeason.id })
        .expect(201);

      const body = copied.body as {
        offerId: string; title: string; dayOffset: number;
        checkpointType: string; completedAt: string | null;
      }[];

      expect(body.map((m) => [m.dayOffset, m.title])).toEqual([
        [0, 'Vol Alger'], [0, 'Installation'], [1, 'Omra'],
      ]);
      // New rows on the TARGET offer, not references to the source's.
      expect(body.every((m) => m.offerId === nextSeason.id)).toBe(true);
      expect(body[0]?.checkpointType).toBe('mandatory');
      expect(body.every((m) => m.completedAt === null)).toBe(true);

      // The source is untouched — this reads it, it does not move it.
      const sourceStill = await ctx.prisma.offerMilestone.count({
        where: { offerId: lastSeason.id, deletedAt: null },
      });
      expect(sourceStill).toBe(3);

      // An offer cannot copy from itself.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${nextSeason.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceOfferId: nextSeason.id })
        .expect(422);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { action: 'offer_milestone.programme_copied' },
        select: { entityId: true },
      });
      expect(audits).toEqual([expect.objectContaining({ entityId: nextSeason.id })]);
    });

    it('refuses a copy that would push the programme past its ceiling', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const source = await createOffer(ctx, agency, { title: 'Grand programme' });
      const target = await createOffer(ctx, agency, {
        title: 'Programme cible', departureDate: '2027-06-01', returnDate: '2027-06-20',
      });

      // Seeded directly: 200 HTTP round-trips would test the transport, not
      // the ceiling.
      await ctx.prisma.offerMilestone.createMany({
        data: Array.from({ length: 150 }, (_, index) => ({
          agencyId: agency.agencyId,
          offerId: source.id,
          title: `Étape ${index}`,
          dayOffset: 0,
          sortOrder: index,
        })),
      });
      await addMilestone(agency, target.id, { title: 'Déjà là' });

      // 150 + 1 fits.
      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${target.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceOfferId: source.id })
        .expect(201);

      // A second copy would be 301. Nothing partial is written.
      const refused = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${target.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ sourceOfferId: source.id })
        .expect(409);
      expect(refused.body.error.code).toBe('MILESTONE_LIMIT_REACHED');

      const total = await ctx.prisma.offerMilestone.count({
        where: { offerId: target.id, deletedAt: null },
      });
      expect(total).toBe(151);
    });

    it('an agent cannot run either bulk copy', async () => {
      const agency = await createAgencyWithUser(ctx, { plan: 'pro' });
      const agent = await addMember(ctx, agency.agencyId, 'agent');
      const source = await createOffer(ctx, agency, { title: 'Programme source' });
      const target = await createOffer(ctx, agency, {
        title: 'Programme cible', departureDate: '2027-09-01', returnDate: '2027-09-15',
      });
      await addMilestone(agency, source.id, { title: 'Vol', dayOffset: 0 });
      await addMilestone(agency, target.id, { title: 'Vol', dayOffset: 0 });

      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${target.id}/milestones/duplicate-day`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ sourceDayOffset: 0, targetDayOffset: 1 })
        .expect(403);

      await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${target.id}/milestones/copy-from-offer`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ sourceOfferId: source.id })
        .expect(403);

      // But an agent may still SEE which offers have a programme — reading
      // your own agency's offer list is not a privileged act.
      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/offers/${target.id}/milestones/copy-sources`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);
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
