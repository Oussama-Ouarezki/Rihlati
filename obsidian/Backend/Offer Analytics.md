# Offer Analytics

> [!success] Built
> Code: `apps/api/src/modules/offers/offer-metrics.service.ts`, table
> `offer_metrics_daily`. Tests: `apps/api/test/offer-analytics.e2e.test.ts` (8 cases).

The agency's "how are my posts doing?" numbers: **views, WhatsApp taps, phone taps and
inquiries, per offer, per day** — the time series behind the dashboard chart and the
foundation of the analytics agencies pay for.

---

## The design in one sentence

Daily counter rows, not an event stream — one row per (offer, day), incremented atomically,
so the chart is a single indexed range scan forever.

**Why not log every event?** An events table is the "proper" answer and the wrong one here.
Millions of click rows buy you nothing an agency acts on — they act on *days* — and cost
you storage, slow charts, and a growing pile of personal-ish data (rule #4 gets harder the
more you keep). If per-event detail is ever truly needed, an events table can be added
*then*; the rollups stay valid alongside it.

## Collect always, show for paying

The single most important decision in this feature:

> **Collection is never plan-gated. Only the dashboard is.**

Time-series data cannot be backfilled. If collection started when an agency upgraded, their
first day on `pro` would show an empty chart — the upgrade would feel like a scam. Instead
a `free` agency's history accrues silently from day one, and upgrade day opens onto a full
chart. That chart *is* the upsell. (There is a test proving both halves: free is refused
the endpoint with `402 FEATURE_NOT_IN_PLAN`, and the data accrued anyway.)

## What counts, and from where

| Metric | Recorded when | How |
|---|---|---|
| `views` | public offer page fetched | server-side, in `getPublicBySlug` |
| `whatsappClicks` / `phoneClicks` | traveler taps the contact button | browser beacon `POST /offers/{id}/events` — the server can't see a tap on a `wa.me` link on its own |
| `inquiries` | a lead is actually created | **inside the same transaction** as the lead, so chart and inbox can never disagree; the 6-hour dedupe means a double-submit is one everywhere |

Two honesty notes, told to you now rather than discovered later:

- **Views are noisy.** Crawlers and bots count. These are *trend* numbers for the agency's
  own eyes, not accounting — say "views" in the UI, never "visitors".
- **The beacon is public and therefore spammable** in principle. Accepted: it can only
  increment two counters on a *published* offer, so the worst abuse is an agency flattering
  its own chart, and the rate limit bounds the noise. A metrics failure never breaks the
  page — the counter write swallows its own errors.

## Days are Algiers days

Buckets use the **Algiers calendar day**, not UTC. Algeria is UTC+1 with no daylight-saving
time, so this is a fixed one-hour shift — no timezone library. Why it matters: a view at
00:30 local would land on "yesterday" in UTC buckets, and the agency comparing the chart to
their own memory of the evening would rightly call it wrong.

## The endpoint

`GET /v1/agencies/{agencyId}/analytics/offers?days=30&offerId=` — member, plan-gated.

Returns a **zero-filled** series (exactly `days` points — charts plot it without patching
holes), window totals, and the top 10 offers by views. `offerId` narrows to one offer and
404s if it isn't yours — a foreign id must be indistinguishable from a missing one, the
same rule as everywhere ([[Multi-Tenancy]]).

## What joins this picture later

- **[[Vision and Roadmap|Tracked links]]** (task #10): click→inquiry conversion per named
  link — "your Facebook post brought 40 clicks and 3 clients" lands next to these numbers.
- **Response-time analytics** from `firstRespondedAt` on [[Lead]] — already recorded.
- The **[[Agency Chatbot]]**'s unanswered questions — demand data from the same audience.

## Open questions — yours

- Should `free` agencies get a **teaser** (e.g. total views on each offer in their list,
  chart locked)? Good anchor mechanics; one small endpoint change when you decide.
- How long to keep daily rows? They're tiny (offers × days), so "forever" is fine for
  years — but decide before someone asks in a data-protection context.

---

Related: [[Plan Limits and Quotas]] · [[API Endpoints]] · [[Search and Filters]] ·
[[Lead]] · [[The Seven Rules]] · [[Vision and Roadmap]]
