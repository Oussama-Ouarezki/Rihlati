import type {
  AgencyFaqItem,
  OfferDetail,
  OfferSummary,
  Page,
  TravelerTripView,
} from '@rihlati/shared';

/**
 * The server-side API client. Every page fetches through here, so "how do we
 * talk to the API" has one answer.
 *
 * The base URL is not a secret — it's the same address every browser will
 * call. Server components prefer API_URL (reachable inside the deployment
 * network); the NEXT_PUBLIC_ fallback keeps dev working with zero config.
 */
const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

/** For client components (beacon, inquiry form). Inlined at build time. */
export const PUBLIC_API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

async function get<T>(path: string): Promise<T | null> {
  const response = await fetch(`${API_BASE}${path}`, {
    // Offers change (price edits, seats, pauses) and stale inventory is worse
    // than a slower page. Real caching comes later, with measured numbers.
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    // The page decides what to render; the requestId makes the failure
    // traceable across both apps' logs (rule #4).
    throw new Error(
      `API ${response.status} on ${path} (requestId: ${response.headers.get('x-request-id') ?? '—'})`,
    );
  }
  return (await response.json()) as T;
}

/**
 * The marketplace search.
 *
 * A 422 here means the visitor's filters were out of range — someone typed
 * 99 000 000 into the price box, or edited the URL. That is an EMPTY RESULT,
 * not an error page: showing a crash to someone who typed a big number is a
 * lost visitor. Server errors still throw, because those are ours.
 */
export async function searchOffers(query: URLSearchParams): Promise<Page<OfferSummary> | null> {
  const response = await fetch(`${API_BASE}/v1/offers?${query.toString()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (response.status === 422 || response.status === 404) {
    return { items: [], nextCursor: null };
  }
  if (!response.ok) {
    throw new Error(
      `API ${response.status} on /v1/offers (requestId: ${response.headers.get('x-request-id') ?? '—'})`,
    );
  }
  return (await response.json()) as Page<OfferSummary>;
}

export function getOfferBySlug(slug: string): Promise<OfferDetail | null> {
  return get<OfferDetail>(`/v1/offers/by-slug/${encodeURIComponent(slug)}`);
}

/**
 * A booked family's own trip, by the code in their /mon-voyage link. Returns
 * null for a wrong, expired or cancelled code — the page renders "this link
 * is no longer valid" rather than a crash, because the person reading it is a
 * traveler, not an engineer.
 */
export function getTripByCode(code: string): Promise<TravelerTripView | null> {
  return get<TravelerTripView>(`/v1/trips/${encodeURIComponent(code)}`);
}

export function getAgencyFaq(slug: string): Promise<AgencyFaqItem[] | null> {
  return get<AgencyFaqItem[]>(`/v1/agencies/by-slug/${encodeURIComponent(slug)}/faq`);
}
