import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FAQ_ENTRIES } from '@rihlati/shared';
import {
  addMember,
  createAgencyWithUser,
  createTestApp,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

describe('agency FAQ', () => {
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

  async function createFaq(
    agency: Awaited<ReturnType<typeof createAgencyWithUser>>,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/faq`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({
        question: 'Le visa est-il inclus dans le prix ?',
        answer: 'Oui, le visa est inclus pour toutes nos offres Omra.',
        ...overrides,
      })
      .expect(201);
    return response.body.id as string;
  }

  describe('tenant isolation — the non-optional test', () => {
    it("agency B gets 404 for agency A's FAQ entry, on update and delete", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      const faqId = await createFaq(agencyA);

      await request(ctx.http)
        .patch(`/v1/agencies/${agencyB.agencyId}/faq/${faqId}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .send({ answer: 'Réponse détournée' })
        .expect(404);

      await request(ctx.http)
        .delete(`/v1/agencies/${agencyB.agencyId}/faq/${faqId}`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(404);

      // Untouched — a 404 that still wrote would be worse than no check.
      const stored = await ctx.prisma.agencyFaq.findUniqueOrThrow({ where: { id: faqId } });
      expect(stored.answer).not.toBe('Réponse détournée');
    });

    it("agency B's FAQ list never contains agency A's entries", async () => {
      const agencyA = await createAgencyWithUser(ctx);
      const agencyB = await createAgencyWithUser(ctx);
      await createFaq(agencyA);

      const list = await request(ctx.http)
        .get(`/v1/agencies/${agencyB.agencyId}/faq`)
        .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
        .expect(200);

      expect(list.body).toHaveLength(0);
    });

    it('an agent cannot write FAQ entries (403), and no token is 401', async () => {
      const agency = await createAgencyWithUser(ctx);
      const agent = await addMember(ctx, agency.agencyId, 'agent');

      const denied = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/faq`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ question: 'Question de test suffisamment longue ?', answer: 'Réponse.' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');

      await request(ctx.http)
        .get(`/v1/agencies/${agency.agencyId}/faq`)
        .expect(401);
    });
  });

  describe('public listing', () => {
    it('shows only ENABLED entries, in sort order', async () => {
      const agency = await createAgencyWithUser(ctx);
      await createFaq(agency, { question: 'Deuxième question visible ici ?', sortOrder: 2 });
      await createFaq(agency, { question: 'Première question visible ici ?', sortOrder: 1 });
      await createFaq(agency, {
        question: 'Question désactivée, invisible ?',
        isEnabled: false,
      });

      const response = await request(ctx.http)
        .get(`/v1/agencies/by-slug/${agency.slug}/faq`)
        .expect(200);

      expect(response.body.map((f: { question: string }) => f.question)).toEqual([
        'Première question visible ici ?',
        'Deuxième question visible ici ?',
      ]);
      // The public shape must not reveal the moderation switch.
      expect(response.body[0]).not.toHaveProperty('isEnabled');
    });

    it('an unverified agency has no public FAQ — 404, like the rest of its page', async () => {
      const agency = await createAgencyWithUser(ctx, { verified: false });
      await createFaq(agency);

      await request(ctx.http)
        .get(`/v1/agencies/by-slug/${agency.slug}/faq`)
        .expect(404);
    });
  });

  describe('the cap', () => {
    it(`refuses entry ${MAX_FAQ_ENTRIES + 1}`, async () => {
      const agency = await createAgencyWithUser(ctx);

      // Insert 50 directly — creating them through the API works but takes
      // ~50 requests; the cap check reads a database count either way.
      await ctx.prisma.agencyFaq.createMany({
        data: Array.from({ length: MAX_FAQ_ENTRIES }, (_, i) => ({
          agencyId: agency.agencyId,
          question: `Question numéro ${i} suffisamment longue ?`,
          answer: 'Réponse.',
        })),
      });

      const response = await request(ctx.http)
        .post(`/v1/agencies/${agency.agencyId}/faq`)
        .set('Authorization', `Bearer ${agency.owner.accessToken}`)
        .send({ question: 'Une question de trop, non ?', answer: 'Réponse.' });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toMatchObject({ limit: MAX_FAQ_ENTRIES });
    });
  });

  it('update and delete work for the owning agency, and are audited', async () => {
    const agency = await createAgencyWithUser(ctx);
    const faqId = await createFaq(agency);

    await request(ctx.http)
      .patch(`/v1/agencies/${agency.agencyId}/faq/${faqId}`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .send({ answer: 'Réponse mise à jour.', isEnabled: false })
      .expect(200);

    await request(ctx.http)
      .delete(`/v1/agencies/${agency.agencyId}/faq/${faqId}`)
      .set('Authorization', `Bearer ${agency.owner.accessToken}`)
      .expect(200);

    const actions = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'agency_faq', entityId: faqId },
      select: { action: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'agency.faq_created',
      'agency.faq_updated',
      'agency.faq_deleted',
    ]);
  });
});
