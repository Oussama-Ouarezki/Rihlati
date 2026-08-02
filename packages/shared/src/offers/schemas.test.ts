import { describe, expect, it } from 'vitest';
import { createOfferSchema, offerSearchSchema, updateOfferSchema } from './schemas';
import { dzdToCentimes } from '../money';

describe('offerSearchSchema — query booleans', () => {
  it('treats "false" as false, not as a truthy string', () => {
    // z.coerce.boolean() would return TRUE here, because Boolean("false") is
    // true. That would silently invert the filter with no error at all.
    const parsed = offerSearchSchema.parse({ verifiedAgenciesOnly: 'false' });
    expect(parsed.verifiedAgenciesOnly).toBe(false);
  });

  it('accepts the forms a real client sends', () => {
    for (const [input, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['', false],
      ['FALSE', false],
      ['  True  ', true],
    ] as const) {
      expect(
        offerSearchSchema.parse({ verifiedAgenciesOnly: input }).verifiedAgenciesOnly,
        `input: "${input}"`,
      ).toBe(expected);
    }
  });

  it('defaults to the strict option — unverified agencies stay hidden', () => {
    expect(offerSearchSchema.parse({}).verifiedAgenciesOnly).toBe(true);
    expect(offerSearchSchema.parse({}).includeFlaggedDuplicates).toBe(false);
  });

  it('rejects garbage instead of guessing', () => {
    expect(offerSearchSchema.safeParse({ verifiedAgenciesOnly: 'maybe' }).success).toBe(false);
  });
});

describe('offerSearchSchema — filters', () => {
  it('accepts a kind list in both query-string styles', () => {
    expect(offerSearchSchema.parse({ kind: 'omra,hajj' }).kind).toEqual(['omra', 'hajj']);
    expect(offerSearchSchema.parse({ kind: ['omra', 'hajj'] }).kind).toEqual(['omra', 'hajj']);
    expect(offerSearchSchema.parse({ kind: 'omra' }).kind).toEqual(['omra']);
  });

  it('rejects an unknown kind rather than ignoring it', () => {
    expect(offerSearchSchema.safeParse({ kind: 'omra,teleportation' }).success).toBe(false);
  });

  it('rejects an inverted price range', () => {
    const result = offerSearchSchema.safeParse({
      minPriceCentimes: dzdToCentimes(300_000),
      maxPriceCentimes: dzdToCentimes(100_000),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an inverted date window', () => {
    expect(
      offerSearchSchema.safeParse({ departureFrom: '2026-06-01', departureTo: '2026-03-01' })
        .success,
    ).toBe(false);
  });

  it('accepts a valid full filter set', () => {
    const parsed = offerSearchSchema.parse({
      q: 'omra ramadan',
      kind: 'omra',
      minPriceCentimes: String(dzdToCentimes(200_000)),
      maxPriceCentimes: String(dzdToCentimes(400_000)),
      destinationCountry: 'sa',
      departureWilayaCode: '16',
      departureFrom: '2026-02-01',
      departureTo: '2026-04-30',
      sort: 'price_asc',
      limit: '24',
    });
    expect(parsed.destinationCountry).toBe('SA'); // uppercased for us
    expect(parsed.minPriceCentimes).toBe(20_000_000);
    expect(parsed.limit).toBe(24);
  });

  it('rejects an invalid wilaya code', () => {
    expect(offerSearchSchema.safeParse({ departureWilayaCode: '99' }).success).toBe(false);
  });

  it('caps the page size so nobody can ask for a million rows', () => {
    expect(offerSearchSchema.safeParse({ limit: '100000' }).success).toBe(false);
    expect(offerSearchSchema.parse({}).limit).toBe(20);
  });
});

describe('createOfferSchema', () => {
  const validOmra = {
    kind: 'omra' as const,
    title: 'Omra Ramadan 2026 depuis Alger',
    priceFromCentimes: dzdToCentimes(320_000),
    departureDate: '2026-03-01',
    returnDate: '2026-03-15',
    destinationCountry: 'SA',
    departureWilayaCode: '16',
    attributes: { nightsInMakkah: 10, roomOccupancy: 'quad' },
  };

  it('accepts a complete offer', () => {
    const parsed = createOfferSchema.parse(validOmra);
    expect(parsed.currency).toBe('DZD');
    expect(parsed.isFlexibleDates).toBe(false);
  });

  it('validates attributes against the offer kind', () => {
    const result = createOfferSchema.safeParse({
      ...validOmra,
      attributes: { nightsInMakkah: 10, madeUpField: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error path points at the exact field, so a form can highlight it.
      expect(result.error.issues.some((i) => i.path[0] === 'attributes')).toBe(true);
    }
  });

  it('rejects a return date before the departure date', () => {
    const result = createOfferSchema.safeParse({
      ...validOmra,
      departureDate: '2026-03-15',
      returnDate: '2026-03-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an inverted price range', () => {
    expect(
      createOfferSchema.safeParse({
        ...validOmra,
        priceFromCentimes: dzdToCentimes(400_000),
        priceToCentimes: dzdToCentimes(300_000),
      }).success,
    ).toBe(false);
  });

  it('ignores fields the client must not control', () => {
    // rule #2: status, agencyId, isFeatured and qualityScore are server-owned.
    // z.object() strips unknown keys rather than passing them through, so an
    // agency cannot publish itself or feature itself for free.
    const parsed = createOfferSchema.parse({
      ...validOmra,
      status: 'published',
      agencyId: 'someone-elses-agency',
      isFeatured: true,
      qualityScore: 100,
    }) as Record<string, unknown>;

    expect(parsed.status).toBeUndefined();
    expect(parsed.agencyId).toBeUndefined();
    expect(parsed.isFeatured).toBeUndefined();
    expect(parsed.qualityScore).toBeUndefined();
  });

  it('rejects a title too short to be meaningful', () => {
    expect(createOfferSchema.safeParse({ ...validOmra, title: 'Omra' }).success).toBe(false);
  });
});

describe('updateOfferSchema', () => {
  it('allows partial updates', () => {
    const parsed = updateOfferSchema.parse({ title: 'Omra Ramadan 2026 — dernières places' });
    expect(parsed.title).toBe('Omra Ramadan 2026 — dernières places');
  });

  it('does not accept a change of kind', () => {
    // Changing kind would invalidate every stored attribute. The field is
    // omitted, so z.object() strips it silently rather than acting on it.
    const parsed = updateOfferSchema.parse({ kind: 'flight' }) as Record<string, unknown>;
    expect(parsed.kind).toBeUndefined();
  });
});
