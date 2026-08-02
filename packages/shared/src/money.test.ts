import { describe, expect, it } from 'vitest';
import { MAX_PRICE_CENTIMES, centimesSchema, centimesToDzd, dzdToCentimes } from './money';

describe('money is integer centimes', () => {
  it('round-trips without losing centimes', () => {
    expect(dzdToCentimes(150_000)).toBe(15_000_000);
    expect(centimesToDzd(15_000_000)).toBe(150_000);
    expect(dzdToCentimes(1234.56)).toBe(123_456);
  });

  it('is immune to the float bug that eats money', () => {
    // The reason money is never a float: 0.1 + 0.2 === 0.30000000000000004
    const total = dzdToCentimes(0.1) + dzdToCentimes(0.2);
    expect(total).toBe(30);
    expect(centimesToDzd(total)).toBe(0.3);
  });

  it('rejects a fractional number of centimes', () => {
    expect(centimesSchema.safeParse(150.5).success).toBe(false);
    expect(centimesSchema.safeParse(-1).success).toBe(false);
    expect(centimesSchema.safeParse(15_000_000).success).toBe(true);
  });

  it('rejects an obviously fat-fingered price', () => {
    // 500 billion DZD for an Omra package
    expect(centimesSchema.safeParse(50_000_000_000_00).success).toBe(false);
  });
});

describe('MAX_PRICE_CENTIMES fits the database column', () => {
  // Regression: this was 10 000 000 000 while the Postgres columns are INT4
  // (max 2 147 483 647). Prices near the old ceiling could not be stored, and
  // a search filter using one crashed the query with a 500. Found by
  // Playwright on its first run.
  const INT4_MAX = 2_147_483_647;

  it('is inside a 32-bit signed integer', () => {
    expect(MAX_PRICE_CENTIMES).toBeLessThanOrEqual(INT4_MAX);
  });

  it('still allows a realistic luxury package', () => {
    // A high-end Hajj is around 1.5 million DZD; the ceiling must clear that
    // comfortably or agencies hit a limit that looks like a bug.
    expect(centimesSchema.safeParse(dzdToCentimes(2_000_000)).success).toBe(true);
  });

  it('rejects a value the column cannot hold', () => {
    expect(centimesSchema.safeParse(INT4_MAX + 1).success).toBe(false);
  });
});
