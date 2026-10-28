# Indexes and Why Queries Get Slow

## The problem

Find every published Omra offer under 300 000 DZD leaving from Alger in March.

Without an index, Postgres reads **every row** in `offers_offer` and checks each one. At 500
rows that's instant. At 500 000 it's seconds — and seconds per search, multiplied by every
visitor, is a site that falls over.

An **index** is a pre-sorted lookup structure. Instead of reading everything, the database
jumps straight to the matching range. Same query, milliseconds instead of seconds.

The catch: indexes cost disk space and make writes slightly slower (every insert updates every
index on that table). So you index what you query, not everything.

---

## Why column order matters

An index on `[status, duplicate_status, kind, departure_date]` is like a phone book sorted by
surname, then first name, then street.

You can look up:

- everyone named "Benali" ✅
- "Benali, Amine" ✅
- "Benali, Amine, on rue Didouche" ✅

You cannot efficiently look up "everyone named Amine" — you'd read the whole book, because
first name is only sorted *within* each surname.

**The rule: an index helps a query only if the query uses a prefix of its columns, left to
right.** That is why the same table has several indexes with overlapping columns in different
orders, and it is written as a comment in `apps/offers/models.py` so nobody reorders them
casually.

---

## What Rihlati indexes, and why

### Offers — the public search

```python
class Meta:
    ordering = ["departure_date"]
    indexes = [
        models.Index(fields=["status", "duplicate_status", "kind", "departure_date"]),
        models.Index(fields=["status", "duplicate_status", "departure_wilaya_code"]),
        models.Index(fields=["status", "duplicate_status", "price_centimes"]),
        models.Index(fields=["agency", "status"]),
    ]
```

`status` and `duplicate_status` lead on all three public indexes because **every** public
search filters on both — `Offer.publicly_visible()` always applies them. Since they're always
present, they belong at the front where they narrow the search first.

Then each index serves one common filter combination: by kind and date, by departure wilaya, by
price. See [[Search and Filters]].

The fourth is a different query entirely: `[agency, status]` serves the agency's own dashboard
("my drafts", "my published offers"), which never touches `duplicate_status`.

> [!info] The third condition in `publicly_visible()` is not in the index, on purpose
> The queryset also does `.exclude(duplicate_status=CONFIRMED_DUPLICATE)`, and `NOT =` is a
> low-selectivity condition — almost every row passes it, so leading an index with it would
> sort thousands of rows into one bucket and one tiny one. It sits second because it is nearly
> free there, not because it narrows much.

### Leads — every index starts with `agency`

```python
indexes = [
    # Every index leads with `agency` because every query on this table
    # is tenant-scoped: there is no "find lead 123" without "belonging
    # to my agency".
    models.Index(fields=["agency", "status", "-created_at"]),
    models.Index(fields=["agency", "quality"]),
    models.Index(fields=["agency", "assigned_to", "next_action_at"]),
    models.Index(fields=["agency", "phone_e164"]),
]
```

| Index | Answers |
|---|---|
| `agency, status, -created_at` | the inbox, newest first, filtered by pipeline stage |
| `agency, quality` | "show me the serious ones" |
| `agency, assigned_to, next_action_at` | "my callbacks today" |
| `agency, phone_e164` | "has this person called us before?" |

Every one leads with `agency` because every lead query goes through
`scoped(Lead.objects, agency_id)`, which means `agency_id = %s` is in the `WHERE` clause
*always*. See [[Multi-Tenancy]].

**The security design and the performance design point the same way here**, which is usually a
sign the design is right. The column you must filter by is also the column that makes the
filter fast.

Note the `-created_at` in the first one: a descending index column. It matters because
`ordering = ["-created_at"]` on the model means every unfiltered lead list sorts that way, and
an index in the wrong direction still forces a sort step.

---

## Unique constraints do double duty

In Django, a `UniqueConstraint` creates an index *and* a rule the database enforces. Nothing —
not a bug, not a shell session, not a race between two requests — can violate it.

```python
models.UniqueConstraint(fields=["user", "agency"], name="unique_membership_per_agency")
```

One membership row per person per agency. Without it, a double-clicked "invite" button creates
two rows, and now `get_membership()` returns whichever one the database felt like, with
whichever role it happened to have.

**The race condition is the point.** "Check whether it exists, then create it" has a gap
between the two statements, and under load two requests land in that gap. A unique constraint
has no gap: the second insert fails, at the database, always.

Three more in the codebase, each guarding a different race:

| Constraint | Stops |
|---|---|
| `one_metric_row_per_offer_day` on `(offer, day)` | two concurrent views creating two counter rows for the same day |
| `one_checkin_per_family_per_checkpoint` on `(milestone, reservation)` | a family marked present twice at one checkpoint |
| `unique_tag_name_per_agency` on `(agency, name)` | two "VIP" tags in one agency, splitting the list in half |

The report constraints are the interesting pair, because they are **conditional**:

```python
models.UniqueConstraint(
    fields=["offer", "reporter"],
    condition=models.Q(reporter__isnull=False),
    name="one_report_per_user_per_offer",
),
models.UniqueConstraint(
    fields=["offer", "reporter_fingerprint"],
    condition=~models.Q(reporter_fingerprint=""),
    name="one_report_per_fingerprint_per_offer",
),
```

One report per person per offer — but reporting a scam listing doesn't require an account, so
"person" is a logged-in user *or* an anonymous fingerprint, and each rule must not fire when
the other identifier is the one in use. Without the `condition`, every anonymous report would
collide with every other anonymous report on the same offer, because they'd all share the same
`NULL` reporter.

### `unique=True` on a single field

`TrackedLink.code`, `Reservation.public_code` and `RefreshToken.token_hash` are all
`unique=True`, which gives a unique index too. For the first two that is a correctness
requirement of a different kind: these are **capability URLs**, where the code *is* the
credential, so a collision would hand one traveler another's trip page.

---

## Check constraints: rules the code cannot forget

```python
models.CheckConstraint(
    condition=models.Q(seats_left__lte=models.F("seats_total")),
    name="seats_left_within_total",
),
models.CheckConstraint(
    condition=models.Q(price_centimes__gt=0), name="price_is_positive"
),
```

Not indexes — but the same philosophy, and the comment above them says it: *"The database
refuses, rather than every caller remembering."*

`validate_price_centimes` in `apps/common/validators.py` also rejects a non-positive price, at
both doors. The check constraint is the third line of defence, for the paths that have no door
at all: a management command, a data migration, a `manage.py shell` session at 11pm. Belt,
braces, and a bolt through the floor — because a negative price in the database is not an
error message, it's a listing that says "-350 000,00 DZD".

---

## Why JSON can't be indexed for this

[[Offer]] stores kind-specific fields in an `attributes` JSON column. Postgres can index JSON
for *exact* lookups (a GIN index on `jsonb`), but not efficiently for **range** queries like
`price BETWEEN x AND y` or `date > today`.

That's the whole reason for the rule: **anything users filter or sort by must be a real
column.** `price_centimes`, `departure_date`, `destination_country` and
`departure_wilaya_code` are columns for exactly this reason, and they are the four things the
search page filters on.

The test of whether a field belongs in `attributes`: *would anyone ever sort or filter a search
by it?* "Hotel distance from the Haram" — probably not, it's a detail you read on the page.
"Price" — obviously yes. When the answer changes, the field has to be promoted to a column and
backfilled, which is a migration and not a small one. See [[Migrations]].

---

## `select_related` and `prefetch_related` — the other kind of slow

Indexes make one query fast. The N+1 problem is about issuing *too many* queries, and it is far
more common in practice.

```python
for offer in Offer.publicly_visible():
    print(offer.agency.name)     # ← one extra SELECT per offer
```

Twenty offers on a search page, twenty-one queries. Every one is indexed and instant, and the
page is still slow, because the cost is twenty round-trips to the database rather than any
single query being expensive.

```python
Offer.publicly_visible().select_related("agency")        # a JOIN — one query
Offer.publicly_visible().prefetch_related("milestones")  # two queries, total
```

`select_related` follows a foreign key **forwards** (many offers → one agency) with a JOIN.
`prefetch_related` follows one **backwards or many-to-many** (one offer → many milestones) with
a second query and a join in Python — because a JOIN there would multiply the offer rows by
their milestone count.

This is why `get_offer` in `apps/offers/api.py` reads:

```python
Offer.publicly_visible().select_related("agency").prefetch_related("milestones")
```

Two words, and the offer detail page is 2 queries instead of 1 + the number of days in the
programme.

> [!tip] How to catch an N+1 before a user does
> `django-debug-toolbar` shows a query count per page and is the single most useful package to
> add when the site feels slow. Not installed here yet. Until then,
> `django.db.connection.queries` in a shell after running a view does the same job crudely.

---

## Finding out for real

Guessing about performance is unreliable. Ask the database:

```python
>>> print(Offer.publicly_visible().explain(analyze=True))
```

`Seq Scan` means it read the whole table. `Index Scan` means it used an index. On a table you
expect to be large, `Seq Scan` is the warning sign.

> [!warning] Don't do this on SQLite and believe the answer
> Locally `DATABASE_URL` is unset, so you are on SQLite, whose planner and index behaviour are
> not Postgres's. Query plans are one of the things where the two genuinely differ. Measure on
> Postgres or don't measure.

Not worth optimising anything yet — with no data, every query is instant and every measurement
is meaningless. The indexes above exist because they were free to add now and awkward to add to
a large live table later: `CREATE INDEX` locks the table while it builds, which is fine at
1 000 rows and an outage at 10 million. Postgres has `CREATE INDEX CONCURRENTLY`, and Django
exposes it as `AddIndexConcurrently` with `atomic = False` on the migration. Knowing that exists
is enough for now.

---

## Open questions

- Search is currently exact filters, not text search. The moment a traveler types "omra
  ramadan pas cher" into a box, you need Postgres full-text search (`SearchVector` + a GIN
  index) or a search engine, and neither is free. Which comes first, and does Arabic text
  search work well enough in Postgres for what you need? **Verify that before promising it** —
  Arabic stemming is not something to assume.
- Should `OfferDailyMetric` rows be rolled up and deleted after a year? Counters are small, but
  they grow forever by construction.

---

Related: [[Data Model Overview]] · [[Search and Filters]] · [[Multi-Tenancy]] · [[Migrations]] ·
[[Offer]] · [[Lead]] · [[Offer Analytics]]
