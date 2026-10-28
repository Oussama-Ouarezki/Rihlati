# Offer

One thing an agency sells: an Omra package, an organised trip, visa assistance.

Defined in `apps/offers/models.py`. This is the table whose design most directly answers the
worry *"I don't know all my features yet, I want it easy to change"* — so read the section on
columns-vs-JSON twice.

---

## The four groups of columns

| Group | Columns |
|---|---|
| **Identity** | `agency`, `title_fr`, `title_ar`, `slug`, `description`, `kind`, `cover_image_url` |
| **What people filter by** | `price_centimes`, `price_to_centimes`, `departure_date`, `return_date`, `is_flexible_dates`, `departure_wilaya_code`, `destination_country`, `destination_city`, `seats_total`, `seats_left`, `status`, `expires_at` |
| **Kind-specific** | `attributes` (JSON) |
| **Server-owned** | `is_featured`, `featured_until`, `quality_score`, `fingerprint`, `duplicate_status`, `duplicate_of`, `report_count` |

That fourth group is the one to notice. The comment above it in the model reads:

```python
# --- server-owned. Never in an input schema, never in a form. --------
```

Every one of those is a field an agency would love to set and must never be able to.
`is_featured` is the ad inventory you plan to sell; `quality_score` is the search ranking;
`duplicate_status` is the moderation verdict on itself. `OfferIn` and `OfferForm` both omit all
seven, and `ServerOwnedFieldTests` runs the attack and asserts it's rejected. See
[[Validation at the Boundary]].

Two details easy to skim past:

**`departure_date` is a `DateField`, not a `DateTimeField`.** A trip leaves on a day, not at
14:32:07 UTC. Storing it as a timestamp means it shifts across midnight depending on the
reader's timezone, and a Ramadan departure showing as the day before is a support ticket you
can't reproduce.

**`cover_image_url` is a URL, not an upload.** Photos live on whatever host the agency already
uses until [[Image Uploads]] moves them to a bucket. Files never go in the database — see that
note for why, and for what this interim decision costs.

---

## Shared columns + kind-specific JSON

An Omra package and a Schengen visa service have almost nothing in common. Three ways to handle
that:

1. **One table with every possible column.** 120 columns, 100 of them `NULL` on any given row.
   Every new offer type is a migration. Unmaintainable.
2. **A separate table per kind.** Clean per kind — until "everything under 300 000 DZD leaving
   from Oran in March" means querying seven tables and merging by hand. Sorting across them is
   worse.
3. **Shared columns + typed JSON.** ← the design.

```
Offer
├── COLUMNS  (the same for every kind — what people filter by)
│     agency, kind, status, title_fr, title_ar, price_centimes,
│     departure_date, departure_wilaya_code, seats_total, seats_left
│
└── attributes  (JSONField — different per kind)
      kind = "omra"  → nights_in_madinah, haram_distance_m, room_occupancy…
      kind = "trip"  → hotel_stars, meal_plan, excursions…
      kind = "visa"  → visa_type, target_country, processing_days…
```

Search only ever touches the columns, so it stays one fast indexed query. The kind-specific
parts ride along in JSON.

### The one rule that keeps this from rotting

> **If a user will filter or sort by it, it must be a real column — not `attributes`.**

Postgres cannot efficiently index a *range* query inside JSON. `price_centimes BETWEEN x AND y`
on a column is instant; the same inside JSON reads every row in the table.

That's why price, departure date, wilaya and kind are columns, and why `meal_plan` isn't —
nobody filters a trip by breakfast.

Distance to the Haram is the interesting borderline. It's the field Omra buyers care about
most, and price differences largely reflect it. It belongs in `attributes` — until you want a
"moins de 300 m du Haram" filter, at which point it must become a column. That promotion *is* a
migration, but a small one, and that is the right moment to pay for it.

> [!danger] Honest state — `attributes` has no schema, so it currently has no rules
> The column exists: `models.JSONField(default=dict, blank=True)`. `OfferIn` types it `dict`.
> **That means any JSON object is accepted.** `{"nightsInMaccah": "yes please"}` — a typo and a
> wrong type in one value — returns `201`.
>
> `Strict` protects the *top level* of every payload; nothing protects the inside of a blob.
> The NestJS repo has a per-kind Zod schema and a test asserting every kind has one. Here the
> equivalent belongs in `apps/common/validators.py`, called from both `OfferIn` and
> `OfferForm` — the two-doors problem from [[One Rule, Two Entry Points]] — and unknown keys
> must be **rejected**, not ignored, or you store fields nothing reads and find out months
> later.
>
> **This is the single riskiest unfinished thing in the schema**, because every day it stays
> open is more junk to clean up. See [[Known Gaps]].

---

## Status, publishing, and the quota

```
draft ──► published ──► archived
```

Three states, and — unlike [[Agency]] — **no transition table**. Moving between them is done by
two dedicated endpoints, not by writing to a field:

```python
@agency_router.post(".../offers/{uuid:offer_id}/publish")
def publish_offer(request, agency_id, offer_id):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    if not agency.is_verified:
        raise HttpError(403, ...)
    assert_can_publish(agency, exclude_pk=offer.pk)
    ...
```

Four things happen in those five lines, and each is a rule from a different note:

1. `require_membership(..., MANAGER)` — an agent hired last week cannot publish. *Authorization*
   ([[Authentication vs Authorization]]).
2. `scoped(...)` — you can only publish *your own* offer, and someone else's id is a 404.
   *Tenancy* ([[Multi-Tenancy]]).
3. `agency.is_verified` — an unverified agency cannot publish at all. *The product*
   ([[Agency Verification]]).
4. `assert_can_publish` — the free plan stops at five. *The quota* ([[Plan Limits and Quotas]]),
   returning `409` because you're entitled to publish, just not a sixth one.

**`status` is not in `OfferIn` or `OfferForm`.** That is the design: a status you change by
calling `/publish` is a status with four checks attached; a status you change by `PUT`ing a
field is a status with none. Making the state change its own endpoint is what gives you
somewhere to put the rules.

> [!info] Why no `STATUS_TRANSITIONS` dict here, when `Agency` has one
> `Agency` has five states and a genuinely branching graph — rejected loops back, suspended is
> reversible, some moves are staff-only and some are owner-only. A table earns its keep.
>
> `Offer` has three states and two endpoints, one per legal move. The endpoint *is* the
> transition table. Adding a `pending_review` state would tip the balance the other way, and
> that is the moment to copy `Agency`'s dict rather than add a third endpoint.

`expires_at` exists and `Offer.is_expired` reads it. Stale listings are the top complaint on
every marketplace — a traveler calling about a trip that left four months ago is how a
marketplace starts feeling dead.

---

## Only published offers from verified agencies are public

```python
@classmethod
def publicly_visible(cls):
    return cls.objects.filter(
        status=cls.PUBLISHED,
        agency__status=Agency.VERIFIED,
    ).exclude(duplicate_status=cls.CONFIRMED_DUPLICATE)
```

Three conditions nobody can turn off, in one named place with four callers: the API list, the
API detail, the search page, and the inquiry endpoint. **That last one is the non-obvious
one** — it's what stops a traveler submitting an inquiry against a draft offer whose id they
guessed.

Writing `filter(status="published")` inline instead would work, four times, until the fifth
caller forgets `agency__status` and an unverified agency starts quietly receiving real leads.
**Naming the rule is what makes it hard to get subtly wrong.**

Trust is the product, so the strict option is the *named queryset* rather than a flag someone
might forget to pass.

---

## Derived fields: computed on write, never accepted from a client

`apply_derived_fields(offer)` runs after every create and update:

```python
offer.fingerprint = fingerprint_for(offer)
offer.quality_score = offer.compute_quality_score()
```

**`fingerprint`** is `sha256(title + kind + departure_date + price)`. Its docstring is careful
about what it is *not*:

> Not a similarity score — an exact match on obvious fields catches copy-paste reposting, which
> is the actual behaviour, and never accuses two genuinely similar Omra packages of being
> duplicates.

A clash with a **different agency's** offer sets `duplicate_status = SUSPECTED` and links
`duplicate_of`. It never hides anything:

> Flagged for a human, never auto-hidden. An automatic takedown on a hash collision is a way to
> remove a competitor by copying their title.

That sentence is the whole design of automated moderation in one line: an automatic penalty is
a weapon you hand to whoever figures out how to trigger it. See
[[Duplicate and Spam Control]].

**`quality_score`** is listing completeness out of 100 — eight boolean checks (cover image, a
description over 200 characters, destination city, departure wilaya, return date, a price
range, at least three programme milestones, a non-empty Arabic title), averaged. It rewards
agencies that fill in real detail and gives search something fairer than recency to rank on.
See [[Search and Filters]].

Note that both are recomputed from scratch on every save rather than patched incrementally.
That is deliberate: a derived value that is recomputed cannot drift, which is the same argument
`Agency.is_verified` makes as a property. Compare `Agency.rating_sum`, which *is* incremental
and therefore needs `recompute_rating()` as a reconciliation job.

---

## The slug is generated, never accepted

```python
def save(self, *args, **kwargs):
    if not self.slug:
        self.slug = self._unique_slug()
    return super().save(*args, **kwargs)

def _unique_slug(self):
    """Generated server-side, never accepted from a client: an agency that
    picks its own slug can claim `omra-pas-cher`, or a competitor's name."""
    base = slugify(f"{self.title_fr}-{self.agency.city}")[:200] or "offre"
    candidate, n = base, 1
    while Offer.objects.filter(slug=candidate).exclude(pk=self.pk).exists():
        n += 1
        candidate = f"{base}-{n}"
    return candidate
```

Three things worth stealing from these ten lines:

- **The `or "offre"` fallback.** `slugify("عمرة رمضان")` returns an empty string — Arabic has no
  ASCII to slugify — and an empty slug would collide with the next one on a `unique` column.
  Every slug generator needs this and most don't have it.
- **The de-duplication loop** exists because `unique=True` will otherwise raise `IntegrityError`
  on the second "Omra Ramadan" in Alger, which is a 500 rather than a suffix.
- **`if not self.slug`** means the slug is set once and never changes on edit. A URL that
  changes loses its search ranking and breaks every link already pasted into WhatsApp.

`Agency.slug` has none of this. See [[Agency]].

---

## The indexes, and why exactly these

```python
ordering = ["departure_date"]
indexes = [
    models.Index(fields=["status", "duplicate_status", "kind", "departure_date"]),
    models.Index(fields=["status", "duplicate_status", "departure_wilaya_code"]),
    models.Index(fields=["status", "duplicate_status", "price_centimes"]),
    models.Index(fields=["agency", "status"]),
]
```

The first three mirror `publicly_visible()` plus one common filter each. The fourth serves the
agency's own dashboard, which never touches `duplicate_status`. Column order matters — see
[[Indexes and Why Queries Get Slow]].

`ordering = ["departure_date"]` is a convenience with a cost worth knowing: it applies to
*every* query on this model, including ones where you don't want it, and it makes
`Offer.objects.all()[0]` do a sort. It's cheap here and it means no view can accidentally render
an unordered list — which on a paginated page produces rows that appear on two pages or none.

---

## `seats_left` is a claim, not a fact

`seats_total` and `seats_left` are both agency-maintained integers. Nothing decrements
`seats_left` when a lead arrives, because **a lead is a question, not a booking**. A
`Reservation` is the commitment; see [[Trip Manifest]].

Do not build anything transactional on this number. The moment money is involved, seats need a
reservation flow with a real lock — two travelers hitting "book" on the last seat at the same
moment is the classic race condition, and `seats_left -= 1` in Python loses it every time. The
fix, when it comes, is `F("seats_left") - 1` so the database does the arithmetic.

The cross-field rule is enforced in **three** places, and the layering is the lesson:

| Where | What it catches |
|---|---|
| `validate_offer_payload` (API) | a bad request, as a 422 naming the field |
| `OfferForm.clean()` (HTML) | the same mistake at the other door |
| `CheckConstraint(seats_left <= seats_total)` | everything else — a shell session, a migration, a management command |

The comment above the constraint says it: *"The database refuses, rather than every caller
remembering."* Two doors need two validations because each has to produce a good error message;
the constraint needs no message because nothing human should ever hit it.

---

## What's still missing

| Field | For | Cost |
|---|---|---|
| per-kind `attributes` schema | the whole point of the JSON column | a day, and it should be the next thing done |
| `media` | more than one photo | needs [[Image Uploads]] first |
| a public route by `slug` | SEO URLs — `/offres/omra-ramadan-2026-alger` | the column exists and is generated; nothing routes by it |
| soft delete | undoing a mistake on Thursday | see [[Data Model Overview]] |

---

## Open questions

- **Is `title_fr` / `title_ar` the right shape, or should translations be their own table?** Two
  columns is simple and fine for two languages. It stops working at four, and it can't express
  "this offer has no Arabic title yet" distinctly from "the Arabic title is empty". Both are
  required today, so an agency must write both — is that acceptable friction, or will they paste
  the French into the Arabic field? (`quality_score` rewards a non-empty `title_ar`, which nudges
  without forcing. That may be the right compromise already.)
- **Should `seats_left` be visible to travelers at all?** Scarcity converts. A wrong number reads
  as a lie, and you can't verify it. It's shown today.
- **How long until an offer auto-expires with no explicit `expires_at`?** 90 days after
  `departure_date`? Nothing currently sets a default, so the field is opt-in and most offers
  will never have one.
- **Promote `haram_distance_m` to a column?** Only if you want a filter on it — and I'd bet you
  will, because it's the first thing an Omra buyer asks.
- **Should publishing require per-offer review, not just per-agency verification?** Today the
  human gate is at the agency level. That's survivable and it is a real decision, not an
  oversight — but it means a verified agency can publish anything instantly.

---

Related: [[Data Model Overview]] · [[Agency]] · [[Lead]] · [[Search and Filters]] ·
[[Validation at the Boundary]] · [[Multi-Tenancy]] · [[Trip Programme]] ·
[[Duplicate and Spam Control]] · [[Indexes and Why Queries Get Slow]] ·
[[Plan Limits and Quotas]] · [[Offer Analytics]]
