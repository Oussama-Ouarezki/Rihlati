import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { requestIdMiddleware } from '../src/common/http/request-context';

/**
 * Test fixtures.
 *
 * These build state through the REAL API wherever possible — registering a
 * user goes through `POST /auth/register`, not a Prisma insert. Fixtures that
 * write directly to the database can create rows the API itself would refuse,
 * and then the test proves something about a state that cannot occur.
 *
 * The exceptions are marked, and each one exists because a platform admin or a
 * verification step is not exposed as an endpoint yet.
 */

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: App;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    http: app.getHttpServer() as App,
  };
}

/** Wipe between tests so each one starts from a known, empty database. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.truncateAllForTests();
}

let counter = 0;
function unique(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(
  ctx: TestContext,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? `user-${unique()}@example.test`;
  const password = overrides.password ?? 'correct-horse-battery-staple';

  const response = await request(ctx.http)
    .post('/v1/auth/register')
    .send({ email, password, displayName: overrides.displayName ?? 'Test User' })
    .expect(201);

  return {
    userId: response.body.user.id,
    email,
    password,
    accessToken: response.body.tokens.accessToken,
    refreshToken: response.body.tokens.refreshToken,
  };
}

export interface TestAgency {
  agencyId: string;
  slug: string;
  owner: TestUser;
}

/**
 * A user with a verified agency they own.
 *
 * Verification is done with a direct database write on purpose: it is a manual
 * back-office action by Rihlati staff, and there is deliberately no endpoint
 * an agency could call to verify itself. Faking it here is faking the admin,
 * not bypassing a check the test should be exercising.
 */
export async function createAgencyWithUser(
  ctx: TestContext,
  options: { verified?: boolean; plan?: 'free' | 'pro' | 'business' } = {},
): Promise<TestAgency> {
  const owner = await registerUser(ctx);
  const slug = `agence-${unique()}`;

  const response = await request(ctx.http)
    .post('/v1/agencies')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({
      name: `Agence ${slug}`,
      slug,
      registreCommerce: '16/00-1234567B25',
      nif: '000216001234567',
    })
    .expect(201);

  const agencyId = response.body.id as string;

  if (options.verified !== false) {
    await ctx.prisma.agency.update({
      where: { id: agencyId },
      data: { status: 'verified', verifiedAt: new Date(), plan: options.plan ?? 'free' },
    });
  } else if (options.plan) {
    await ctx.prisma.agency.update({ where: { id: agencyId }, data: { plan: options.plan } });
  }

  return { agencyId, slug, owner };
}

/** Add a second person to an agency, with a chosen role. */
export async function addMember(
  ctx: TestContext,
  agencyId: string,
  role: 'manager' | 'agent',
): Promise<TestUser> {
  const user = await registerUser(ctx);
  await ctx.prisma.membership.create({
    data: { userId: user.userId, agencyId, role, acceptedAt: new Date() },
  });
  return user;
}

export async function makePlatformAdmin(ctx: TestContext, userId: string): Promise<void> {
  await ctx.prisma.user.update({ where: { id: userId }, data: { isPlatformAdmin: true } });
}

/**
 * A Rihlati staff account that belongs to NO agency.
 *
 * That matters: `AgencyMembershipGuard` checks for a membership row first, and
 * only falls through to the platform-admin branch when there is none. So an
 * admin who also happens to own an agency acts as its owner there, not as
 * staff — which is the right behaviour (their own actions are recorded as the
 * agency's, not as a support intervention) and means a test needs a genuinely
 * separate account to exercise the admin path.
 */
export async function createPlatformAdmin(ctx: TestContext): Promise<TestUser> {
  const admin = await registerUser(ctx);
  await makePlatformAdmin(ctx, admin.userId);
  return admin;
}

export interface TestOffer {
  id: string;
  slug: string;
}

export async function createOffer(
  ctx: TestContext,
  agency: TestAgency,
  overrides: Record<string, unknown> = {},
): Promise<TestOffer> {
  const response = await request(ctx.http)
    .post(`/v1/agencies/${agency.agencyId}/offers`)
    .set('Authorization', `Bearer ${agency.owner.accessToken}`)
    .send({
      kind: 'omra',
      title: `Omra Ramadan ${unique()}`,
      priceFromCentimes: 30_000_000,
      departureDate: '2027-03-01',
      returnDate: '2027-03-15',
      destinationCountry: 'SA',
      destinationCity: 'Makkah',
      departureWilayaCode: '16',
      attributes: {
        makkahHotelStars: 4,
        madinahHotelStars: 4,
        nightsInMakkah: 9,
        nightsInMadinah: 5,
        visaIncluded: true,
        transportMode: 'flight_direct',
        mealPlan: 'half_board',
      },
      ...overrides,
    })
    .expect(201);

  return { id: response.body.id, slug: response.body.slug };
}

/**
 * Publish an offer.
 *
 * Publishing requires platform-admin rights by design — an agency asks for
 * review, a human decides. The helper temporarily grants the flag rather than
 * writing `status: 'published'` straight into the row, so the quota check and
 * the status-transition table are still exercised.
 */
export async function publishOffer(
  ctx: TestContext,
  agency: TestAgency,
  offerId: string,
): Promise<request.Response> {
  const url = `/v1/agencies/${agency.agencyId}/offers/${offerId}/status`;
  const auth = `Bearer ${agency.owner.accessToken}`;

  // Step 1: the agency submits. Anyone with `manager` can do this, and
  // `draft -> published` is not a legal transition, so the review step is not
  // skippable even here.
  await request(ctx.http).patch(url).set('Authorization', auth)
    .send({ status: 'pending_review' })
    .expect(200);

  // Step 2: a human at Rihlati approves. A separate staff account, because an
  // agency's own members can never publish their own listings — see
  // createPlatformAdmin() for why the guard treats the two cases differently.
  const admin = await createPlatformAdmin(ctx);
  return request(ctx.http).patch(url)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ status: 'published' });
}

export { request };
