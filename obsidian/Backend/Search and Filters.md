# Search and Filters

Filter by **price**, **destination** and **dates** — the three you named. Plus departure
wilaya, which matters more in Algeria than any of them.

Schema: `packages/shared/src/offers/schemas.ts` (`offerSearchSchema`).
Tests: `schemas.test.ts`.

---

## Every filter

| Filter | Parameter | Notes |
|---|---|---|
| Free text | `q` | title, summary, destination |
| Kind | `kind` | `omra`, `hajj`, `package`, `visa`, `flight`, `hotel`, `transport`. Multiple allowed |
| **Price** | `minPriceCentimes`, `maxPriceCentimes` | integer centimes |
| **Destination** | `destinationCountry`, `destinationCity` | country is ISO-2, auto-uppercased |
| Departure from | `departureWilayaCode` | `"16"` = Alger. Validated against all 58 |
| **Dates** | `departureFrom`, `departureTo` | a **window**, not one day |
| Duration | `minDurationDays`, `maxDurationDays` | |
| Agency | `agencySlug` | that agency's offers only |
| Verified only | `verifiedAgenciesOnly` | **defaults to true** |
| Show flagged | `includeFlaggedDuplicates` | defaults to false |
| Sort | `sort` | `relevance`, `price_asc`, `price_desc`, `departure_soon`, `newest`, `rating_desc` |
| Page size | `limit` | default 20, max 100 |
| Page | `cursor` | see below |

---

## Dates are a window, not a day

`departureFrom` + `departureTo` rather than one `departureDate`.

Because nobody travels on exactly one day. A traveler thinks *"some time in Ramadan"* or
*"July, ideally the first half"*. Asking for one exact date would return almost nothing and
they'd conclude the site is empty.

`Offer.isFlexibleDates` handles the other side of this — "departures every week during
Ramadan" must not be treated as one fixed date.

---

## Every filter maps to an indexed column

This is the rule that keeps search fast, and it's why [[Offer]] is split into columns +
JSON:

> **If users filter or sort by it, it's a real column. Never `attributes`.**

Postgres can't efficiently index a range query inside JSON. `price BETWEEN x AND y` on a
column is instant. On JSON it reads every row — fine with 200 offers, dead at 200 000.

So `priceFromCentimes`, `departureDate`, `destinationCountry` and `departureWilayaCode` are
columns. `mealPlan` isn't — nobody picks a trip by breakfast.

**The one to watch:** distance to the Haram. It's the field Omra buyers care about most and
it's in `attributes` today. The moment you want a "under 300 m" filter, it has to be
promoted to a column. Ask me and I'll do it — it's a small migration.

The indexes that serve these queries:

```
[status, duplicateStatus, kind, departureDate]
[status, duplicateStatus, destinationCountry, priceFromCentimes]
[status, duplicateStatus, departureWilayaCode, departureDate]
```

Column order isn't arbitrary — see [[Indexes and Why Queries Get Slow]].

---

## Two conditions nobody can turn off

Every public search silently adds:

- `status = 'published'`
- the agency is `verified`

`verifiedAgenciesOnly` defaults to `true`, and the endpoint ignores an attempt to set it
false unless the caller is a platform admin. Trust is the product, so the strict option is
the **default**, not a flag someone might forget.

Offers with `duplicateStatus = 'confirmed'` are also out of the default listing — but they
still exist and are still reachable by direct link. See [[Duplicate and Spam Control]].

---

## Query booleans: a real bug, worth understanding

The obvious way to read a boolean from a URL is `z.coerce.boolean()`. It's wrong.

`z.coerce.boolean()` is `Boolean(value)`. In JavaScript, **every non-empty string is
truthy** — including `"false"`, `"0"` and `"no"`. So:

```
?verifiedAgenciesOnly=false   →   true
```

The filter does the exact opposite of what was asked, with no error, no warning, nothing in
the logs. Unverified agencies appear in results and you'd find out from a user.

The fix is an explicit parser: `true/1/yes/on` → true, `false/0/no/off/""` → false, and
anything else is a validation **error** rather than a guess. Twelve tests cover it.

Worth internalising as a pattern: **a "convenient" coercion that can't fail is a coercion
that hides bugs.** Prefer the version that refuses garbage.

---

## Cursor pagination, not page numbers

`?cursor=<id>&limit=20`, not `?page=5`.

Page numbers have two problems that get worse as you grow:

1. **`?page=500` is slow.** The database has to walk 10 000 rows to skip them. Cursors say
   "start after this id" and jump straight there. Same speed at page 1 and page 5 000.
2. **Page numbers show duplicates.** New offers are added while someone browses, everything
   shifts down, and the row that was last on page 1 appears first on page 2. Cursors are
   anchored to a row, so this can't happen.

The technique: fetch `limit + 1` rows. If the extra one exists there's another page, and the
last real row's id is the next cursor. `buildPage()` in
`packages/shared/src/pagination.ts`.

`limit` is capped at 100 — otherwise `?limit=1000000` is a free denial-of-service.

---

## Sorting, and `relevance`

`price_asc`, `departure_soon` and `newest` are obvious. `relevance` is the default and the
interesting one, because it's where you decide what the marketplace rewards.

The ingredients available:

- text match, when there's a `q`
- `Offer.qualityScore` — how completely the listing is filled in
- agency rating (`ratingSum / ratingCount`)
- agency response time (`Lead.firstRespondedAt` averages)
- `−40` for `duplicateStatus = 'suspected'` (`SUSPECTED_DUPLICATE_RANK_PENALTY`)
- `isFeatured` — paid placement, later

> [!important] Ranking is a product decision, not a technical one
> Whatever you rank on, agencies will optimise for. Rank on price and you get a race to
> the bottom and worse trips. Rank on response time and agencies answer faster — good for
> travelers. Rank on completeness and listings get more honest.
>
> Two things worth committing to now: **paid placement must be visibly labelled**, and it
> must not be able to outrank a *badly* rated agency. Selling the top slot to whoever pays
> is how a marketplace loses the trust it spent years earning.

---

## What isn't built yet

- The search endpoint itself (comes with the API)
- Full-text search — Postgres `tsvector`, or trigram matching for typo tolerance. Needs
  Arabic *and* French, so it deserves its own pass
- Facet counts ("Turkey (23)") — a second aggregate query
- Saved searches / price-drop alerts — `SavedOffer` is the seed of this

---

Related: [[Offer]] · [[Duplicate and Spam Control]] ·
[[Indexes and Why Queries Get Slow]] · [[Validation at the Boundary]]
