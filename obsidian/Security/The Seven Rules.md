# The Seven Rules

Your list of what goes wrong in AI-built apps, turned into rules the code has to obey.

The enforceable version lives in `CLAUDE.md` at the repo root — that's the file I read
before writing anything. This note explains *why* each rule exists and what it looks like
here.

Violating one is a bug, not a style disagreement.

> [!tip] The one thing to take from this note
> Every rule below is either **enforced by a mechanism** (something that makes the wrong code
> impossible) or **enforced by a test** (something that makes the wrong code fail loudly). A
> rule enforced by "remember to do this" is not enforced. Where this port had to trade a
> mechanism for a test, the note says so.

---

## 1. No secrets in code

**The failure:** an API key committed to the repo, or rendered into a page. Anyone who clones
the repo — or opens devtools — has it.

**Here:**
- Secrets live in `.env`, which `.gitignore` covers on **its first lines**, before the first
  commit ever happened. That ordering matters: a secret committed once is in git history
  forever, even if you delete it in the next commit.
- Only `.env.example` is committed, with empty values and a comment saying what each is for.
- `SecretsTests` in `apps/common/tests_house_rules.py` fails the build if anyone writes a
  literal key into `settings.py` instead of reading it from the environment.
- CI has a **separate `secrets` job** that scans the *full history*, refuses a tracked `.env`,
  and refuses a tracked `.sqlite3` file — a development database is real data.

> [!warning] The Django-shaped version of this failure is `DEBUG`
> There is no `NEXT_PUBLIC_` here to accidentally publish a key through. The equivalent
> mistake is `DJANGO_DEBUG=1` on a public server: Django's 500 page then renders your settings
> module, the SQL it was running, and the whole environment — including `SECRET_KEY` — to
> whoever triggered the error. It is an environment variable rather than an inference about
> which machine you are on, precisely so it is a visible decision.

**Check yourself:** `git diff --staged | grep -iE "sk-|secret|password|api[_-]?key"`

**If a real key ever appears:** rotate it today. Not after launch. Deleting the line does
nothing — the old commit still has it.

---

## 2. The UI is never the security

**The failure:** the delete button is hidden from non-managers, but `DELETE /api/offers/abc`
answers anyone who calls it. Attackers don't use your interface.

**Here:**
- **Deny by default at the root.** `NinjaAPI(auth=API_AUTH)` in `config/api.py` is set once,
  so every route needs a logged-in caller unless it says `auth=None`. Forgetting a check
  leaves the door **locked**, which is the only safe direction for a mistake to fall.
- `auth=None` is the only exit, and it is **pinned by a test**:
  `test_public_endpoints_are_the_ones_we_expect` reads the generated OpenAPI document and
  compares the set of unauthenticated operations against a hand-written list. Adding a public
  route is an edit to that list, with a reviewer attached. The test reads the *schema* rather
  than grepping the source, so a route that became public by inheriting from a public router
  is caught too.
- Server-owned fields are **absent from the input schemas**, so there is nothing to ignore.
  `AgencyProfileIn` has no `status` or `plan`; `OfferForm.Meta.fields` has no `agency` or
  `is_featured`. `Strict` sets `extra="forbid"`, so sending one is a 422 rather than a
  silently dropped field.
- The role is re-read from the database **every request**, never taken from the token — the
  access token contains a user id and nothing else. Fire someone at 09:00 and they lose access
  at 09:00, not whenever their token expires.
- Page views carry the same rule through a different door: `@login_required` plus
  `require_membership_or_404`, not a hidden button.

Full explanation: [[Authentication vs Authorization]] and [[Auth Flow]].

---

## 3. One user must never see another's data

**The failure:** make two accounts, create data in the first, fetch it by id from the
second. It works far more often than anyone expects.

**Here:** the whole of [[Multi-Tenancy]]. Four layers:

1. Every tenant table has a **non-null `agency`** column, checked by a test that reads the
   model metadata — a nullable one means a row can exist belonging to nobody, invisible to
   every scoped query, and it surfaces as "the customer says it vanished".
2. Every query goes through `scoped(queryset, agency_id)` — the filter lives **inside the
   queryset**, not in an `if` after the row is in hand. A condition inside a queryset cannot
   be accidentally skipped, because there is nothing to skip.
3. **A house-rules test bans the unsafe shape.** `Offer.objects.get(pk=…)` cannot also require
   an agency id, so an AST test walks every source file and fails the build on it.
4. **Every resource has a test where Agency B tries it and gets `404`** — 10 in
   `apps/offers/tests.py`, 5 more for the page views in `apps/pages/tests.py`.

A missing row and a forbidden row return the same `404`. `403` would confirm the row exists,
which is enough to count a competitor's clients without reading one.

> [!warning] What the port lost, and what replaced it
> In NestJS the membership check was a **global guard** that armed itself on any route with an
> `:agencyId` parameter — the thing that made a route tenant-scoped was the same thing that
> switched the check on, so there was no decorator to forget.
>
> Django Ninja has no equivalent hook, so here `require_membership()` is a plain function call
> at the top of each handler, and a plain function call **can be left out**. What replaces the
> guarantee is `MembershipCheckTests`: it finds every handler taking an `agency_id` — 56 of
> them today — and fails if one never calls a gate. Handlers that are public on purpose sit in
> a named `EXEMPT` list with the reason written next to them, and a second test fails if that
> list ever names a handler that no longer exists.
>
> A convention plus a test that fails when the convention is broken is weaker than a
> mechanism, and enormously stronger than trusting a reviewer to spot a missing line in a
> forty-line diff.

**A feature without that test is not done.**

---

## 4. Errors and logs from day one

**The failure:** users don't report bugs. They leave, silently, and you never find out.

**Here:**
- **Structured JSON logs** with a `requestId` on every request, echoed in the `X-Request-Id`
  header **and** inside every error body. A user quotes the id; you find the exact request.
- The inbound `X-Request-Id` is **not trusted** — it is generated server-side, because a
  client-chosen id is a free way to poison your own logs by claiming someone else's.
- **Redaction happens at the exit**, in `JsonFormatter`, not at each call site. One
  `logger.info(f"lead {lead}")` written in a hurry would otherwise put a phone number in the
  aggregator forever. Passwords, tokens, OTP codes and secrets become `***`; phone numbers
  become `+21355***222` — enough for an agent to confirm on a call, not enough to dial.
- A house-rules test **bans logging a phone field** at the call site as well. Both layers,
  because the regex catches what the reviewer missed and the ban catches what the regex
  cannot see.
- An unhandled `500` is an incident, and the API's error handlers deliberately **do not**
  catch it — swallowing an unexpected error into a tidy envelope is how an incident becomes a
  mystery.

**Error reporting is wired** (`apps/common/observability.py`). It works with Sentry or a
self-hosted GlitchTip — same protocol, and [[Decision Log|Decision 017]] picks GlitchTip
because the reports contain travelers' names and numbers. No `SENTRY_DSN` = a silent no-op,
which is why local runs and CI stay quiet.

Two details worth knowing:
- Only **unexpected** errors are reported. A 404 or a validation failure is the app working
  correctly, and flooding a tracker with those is how people learn to ignore the alerts.
- Everything leaving for the tracker goes through the **same redaction the logs use**, plus a
  second pass the logs do not need. A crash report is *structured*: the field name is a dict
  key and the value is somewhere else, so the log regex — which has to see `token=value` in
  one string — walks straight past an `{"Authorization": "Bearer …"}` pair. A test caught
  that, and `is_sensitive_key()` now drops the value by its key.

**Still to do:** set `SENTRY_DSN` when you deploy.

---

## 5. Backups are only real once restored

**The failure:** everyone has backups. Almost nobody has restored one. Until you have, you
have hope.

> [!danger] This is the weakest rule in the project right now
> There is **no production database, no backup, and no rehearsal**. The runbook in
> [[Restore From Backup]] describes the procedure; nothing has executed it. That is an honest
> ⬜, not a 🟡, and it is the line to fix before a single real agency is invited in.

What the NestJS repo had and this one does not: a scripted rehearsal that dumps, restores into
a scratch database, and then **starts the real API against the restored data** to confirm an
agency can log in, sees its own leads, and gets a 404 for another agency's. Scripted rather
than a checklist, because a procedure you have to remember at 3am is a procedure you will get
wrong at 3am. Port it before launch, not after.

Still needed: managed Postgres with PITR, a nightly dump to *separate* storage, encryption,
and one rehearsal against the real thing with the date written down.

---

## 6. Money never comes from the client

**The failure:** the frontend sends the price. Webhook signatures unverified. Someone buys a
400 000 DZD Omra for 1 dinar by editing one number.

**Here:** no payment code exists yet. What already holds:
- Prices are stored as **integer centimes** and never as floats — there is a house-rules test
  that fails the build on any `FloatField` anywhere in the schema, because 0.1 + 0.2 is not
  0.3 and a rounding error in a price is a refund conversation.
- The offer form takes a price in **dinars as an integer** and multiplies by 100 server-side.
  No float touches money at any point in the round trip.

When payments arrive:
- prices and plan tiers are read from the **database**, server-side; the client sends an item
  id and nothing else
- every webhook verifies its signature and is idempotent (dedupe on the provider's event id)
- payment state changes only on a verified webhook — **never** on a client redirect saying
  "success"

**Algeria note:** Stripe doesn't operate there, so the boring-and-correct Stripe checklist
everyone recommends doesn't apply directly. Local CIB/Edahabia rails plus manual
CCP/BaridiMob confirmation. Same principle, different provider. **Verify current terms
yourself** — this is exactly the kind of fact nobody should take from a note. See
[[Plan Limits and Quotas]].

---

## 7. Nothing changes silently

**The failure:** the AI edited something in a part of the app you weren't looking at. You
find out from a user.

**Here:**
- **One command**, `./scripts/check.sh`: lint, format check, Django system checks, a
  missing-migration check, and the tests. CI runs *that script*, not a parallel list of steps
  — two lists drift, and the one that drifts is always the local one, so "it passed on my
  machine" quietly stops meaning anything.
- **153 tests**, run against a real **Postgres** in CI rather than SQLite. The bugs they exist
  to catch — a missing `agency_id` in a `WHERE`, a constraint that rejects a legal value, a
  JSON lookup that only works on one backend — are invisible to SQLite.
- The **missing-migration check** is the quiet hero: a model change with no migration works
  perfectly on your laptop, because your database already has the column. It fails on a fresh
  deploy, which is the worst possible place to find out.
- **House rules encoded as AST tests** rather than review comments, in
  `apps/common/tests_house_rules.py`: no unscoped read on a tenant model, no nullable tenant
  column, no handler that names an agency without checking membership, no phone number in a
  log call, no float field, no literal secret in settings, and a pinned list of public routes.
  Each one is a bug that has actually happened somewhere.
- Migrations reviewed by hand.

> [!warning] CI is only half of this rule
> The other half is a GitHub setting: protect `main` and require the `check` job to pass.
> Until you click that, CI is a notification — and people learn to scroll past notifications.

> [!danger] The gap: no browser tests
> `CLAUDE.md` requires Playwright over the five pages that matter — search, offer detail,
> inquiry submission, agency lead inbox, login — with a screenshot assertion on each. **None
> of that exists in this port yet.** Every test here is a Django test; nothing has ever opened
> a real browser at this application. A template that renders an empty page passes the entire
> suite.

---

## Where each rule stands

| Rule | Status | What is still missing |
|---|---|---|
| 1 — No secrets in code | ✅ enforced | — (CI scans the diff and full history) |
| 2 — UI is never security | ✅ enforced | no self-registration, so no signup surface to defend yet |
| 3 — No cross-tenant reads | ✅ enforced | add a test per new resource, always |
| 4 — Errors and logs | 🟡 partly | set `SENTRY_DSN` on deploy |
| 5 — Tested backups | ⬜ **not started** | **no backup, no rehearsal, no production database** |
| 6 — Money not from client | ⬜ n/a | no payment code exists yet |
| 7 — Nothing silent | 🟡 partly | **browser tests**; branch protection in GitHub |

> [!warning] Rule 5 is the one to watch
> Rules 4 and 7 are each one setting or one task away from done and would cost you a bad
> afternoon. Rule 5 is the one that costs you the company. Nothing in this repository has ever
> been backed up or restored.

---

Related: [[Multi-Tenancy]] · [[Authentication vs Authorization]] ·
[[Validation at the Boundary]] · [[Restore From Backup]] · [[Start Here]]
