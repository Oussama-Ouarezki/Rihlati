# How Rihlati is built — and why it's easy to change

Written for someone who is still learning backend. Read it top to bottom once.

---

## The shape: one project, two front doors

```
   Web browser ───► /            ┌──────────────────────────┐
   (Django templates)            │                          │
                                 │   Django  (one process)  │ ──►  PostgreSQL
   Phone app, later ──► /api/    │   all rules live here    │
   (PWA or Expo)                 │                          │
                                 └──────────────────────────┘
                                            ▲
                              apps/common/  ── the spine
                        (tenancy · auth · validation · errors · logging)
```

**One rule: nothing reaches the database except through a handler that has authorized
itself.** The HTML pages and the JSON API are two doors into the same building — same
models, same membership checks, same validators. Neither is a "frontend" that gets to be
trusted more.

Why this matters to you specifically: a phone app later is *not a second project*. Every rule,
permission and price check already exists at `/api/`. You'd only write screens.

> [!info] Django vs NestJS
> In the NestJS repo this diagram has three boxes — `apps/api`, `apps/web`, and
> `packages/shared` holding the contract between them. Here there is one box, because
> Django renders HTML *and* serves JSON from the same process and the same models.
>
> That is a real trade, not a free win. **What you gain:** no contract package to keep in
> sync, no second deployment, and the page and the endpoint literally cannot disagree about
> what an offer is. **What you lose:** the shared *runtime* validator. A Zod schema in
> `packages/shared` is the same code running in the browser and on the server, so instant
> client-side feedback is free. Here, a form that wants to validate as you type has to
> repeat the rule in JavaScript — see [[One Rule, Two Entry Points]] for how far the
> single-definition discipline can actually go.
>
> The half of `packages/shared` that *is* replaced: the **OpenAPI document** generated at
> `/api/docs` from the same Pydantic schemas the handlers validate against. A TypeScript
> client generates its types from that document instead of hand-writing a second copy of
> every interface. One definition, two languages, no drift.

---

## Why apps with walls, not microservices

One program, divided inside into Django *apps* with walls between them:

```
apps/
  common/       the spine: tenancy, auth, validation, errors, logging, quotas
  accounts/     who are you — User, Agency, Membership, RefreshToken, AuditLog
  offers/       the packages, the programme, tracked links, metrics, reports
  leads/        inquiries + the CRM + tags + the consent trail
  trips/        reservations, check-ins, the traveler's own trip page
  reviews/      ratings, tied to a real lead
  pages/        the server-rendered HTML over all of the above
```

Each app owns its own models, routers and tests, and talks to the others through explicit
imports. Deleting `pages/` would remove the website and leave the API working.

Microservices would mean seven separate programs, seven deployments, and network calls
between them. That's a solution to a problem you will not have for years. A monolith with
clean walls can be split later *if* you ever need to. Splitting a mess cannot.

**A Django-specific warning about those walls.** Django apps are a weaker boundary than
NestJS modules. Nest forces you to declare what a module exports; Django lets any file import
any other, so the wall is a convention that erodes quietly. The rule here: an app may import
another app's **models and validators**, never its **routers**. When you catch yourself
wanting a handler from another app, the logic wanted to be on a model or in `common/` all
along.

---

## Why Django Ninja and not DRF

This backend was first written with Django REST Framework and then migrated. The reason is
worth understanding, because it is the same reason `packages/shared` exists in the NestJS
repo — see [[Decision Log]] #D-01 for the full argument.

A DRF `Serializer` is a class full of hand-written checks. A `ninja.Schema` is a **Pydantic
model** — which means it is a *type*. From that one declaration you get three things that
used to be able to disagree:

1. the parsing and validation of the request,
2. the OpenAPI document at `/api/docs`,
3. the declared shape of the response.

And one thing DRF gets structurally wrong by default: **unknown fields are ignored**. A
client that sends `{"stauts": "published"}` — a typo — gets a `200` and no status change.
`Strict` in `apps/common/schemas.py` sets `extra="forbid"`, so the same request is a `422`
naming the field. See [[Validation at the Boundary]].

---

## The trick that makes new features cheap

You said you don't know your final feature list. Three design choices absorb that.

### 1. Offers: shared skeleton + typed extras

Every offer type shares the same core: agency, title, kind, price, departure date, seats,
status. Those are real database columns — so search and filters are fast.

Everything *specific* to a type lives in the `attributes` JSON column:

```
Offer
├── (columns, shared)  agency, kind, title_fr, title_ar, price_centimes, departure_date …
└── attributes (JSON)  the per-kind extras
      kind = "omra"             → makkah_hotel_distance_m, nights_madinah, visa_included …
      kind = "organized_trip"   → hotel_stars, meal_plan, excursions …
      kind = "visa_assistance"  → visa_type, processing_days …
```

**What this buys you:** adding "cruise" or "student visa" later is one schema — no
migration, no downtime, and old rows stay valid.

The trade-off, stated honestly: **if users will filter or sort by it, it must be a real
column.** Postgres can index inside JSON, but the query is slower, the index is bigger, and
the ORM syntax is worse. Price, dates and departure wilaya are columns for exactly that
reason. Hotel meal plan is not.

> [!warning] Honest state — the column exists, the per-kind schema does not
> `Offer.attributes` is a real `JSONField`, and `OfferIn.attributes` accepts it at the
> boundary — but it is typed `dict`, with no per-kind validation behind it. So today it *is*
> the junk drawer this design was meant to avoid: any keys, any values, silently stored.
>
> The fix is a discriminated union — one `Strict` schema per `kind`, picked by the `kind`
> field — and it is maybe forty lines. Until it is written, treat `attributes` as untrusted
> display data and never let a business rule read from it. See [[Offer]].

### 2. Anything you'll want to reword lives in the database, not in code

Lead statuses (`new → contacted → quoted → negotiating → booked → travelled → lost`) are a
fixed list because fixed lists are easy to reason about and they are *your* vocabulary.
Agency-specific **tags** are rows in a table, so an agency can invent "waiting for passport"
without you shipping code. See [[Client Quality Labels]].

### 3. One definition per rule

An Algerian phone number is valid according to exactly one regex, in
`apps/common/validators.py`. The Ninja schema imports it. The HTML form imports it. There is
no second copy to disagree with the first.

This is the direct answer to rule #7 ("nothing changes silently"): when the rule changes, it
changes in one place, and both doors change with it. What Python does *not* give you is the
compiler sweep TypeScript does — nothing will tell you at build time that a template still
references a renamed field. That gap is why the test suite covers the rendered pages and not
only the JSON. See [[One Rule, Two Entry Points]].

---

## The security spine

Three mechanisms, each making a whole class of bug structurally impossible rather than
something you have to remember.

**Deny by default.** `NinjaAPI(auth=API_AUTH)` in `config/api.py` is set **once, at the
root**, so every route requires a caller unless it explicitly says `auth=None`. Forgetting to
write anything leaves the endpoint *closed*, not open. The failure mode is a support ticket,
not a breach.

And because "explicitly public" is a decision worth counting, `tests_house_rules.py` reads
the generated OpenAPI document and pins the exact list of operations with no security
requirement. Ten of them, each with a comment saying why. Adding a public endpoint is an edit
to that test, with a reviewer attached.

**Tenant scoping in one place.** Every agency-owned model has a non-null `agency` foreign
key. `require_membership(user, agency_id)` proves the session belongs to the agency in the
URL, and then every query runs through `scoped(queryset, agency_id)`. There is no code path
that fetches "lead 123"; only "lead 123 belonging to my agency". A missing row and a
forbidden row both return `404`, so you cannot even probe for what exists. See
[[Multi-Tenancy]].

**Never trust the client.** The client sends *what* it wants, never *who* it is or *what it
costs*. User, agency, price limits and quotas all come from the session and the database.
`OfferIn` simply has no `agency`, `status`, `is_featured` or `quality_score` field — a field
absent from the schema is a field a client cannot set, which is stronger than a handler
remembering to ignore it.

---

## Money and language, decided now because they're painful later

- **Money is an integer number of centimes.** `150 000,00 DZD` is stored as `15000000` in a
  `BigIntegerField`. Floating-point loses pennies — never use it for money. `MoneyTests` in
  the house rules bans `FloatField` and `DecimalField` outright so this can't drift.
- **Phones are stored `+213…`**, one format always, and masked before they reach a log.
- **Dates are stored UTC** (`USE_TZ = True`), shown in Africa/Algiers. The one deliberate
  exception is `OfferMilestone.time_of_day`, a wall-clock *string* — see [[Trip Programme]]
  for why converting it would be a bug.
- **Arabic and French from day one.** Arabic reads right-to-left, which changes layout, not
  just text: no hardcoded strings, and CSS uses `margin-inline-start`, never `margin-left`.
  Doing this from the first template costs nothing. Retrofitting it costs a rewrite.

> [!warning] Honest state — i18n is declared, not used
> `USE_I18N` is on and both languages are declared in `settings.py`, but the templates are
> written in French directly rather than through `{% translate %}`. That is a real violation
> of the rule above, carried over from when this was a throwaway comparison. It gets worse
> the longer it waits, and it is a named milestone — see [[Milestone Plan]].

---

## Adding a feature: the recipe

Say you want "flag an offer as expired".

1. **Store** — add the field in `apps/offers/models.py`, run `python manage.py makemigrations`,
   then *read the generated file* before committing it.
2. **Shape** — add it to the `Strict` schema and the form, with the validation rule in
   `apps/common/validators.py` if both need it.
3. **Rule** — put the logic on the model or a helper module, not in the handler. A handler
   that knows business rules is a rule you can't reuse from a management command.
4. **Door** — expose it on the router: `require_membership` with the right minimum role, and
   `scoped()` on every query.
5. **Proof** — write the test where Agency B tries it on Agency A's offer and gets `404`.
6. **Face** — add it to the template, using a translation key, never raw text.
7. **Truth** — update the note in this vault, in the same commit.

Steps 5 and 7 are not optional — see the definition of done in `CLAUDE.md`.

---

## What "later" looks like (designed for, not built)

Not built here, but nothing in the schema blocks them:

- **Promoted offers / ads** — `Offer.is_featured` and `featured_until` exist as columns and
  are server-owned; nothing writes them yet. See [[Credits and Promotion]].
- **Paid leads** — `Lead` is a first-class record, `Lead.is_billable` already distinguishes
  the leads Rihlati brought from the ones the agency brought itself, and the consent trail is
  collected on every one. Billing becomes a ledger table beside it.
- **Premium CRM tiers** — one `Agency.plan` column gates features in one place, and
  `apps/common/quotas.py` already reads the limit from the database rather than the request.
  See [[Plan Limits and Quotas]].
- **AI chatbot** — needs your own offer and lead data to be any good. That data is being
  collected from day one. That's the whole reason to build the boring version first. See
  [[Agency Chatbot]].

## Open questions

- Does the phone app happen at all, or does a well-built responsive site plus "add to home
  screen" cover it? The answer decides whether `/api/` needs to stay a first-class product
  or can become an implementation detail of the website.
- The `attributes` column exists but is unvalidated. Do you want the per-kind schemas now,
  while there are four offer kinds and changing the shape is cheap, or later, when there are
  rows to migrate?

## See also

[[Architecture]] — the same system described physically: the processes, the state, the release
path, and what is missing before it can run anywhere but a laptop.

[[Start Here]] · [[What the API Is]] · [[Multi-Tenancy]] · [[Data Model Overview]] ·
[[The Seven Rules]] · [[Milestone Plan]]
