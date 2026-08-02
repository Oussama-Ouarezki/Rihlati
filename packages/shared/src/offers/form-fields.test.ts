import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OFFER_KINDS, type OfferKind } from '../enums';
import { offerAttributeSchemas } from './attributes';
import { attributeFieldsFor, buildAttributes } from './form-fields';

/**
 * The form field descriptors restate what the Zod schemas already know. These
 * tests are the reason that duplication is safe: they fail the moment the two
 * disagree, which is the only way a second declaration stays honest.
 */
describe('offer form fields', () => {
  function shapeOf(kind: OfferKind): Record<string, z.ZodTypeAny> {
    const schema = offerAttributeSchemas[kind];
    return (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  }

  /** Unwraps `.optional()` / `.default()` wrappers to reach the real type. */
  function isOptional(field: z.ZodTypeAny): boolean {
    return field.isOptional();
  }

  it.each(OFFER_KINDS)('every %s field exists in the Zod schema', (kind) => {
    const shape = shapeOf(kind);
    for (const field of attributeFieldsFor(kind)) {
      expect(
        Object.keys(shape),
        `form field "${field.name}" is not in the ${kind} schema — the form would send a key the API rejects (strictObject)`,
      ).toContain(field.name);
    }
  });

  it.each(OFFER_KINDS)('every required %s field is asked for in the form', (kind) => {
    const shape = shapeOf(kind);
    const required = Object.entries(shape)
      .filter(([, value]) => !isOptional(value))
      .map(([key]) => key);
    const asked = attributeFieldsFor(kind).map((field) => field.name);

    for (const name of required) {
      expect(
        asked,
        `${kind}.${name} is required by the schema but the form never asks for it — every submission would 422`,
      ).toContain(name);
    }
  });

  it.each(OFFER_KINDS)('%s marks exactly the schema-required fields as required', (kind) => {
    const shape = shapeOf(kind);
    for (const field of attributeFieldsFor(kind)) {
      const inSchema = shape[field.name];
      if (!inSchema) continue;
      expect(
        field.required === true,
        `${kind}.${field.name}: form says required=${String(field.required)}, schema says required=${String(!isOptional(inSchema))}`,
      ).toBe(!isOptional(inSchema));
    }
  });

  describe('buildAttributes', () => {
    it('produces something the schema accepts', () => {
      const built = buildAttributes('omra', {
        makkahHotelStars: '4',
        nightsInMakkah: '9',
        mealPlan: 'half_board',
        visaIncluded: 'on',
        makkahHotelName: '  Hôtel Démo  ',
      });

      expect(built).toEqual({
        makkahHotelStars: 4,
        nightsInMakkah: 9,
        mealPlan: 'half_board',
        visaIncluded: true,
        makkahHotelName: 'Hôtel Démo',
      });
      expect(offerAttributeSchemas.omra.safeParse(built).success).toBe(true);
    });

    it('drops empty values instead of sending empty strings', () => {
      // The schemas are `.optional()`, not `.nullable()` — an empty text box
      // must vanish, or a strictObject parse fails on "".
      const built = buildAttributes('omra', {
        makkahHotelName: '',
        airline: '   ',
        nightsInMakkah: undefined,
      });
      expect(built).toEqual({});
      expect(offerAttributeSchemas.omra.safeParse(built).success).toBe(true);
    });

    it('omits unchecked booleans rather than sending false', () => {
      // "not included" rows on the offer page are noise; the renderer hides
      // `false`, so never send it in the first place.
      const built = buildAttributes('omra', { visaIncluded: 'on' });
      expect(built).toEqual({ visaIncluded: true });
      expect(built).not.toHaveProperty('guideIncluded');
    });

    it('splits tags and keeps multiselect arrays', () => {
      const built = buildAttributes('package', {
        excursions: 'Bosphore, Cappadoce , ,Sainte-Sophie',
        themes: ['family', 'culture'],
      });
      expect(built['excursions']).toEqual(['Bosphore', 'Cappadoce', 'Sainte-Sophie']);
      expect(built['themes']).toEqual(['family', 'culture']);
      expect(offerAttributeSchemas.package.safeParse(built).success).toBe(true);
    });

    it('ignores keys that are not fields of this kind', () => {
      // A hand-crafted POST cannot smuggle an omra field into a visa offer —
      // the loop only reads the descriptors for `kind`, and strictObject would
      // reject it anyway.
      const built = buildAttributes('visa', {
        visaType: 'schengen',
        targetCountry: 'FR',
        makkahHotelStars: '5',
      });
      expect(built).not.toHaveProperty('makkahHotelStars');
      expect(offerAttributeSchemas.visa.safeParse(built).success).toBe(true);
    });
  });
});
