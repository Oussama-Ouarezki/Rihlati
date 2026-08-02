import { z } from 'zod';
import { type OfferKind } from '../enums';

/**
 * ===========================================================================
 * THE EXTENSIBILITY MECHANISM
 * ===========================================================================
 *
 * Every offer shares a skeleton of real database columns (price, dates,
 * destination, seats) because those are what users filter and sort by.
 *
 * Everything that is specific to ONE kind of offer lives here, and is stored in
 * a single `attributes` JSON column. Because each kind has a strict schema,
 * that column is not a junk drawer — unknown fields are rejected at the door.
 *
 * TO ADD A NEW OFFER TYPE (e.g. "cruise"):
 *   1. add 'cruise' to OFFER_KINDS in ../enums.ts
 *   2. add 'cruise' to `enum OfferKind` in prisma/schema.prisma
 *   3. write cruiseAttributesSchema below
 *   4. add it to `offerAttributeSchemas`
 *
 * No database migration of existing rows. TypeScript refuses to compile until
 * step 4 is done, so a half-added type cannot ship.
 *
 * THE ONE RULE: if users will FILTER or SORT by a field, it does NOT belong
 * here — promote it to a real column in schema.prisma. JSON cannot be indexed
 * efficiently for range queries.
 */

// ---------------------------------------------------------------------------
// Shared vocabularies — reused across kinds so the UI can render one component
// ---------------------------------------------------------------------------

export const MEAL_PLANS = ['none', 'breakfast', 'half_board', 'full_board', 'all_inclusive'] as const;
export const mealPlanSchema = z.enum(MEAL_PLANS);
export type MealPlan = (typeof MEAL_PLANS)[number];

export const ROOM_OCCUPANCIES = ['single', 'double', 'triple', 'quad', 'quint'] as const;
export const roomOccupancySchema = z.enum(ROOM_OCCUPANCIES);
export type RoomOccupancy = (typeof ROOM_OCCUPANCIES)[number];

export const TRANSPORT_MODES = [
  'flight_direct',
  'flight_connecting',
  'bus',
  'boat',
  'own_transport',
] as const;
export const transportModeSchema = z.enum(TRANSPORT_MODES);

export const CABIN_CLASSES = ['economy', 'premium_economy', 'business', 'first'] as const;

export const VISA_TYPES = [
  'schengen',
  'tourist',
  'umrah',
  'hajj',
  'student',
  'work',
  'business',
  'transit',
  'family_visit',
] as const;
export const visaTypeSchema = z.enum(VISA_TYPES);

export const GROUP_LANGUAGES = ['ar', 'fr', 'both'] as const;

const hotelStars = z.number().int().min(1).max(5);
const nights = z.number().int().min(0).max(90);
const distanceMeters = z.number().int().min(0).max(50_000);
const shortText = z.string().trim().max(160);
const longText = z.string().trim().max(1000);
/** ISO-3166 alpha-2, uppercased. "SA", "TR", "AE". */
const countryCode = z.string().trim().length(2).toUpperCase();

// ---------------------------------------------------------------------------
// omra
// ---------------------------------------------------------------------------

/**
 * Distance to the Haram is the single most important field in this market —
 * it is what price differences actually reflect. Buyers compare on it, so if
 * you ever let users filter by it, promote it to a column.
 */
export const omraAttributesSchema = z.strictObject({
  // Makkah
  makkahHotelName: shortText.optional(),
  makkahHotelStars: hotelStars.optional(),
  makkahDistanceToHaramMeters: distanceMeters.optional(),
  nightsInMakkah: nights.optional(),

  // Madinah
  madinahHotelName: shortText.optional(),
  madinahHotelStars: hotelStars.optional(),
  madinahDistanceToHaramMeters: distanceMeters.optional(),
  nightsInMadinah: nights.optional(),

  // Stay
  roomOccupancy: roomOccupancySchema.optional(),
  mealPlan: mealPlanSchema.optional(),

  // Travel
  transportMode: transportModeSchema.optional(),
  airline: shortText.optional(),

  // Inclusions — these drive the comparison table on the offer page
  visaIncluded: z.boolean().optional(),
  guideIncluded: z.boolean().optional(),
  ziyaratIncluded: z.boolean().optional(),
  localTransportIncluded: z.boolean().optional(),
  insuranceIncluded: z.boolean().optional(),
  mealsIncluded: z.boolean().optional(),

  // Group
  groupLanguage: z.enum(GROUP_LANGUAGES).optional(),
  womenOnlyGroupAvailable: z.boolean().optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// hajj — omra plus the pilgrimage-specific parts
// ---------------------------------------------------------------------------

export const hajjAttributesSchema = omraAttributesSchema.extend({
  hajjType: z.enum(['tamattu', 'ifrad', 'qiran']).optional(),
  /**
   * Hajj is quota-regulated. This is a reference an admin verifies by hand;
   * it is NOT proof of anything on its own — never present it as a guarantee.
   */
  quotaReference: shortText.optional(),
  minaTentCategory: z.enum(['standard', 'upgraded', 'vip']).optional(),
  arafatServices: longText.optional(),
  nightsInMina: nights.optional(),
});

// ---------------------------------------------------------------------------
// package — organized trips (Turkey, Dubai, Tunisia, Egypt...)
// ---------------------------------------------------------------------------

export const PACKAGE_THEMES = [
  'beach',
  'city',
  'culture',
  'shopping',
  'nature',
  'medical',
  'honeymoon',
  'family',
  'ski',
  'desert',
] as const;

export const packageAttributesSchema = z.strictObject({
  hotelName: shortText.optional(),
  hotelStars: hotelStars.optional(),
  nights: nights.optional(),
  mealPlan: mealPlanSchema.optional(),
  roomOccupancy: roomOccupancySchema.optional(),

  transportMode: transportModeSchema.optional(),
  airline: shortText.optional(),

  visaIncluded: z.boolean().optional(),
  insuranceIncluded: z.boolean().optional(),
  airportTransferIncluded: z.boolean().optional(),
  guideIncluded: z.boolean().optional(),

  excursions: z.array(shortText).max(30).optional(),
  themes: z.array(z.enum(PACKAGE_THEMES)).max(6).optional(),
  childPolicy: longText.optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// visa — a service, not a trip. Note the required fields.
// ---------------------------------------------------------------------------

export const visaAttributesSchema = z.strictObject({
  visaType: visaTypeSchema,
  targetCountry: countryCode,

  processingDays: z.number().int().min(1).max(365).optional(),
  consulateCity: shortText.optional(),

  appointmentIncluded: z.boolean().optional(),
  documentReviewIncluded: z.boolean().optional(),
  translationIncluded: z.boolean().optional(),
  insuranceIncluded: z.boolean().optional(),
  /**
   * Deliberately NOT a "success rate" field. Advertising an approval
   * percentage for a consular decision is a claim no agency can substantiate,
   * and it is the exact promise scam agencies make. Keep it out of the schema.
   */
  refundIfRefused: z.boolean().optional(),
  requiredDocuments: z.array(shortText).max(40).optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// flight
// ---------------------------------------------------------------------------

export const flightAttributesSchema = z.strictObject({
  tripType: z.enum(['one_way', 'round_trip', 'multi_city']),
  airline: shortText.optional(),
  cabinClass: z.enum(CABIN_CLASSES).optional(),
  /** IATA codes, e.g. "ALG", "IST". */
  originAirportIata: z.string().trim().length(3).toUpperCase().optional(),
  destinationAirportIata: z.string().trim().length(3).toUpperCase().optional(),
  stops: z.number().int().min(0).max(4).optional(),
  checkedBaggageKg: z.number().int().min(0).max(100).optional(),
  cabinBaggageKg: z.number().int().min(0).max(30).optional(),
  refundable: z.boolean().optional(),
  changeable: z.boolean().optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// hotel
// ---------------------------------------------------------------------------

export const HOTEL_AMENITIES = [
  'wifi',
  'pool',
  'spa',
  'gym',
  'parking',
  'airport_shuttle',
  'restaurant',
  'family_rooms',
  'air_conditioning',
  'prayer_room',
] as const;

export const hotelAttributesSchema = z.strictObject({
  hotelName: shortText,
  hotelStars: hotelStars.optional(),
  nights: nights.optional(),
  mealPlan: mealPlanSchema.optional(),
  roomOccupancy: roomOccupancySchema.optional(),
  amenities: z.array(z.enum(HOTEL_AMENITIES)).max(20).optional(),
  distanceToCityCentreMeters: distanceMeters.optional(),
  cancellationPolicy: longText.optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export const transportAttributesSchema = z.strictObject({
  vehicleType: z.enum(['bus', 'minibus', 'car', 'van', 'suv_4x4']),
  seats: z.number().int().min(1).max(80).optional(),
  /** How the column price should be read. The amount itself stays a column. */
  pricingUnit: z.enum(['per_day', 'per_trip', 'per_person']).optional(),
  withDriver: z.boolean().optional(),
  airConditioned: z.boolean().optional(),
  routeDescription: longText.optional(),
  notes: longText.optional(),
});

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------

/**
 * `satisfies Record<OfferKind, ...>` is the compile-time guarantee that every
 * offer kind has a schema. Add a kind to the enum without adding it here and
 * the build fails — which is exactly what you want.
 */
export const offerAttributeSchemas = {
  omra: omraAttributesSchema,
  hajj: hajjAttributesSchema,
  package: packageAttributesSchema,
  visa: visaAttributesSchema,
  flight: flightAttributesSchema,
  hotel: hotelAttributesSchema,
  transport: transportAttributesSchema,
} as const satisfies Record<OfferKind, z.ZodTypeAny>;

export type OfferAttributesByKind = {
  [K in OfferKind]: z.infer<(typeof offerAttributeSchemas)[K]>;
};

export type AnyOfferAttributes = OfferAttributesByKind[OfferKind];

/** Throws a ZodError on invalid input. Use inside a validation pipe. */
export function parseOfferAttributes<K extends OfferKind>(
  kind: K,
  input: unknown,
): OfferAttributesByKind[K] {
  return offerAttributeSchemas[kind].parse(input) as OfferAttributesByKind[K];
}

/** Non-throwing variant, for forms that want field-level errors. */
export function safeParseOfferAttributes<K extends OfferKind>(
  kind: K,
  input: unknown,
): z.SafeParseReturnType<unknown, OfferAttributesByKind[K]> {
  return offerAttributeSchemas[kind].safeParse(input) as z.SafeParseReturnType<
    unknown,
    OfferAttributesByKind[K]
  >;
}

/**
 * Discriminated union of `{ kind, attributes }`. Narrowing on `kind` gives the
 * correct attribute type with no casting — this is what makes the offer form
 * type-safe per kind in both the web and mobile apps.
 */
export const offerKindWithAttributesSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('omra'), attributes: omraAttributesSchema }),
  z.object({ kind: z.literal('hajj'), attributes: hajjAttributesSchema }),
  z.object({ kind: z.literal('package'), attributes: packageAttributesSchema }),
  z.object({ kind: z.literal('visa'), attributes: visaAttributesSchema }),
  z.object({ kind: z.literal('flight'), attributes: flightAttributesSchema }),
  z.object({ kind: z.literal('hotel'), attributes: hotelAttributesSchema }),
  z.object({ kind: z.literal('transport'), attributes: transportAttributesSchema }),
]);

export type OfferKindWithAttributes = z.infer<typeof offerKindWithAttributesSchema>;
