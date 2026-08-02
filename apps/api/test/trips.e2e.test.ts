import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createAgencyWithUser,
  createOffer,
  createTestApp,
  publishOffer,
  request,
  resetDatabase,
  type TestAgency,
  type TestContext,
} from './helpers';

/**
 * THE TRAVELER'S TRIP PAGE — GET /v1/trips/:code
 *
 * This endpoint breaks the codebase's usual rule that every query is scoped by
 * the session's tenant, because there is no session: the caller is a family
 * with a WhatsApp link. The capability code replaces the tenant scope.
 *
 * So the tests here are not the usual "agency B gets 404". They pin down the
 * two properties the design actually rests on:
 *
 *   1. the code names exactly one reservation, and a wrong one reveals nothing
 *   2. the response carries this family's data and NOTHING about anyone else
 *
 * Property 2 is the one that would quietly rot. A future column added to
 * `reservations` or an innocent `include` would leak into a page that anyone
 * holding a forwarded link can open, so it is asserted as an exact key set —
 * a new field fails this test until somebody decides it is safe.
 */
describe('traveler trip page (capability URL)', () => {
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
        notes: 'Paie le solde au bus',
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string; publicCode: string };
  }

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
    return response.body as { id: string };
  }

  it('a booking is reachable by its code, with no login at all', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    await addMilestone(agency, offer.id, {
      title: 'Départ vers l’aéroport',
      kind: 'transport',
      meetingPoint: 'Parking de l’agence, devant l’entrée',
    });
    const reservation = await reserve(agency, offer.id);

    expect(reservation.publicCode).toBeTruthy();

    const response = await request(ctx.http)
      .get(`/v1/trips/${reservation.publicCode}`)
      .expect(200);

    expect(response.body.contactName).toBe('Famille Amrani');
    expect(response.body.peopleCount).toBe(4);
    expect(response.body.milestones).toHaveLength(1);
    // They booked, so they get the meeting point. A buyer does not — see below.
    expect(response.body.milestones[0].meetingPoint).toBe(
      'Parking de l’agence, devant l’entrée',
    );
  });

  it('exposes this family and nothing else — exact allow-list', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    const reservation = await reserve(agency, offer.id);

    // A second family on the same departure. If the response ever grows a
    // manifest, this is the name that shows up in it.
    await reserve(agency, offer.id, {
      contactName: 'Famille Benali',
      contactPhone: '0551234599',
    });

    const response = await request(ctx.http)
      .get(`/v1/trips/${reservation.publicCode}`)
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      'agency',
      'contactName',
      'currentMilestoneId',
      'milestones',
      'offer',
      'peopleCount',
    ]);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('Benali'); // no other traveler, ever
    expect(body).not.toContain('0551234599'); // no other traveler's phone
    expect(body).not.toContain('Paie le solde au bus'); // internal notes
    expect(response.body).not.toHaveProperty('status'); // internal booking state
    expect(response.body).not.toHaveProperty('notes');
  });

  it('a buyer on the public offer page gets the programme without meeting points', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    await addMilestone(agency, offer.id, {
      title: 'Départ vers l’aéroport',
      meetingPoint: 'Parking de l’agence, devant l’entrée',
      mapUrl: 'https://maps.app.goo.gl/abc',
    });
    await publishOffer(ctx, agency, offer.id);

    const response = await request(ctx.http)
      .get(`/v1/offers/by-slug/${offer.slug}`)
      .expect(200);

    expect(response.body.milestones).toHaveLength(1);
    expect(response.body.milestones[0].title).toBe('Départ vers l’aéroport');
    // Withheld until they book. Operational detail, and an indexable page.
    expect(response.body.milestones[0].meetingPoint).toBeNull();
    expect(response.body.milestones[0].mapUrl).toBeNull();
    // The agency's internal attendance setting is not a buyer's business.
    expect(response.body.milestones[0]).not.toHaveProperty('checkpointType');
  });

  it('"you are here" follows what the agency has ticked off, not the clock', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    const first = await addMilestone(agency, offer.id, { title: 'Réunion', dayOffset: 0 });
    const second = await addMilestone(agency, offer.id, { title: 'Départ', dayOffset: 1 });
    const reservation = await reserve(agency, offer.id);

    const before = await request(ctx.http)
      .get(`/v1/trips/${reservation.publicCode}`)
      .expect(200);
    expect(before.body.currentMilestoneId).toBe(first.id);

    await ctx.prisma.offerMilestone.updateMany({
      where: { id: first.id },
      data: { completedAt: new Date() },
    });

    const after = await request(ctx.http)
      .get(`/v1/trips/${reservation.publicCode}`)
      .expect(200);
    expect(after.body.currentMilestoneId).toBe(second.id);
    expect(after.body.milestones[0].isDone).toBe(true);
  });

  it('ticking a step in the console moves every traveler’s marker', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    const first = await addMilestone(agency, offer.id, { title: 'Réunion', dayOffset: 0 });
    const second = await addMilestone(agency, offer.id, { title: 'Départ', dayOffset: 1 });
    const reservation = await reserve(agency, offer.id);

    const tick = (milestoneId: string, isDone: boolean) =>
      request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${milestoneId}/completion`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ isDone });

    await tick(first.id, true).expect(201);
    const advanced = await request(ctx.http)
      .get(`/v1/trips/${reservation.publicCode}`)
      .expect(200);
    expect(advanced.body.currentMilestoneId).toBe(second.id);

    // The undo: the tap that matters right after a wrong tap.
    await tick(first.id, false).expect(201);
    const undone = await request(ctx.http).get(`/v1/trips/${reservation.publicCode}`).expect(200);
    expect(undone.body.currentMilestoneId).toBe(first.id);
  });

  it("an agent can tick a step off — it is bus-side work, not a manager's", async () => {
    const agency = await createAgencyWithUser(ctx);
    const agent = await addMember(ctx, agency.agencyId, 'agent');
    const offer = await createOffer(ctx, agency);
    const milestone = await addMilestone(agency, offer.id);

    await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${milestone.id}/completion`)
      .set('Authorization', `Bearer ${agent.accessToken}`)
      .send({ isDone: true })
      .expect(201);

    // But editing the programme itself is still planning work.
    await request(ctx.http)
      .patch(`/v1/agencies/${agency.agencyId}/offers/${offer.id}/milestones/${milestone.id}`)
      .set('Authorization', `Bearer ${agent.accessToken}`)
      .send({ title: 'Renommée par un agent' })
      .expect(403);
  });

  it("agency B cannot tick off a step in agency A's programme", async () => {
    const agencyA = await createAgencyWithUser(ctx);
    const agencyB = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agencyA);
    const milestone = await addMilestone(agencyA, offer.id);

    await request(ctx.http)
      .post(`/v1/agencies/${agencyB.agencyId}/offers/${offer.id}/milestones/${milestone.id}/completion`)
      .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
      .send({ isDone: true })
      .expect(404);
  });

  it('a wrong code, a cancelled booking and a closed agency are the same 404', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    const reservation = await reserve(agency, offer.id);

    // Well-formed but not ours.
    await request(ctx.http).get('/v1/trips/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    // Malformed: rejected by the param schema before it reaches the database.
    await request(ctx.http).get('/v1/trips/../../etc/passwd').expect(404);

    await ctx.prisma.reservation.updateMany({
      where: { id: reservation.id },
      data: { deletedAt: new Date() },
    });
    await request(ctx.http).get(`/v1/trips/${reservation.publicCode}`).expect(404);
  });

  it("agency B cannot mint a trip link on agency A's reservation", async () => {
    const agencyA = await createAgencyWithUser(ctx);
    const agencyB = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agencyA);
    const reservation = await reserve(agencyA, offer.id);

    await request(ctx.http)
      .post(`/v1/agencies/${agencyB.agencyId}/reservations/${reservation.id}/trip-link`)
      .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
      .expect(404);
  });

  it('issuing a trip link is idempotent — an existing code is never rotated', async () => {
    const agency = await createAgencyWithUser(ctx);
    const offer = await createOffer(ctx, agency);
    const reservation = await reserve(agency, offer.id);

    // Simulate a row created before the column existed.
    await ctx.prisma.reservation.updateMany({
      where: { id: reservation.id },
      data: { publicCode: null },
    });

    const url = `/v1/agencies/${agency.agencyId}/reservations/${reservation.id}/trip-link`;
    const auth = `Bearer ${agency.owner.accessToken}`;

    const minted = await request(ctx.http).post(url).set('Authorization', auth).expect(201);
    expect(minted.body.publicCode).toBeTruthy();

    const again = await request(ctx.http).post(url).set('Authorization', auth).expect(201);
    // A rotated code would break a link already sitting in a WhatsApp thread.
    expect(again.body.publicCode).toBe(minted.body.publicCode);

    await request(ctx.http).get(`/v1/trips/${minted.body.publicCode}`).expect(200);
  });
});
