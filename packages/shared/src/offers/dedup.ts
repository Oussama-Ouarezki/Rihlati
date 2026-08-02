import type { OfferKind } from '../enums';

/**
 * DUPLICATE OFFER DETECTION
 *
 * Two things cause duplicates in this market:
 *   1. the same agency re-posting a trip instead of editing the old one
 *   2. several agencies reselling the *same* package from one wholesaler
 *
 * Case 1 should be merged. Case 2 must NOT be — those are genuinely different
 * sellers at different prices, and collapsing them would hide the comparison
 * that makes the marketplace useful. So the fingerprint is scoped per-agency,
 * and cross-agency similarity is only ever a suggestion for a human to judge.
 *
 * Nothing here merges anything on its own. Both paths produce a review record;
 * a person decides. Silent merging of a seller's listing is not a bug you get
 * to discover in production.
 *
 * This file only NORMALIZES. Hashing happens in the API (node:crypto), because
 * this package must stay usable in a browser and in React Native.
 */

/** Strips accents, punctuation, case and filler words so titles compare fairly. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    // combining marks: é -> e
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Arabic diacritics and tatweel
    .replace(/[ً-ْـ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !TITLE_STOPWORDS.has(word))
    .sort()
    .join(' ');
}

/**
 * Words that carry no distinguishing information in an offer title.
 * Sorted-token comparison means "Omra Ramadan 2026" and "2026 Omra Ramadan"
 * produce the same key, which is exactly the re-post case.
 */
const TITLE_STOPWORDS = new Set([
  // --- French grammar ---
  'de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'ou', 'a', 'au', 'aux',
  'en', 'pour', 'avec', 'sans', 'par', 'sur', 'dans', 'vers', 'chez',
  // --- French marketing filler. NOTE: matched AFTER accents are stripped, so
  // these must be written without accents ("speciale", not "spéciale"). Gendered
  // and plural forms are listed explicitly — there is no stemming here.
  'offre', 'offres', 'promo', 'promos', 'promotion', 'promotions',
  'special', 'speciale', 'speciales', 'speciaux',
  'nouveau', 'nouvelle', 'nouveaux', 'nouvelles',
  'depart', 'departs', 'depuis', 'destination',
  'disponible', 'disponibles', 'place', 'places', 'reste', 'restantes',
  'inclus', 'incluse', 'incluses', 'tout', 'toute', 'tous', 'toutes',
  'prix', 'partir', 'exclusif', 'exclusive', 'derniere', 'dernieres',
  'jour', 'jours', 'nuit', 'nuits', 'personne', 'personnes', 'pers',
  // --- Arabic grammar + filler (diacritics already stripped) ---
  'من', 'الى', 'إلى', 'في', 'مع', 'بدون', 'او', 'أو', 'و',
  'عرض', 'عروض', 'خاص', 'خاصة', 'جديد', 'جديدة', 'تخفيض', 'اسعار', 'سعر',
  'ليلة', 'ليالي', 'ايام', 'أيام', 'يوم', 'شخص', 'اماكن', 'متوفرة', 'انطلاق',
  // --- English ---
  'the', 'and', 'from', 'with', 'for', 'all', 'new', 'offer', 'offers',
  'special', 'day', 'days', 'night', 'nights', 'person', 'departure',
]);

export interface FingerprintInput {
  agencyId: string;
  kind: OfferKind;
  title: string;
  departureDate?: string | null;
  destinationCountry?: string | null;
  destinationCity?: string | null;
  departureWilayaCode?: string | null;
}

/**
 * Builds the string the API hashes into `Offer.fingerprint`.
 *
 * Includes `agencyId`, so an exact match always means "this agency already
 * posted this trip".
 *
 * PRICE IS DELIBERATELY EXCLUDED. Changing a price is the single most common
 * edit an agency makes, and it must not turn one offer into two. Identity is
 * "who is selling what trip, leaving from where, on what date" — the price is
 * an attribute of that offer, not part of what makes it that offer.
 *
 * An exact match is a strong signal but NOT an automatic merge: two genuinely
 * different tiers of the same trip can share every field here. The API records
 * an OfferDuplicateCandidate and prompts the agency ("you already posted this —
 * update it instead?"). A human always decides.
 */
export function offerFingerprintSource(input: FingerprintInput): string {
  return [
    'v1',
    input.agencyId,
    input.kind,
    input.destinationCountry?.toUpperCase() ?? '-',
    input.destinationCity?.trim().toLowerCase() ?? '-',
    input.departureWilayaCode ?? '-',
    input.departureDate ?? '-',
    normalizeTitle(input.title),
  ].join('|');
}

/**
 * Cheap similarity for the cross-agency "is this the same trip?" suggestion.
 * Jaccard overlap of normalized title tokens, 0..1.
 *
 * Deliberately simple. Better matching (trigram indexes, embeddings) is a
 * later optimization; the admin review queue means a mediocre score is
 * harmless — it only decides what a human looks at first.
 */
export function titleSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Above this, a cross-agency pair is queued for admin review. */
export const DUPLICATE_REVIEW_THRESHOLD = 0.72;
