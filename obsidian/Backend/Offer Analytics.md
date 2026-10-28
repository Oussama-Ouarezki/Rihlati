# Offer Analytics

> [!success] Built
> Table: `OfferDailyMetric` in `apps/offers/models.py`. Writer: `record_metric()` in
> `apps/offers/api.py`. Endpoint: `GET /api/agencies/{agency_id}/offers/{offer_id}/metrics`
> in `apps/offers/api.py`. Tests: `OfferAnalyticsTests` in `apps/offers/tests.py` (6 cases).

The agency's "how are my posts doing?" numbers: **views, inquiries and tracked-link clicks,
per offer, per day** — the time series behind the dashboard chart.

---

## The design in one sentence

Daily counter rows, not an event stream — one row per (offer, day), incremented atomically,
so the chart is a single indexed range scan forever.

**Why not log every event?** An events table is the "proper" answer and the wrong one here.
Millions of click rows buy you nothing an agency acts on — they act on *days* — and cost
you storage, slow charts, and a growing pile of personal-ish data (rule #4 gets harder the
more you keep). Counters per day are also anonymous by construction: there is no row that
says *this person looked at this offer*, so there is nothing to leak. If per-event detail
is ever truly needed, an events table can be added *then*; the rollups stay valid alongside it.

## What counts, and from where

Three counters exist. That is the whole list — the model has `views`, `inquiries` and
`link_clicks`, and nothing else.

| Column | Recorded when | Where |
|---|---|---|
| `views` | the public offer page is rendered | `apps/pages/views.py::offer_detail` (GET branch) and `apps/offers/api.py::public_offer` |
| `inquiries` | a lead is actually created | `apps/leads/api.py::create_inquiry` and the HTML form in `apps/pages/views.py` — **inside the same `transaction.atomic()` as the lead** |
| `link_clicks` | someone taps a tracked campaign link | `apps/pages/views.py::tracked_link_redirect` |

Three things worth knowing before you read a chart from this:

- **Views are noisy.** Crawlers and bots count. A page render is a view; nobody is
  fingerprinting the reader to decide whether they're a person. These are *trend* numbers
  for the agency's own eyes, not accounting — the UI says "vues", never "visiteurs".
- **Inquiries are counted in the lead's transaction**, so the chart and the inbox can never
  disagree. If the lead insert rolls back, so does the increment.
- **A tracked-link tap is counted twice, on purpose.** `TrackedLink.click_count` answers
  "did this Facebook post work"; the offer's `link_clicks` answers "where did this offer's
  traffic come from this week". Same tap, two questions, and one number cannot be both.
  See [[Tracked Links]].

## Why `F()` and not `+= 1`

```python
row, _ = OfferDailyMetric.objects.get_or_create(offer=offer, day=timezone.localdate(), ...)
OfferDailyMetric.objects.filter(pk=row.pk).update(**{field: models.F(field) + 1})
```

`F()` makes the increment one atomic `UPDATE ... SET views = views + 1` in the database.
The obvious version — read the row into Python, add one, save — loses an increment whenever
two workers do it at the same moment, which on a busy offer is the normal case, not the
edge case. Undercounting quietly is worse than not counting: an agency will make decisions
on these numbers.

The unique constraint `one_metric_row_per_offer_day` is what makes `get_or_create` safe.
Two concurrent first-views of the day race to create the row; one of them loses on the
constraint and retries into the existing row instead of creating a duplicate.

## The endpoint

`GET /api/agencies/{agency_id}/offers/{offer_id}/metrics?days=30` — member only.

Two lines do the security, and they are the same two lines as every other agency route:

```python
require_membership(request.user, agency_id)
offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
```

`scoped()` means another agency's offer id returns **404, not 403** — a foreign id must be
indistinguishable from a missing one ([[Multi-Tenancy]]). There is a test for exactly that.
`days` is bounded `1..365` by the schema, so `days=99999` is a 422 at the boundary rather
than a full table scan ([[Validation at the Boundary]]).

> [!warning] Two things the NestJS note promised that this port does not do
> - **No zero-filling.** The endpoint returns only the days that have rows. A day with no
>   activity is simply absent, and the caller has to fill the gap. The NestJS version
>   returned exactly `days` points. Cheap to add — one dict lookup over a date range — but
>   it is not there today, so don't write a chart that assumes it.
> - **No plan gate.** Any member can read the series. See the section below.

## Collect always, show for paying

The intended decision, unchanged:

> **Collection is never plan-gated. Only the dashboard is.**

Time-series data cannot be backfilled. If collection started when an agency upgraded, their
first day on `pro` would show an empty chart — the upgrade would feel like a scam. Instead
a `free` agency's history accrues silently from day one, and upgrade day opens onto a full
chart. That chart *is* the upsell.

> [!danger] Only the first half is built
> Collection happens for everyone — that part is real and, being the irreversible half,
> is the one that mattered to get right early. The **gate on reading** is not built:
> `offer_metrics` checks membership and stops. There is no `has_feature()` helper in this
> port, so no route can be plan-gated yet. See [[Plan Limits and Quotas]].

## Which day is a day?

`timezone.localdate()`, and `TIME_ZONE` is `"UTC"` in `config/settings.py`. So buckets are
**UTC calendar days**, not Algiers days.

> [!warning] This is a known, deliberate deviation — and a small bug in waiting
> Algeria is UTC+1 with no daylight saving, so the two calendars differ by one hour. A view
> at 00:30 Algiers time lands in *yesterday's* bucket. An agency comparing the chart against
> their own memory of the evening would be right to call it wrong.
>
> It is not fixed yet because the fix has a choice inside it: either flip `TIME_ZONE` to
> `Africa/Algiers` (changes every date in the app, including departure dates and the
> manifest) or pass an explicit timezone to `localdate()` here only (two lines, but now two
> notions of "today" live in the codebase). The first is almost certainly right — storage
> stays UTC either way because `USE_TZ = True` — but it touches [[Trip Programme]] dates and
> deserves its own change. Flagged rather than smuggled in ([[The Seven Rules|rule #7]]).

## What joins this picture later

- **Response-time analytics** from `first_responded_at` on [[Lead]] — already recorded, not
  yet aggregated anywhere.
- The **[[Agency Chatbot]]**'s unanswered questions — demand data from the same audience.

## Open questions — yours

- **WhatsApp and phone taps.** The original design tracked these via a browser beacon
  (`POST /offers/{id}/events`), because the server cannot see a tap on a `wa.me` link.
  Not built here, and not in the schema. Worth it? It is the metric closest to "did this
  offer earn money", and it is also a public write endpoint someone can spam — bounded, since
  it could only ever bump two counters on a *published* offer, but still a surface.
- Should `free` agencies get a **teaser** (total views on each offer in their list, chart
  locked)? Good anchor mechanics, one small change once feature gates exist.
- How long to keep daily rows? They're tiny (offers × days), so "forever" is fine for years
  — but decide before someone asks in a data-protection context.

---

Related: [[Plan Limits and Quotas]] · [[API Endpoints]] · [[Tracked Links]] ·
[[Multi-Tenancy]] · [[Lead]] · [[The Seven Rules]] · [[Vision and Roadmap]]
