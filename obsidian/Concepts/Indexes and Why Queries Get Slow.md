# Indexes and Why Queries Get Slow

## The problem

Find every published Omra offer under 300 000 DZD leaving from Alger in March.

Without an index, Postgres reads **every row** in `offers` and checks each one. At 500 rows
that's instant. At 500 000 it's seconds — and seconds per search, multiplied by every visitor,
is a site that falls over.

An **index** is a pre-sorted lookup structure. Instead of reading everything, the database
jumps straight to the matching range. Same query, milliseconds instead of seconds.

The catch: indexes cost disk space and make writes slightly slower (every insert updates
every index on that table). So you index what you query, not everything.

## Why column order matters

An index on `[status, kind, departureDate]` is like a phone book sorted by surname, then
first name, then street.

You can look up:
- everyone named "Benali" ✅
- "Benali, Amine" ✅
- "Benali, Amine, on rue Didouche" ✅

You cannot efficiently look up "everyone named Amine" — you'd read the whole book, because
first name is only sorted *within* each surname.

**The rule: an index helps a query only if the query uses a prefix of its columns, left to
right.** This is why the same table has several indexes with overlapping columns in different
orders.

## What Rihlati indexes, and why

### Offers — the public search

```
[status, duplicateStatus, kind, departureDate]
[status, duplicateStatus, destinationCountry, priceFromCentimes]
[status, duplicateStatus, departureWilayaCode, departureDate]
```

`status` and `duplicateStatus` come first on all three because **every** public search
filters on both — only `published` offers from non-spam listings. Since they're always
present, they belong at the front where they narrow the search first.

Then each index serves one common filter combination. See [[Search and Filters]].

### Leads — every index starts with `agencyId`

```
[agencyId, stage, createdAt]                  -- the inbox
[agencyId, quality]                           -- "show the serious ones"
[agencyId, assignedToUserId, nextActionAt]    -- "my callbacks today"
[agencyId, contactPhone]                      -- "has this person called before?"
```

Every one leads with `agencyId` because **every lead query is tenant-scoped** — there is no
such thing as "find lead 123" without "belonging to my agency". So `agencyId` is always in
the query, and always belongs first. See [[Multi-Tenancy]].

The security design and the performance design point the same way here, which is usually a
sign the design is right.

## Unique indexes do double duty

`@unique` creates an index *and* a constraint. `User.phone @unique` makes phone lookups fast
and makes it impossible for two accounts to share a number.

That second part is a real rule enforced by the database itself, not by code that might
forget — which is why [[User]] normalizes phones during validation. If `0551234567` and
`+213551234567` could both be stored, `@unique` would be guarding nothing.

`OfferReport @@unique([offerId, reporterUserId])` is the same trick: one report per person
per offer, enforced structurally rather than by checking first (which has a race condition).

## Why JSON can't be indexed for this

[[Offer]] stores kind-specific fields in an `attributes` JSON column. Postgres can index JSON
for *exact* lookups, but not efficiently for **range** queries like `price BETWEEN x AND y`
or `date > today`.

That's the whole reason for the rule: **anything users filter or sort by must be a real
column.** Price, dates, destination and departure wilaya are columns for exactly this
reason.

## Finding out for real

Guessing about performance is unreliable. Ask the database:

```sql
EXPLAIN ANALYZE SELECT ... ;
```

`Seq Scan` means it read the whole table. `Index Scan` means it used an index. On a table
you expect to be large, `Seq Scan` is the warning sign.

Not worth optimising anything yet — with no data, every query is instant and every
measurement is meaningless. The indexes above exist because they were free to add now and
awkward to add to a large live table later.

---

Related: [[Data Model Overview]] · [[Search and Filters]] · [[Multi-Tenancy]] · [[Migrations]]
