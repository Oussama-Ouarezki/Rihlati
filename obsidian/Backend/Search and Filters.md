# Search and Filters

Filter by **price**, **destination** and **dates** — the three you named. Plus departure
wilaya, which matters more in Algeria than any of them.

> [!success] Built
> Schema and query builder: `OfferFilters` and `apply_filters()` in `apps/offers/api.py`.
> Used by `GET /api/offers` **and** by the HTML search page (`apps/pages/views.py::search`).
> Tests in `apps/offers/tests.py`.

---

## Every filter that exists today

| Filter | Parameter | Notes |
|---|---|---|
| Free text | `q` | title FR, title AR, destination city, agency name |
| Kind | `kind` | `omra`, `hajj`, `trip`, `visa` — one at a time |
| **Price** | `price_min`, `price_max` | integer centimes, `ge=0` |
| Departure from | `wilaya` | `"16"` = Alger |
| **Dates** | `date_from`, `date_to` | a **window**, not one day |
| Sort | `sort` | `departure`, `price`, `price_desc`, `recent`, `quality` |
| Page size | `limit` | default 20, **max 50** |
| Page | `offset` | plain offset — see the note below |

The search *page* accepts a friendlier subset: `kind`, `wilaya`, `q`, `sort` and a
`max_price` in whole dinars, which the view multiplies by 100 before handing it to the same
schema. Humans type dinars; the database stores centimes ([[Glossary|centimes]]).

> [!important] One parser, two doors
> `apps/pages/views.py::search` builds an `OfferFilters` from the query string and calls
> `apply_filters` — the same object and the same function the JSON API uses. That is not
> tidiness, it is the whole reason the page and the API cannot come to disagree about what
> "Omra sous 300 000 depuis Oran" means. See [[One Rule, Two Entry Points]].

---

## Dates are a window, not a day

`date_from` + `date_to` rather than one `departure_date`.

Nobody travels on exactly one day. A traveler thinks *"some time in Ramadan"* or *"July,
ideally the first half"*. Asking for one exact date returns almost nothing, and they conclude
the site is empty.

`Offer.is_flexible_dates` handles the other side of this — "departures every week during
Ramadan" must not be treated as one fixed date.

> [!note] The types are the validation
> `date_from: date | None`, not `str`. This is a **public, unauthenticated** route, so the
> garbage arrives without anyone having logged in first. `?date_from=hello` typed as `str`
> reaches the ORM and raises there — a 500, in your logs, at 2am. Typed as `date` it is a 422
> naming the parameter, before a query is built. [[Validation at the Boundary]].

---

## Every filter maps to an indexed column

This is the rule that keeps search fast, and it is why [[Offer]] is split into columns +
JSON:

> **If users filter or sort by it, it is a real column. Never `attributes`.**

Postgres cannot efficiently index a range query inside JSON. `price BETWEEN x AND y` on a
column is instant. On JSON it reads every row — fine with 200 offers, dead at 200 000.

So `price_centimes`, `departure_date`, `destination_country` and `departure_wilaya_code` are
columns. `meal_plan` is not — nobody picks a trip by breakfast.

**The one to watch:** distance to the Haram. It is the field Omra buyers care about most and
it lives in `attributes` today. The moment you want an "under 300 m" filter, it has to be
promoted to a column. That is a small migration; ask.

Column order in a composite index is not arbitrary — see
[[Indexes and Why Queries Get Slow]].

---

## Two conditions nobody can turn off

`apply_filters` never runs on `Offer.objects`. It runs on whatever queryset it is handed,
and both public callers hand it `Offer.publicly_visible()`, which silently adds:

- `status = 'published'`
- the agency's `status = 'verified'`
- the departure has not already left

There is **no parameter to disable any of them**. That is deliberate, and stronger than a
`verified_only=true` default: a default can be overridden by a client that guesses the
parameter name, whereas a condition that lives in the queryset factory has no name to guess.
Trust is the product.

---

## The sort map, and what the marketplace rewards

```python
SORTS = {
    "departure":  ["departure_date"],
    "price":      ["price_centimes"],
    "price_desc": ["-price_centimes"],
    "recent":     ["-created_at"],
    "quality":    ["-quality_score", "departure_date"],
}
```

`sort` is validated by a regex in the schema, and the value is then used as a **dictionary
key** — never interpolated into `order_by()`. A `sort` parameter that reaches an ORM call as
a string is a column-name injection: `?sort=agency__owner__password` is the shape of that
bug. Two lines, and it cannot happen.

> [!important] Ranking is a product decision, not a technical one
> Whatever you rank on, agencies will optimise for. Rank on price and you get a race to the
> bottom and worse trips. Rank on response time and agencies answer faster — good for
> travelers. Rank on completeness and listings get more honest.
>
> `quality` sorts by `quality_score` and then by soonest departure. It deliberately does
> **not** put `is_featured` first. Two things worth committing to now: paid placement must be
> visibly labelled, and it must not outrank a *badly* rated agency. Selling the top slot to
> whoever pays is how a marketplace loses the trust it spent years earning.

---

## `q` is deliberately naive

```python
Q(title_fr__icontains=...) | Q(title_ar__icontains=...) | ...
```

`icontains` is `ILIKE '%…%'` — it cannot use an index, it has no typo tolerance, and it does
not know that "عمرة" and "omra" are the same search.

It is still the right first step. It is **correct**, it works on SQLite so the test suite
needs no service, and it can be replaced without changing a single caller — every filter goes
through `apply_filters`, so the swap to `SearchVector`/`pg_trgm` is one function body. The
wrong move would be reaching for full-text search now and paying for a Postgres-only test
suite before anyone has typed a query.

Full-text search needs to handle **Arabic and French**, which is a real piece of work and
deserves its own pass. Noted below.

---

## Offset pagination, and why it is a debt

`?limit=20&offset=40`. The NestJS repo uses a cursor (`?cursor=<id>`), and the cursor is the
better design for two reasons that get worse as you grow:

1. **`?offset=10000` is slow.** The database walks 10 000 rows in order to skip them. A
   cursor says "start after this id" and jumps straight there — the same speed at page 1 and
   at page 5 000.
2. **Offsets show duplicates.** New offers arrive while someone browses, everything shifts
   down, and the row that was last on page 1 appears first on page 2.

Offset is here because it is four characters of code and this catalogue has five offers in
it. Written down rather than quietly shipped, because the day it starts hurting nobody will
remember it was a choice.

`limit` is capped at **50 in the schema field itself**, not clamped in the handler.
`?limit=1000000` is a free denial of service, and the cap belongs somewhere that the next
person writing a list endpoint cannot forget it.

---

## What is not built yet

- **Full-text search** — Postgres `tsvector`, or trigram matching for typo tolerance. Needs
  Arabic *and* French.
- **Cursor pagination**, per the section above.
- **Facet counts** ("Turquie (23)") — a second aggregate query, and a real cost on every
  search.
- **Multiple `kind` values at once.** One at a time today.
- **Saved searches / price-drop alerts.**
- **A next-page link on the HTML search page.** The API paginates; the page does not surface
  it yet.

---

## Open questions — yours to decide

- **What should the default sort be?** It is `departure` (soonest first) today, which is
  honest and favours nobody. `quality` would push agencies to fill their listings in. This is
  the single most consequential product lever in the app.
- **Should an unverified agency's offer ever be findable by direct link?** Today: no, at all,
  anywhere. That is the safe answer and it also means an agency cannot preview its own live
  page before verification.
- **Distance to the Haram: promote it to a column now or wait?** Waiting is cheap; the
  migration is small either way.

---

Related: [[Offer]] · [[One Rule, Two Entry Points]] · [[API Endpoints]] ·
[[Duplicate and Spam Control]] · [[Indexes and Why Queries Get Slow]] ·
[[Validation at the Boundary]] · [[Templates and Pages]]
