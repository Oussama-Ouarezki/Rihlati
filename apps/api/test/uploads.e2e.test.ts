import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  addMember,
  createAgencyWithUser,
  createTestApp,
  registerUser,
  request,
  resetDatabase,
  type TestContext,
} from './helpers';

/**
 * UPLOADS
 *
 * The interesting assertions here are not "does it store a file" — they are the
 * refusals. Each one below is a real attack that a naive implementation lets
 * through, and each is named after what it would cost.
 */

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

/** A real, decodable PNG — built rather than checked in, so the test is self-contained. */
async function pngPixels(width = 64, height = 64): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** A JPEG carrying EXIF GPS coordinates, as a phone camera would produce. */
async function jpegWithGps(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .withExif({
      IFD0: { Make: 'Rihlati Test' },
      // GPS tags live in IFD3 — that is libvips' name for the GPS IFD, and sharp
      // passes the name straight through. There is no `GPS:` key.
      // 36.75 N, 3.06 E — Alger. Standing in for someone's home address.
      IFD3: { GPSLatitude: '36/1 45/1 0/1', GPSLatitudeRef: 'N', GPSLongitude: '3/1 3/1 0/1' },
    })
    .jpeg()
    .toBuffer();
}

describe('avatar upload', () => {
  it('stores a picture and returns its URL', async () => {
    const user = await registerUser(ctx);

    const response = await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', await pngPixels(), 'me.png')
      .expect(201);

    expect(response.body.avatarUrl).toMatch(/\/avatars\/[a-f0-9]{32}\.webp$/);

    // And it is reflected in the session, so the client does not have to guess.
    const me = await request(ctx.http)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(me.body.avatarUrl).toBe(response.body.avatarUrl);
  });

  it('re-encodes to WebP regardless of what was sent', async () => {
    const user = await registerUser(ctx);
    const response = await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', await pngPixels(), 'me.png')
      .expect(201);

    const stored = await request(ctx.http).get(new URL(response.body.avatarUrl).pathname).expect(200);
    expect(stored.headers['content-type']).toBe('image/webp');
    // `nosniff` is what stops a browser deciding these bytes are HTML.
    expect(stored.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(stored.body).metadata()).format).toBe('webp');
  });

  /**
   * The one that protects a person rather than the server: a photo straight off
   * a phone carries the GPS coordinates of where it was taken, which for a
   * profile picture is very often someone's home.
   */
  it('strips EXIF GPS from the stored image', async () => {
    const user = await registerUser(ctx);
    const original = await jpegWithGps();
    // Prove the fixture really carries EXIF before asserting it was removed —
    // otherwise a `withExif` that silently did nothing would make this test
    // pass while proving nothing at all.
    const originalExif = (await sharp(original).metadata()).exif;
    expect(originalExif).toBeDefined();
    expect(originalExif!.includes(Buffer.from('Rihlati Test'))).toBe(true);

    const response = await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', original, 'holiday.jpg')
      .expect(201);

    const stored = await request(ctx.http).get(new URL(response.body.avatarUrl).pathname).expect(200);
    expect((await sharp(stored.body).metadata()).exif).toBeUndefined();
  });

  it('rejects a non-image whatever the content type claims', async () => {
    const user = await registerUser(ctx);

    const response = await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.png',
        contentType: 'image/png',
      })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  /** An SVG is a document that can contain script. It is never an acceptable avatar. */
  it('rejects SVG', async () => {
    const user = await registerUser(ctx);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
        '<script>alert(1)</script></svg>',
    );

    await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', svg, { filename: 'logo.svg', contentType: 'image/svg+xml' })
      .expect(422);
  });

  it('requires authentication', async () => {
    await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .attach('file', await pngPixels(), 'me.png')
      .expect(401);
  });

  it('removes the picture', async () => {
    const user = await registerUser(ctx);
    await request(ctx.http)
      .post('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('file', await pngPixels(), 'me.png')
      .expect(201);

    await request(ctx.http)
      .delete('/v1/auth/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const me = await request(ctx.http)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(me.body.avatarUrl).toBeNull();
  });
});

describe('agency logo', () => {
  it('a manager can set it', async () => {
    const agency = await createAgencyWithUser(ctx);
    const manager = await addMember(ctx, agency.agencyId, 'manager');

    const response = await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/logo`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .attach('file', await pngPixels(), 'logo.png')
      .expect(201);

    expect(response.body.logoUrl).toMatch(/\/logos\/[a-f0-9]{32}\.webp$/);
  });

  it('an agent cannot — a logo is the agency\'s public face', async () => {
    const agency = await createAgencyWithUser(ctx);
    const agent = await addMember(ctx, agency.agencyId, 'agent');

    await request(ctx.http)
      .post(`/v1/agencies/${agency.agencyId}/logo`)
      .set('Authorization', `Bearer ${agent.accessToken}`)
      .attach('file', await pngPixels(), 'logo.png')
      .expect(403);
  });

  /**
   * THE TENANT-ISOLATION TEST (CLAUDE.md rule #3).
   *
   * 404, not 403: a 403 would confirm the agency id exists, which turns the
   * endpoint into an oracle for enumerating agencies.
   */
  it('agency B cannot set agency A\'s logo, and gets 404 not 403', async () => {
    const agencyA = await createAgencyWithUser(ctx);
    const agencyB = await createAgencyWithUser(ctx);

    const response = await request(ctx.http)
      .post(`/v1/agencies/${agencyA.agencyId}/logo`)
      .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
      .attach('file', await pngPixels(), 'logo.png')
      .expect(404);

    // Plain NOT_FOUND, and NOT the more specific NOT_AGENCY_MEMBER: the answer
    // for "this agency does not exist" and "it exists but is not yours" must be
    // byte-identical, or the code itself becomes the oracle the 404 was meant
    // to close.
    expect(response.body.error.code).toBe('NOT_FOUND');

    // And A's logo is untouched.
    const a = await ctx.prisma.agency.findUnique({
      where: { id: agencyA.agencyId },
      select: { logoUrl: true },
    });
    expect(a?.logoUrl).toBeNull();
  });

  it('agency B cannot delete agency A\'s logo', async () => {
    const agencyA = await createAgencyWithUser(ctx);
    const agencyB = await createAgencyWithUser(ctx);

    await request(ctx.http)
      .post(`/v1/agencies/${agencyA.agencyId}/logo`)
      .set('Authorization', `Bearer ${agencyA.owner.accessToken}`)
      .attach('file', await pngPixels(), 'logo.png')
      .expect(201);

    await request(ctx.http)
      .delete(`/v1/agencies/${agencyA.agencyId}/logo`)
      .set('Authorization', `Bearer ${agencyB.owner.accessToken}`)
      .expect(404);

    const a = await ctx.prisma.agency.findUnique({
      where: { id: agencyA.agencyId },
      select: { logoUrl: true },
    });
    expect(a?.logoUrl).not.toBeNull();
  });
});

describe('the /media route', () => {
  it('refuses a path-traversal key', async () => {
    // Encoded so it survives the URL as a literal segment rather than being
    // collapsed by the router.
    await request(ctx.http).get('/media/..%2F..%2F..%2Fetc%2Fpasswd').expect(404);
  });

  it('refuses a key that is not one we generate', async () => {
    await request(ctx.http).get('/media/avatars/notahash.webp').expect(404);
  });
});

describe('profile update', () => {
  it('changes the display name', async () => {
    const user = await registerUser(ctx);

    const response = await request(ctx.http)
      .patch('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName: 'Amina B.' })
      .expect(200);

    expect(response.body.displayName).toBe('Amina B.');
  });

  /**
   * Rule #2. `avatarUrl` is not in `updateProfileSchema`, so Zod strips it —
   * a client cannot point its own picture at a server it controls.
   */
  it('ignores an avatarUrl sent in the body', async () => {
    const user = await registerUser(ctx);

    const response = await request(ctx.http)
      .patch('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName: 'Amina B.', avatarUrl: 'https://tracker.example/pixel.gif' })
      .expect(200);

    expect(response.body.avatarUrl).toBeNull();
  });

  it('ignores isPlatformAdmin sent in the body', async () => {
    const user = await registerUser(ctx);

    await request(ctx.http)
      .patch('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName: 'Amina B.', isPlatformAdmin: true })
      .expect(200);

    const row = await ctx.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isPlatformAdmin: true },
    });
    expect(row?.isPlatformAdmin).toBe(false);
  });

  it('requires authentication', async () => {
    await request(ctx.http).patch('/v1/auth/me').send({ displayName: 'Nobody' }).expect(401);
  });
});
