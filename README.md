# Rihlati — Django

Two-sided marketplace + CRM for Algerian travel agencies. Travelers discover verified agency
offers (Omra, Hajj, organized trips, visa help); agencies receive qualified leads and work them
in a built-in CRM.

This repository is the **Django + Django Ninja implementation**. It started as a stack
comparison against a NestJS version and is now the full application: same product decisions,
same design, same seven rules — a different backend. See entry 030 in
`obsidian/Decisions/Decision Log.md` for why, and what the comparison actually showed.

**Status:** greenfield, no monetization yet. Nothing here has taken a real user or a real
dinar. The honest gaps are listed at the bottom, not hidden.

---

## Read this first

`obsidian/` is an [Obsidian](https://obsidian.md) vault and it is the real documentation —
47 notes explaining *why* each decision was made, not what the code says. Open the folder as a
vault, or read the Markdown directly. Start at:

| Note | For |
|---|---|
| `obsidian/Start Here.md` | the ten-minute orientation |
| `obsidian/How to Study This Codebase.md` | a reading order if you are learning from it |
| `obsidian/System Overview.md` | how a request travels through the app |
| `obsidian/Architecture.md` | what actually runs, what holds state, how a change reaches it |
| `obsidian/Backend/API Endpoints.md` | every route, its guard, and its shape |
| `obsidian/Decisions/Decision Log.md` | every decision, with the alternative that lost |
| `obsidian/Known Gaps.md` | what is wrong in code that already looks finished |
| `obsidian/Milestone Plan.md` | what is built, what is next, what "done" means |

The vault is a deliverable. If a note contradicts the code, the code is right and the note is
a bug — fix the note in the same change.

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env          # then fill in DJANGO_SECRET_KEY
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview
.venv/bin/python manage.py runserver
```

> [!info] No `DATABASE_URL` needed locally
> Without `DATABASE_URL`, SQLite (`preview.sqlite3`) is used. CI and production set it to Postgres.
> Nothing in the code branches on which one you are using.

> **[warning] After pulling new code**
> Re-run `manage.py migrate && manage.py seed_preview`. A stale `preview.sqlite3` causes 500s
> (missing columns) or empty marketplace (old defaults persist). This is the first thing to try
> when "nothing works".

The CSS is generated, so after editing a template:

```bash
npm install
npm run css        # or: npm run css:watch
```

### Seeded logins

`amina` (Dar Essalam Voyages, Alger) and `karim` (Wahran Tours, Oran), password
`preview-password`. Local fixture only — `seed_preview` refuses to run outside `DEBUG`.

For the admin surface (agency verification), make yourself a superuser:

```bash
.venv/bin/python manage.py createsuperuser
```

### API

One JSON API under `/api/`, with the OpenAPI document and a browsable UI at **`/api/docs`**.

```bash
curl -X POST localhost:8000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"karim","password":"preview-password"}'

curl -H "Authorization: Bearer <access_token>" localhost:8000/api/me
```

Access tokens last 15 minutes; refresh tokens rotate on use and are revoked wholesale on
logout. `obsidian/Backend/Auth Flow.md` explains why each of those three sentences is a
separate decision.

That OpenAPI document is this repo's answer to a shared types package: a client generates its
types from it rather than hand-writing a second copy of every interface, which then drifts.

> [!tip] `/api/docs` is the single most useful URL in the project
> It is not hand-written documentation — it is generated from the same Pydantic schemas the
> handlers validate against, so it cannot drift from the code. Every endpoint, every field,
> every response shape, and a "Try it out" button. When [[API Endpoints]] and `/api/docs`
> disagree, `/api/docs` is right and the note is a bug.

### See tenant isolation with your own eyes (90 seconds)

This takes ninety seconds and teaches more than the note does:

1. Log in as `karim` (Wahran Tours, Oran).
2. Go to `/` and open an offer belonging to **Dar Essalam**. Copy its id out of the URL.
3. Paste that id into *your own* agency's edit URL: `/a/<your-agency-id>/offers/<their-offer-id>/`.
4. **404.** Not "forbidden" — as far as that page is concerned, the row does not exist.

That is [[Multi-Tenancy]], and step 4 is the whole point: the row was never in the queryset,
so there was nothing to reject.

### Checks

```bash
./scripts/check.sh
```

Lint, format, Django system checks, missing-migration check, then the test suite —
**218 tests**, all green. CI runs this exact script rather than a parallel list of steps,
because two lists drift and the one that drifts is always the local one — at which point
"it passed on my machine" stops meaning anything.

It runs five things, in this order:

| Step | Catches |
|---|---|
| `ruff check .` | lint: unused imports, shadowed names, long lines |
| `ruff format --check .` | formatting, so diffs are about behaviour |
| `manage.py check` | a misconfigured setting, a broken URLconf, a model that won't make a table |
| `manage.py makemigrations --check --dry-run` | **a model change with no migration** |
| `manage.py test` | the suite — including the tenant-isolation tests |

That fourth step deserves a sentence. A model change with no migration works perfectly on
your laptop, because your database already has the column. It fails on a fresh deploy, which
is the worst possible place to find out. See [[Migrations]].

For the browser-level tests — the five pages that matter, clicked through like a user — see
[[End-to-End Testing]].

## How the seven rules land

`CLAUDE.md` states them. This is where each one physically lives:

| Rule | Where |
|---|---|
| 1 — no secrets in code | `.env` is gitignored; `.env.example` is committed with empty values; the `secrets` job in `.github/workflows/ci.yml` scans full history |
| 2 — the UI is never the security | `NinjaAPI(auth=API_AUTH)` in `config/api.py` — deny-by-default for the whole API. `auth=None` is the only exit, and grepping for it lists the entire public surface in one screen |
| 3 — tenant isolation in the data layer | `apps/common/tenancy.py` — `require_membership`, `require_membership_or_404`, `scoped()`. Every tenant table has a non-null `agency` FK; missing and forbidden both return 404 |
| 4 — errors and logs from day one | `apps/common/errors.py` — typed `{code, details, requestId}` on every failure; `RequestIdMiddleware`; JSON logs that redact phone numbers at the exit; Sentry/GlitchTip inert until `SENTRY_DSN` is set |
| 5 — backups only real once restored | `obsidian/Runbooks/Restore From Backup.md` — **the rehearsal has not been run** |
| 6 — money never comes from the client | Nothing charges yet. Every price is read from the database; money is integer centimes and `apps/common/tests_house_rules.py` fails the build on a `FloatField` money column |
| 7 — nothing changes silently | `./scripts/check.sh` in CI; `makemigrations --check` blocks a model change with no migration |

Three of those are enforced by tests that read the source with `ast`, in
`apps/common/tests_house_rules.py`: every agency-scoped route must call one of the membership
gates, no money column may be a float, and so on. A rule a human has to remember is a rule
that gets forgotten — the ones that already got forgotten once are now tests.

## Layout

```
config/          settings, the API root, URLs
apps/accounts/   User, Agency, Membership, auth, audit log, staff verification
apps/offers/     Offer, programme milestones, quality score, duplicates, reports, links
apps/leads/      Inquiry → Lead, CRM pipeline, notes, tags, quality labels
apps/trips/      Reservations, the departure manifest, the traveler's live trip view
apps/reviews/    Traveler reviews and agency replies
apps/pages/      Server-rendered HTML over the same models — the "PWA-first" half
apps/common/     Tenancy, errors, auth, quotas, throttling, logging, house-rule tests
obsidian/        The vault
```

`apps/pages/` and `apps/*/api.py` are two doors onto one set of rules. A rule written in only
one of them is a rule the other door disagrees with — see
`obsidian/Concepts/One Rule, Two Entry Points.md`.

## What is not built

Listed because a README that only lists wins is a sales page:

- **No end-to-end tests.** The 218 are unit and integration tests. Nothing drives a browser,
  and the five pages that matter have no screenshot assertions.
- **No deployment configuration.** No Dockerfile, no gunicorn, no `STATIC_ROOT`, none of the
  `SECURE_*` settings. `runserver` is the only way this has ever been started.
- **No i18n.** `USE_I18N = True` is set and does nothing: every user-facing string is a
  hardcoded French literal, there is no `locale/`, and Arabic is unreachable. The RTL
  groundwork *is* in place (logical CSS properties, `dir` off `LANGUAGE_CODE`).
- **No image uploads.** Offers carry image URLs; nothing is stored.
- **No payments, no plan gating.** Quotas exist for published offers only. Stripe does not
  operate in Algeria — the rails will be local, and none of it is built.
- **No report review queue.** Reports increment counters that nothing reads.
- **No restore rehearsal.** Rule 5 says a backup is not real until it has been restored, and
  it has not been.

Each of these is written up honestly in the vault, next to the feature it belongs to, with the
open questions that are the owner's to answer. `obsidian/Known Gaps.md` additionally tracks the
defects in code that already *looks* finished, and `obsidian/Milestone Plan.md` puts all of it
in the order it should be done.
