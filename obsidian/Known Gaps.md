# Known Gaps

The register of things that are **wrong or missing in code that is already shipped**. Six
other notes send you here, each having just admitted to something and promised it was written
down somewhere central. This is that somewhere.

It is not a backlog of features — that is [[Milestone Plan]]. Everything on this page is a
defect in something that already exists and already looks finished.

> [!info] Why keep this list separate at all
> A gap admitted only inside the note about the feature is invisible: nobody reads
> [[Data Model Overview]] wondering what is broken. A gap admitted only here loses the
> explanation of why the design wanted something different. So both, deliberately — the
> feature note argues, this page counts. Each entry links back.
>
> **An entry leaves this page only when the code changes.** Not when it is explained better.

---

## G1 · `Offer.attributes` accepts any JSON at all

`apps/offers/api.py:180` — `attributes: dict = {}`.

Any JSON object is accepted: no per-`kind` schema, no key allowlist. `nightsInMakkah`,
`nights_in_makkah` and `nightsInMaccah` are all equally valid, and two of them are data
nothing will ever read.

`Strict` protects the *top level* of every payload. Nothing protects the inside of a blob —
which is exactly the thing that made a JSON column look free.

**The fix:** a per-kind schema in `apps/common/validators.py`, called from **both** `OfferIn`
and `OfferForm` ([[One Rule, Two Entry Points]]), rejecting unknown keys rather than ignoring
them. The NestJS repo has `offers/attributes.ts` and a test asserting every kind has one.

> [!note] Partial mitigation, read side only (2026-10-28)
> `apps/chat/context.py` now passes `Offer.attributes` through a per-kind allowlist and drops
> unknown or nested values before they reach an assistant prompt. That stops one consumer from
> repeating a typo; it does **not** stop the typo being written, read by any other consumer, or
> exported. This gap stays open until both entry points validate.

**Why it is first:** it is the only gap here that gets *worse while you wait*. Every day open
is more junk written into rows you will later have to clean by hand. [[Offer]] calls it the
single riskiest unfinished thing in the schema and that is still true.

→ [[Offer]] · [[Data Model Overview]] · [[Validation at the Boundary]]

## G2 · `next_action_at` is typed as a string, so a bad value gets the wrong error

`apps/leads/api.py:59` and `:76` — `next_action_at: str | None`.

Django parses an ISO string on save, so `"2026-09-01T10:00:00Z"` works and the bug hides.
`"demain matin"` reaches the model, raises Django's `ValidationError` at save time, and comes
back as a **400 with a French Django sentence in it** — instead of the 422 naming the field
that every other bad input on that schema produces.

**The fix:** type it `datetime | None` and let Pydantic reject it at the boundary, where the
rule belongs.

**Why it matters more than one field:** it is the same class of bug as `departure_date: str`,
which did cause a 500. That one was loud. This one is quiet, and quiet is why it is still
here. Any time a Pydantic schema types a date or a number as `str`, validation has been
silently delegated to the database layer.

→ [[Lead]] · [[Validation at the Boundary]]

## G3 · A `GET` endpoint that writes to the database

`apps/accounts/api.py:384` — `@admin_router.get("/admin/reconcile-ratings")` loops over every
agency calling `recompute_rating()` and saving.

`GET` is supposed to be safe: browsers prefetch it, proxies cache it, crawlers follow it, and
a `<link rel=prefetch>` should never change data. Staff-only limits the blast radius; it does
not make the verb correct.

**The fix:** `POST`. And the docstring already says the real answer — *"it belongs on a
schedule before launch"*, which means it should not be an endpoint at all but a management
command run by cron. That is blocked on there being anywhere to run cron ([[Architecture]],
M7 in [[Milestone Plan]]).

→ [[Agency Ratings]] · [[Agency]]

## G4 · `Agency.slug` is never generated

`apps/accounts/models.py:66` — `slug = models.SlugField(unique=True)`, with no `save()`
override.

`Offer` has one: it builds a slug, de-duplicates it in a loop, and refuses to let a client
choose its own so nobody can claim `omra-pas-cher` or a competitor's name. **`Agency` has
none.** `seed_preview.py` sets it by hand, so nothing has ever noticed. Creating an agency any
other way hits the `unique` constraint on the empty string on the second attempt.

**The fix:** ten lines copied from `Offer`.

**Why it has not been done, and why that is the more interesting fact:** there is no endpoint
that creates an agency. Every agency in existence was made by a seed script or by hand in
`/admin/`. That is a gap worth noticing on its own — self-signup is unbuilt, and the
verification queue is currently fed by a table nobody can add to through the product.

→ [[Agency]] · [[Agency Verification]]

## G5 · There is no single-offer read on the agency API

The agency router has `GET /agencies/{id}/offers` (list) and
`PUT /agencies/{id}/offers/{offer_id}` (update), but **no `GET` for one offer**. A console
that wants to open one offer has to fetch the list and filter client-side.

This surfaced while writing tenant-isolation tests: the read-isolation test has to go through
the `/milestones` sub-resource instead. That is a legitimate substitute — it uses the same
`scoped(Offer.objects, agency_id)` lookup and fails the same way if scoping breaks — but the
test is proving the property indirectly, and a reader deserves to know that.

**The fix:** add the route, with the create-as-A / fetch-as-B / assert-404 test that
[[Multi-Tenancy]] requires, and point the isolation test at it directly.

→ [[Multi-Tenancy]] · [[API Endpoints]]

## G6 · The login rate limit counts in per-process memory

`CACHES` is `LocMemCache`, and `apps/common/throttling.py` counts login attempts in it. Local
memory is per process, so N web workers means N times the allowed attempts — and the limit
still looks enforced from the outside.

Correct today, because one process. A deployment decision away from being a security bug, and
the deployment is M7.

**The fix:** a shared cache — Redis, or `django.core.cache.backends.db` — before the app ever
runs on more than one worker.

→ [[Architecture]] · [[Auth Flow]]

---

## Closed

Kept, not deleted. A fixed bug with its reasoning intact is how the same mistake stops
recurring; a deleted one is a lesson thrown away.

**C1 · A unique column added to a populated table — fixed 2026-08-09.** `offers/0003` added
`Offer.slug` as `unique=True` in one `AddField`. Fine on a fresh clone, `IntegrityError` on
any database with more than one offer — and because migrations are transactional, the failure
left the schema behind the code, so the symptom was the *home page* 500ing on an unrelated
missing column. The whole test suite was green throughout, because every test starts from an
empty database and an empty table accepts any migration. Fixed with the three-step
add / backfill / constrain shape, and pinned by `apps/offers/tests_migrations.py` — the only
test in the repo that runs a migration against actual rows. → [[Migrations]]

**C2 · `seed_preview` would wipe a production database — fixed 2026-08-09.** Its first act is
to delete every agency, offer, lead and reservation, and it had no guard, so the difference
between a local reset and a catastrophe was one environment variable. It now refuses unless
`DEBUG` is on. The general shape is worth keeping: *a destructive command must refuse by
default rather than trust whoever typed it.*

**C4 · Every page was rendering its own source comments to the customer — fixed 2026-08-09.**
`{# ... #}` in a Django template is **single-line only**; the lexer matches it with a regex that
never crosses a newline. Twenty comments in twelve templates had the closing `#}` on a later
line, so none of them were comments at all — they were literal text, on every page in the app.
The marketplace home page was explaining to travelers why its filter bar is a plain GET form.
Fixed by converting all twenty to `{% comment %}...{% endcomment %}`, and pinned by
`TemplateCommentTests` in `apps/common/tests_house_rules.py`.

Two things worth keeping from it. First, it is **pure Django trivia** — the Nest/Prisma repo has
no equivalent, because JSX comments are expressions and a malformed one will not compile. This
is the sort of stack-specific footgun this repo exists to surface. Second, and much more
important: **the suite was green the entire time, and stayed green after the fix — 218 tests
either way.** Every test asserts some expected string is *present*; not one asserts template
source is *absent*, because no test renders a page and looks at it. A person opened the site and
saw it in one second. That is [[End-to-End Testing]]'s argument stated as a fact rather than a
prediction, and it is why M1 is first in [[Milestone Plan]].

**C3 · Duplicate detection was inverted.** The fingerprint excluded `agency_id`, so it flagged
two different agencies selling the same package as duplicates of each other, and never flagged
an agency reposting its own trip — the actual behaviour the feature exists to stop. No test
covered it. Fixed by putting `agency_id` inside the hash and keeping `price_centimes` out,
and pinned by `DuplicateFingerprintTests`, notably
`test_two_agencies_selling_the_same_package_never_collide`. → [[Duplicate and Spam Control]]

---

## Open questions — yours

- **Does G1 block launch?** It is the only entry that accumulates damage. Everything else is
  the same size in six months; that one is not.
- **G4 asks a product question, not a technical one:** do agencies sign themselves up and wait
  for verification, or do you create every account by hand? [[Decisions You Must Make]] §1
  argues for by hand, at least for the first forty. If that stands, G4 stays cheap.

---

Related: [[Milestone Plan]] · [[Architecture]] · [[The Seven Rules]] · [[Decision Log]]
