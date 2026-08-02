# How Rihlati is built — and why it's easy to change

Written for someone who is still learning backend. Read it top to bottom once.

---

## The shape: one API, many faces

```
                    ┌─────────────────────────┐
   Web browser ───► │                         │
   (Next.js)        │      API  (NestJS)      │ ──►  PostgreSQL
                    │  all rules live here    │
   Phone app ─────► │                         │
   (Expo, later)    └─────────────────────────┘
                                ▲
                    packages/shared  ── the contract
                    (types + validation, used by all three)
```

**One rule: the API is the only thing that touches the database.** The website and the phone app
are just faces. They ask the API for things.

Why this matters for you specifically: it means the phone app is *not a second project*. When you
build it later, every rule, permission and price check already exists and already works. You only
write screens.

This is also why "which platform first?" wasn't the important question. Build the brain, add faces.

---

## Why a "modular monolith", not microservices

One program, divided inside into modules with walls between them:

```
apps/api/src/modules/
  auth/         who are you
  users/        accounts
  agencies/     the travel agencies + verification
  offers/       the travel packages
  search/       filtering and ranking
  leads/        inquiries + the CRM
  reviews/      agency ratings
  admin/        moderation back-office
  audit/        who did what
```

Each module owns its own folder and talks to others through explicit calls. You can delete
`reviews/` and nothing else breaks.

Microservices would mean 8 separate programs, 8 deployments, and network calls between them.
That's a solution to a problem you will not have for years. A monolith with clean walls can be
split later *if* you ever need to. Splitting a mess cannot.

---

## The trick that makes new features cheap

You said you don't know your final feature list. Three specific design choices absorb that.

### 1. Offers: shared skeleton + typed extras

Every offer type shares the same core: agency, title, price, dates, destination, seats, status.
Those are real database columns — so search and filters are fast.

Everything *specific* to a type lives in one `attributes` JSON column, validated by a schema
per type in `packages/shared`:

```
Offer
├── (columns, shared)  agencyId, kind, title, priceFrom, departureDate, destinationCountry …
└── attributes (JSON)
      kind = "omra"     → makkahHotelDistanceMeters, nightsMadinah, roomOccupancy, visaIncluded …
      kind = "package"  → hotelStars, mealPlan, excursions, transferIncluded …
      kind = "visa"     → visaType, processingDays, appointmentIncluded …
```

**What this buys you:** adding "cruise" or "student visa" later is *one file* in `packages/shared`
— no database migration, no downtime, and the old data stays valid. And because the JSON is
validated by a schema, it isn't a junk drawer: a bad field is rejected at the door.

The trade-off, stated honestly: you can't filter efficiently on a JSON field. So the rule is —
**if users will filter or sort by it, it must be a real column.** Price, dates, destination and
departure city are columns for exactly that reason. Hotel meal plan is not.

### 2. Anything you'll want to reword lives in the database, not in code

Your CRM lead stages (`new → contacted → quoted → booked → paid → travelled → lost`) and your
client labels (`troll`, `cold`, `warm`, `serious`, `vip`) start as fixed lists because fixed lists
are easier to reason about. But agency-specific **tags** are rows in a table, so an agency can
invent "waiting for passport" without you shipping code.

When you later want fully custom pipelines per agency, the tag table is already the pattern to copy.

### 3. One source of truth for every shape

`packages/shared` holds the validation schemas. The API validates incoming requests with them.
The website builds its forms from them. The phone app will too.

Change a field in one place → TypeScript immediately shows you every screen that needs updating.
This is the direct fix for problem #7 in `CLAUDE.md` ("silent rewrites"): the compiler finds what
your eyes skip.

---

## The security spine

Three mechanisms, each making a whole class of bug structurally impossible rather than
something you have to remember.

**Deny by default.** Every endpoint requires a logged-in user unless it is explicitly marked
`@Public()`. Forgetting to add a permission check leaves the endpoint *closed*, not open.
The failure mode is a support ticket, not a breach.

**Tenant scoping in one place.** Every table belonging to an agency has an `agencyId` column, and
all reads go through a helper that injects the current user's agency into the query. There is no
code path that fetches "lead 123" — only "lead 123 belonging to my agency". Agency A physically
cannot read Agency B's leads, and a missing row and a forbidden row return the same `404`, so you
can't even probe for what exists.

**Never trust the client.** The client sends *what* it wants, never *who* it is or *what it costs*.
User id, agency id, role, and price all come from the session and the database.

---

## Money and language, decided now because they're painful later

- **Money is stored as an integer number of centimes.** `150000.00 DZD` is stored as `15000000`.
  Floating-point numbers lose pennies — never use them for money.
- **Phones are stored as `+213...`** (one format, always). Dates stored in UTC, shown in
  Africa/Algiers.
- **Arabic and French from day one.** Arabic reads right-to-left, which changes layout, not just
  text. So: no hardcoded strings anywhere, and CSS uses `margin-inline-start` instead of
  `margin-left`. Doing this from the first component costs nothing. Retrofitting it costs a rewrite.

---

## Adding a feature: the recipe

Say you want "flag an offer as expired".

1. **Shape** — add the field/schema in `packages/shared`.
2. **Store** — add the column in `apps/api/prisma/schema.prisma`, run `npm run db:migrate`.
3. **Rule** — add the method in the module's service. Every query stays tenant-scoped.
4. **Door** — add the endpoint in the controller: authz guard + validated input.
5. **Proof** — write the test where Agency B tries it on Agency A's offer and gets `404`.
6. **Face** — add the UI in `apps/web`, using a translation key, never raw text.

Steps 1–5 are the backend. Step 5 is not optional — see the definition of done in `CLAUDE.md`.

---

## What "later" looks like (designed for, not built)

These aren't built in v1, but nothing in the schema blocks them:

- **Promoted offers / ads** — `Offer` has ranking fields search already reads.
- **Paid leads** — `Lead` is already a first-class record with a value estimate; billing becomes a
  ledger table beside it.
- **Premium CRM tiers** — `Agency.plan` gates features in one place.
- **AI chatbot** — needs your own offer and lead data to be any good. That data is being collected
  from day one. That's the whole reason to build the boring version first.
