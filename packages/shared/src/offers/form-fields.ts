import {
  CABIN_CLASSES,
  GROUP_LANGUAGES,
  HOTEL_AMENITIES,
  MEAL_PLANS,
  PACKAGE_THEMES,
  ROOM_OCCUPANCIES,
  TRANSPORT_MODES,
  VISA_TYPES,
} from './attributes';
import type { OfferKind } from '../enums';

/**
 * HOW THE OFFER FORM KNOWS WHAT TO ASK
 *
 * `attributes` holds a different shape for each of the seven offer kinds. A
 * form cannot read that from a Zod schema without ugly runtime introspection,
 * so the shape is declared once more here — as data, not as UI.
 *
 * The duplication is real and it is bounded on purpose:
 *   - a test asserts every field here exists in the matching Zod schema, and
 *     that required fields agree, so the two cannot drift silently
 *   - labels are NOT here: they come from the `attr.*` / `attrValues.*` i18n
 *     keys the offer page already uses, in all three languages
 *
 * Adding an offer kind stays four edits (enum, Prisma, Zod schema, registry)
 * plus this list, and the whole form appears.
 */

export type AttributeFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  /** Comma-separated free text, stored as string[]. */
  | 'tags';

export interface AttributeField {
  /** The key inside `attributes`. Also the i18n key: `attr.{name}`. */
  name: string;
  type: AttributeFieldType;
  required?: boolean;
  /** For select/multiselect. Option labels come from `attrValues.{value}`. */
  options?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

const NOTES: AttributeField = { name: 'notes', type: 'textarea', maxLength: 1000 };

/** Shared by omra and hajj — hajj extends the omra schema. */
const PILGRIMAGE_FIELDS: readonly AttributeField[] = [
  { name: 'makkahHotelName', type: 'text', maxLength: 160 },
  { name: 'makkahHotelStars', type: 'number', min: 1, max: 5 },
  { name: 'makkahDistanceToHaramMeters', type: 'number', min: 0, max: 50_000 },
  { name: 'nightsInMakkah', type: 'number', min: 0, max: 90 },
  { name: 'madinahHotelName', type: 'text', maxLength: 160 },
  { name: 'madinahHotelStars', type: 'number', min: 1, max: 5 },
  { name: 'madinahDistanceToHaramMeters', type: 'number', min: 0, max: 50_000 },
  { name: 'nightsInMadinah', type: 'number', min: 0, max: 90 },
  { name: 'roomOccupancy', type: 'select', options: ROOM_OCCUPANCIES },
  { name: 'mealPlan', type: 'select', options: MEAL_PLANS },
  { name: 'transportMode', type: 'select', options: TRANSPORT_MODES },
  { name: 'airline', type: 'text', maxLength: 160 },
  { name: 'visaIncluded', type: 'boolean' },
  { name: 'guideIncluded', type: 'boolean' },
  { name: 'ziyaratIncluded', type: 'boolean' },
  { name: 'localTransportIncluded', type: 'boolean' },
  { name: 'insuranceIncluded', type: 'boolean' },
  { name: 'mealsIncluded', type: 'boolean' },
  { name: 'groupLanguage', type: 'select', options: GROUP_LANGUAGES },
  { name: 'womenOnlyGroupAvailable', type: 'boolean' },
  NOTES,
];

export const OFFER_ATTRIBUTE_FIELDS = {
  omra: PILGRIMAGE_FIELDS,

  hajj: [
    ...PILGRIMAGE_FIELDS.filter((field) => field.name !== 'notes'),
    { name: 'hajjType', type: 'select', options: ['tamattu', 'ifrad', 'qiran'] },
    { name: 'quotaReference', type: 'text', maxLength: 160 },
    { name: 'minaTentCategory', type: 'select', options: ['standard', 'upgraded', 'vip'] },
    { name: 'nightsInMina', type: 'number', min: 0, max: 90 },
    { name: 'arafatServices', type: 'textarea', maxLength: 1000 },
    NOTES,
  ],

  package: [
    { name: 'hotelName', type: 'text', maxLength: 160 },
    { name: 'hotelStars', type: 'number', min: 1, max: 5 },
    { name: 'nights', type: 'number', min: 0, max: 90 },
    { name: 'mealPlan', type: 'select', options: MEAL_PLANS },
    { name: 'roomOccupancy', type: 'select', options: ROOM_OCCUPANCIES },
    { name: 'transportMode', type: 'select', options: TRANSPORT_MODES },
    { name: 'airline', type: 'text', maxLength: 160 },
    { name: 'visaIncluded', type: 'boolean' },
    { name: 'insuranceIncluded', type: 'boolean' },
    { name: 'airportTransferIncluded', type: 'boolean' },
    { name: 'guideIncluded', type: 'boolean' },
    { name: 'themes', type: 'multiselect', options: PACKAGE_THEMES },
    { name: 'excursions', type: 'tags' },
    { name: 'childPolicy', type: 'textarea', maxLength: 1000 },
    NOTES,
  ],

  visa: [
    { name: 'visaType', type: 'select', options: VISA_TYPES, required: true },
    { name: 'targetCountry', type: 'text', required: true, maxLength: 2 },
    { name: 'processingDays', type: 'number', min: 1, max: 365 },
    { name: 'consulateCity', type: 'text', maxLength: 160 },
    { name: 'appointmentIncluded', type: 'boolean' },
    { name: 'documentReviewIncluded', type: 'boolean' },
    { name: 'translationIncluded', type: 'boolean' },
    { name: 'insuranceIncluded', type: 'boolean' },
    { name: 'refundIfRefused', type: 'boolean' },
    { name: 'requiredDocuments', type: 'tags' },
    NOTES,
  ],

  flight: [
    {
      name: 'tripType',
      type: 'select',
      options: ['one_way', 'round_trip', 'multi_city'],
      required: true,
    },
    { name: 'airline', type: 'text', maxLength: 160 },
    { name: 'cabinClass', type: 'select', options: CABIN_CLASSES },
    { name: 'originAirportIata', type: 'text', maxLength: 3 },
    { name: 'destinationAirportIata', type: 'text', maxLength: 3 },
    { name: 'stops', type: 'number', min: 0, max: 4 },
    { name: 'checkedBaggageKg', type: 'number', min: 0, max: 100 },
    { name: 'cabinBaggageKg', type: 'number', min: 0, max: 30 },
    { name: 'refundable', type: 'boolean' },
    { name: 'changeable', type: 'boolean' },
    NOTES,
  ],

  hotel: [
    { name: 'hotelName', type: 'text', required: true, maxLength: 160 },
    { name: 'hotelStars', type: 'number', min: 1, max: 5 },
    { name: 'nights', type: 'number', min: 0, max: 90 },
    { name: 'mealPlan', type: 'select', options: MEAL_PLANS },
    { name: 'roomOccupancy', type: 'select', options: ROOM_OCCUPANCIES },
    { name: 'amenities', type: 'multiselect', options: HOTEL_AMENITIES },
    { name: 'distanceToCityCentreMeters', type: 'number', min: 0, max: 50_000 },
    { name: 'cancellationPolicy', type: 'textarea', maxLength: 1000 },
    NOTES,
  ],

  transport: [
    {
      name: 'vehicleType',
      type: 'select',
      options: ['bus', 'minibus', 'car', 'van', 'suv_4x4'],
      required: true,
    },
    { name: 'seats', type: 'number', min: 1, max: 80 },
    { name: 'pricingUnit', type: 'select', options: ['per_day', 'per_trip', 'per_person'] },
    { name: 'withDriver', type: 'boolean' },
    { name: 'airConditioned', type: 'boolean' },
    { name: 'routeDescription', type: 'textarea', maxLength: 1000 },
    NOTES,
  ],
  // `satisfies` rather than a plain annotation: adding a kind to OfferKind
  // without a field list fails to compile, exactly like the schema registry.
} as const satisfies Record<OfferKind, readonly AttributeField[]>;

/**
 * The field list for one kind, widened to `AttributeField`.
 *
 * `as const satisfies` above narrows every entry to a literal type, which is
 * what makes a missing kind a compile error — but it also means `field.required`
 * does not exist on entries that omit it. Read through here and the optional
 * keys are back.
 */
export function attributeFieldsFor(kind: OfferKind): readonly AttributeField[] {
  return OFFER_ATTRIBUTE_FIELDS[kind];
}

/**
 * Turns a form's raw string values into the types the Zod schema expects.
 *
 * Every HTML input yields a string; `attributes` needs real numbers, booleans
 * and arrays. Empty values are DROPPED rather than sent as null — the schemas
 * mark optional fields `.optional()`, not `.nullable()`, so an empty text box
 * must vanish, not arrive as "".
 */
export function buildAttributes(
  kind: OfferKind,
  raw: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const field of attributeFieldsFor(kind)) {
    const value = raw[field.name];

    if (field.type === 'boolean') {
      // An unchecked checkbox submits nothing at all. Only send `true` —
      // sending `false` for every unticked box would fill the offer page with
      // "not included" rows nobody wants to read.
      if (value === 'on' || value === 'true') out[field.name] = true;
      continue;
    }

    if (field.type === 'multiselect') {
      const list = Array.isArray(value) ? value : value ? [value] : [];
      if (list.length > 0) out[field.name] = list;
      continue;
    }

    if (field.type === 'tags') {
      const text = typeof value === 'string' ? value : '';
      const list = text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      if (list.length > 0) out[field.name] = list;
      continue;
    }

    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;

    if (field.type === 'number') {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) out[field.name] = parsed;
      continue;
    }

    out[field.name] = text;
  }

  return out;
}
