import { describe, expect, it } from 'vitest';
import { OFFER_KINDS } from '../enums';
import {
  offerAttributeSchemas,
  parseOfferAttributes,
  safeParseOfferAttributes,
} from './attributes';

describe('the offer attribute registry', () => {
  it('has a schema for every offer kind', () => {
    // This is the runtime half of the `satisfies` check: if someone adds a kind
    // to the enum and forgets the schema, this fails loudly.
    for (const kind of OFFER_KINDS) {
      expect(offerAttributeSchemas[kind], `missing schema for "${kind}"`).toBeDefined();
    }
    expect(Object.keys(offerAttributeSchemas)).toHaveLength(OFFER_KINDS.length);
  });
});

describe('omra attributes', () => {
  it('accepts a realistic offer', () => {
    const parsed = parseOfferAttributes('omra', {
      makkahHotelName: 'Swissôtel Al Maqam',
      makkahHotelStars: 5,
      makkahDistanceToHaramMeters: 150,
      nightsInMakkah: 10,
      madinahHotelName: 'Anwar Al Madinah Mövenpick',
      nightsInMadinah: 4,
      roomOccupancy: 'quad',
      mealPlan: 'half_board',
      transportMode: 'flight_direct',
      airline: 'Air Algérie',
      visaIncluded: true,
      ziyaratIncluded: true,
      groupLanguage: 'both',
    });
    expect(parsed.makkahDistanceToHaramMeters).toBe(150);
    expect(parsed.roomOccupancy).toBe('quad');
  });

  it('accepts an empty object — every field is optional', () => {
    expect(parseOfferAttributes('omra', {})).toEqual({});
  });

  it('REJECTS unknown fields, so `attributes` cannot become a junk drawer', () => {
    const result = safeParseOfferAttributes('omra', {
      nightsInMakkah: 10,
      whateverIFeelLike: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(safeParseOfferAttributes('omra', { makkahHotelStars: 7 }).success).toBe(false);
    expect(safeParseOfferAttributes('omra', { nightsInMakkah: -1 }).success).toBe(false);
    expect(safeParseOfferAttributes('omra', { roomOccupancy: 'sextuple' }).success).toBe(false);
  });
});

describe('hajj attributes', () => {
  it('inherits every omra field and adds its own', () => {
    const parsed = parseOfferAttributes('hajj', {
      nightsInMakkah: 20,
      minaTentCategory: 'upgraded',
      hajjType: 'tamattu',
      quotaReference: 'ONPO-2026-0142',
    });
    expect(parsed.nightsInMakkah).toBe(20);
    expect(parsed.minaTentCategory).toBe('upgraded');
  });

  it('stays strict after extension', () => {
    expect(safeParseOfferAttributes('hajj', { notARealField: 1 }).success).toBe(false);
  });
});

describe('visa attributes', () => {
  it('requires the fields that make a visa offer meaningful', () => {
    // A visa offer without a type and a target country is not an offer.
    expect(safeParseOfferAttributes('visa', {}).success).toBe(false);
    expect(safeParseOfferAttributes('visa', { visaType: 'schengen' }).success).toBe(false);
  });

  it('uppercases the country code so "fr" and "FR" are the same', () => {
    const parsed = parseOfferAttributes('visa', { visaType: 'schengen', targetCountry: 'fr' });
    expect(parsed.targetCountry).toBe('FR');
  });

  it('has no success-rate field — an unprovable claim scammers make', () => {
    expect(safeParseOfferAttributes('visa', {
      visaType: 'schengen',
      targetCountry: 'FR',
      successRatePercent: 98,
    }).success).toBe(false);
  });
});

describe('kinds do not leak into each other', () => {
  it("rejects omra fields on a flight offer", () => {
    expect(safeParseOfferAttributes('flight', {
      tripType: 'round_trip',
      nightsInMakkah: 10,
    }).success).toBe(false);
  });

  it('rejects a flight without a trip type', () => {
    expect(safeParseOfferAttributes('flight', { airline: 'Air Algérie' }).success).toBe(false);
  });
});
