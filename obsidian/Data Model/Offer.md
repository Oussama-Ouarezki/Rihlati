# Offer

One thing an agency sells: an Omra package, a Turkey trip, a visa service, a flight.

This is the table whose design most directly answers your worry — *"I don't know all my
features yet, I want it easy to change."* Read the two-part split below and you'll see why
you don't need to know.

Defined in `apps/api/prisma/schema.prisma`. Kind-specific shapes in
`packages/shared/src/offers/attributes.ts`.

---

## The two-part split

An offer is **shared columns + kind-specific JSON**.

```
Offer
├── COLUMNS  (the same for every kind — what people filter by)
│     agencyId, kind, status, title, slug, summary, description
│     priceFromCentimes, priceToCentimes, currency
│     departureDate, returnDate, durationDays, isFlexibleDates
│     departureWilayaCode, destinationCountry, destinationCity
│     seatsTotal, seatsLeft
│
└── attributes  (JSON — different per kind, strictly validated)
      kind = "omra"    → makkahDistanceToHaramMeters, nightsInMadinah,
                          roomOccupancy, visaIncluded, ziyaratIncluded…
      kind = "package" → hotelStars, mealPlan, excursions, themes…
      kind = "visa"    → visaType, targetCountry, processingDays…
      kind = "flight"  → tripType, cabinClass, checkedBaggageKg…
```

### Why this shape

An Omra package and a Schengen visa service have almost nothing in common. Three ways to
handle that:

1. **One table with every possible column.** 120 columns, 100 of them `null` on any given
   row. Every new offer type is a migration. Unmaintainable.
2. **A separate table per kind.** Clean per kind, but now searching "everything under
   300 000 DZD leaving from Oran in March" means querying seven tables and merging the
   results by hand. Sorting across them is a nightmare.
3. **Shared columns + typed JSON.** ← what we do.

Search only ever touches the columns, so it's one fast indexed query. The kind-specific
parts ride along in JSON, validated per kind.

**Adding a new type — say "cruise" — is four edits and no migration:**
1. add `'cruise'` to `OFFER_KINDS` in `packages/shared/src/enums.ts`
2. add `cruise` to `enum OfferKind` in `schema.prisma`
3. write `cruiseAttributesSchema` in `attributes.ts`
4. add it to the `offerAttributeSchemas` registry

TypeScript refuses to compile until step 4, so a half-added type can't ship. Existing rows
are untouched. There's a test asserting every kind has a schema.

### The one rule that keeps this from rotting

> **If users will filter or sort by it, it must be a real column — not `attributes`.**

Postgres cannot efficiently index a range query inside JSON. `price BETWEEN x AND y` on a
column is instant; the same on JSON reads every row.

That's exactly why `priceFromCentimes`, `departureDate`, `destinationCountry` and
`departureWilayaCode` are columns. And why `mealPlan` isn't — nobody filters a trip by
breakfast.

Distance to the Haram is the interesting borderline case. It's the field Omra buyers care
about most, and price differences largely reflect it. It's in `attributes` today. **The
moment you want a "under 300 m from the Haram" filter, it has to become a column.** Tell
me and I'll promote it — that one *is* a migration, but a small one.

### Is the JSON a hole in your defences?

No, and this is the part that makes it safe rather than sloppy. Each kind's schema is
`z.strictObject`, so unknown keys are **rejected**, not ignored. Send
`nightsInMaccah` (typo) and you get a `400`, not a silently stored field nothing reads.
See [[Validation at the Boundary]].

---

## Status, and why an agency can't publish itself

```
draft ──► pending_review ──► published ──► paused ──► published
   │            │                │
   │            └──► rejected    └──► archived
   └──► archived
```

Allowed transitions are a table (`OFFER_STATUS_TRANSITIONS` in `enums.ts`), not scattered
`if` statements. Anything not listed is refused.

`status` is **not** in `createOfferSchema` or `updateOfferSchema`. An agency literally
cannot send it. Publishing goes through its own endpoint that checks the transition table
*and* the plan quota. If `status` were an ordinary updatable field, any agency could
publish unreviewed offers by calling the API directly — that's [[Validation at the Boundary]]'s
mass-assignment bug, and it would quietly destroy the verification that is your whole
product.

Same for `isFeatured` and `qualityScore`: server-owned. `isFeatured` is the thing you plan
to *sell*. If a client could set it, you'd be giving away your ad inventory.

---

## Only `published` offers are public

The default search adds two conditions nobody can turn off:
- `status = 'published'`
- the agency is `verified`

So an unverified agency's offers are invisible no matter what. Trust is the product, so the
strict option is the default rather than a flag someone might forget.

---

## Duplicate flagging

`fingerprint`, `duplicateStatus`, `duplicateOfOfferId`, `reportCount`.

The purpose is **anti-spam**, not deduplication: stopping one agency from flooding the
marketplace with near-identical listings. Nothing is ever deleted or merged. Full
explanation in [[Duplicate and Spam Control]].

---

## The `slug`

`slug` is globally unique and forms the public URL:
`rihlati.dz/offres/omra-ramadan-2026-depuis-alger-agence-el-baraka`

Global rather than per-agency because it's an SEO URL, and Google needs one canonical
address per page. Generated server-side from the title; never accepted from the client.

> [!info] Slugs should not change
> A published URL that changes loses its search ranking and breaks every shared WhatsApp
> link. When a title changes, keep the old slug. If one truly must change, the old one
> needs a redirect.

---

## Fields worth a second look

| Field | Note |
|---|---|
| `priceFromCentimes` | "From" — the cheapest occupancy. `priceToCentimes` optional. Integer centimes, never a decimal. |
| `seatsLeft` | Agency-maintained, so it's a claim, not a fact. Don't build booking on it without a reservation flow. |
| `isFlexibleDates` | "Departures every week in Ramadan" — must not be treated as one fixed date in search. |
| `departureDate` | `@db.Date`, not a timestamp. A trip leaves on a day, not at 14:32:07 UTC. |
| `media` | JSON array of `{url, kind, order, alt}`. Only URLs — files live in object storage, never in the database. |
| `expiresAt` | Stale offers are the top complaint on every marketplace. Auto-pause past this date. |
| `qualityScore` | Listing completeness, 0–100. Rewards agencies that fill in real detail. |

---

## Open questions for you

- **Promote distance-to-Haram to a column?** Needed for a filter on it.
- **Should `seatsLeft` be visible to travelers?** Scarcity converts, but a wrong number
  reads as a lie and you can't verify it.
- **How long until an offer auto-expires** with no `expiresAt` set? 90 days?

---

Related: [[Data Model Overview]] · [[Search and Filters]] · [[Duplicate and Spam Control]] ·
[[Plan Limits and Quotas]] · [[Validation at the Boundary]]

---

## The programme is becoming structured

`description` currently holds the whole trip programme as free text. That is being replaced
by **[[Trip Programme]]** — an `OfferMilestone` list rendered as a timeline, which buyers
can compare, agencies can tick off during the trip, and travelers can read to find out
where to meet. `description` stays as a short prose introduction above it.
