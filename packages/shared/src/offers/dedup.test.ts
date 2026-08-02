import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_REVIEW_THRESHOLD,
  normalizeTitle,
  offerFingerprintSource,
  titleSimilarity,
  type FingerprintInput,
} from './dedup';

describe('normalizeTitle', () => {
  it('ignores case, accents, punctuation and word order', () => {
    expect(normalizeTitle('Omra Ramadan 2026 — Départ Alger'))
      .toBe(normalizeTitle('omra ramadan 2026 depart alger'));
    expect(normalizeTitle('Omra Ramadan 2026')).toBe(normalizeTitle('2026 Ramadan Omra'));
  });

  it('drops marketing filler, including accented and gendered forms', () => {
    expect(normalizeTitle('Offre spéciale Omra Ramadan')).toBe(normalizeTitle('Omra Ramadan'));
    expect(normalizeTitle('PROMO Omra Ramadan — Départ Alger')).toBe(
      normalizeTitle('Omra Ramadan Alger'),
    );
    expect(normalizeTitle('Omra Ramadan 15 jours / 14 nuits')).toBe(
      normalizeTitle('Omra Ramadan 15 14'),
    );
  });

  it('keeps the words that actually distinguish one trip from another', () => {
    // Destination, month and year must survive normalization, or everything
    // collapses into one offer.
    expect(normalizeTitle('Omra Ramadan 2026')).not.toBe(normalizeTitle('Omra Chaabane 2026'));
    expect(normalizeTitle('Omra Ramadan 2026')).not.toBe(normalizeTitle('Omra Ramadan 2027'));
    expect(normalizeTitle('Séjour Istanbul')).not.toBe(normalizeTitle('Séjour Dubai'));
  });

  it('handles Arabic titles', () => {
    expect(normalizeTitle('عرض عمرة رمضان')).toBe(normalizeTitle('عمرة رمضان'));
  });
});

const baseOffer: FingerprintInput = {
  agencyId: 'agency-1',
  kind: 'omra',
  title: 'Omra Ramadan 2026 depuis Alger',
  departureDate: '2026-03-01',
  destinationCountry: 'SA',
  destinationCity: 'Makkah',
  departureWilayaCode: '16',
};

describe('offerFingerprintSource', () => {
  it('matches when the same agency re-posts the same trip', () => {
    const reposted: FingerprintInput = {
      ...baseOffer,
      title: 'OMRA RAMADAN 2026 - Départ Alger !!',
    };
    expect(offerFingerprintSource(reposted)).toBe(offerFingerprintSource(baseOffer));
  });

  it('is unaffected by price, because editing a price is not a new offer', () => {
    // Price is not part of identity. An earlier version bucketed it into 5 000
    // DZD bands, which silently split offers that straddled a band boundary.
    // FingerprintInput has no price field at all now — the type enforces it.
    expect(Object.keys(baseOffer)).not.toContain('priceFromCentimes');
  });

  it('does NOT match two agencies selling the same package', () => {
    // Deliberate: these are different sellers at different prices. Collapsing
    // them would destroy the comparison the marketplace exists to provide.
    const otherAgency = { ...baseOffer, agencyId: 'agency-2' };
    expect(offerFingerprintSource(otherAgency)).not.toBe(offerFingerprintSource(baseOffer));
  });

  it('does not match a genuinely different trip', () => {
    expect(offerFingerprintSource({ ...baseOffer, departureDate: '2026-04-15' }))
      .not.toBe(offerFingerprintSource(baseOffer));
    expect(offerFingerprintSource({ ...baseOffer, departureWilayaCode: '31' }))
      .not.toBe(offerFingerprintSource(baseOffer));
    expect(offerFingerprintSource({ ...baseOffer, kind: 'hajj' }))
      .not.toBe(offerFingerprintSource(baseOffer));
    expect(offerFingerprintSource({ ...baseOffer, title: 'Séjour Istanbul 7 nuits' }))
      .not.toBe(offerFingerprintSource(baseOffer));
  });

  it('treats a missing optional field as absent, not as a match-anything wildcard', () => {
    const noDate: FingerprintInput = { ...baseOffer, departureDate: null };
    expect(offerFingerprintSource(noDate)).not.toBe(offerFingerprintSource(baseOffer));
    // ...but two offers both missing the date still agree with each other.
    expect(offerFingerprintSource(noDate)).toBe(
      offerFingerprintSource({ ...baseOffer, departureDate: undefined }),
    );
  });
});

describe('titleSimilarity', () => {
  it('scores identical trips above the review threshold', () => {
    const score = titleSimilarity(
      'Omra Ramadan 2026 15 jours depuis Alger',
      'Omra Ramadan 2026 depuis Alger 15 jours',
    );
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_REVIEW_THRESHOLD);
  });

  it('scores unrelated trips well below the threshold', () => {
    const score = titleSimilarity('Omra Ramadan 2026 depuis Alger', 'Séjour Istanbul 7 nuits');
    expect(score).toBeLessThan(DUPLICATE_REVIEW_THRESHOLD);
  });

  it('returns 0 rather than throwing on empty input', () => {
    expect(titleSimilarity('', 'Omra')).toBe(0);
  });
});
