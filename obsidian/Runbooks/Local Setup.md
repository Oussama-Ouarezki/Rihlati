# Local Setup

Getting the Django build of Rihlati running on your machine. It is deliberately short:
two Python packages, one SQLite file, no Docker required.

---

## One-time setup

```bash
cd ~/Desktop/rihlati-django-preview

# 1. a virtualenv, so this project's packages don't mix with your system Python
python3 -m venv .venv

# 2. runtime deps (Django, django-ninja) + dev deps (ruff)
.venv/bin/pip install -r requirements-dev.txt

# 3. create the database file and its tables
.venv/bin/python manage.py migrate

# 4. fill it with fake agencies, offers, leads, a programme and a manifest
.venv/bin/python manage.py seed_preview
```

> [!info] Why a `.venv/bin/...` prefix everywhere
> It saves you from remembering whether the virtualenv is activated. `source
> .venv/bin/activate.fish` works too and then plain `python manage.py …` is enough — but
> every command in this vault is written with the explicit path so it works either way.

> [!info] You do **not** need a `.env` to run this locally
> Seeing `.env.example` sitting there, the obvious guess is that step zero is copying it.
> It isn't. Every setting in `config/settings.py` reads through `os.environ.get(...)` with a
> development default, so with no `.env` at all you get `DEBUG=1`, SQLite, `INFO` logs and no
> Sentry — which is exactly what you want on a laptop.
>
> That is a deliberate trade and it cuts both ways. `DJANGO_DEBUG` defaults to **on**, so an
> unconfigured deployment is a leaky one; the same is true of `DJANGO_SECRET_KEY`, whose
> fallback is the literal string `dev-only-not-a-real-secret`. Both are safe here and both are
> a production bug the moment this runs anywhere public — which is why "`DJANGO_DEBUG`
> refusing to default to on when a real hostname is configured" is written into **M7** in
> [[Milestone Plan]] rather than left to whoever does the deploy remembering.
>
> Copy `.env.example` to `.env` when you want to point at Postgres or turn Sentry on. Not
> before.

---

## Every day

```bash
.venv/bin/python manage.py runserver
```

That's it. One process serves the HTML pages **and** the JSON API. There is no separate
"API server" and "web server" to start — that difference is the single biggest day-to-day
change from the NestJS repo.

The app listens on **`localhost:8000`**. Check it is alive:

```bash
curl -s localhost:8000/api/offers | head -c 200
```

An unauthenticated `GET /api/offers` returning offers is the correct answer — it is one of
the ten deliberately public endpoints ([[API Endpoints]]).

### After pulling new code, run these two before `runserver`

```bash
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview
```

Git updates your code. It does not touch `preview.sqlite3`, which is a *separate artifact*
that only these two commands move. Skipping them does not produce a message telling you to
run them; it produces one of two confusing symptoms:

- **Skipped `migrate`** → the home page returns 500 with `no such column:
  offers_offer.<something>`, naming a field you have never heard of.
- **Skipped `seed_preview`** → no error at all, and an **empty marketplace**. Rows created
  before a column existed hold that column's default, so agencies seeded before verification
  was built read as `draft` rather than `VERIFIED`, and `Offer.publicly_visible()` correctly
  hides every one of their offers.

The second is the one that wastes an afternoon, because nothing is broken — the code is doing
exactly what it is supposed to, to data that is out of date. [[Architecture]] has the table of
which combinations of code, schema and data are valid.

---

## Where to click

| Path | What |
|---|---|
| `/` | Public search: kind, wilaya, budget, dates |
| `/offers/<id>/` | Offer detail + the inquiry form (no account needed) |
| `/login/` | Agency login |
| `/dashboard/` | Redirects you to your own agency |
| `/a/<agency_id>/offers/` | Your offers, with lead counts; create & edit |
| `/a/<agency_id>/leads/` | The CRM inbox: filter by status, change status inline |
| `/admin/` | Django admin — the agency verification queue |
| `/api/docs` | **The interactive API browser**, generated from the schemas |

> [!tip] `/api/docs` is the single most useful URL in the project
> It is not hand-written documentation — it is generated from the same Pydantic schemas the
> handlers validate against, so it cannot drift from the code. Every endpoint, every field,
> every response shape, and a "Try it out" button. When [[API Endpoints]] and `/api/docs`
> disagree, `/api/docs` is right and the note is a bug.

### See tenant isolation with your own eyes

This takes ninety seconds and teaches more than the note does:

1. Log in as `karim` (Wahran Tours, Oran).
2. Go to `/` and open an offer belonging to **Dar Essalam**. Copy its id out of the URL.
3. Paste that id into *your own* agency's edit URL: `/a/<your-agency-id>/offers/<their-offer-id>/`.
4. **404.** Not "forbidden" — as far as that page is concerned, the row does not exist.

That is [[Multi-Tenancy]], and step 4 is the whole point: the row was never in the queryset,
so there was nothing to reject.

### The seeded accounts

`seed_preview` creates three agencies. Every account uses the password `preview-password`
(a local fixture, not a credential — it is in the seed file in plain sight for that reason):

| Login | Agency | Notes |
|---|---|---|
| `amina` | Dar Essalam Voyages (Alger) | owner; has the Omra programme, the manifest, a review |
| `karim` | Wahran Tours (Oran) | owner; has a draft Hajj offer and a tracked link |
| — | Sahara Évasion (Ghardaïa) | **pending**, on purpose, so `/admin/` has a queue to work |

The third agency has no login by design. An empty verification queue makes
[[Agency Verification]] look like a feature that doesn't exist.

### Talk to the API from a terminal

```bash
# log in — this is a public endpoint, no token needed to get a token
curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"karim","password":"preview-password"}'

# then use the access token
curl -s localhost:8000/api/me -H "Authorization: Bearer <access_token>"
```

The response to `login` contains the memberships, and the `agency` id in there is what you
put in `/api/agencies/{agency_id}/leads`. See [[Auth Flow]] for why there are two tokens and
what the refresh one is for.

---

## Test it

Two different things people mean by "test", and this repo has both.

### By hand, in a browser

The fastest way to check a change actually works — not just that it imports.

1. `runserver` running, database seeded.
2. **As a traveler:** `localhost:8000` — search, open an offer, submit an inquiry and tick
   the consent box. No login needed; this is the marketplace.
3. **As an agency:** `/login/` as `amina`. The inquiry you just submitted should appear in
   the CRM inbox on the next page load. That loop — public inquiry → agency inbox — is the
   single most important thing in the product to keep working.
4. **As a different agency:** log in as `karim` and confirm you do *not* see Dar Essalam's
   leads or offers anywhere.

### Automated

```bash
./scripts/check.sh
```

One command, and **CI runs exactly this script** rather than a parallel list of steps. Two
lists of checks drift, and the one that drifts is always the local one — at which point "it
passed on my machine" stops meaning anything.

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

---

## Every command

| Command | Does |
|---|---|
| `manage.py runserver` | the whole app on `localhost:8000`, reloading on save |
| `manage.py migrate` | apply schema changes to your database |
| `manage.py makemigrations` | write a migration file for a model change |
| `manage.py seed_preview` | wipe and refill with fake data |
| `manage.py createsuperuser` | an account that can reach `/admin/` |
| `manage.py shell` | a Python REPL with the models importable |
| `manage.py dbshell` | a SQL prompt on the current database |
| `sqlitebrowser preview.sqlite3` | a GUI on every table, column and foreign key |
| `manage.py graph_models ... -o db-schema/schema-clean.png` | an ER diagram image — see below |
| `manage.py test` | every test |
| `manage.py test apps.offers` | one app's tests, when you're iterating |
| `ruff check . --fix` | fix what the linter can fix on its own |
| `ruff format .` | reformat |
| `./scripts/check.sh` | all of the above. **Run before you commit.** |
| `npm run css` | rebuild `static/app.css` after editing a template's classes |

> [!info] Why there is still a `package.json`
> Only for Tailwind. The CSS is compiled from `styles/input.css`, whose `@theme` block is
> copied verbatim from the Next.js app so both builds render the same brand. No JavaScript
> ships to the browser from it.

---

## After I change the database schema

Whenever a file in `apps/*/models.py` changes:

```bash
.venv/bin/python manage.py makemigrations   # writes the file
.venv/bin/python manage.py migrate          # applies it
```

`makemigrations` names the file itself from what changed. **Read the generated file before
you commit it** — that is rule #7, and it is not ceremony: a rename that Django cannot tell
from a drop-and-add becomes `RemoveField` + `AddField`, which is a silent data loss on a real
database. See [[Migrations]].

---

## Useful things

### Look at your data

```bash
.venv/bin/python manage.py dbshell
```

`.tables` lists tables, `.schema offers_offer` describes one, `.quit` quits. (Those are
SQLite commands; on Postgres it's `\dt`, `\d offers_offer`, `\q`.)

The friendlier option is `/admin/` in a browser — a spreadsheet view of every table.
Genuinely the fastest way to build a feel for the schema. Read [[Data Model Overview]] with
`/admin/` open beside it.

> [!info] `/admin/` only shows what's been registered
> Django's admin is opt-in per model — `@admin.register(...)` in an app's `admin.py`. Right
> now only `Agency` and `AuditLog` (in `apps/accounts/admin.py`) are registered, on purpose:
> the `Agency` admin routes through the same status-transition + `AuditLog` write as the API,
> rather than a raw `list_editable` that could badge an agency with no record of who decided.
> A model with no `admin.py` entry is invisible in `/admin/` even though it's in the database
> — `dbshell` or DB Browser (below) show every table regardless of registration.

### A GUI on the actual `.sqlite3` file

**DB Browser for SQLite** (`sqlitebrowser`) opens the raw file — every table, every column,
every foreign key — with no Django app required to see it, and it can edit rows directly
(careful: it writes straight to the file, no validation, no audit trail).

```bash
sqlitebrowser preview.sqlite3
```

It was already installed on this machine (`/usr/bin/sqlitebrowser`); on a fresh machine
that's `sudo apt install sqlitebrowser`. Point it at whichever `.sqlite3` file `DATABASES`
resolves to — see [[Data Model Overview]] for why that fallback exists and when it switches
to Postgres.

### A picture of the schema (ER diagram)

One-time setup — a dev-only dependency, never installed in production:

```bash
.venv/bin/pip install django-extensions pydot   # pydot needs the system `graphviz` package
sudo apt install graphviz                        # if `dot` isn't already on your machine
```

Then in `config/settings.py`, `django_extensions` is added to `INSTALLED_APPS` **gated behind
`DEBUG`**, so it's structurally impossible for it to load in production:

```python
"apps.pages",
*(["django_extensions"] if DEBUG else []),
]
```

Generate the diagram:

```bash
.venv/bin/python manage.py graph_models accounts offers leads trips reviews \
  --exclude-models=UUIDModel,AbstractBaseSession,LogEntry,Group,Permission,ContentType,AbstractBaseUser,PermissionsMixin \
  -o db-schema/schema-clean.png
```

Output lives in `db-schema/` at the repo root. `--exclude-models` strips Django's own
internal/abstract classes so the picture is just Rihlati's models; drop the flag (or use
`-a` for every installed app) if you want Django's `auth`/`sessions`/`admin` tables in the
picture too, at the cost of a much busier image.

> [!info] Why this is worth reading before poking at code
> `agency` foreign keys on every tenant table are [[Multi-Tenancy]] as a literal arrow on the
> diagram. Every model inheriting `UUIDModel` at the bottom is "IDs are UUIDs, never
> sequential integers" enforced structurally rather than by convention. A diagram makes both
> facts obvious in a way scrolling through `models.py` files one at a time doesn't.

### The Python shell, with the models loaded

```bash
.venv/bin/python manage.py shell
```

```python
from apps.offers.models import Offer
Offer.publicly_visible().count()
```

That one queryset is worth poking at by hand — it is the *only* set of offers a traveler is
ever allowed to see, and understanding why it filters on three things at once is most of
[[Search and Filters]].

### Start completely fresh

```bash
rm preview.sqlite3
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview
```

Safe: `preview.sqlite3` is a scratch database with nothing but fake data in it. Nothing on
your machine is backed up — which is exactly why the real one needs
[[Restore From Backup]].

---

## When something breaks

**`ModuleNotFoundError: No module named 'ninja'`**
You're running system Python instead of the virtualenv. Use `.venv/bin/python`, or activate
the venv first.

**`no such table: offers_offer`**
The database file exists but is empty. `manage.py migrate`.

**`Your models have changes that are not yet reflected in a migration`**
Exactly what `check.sh` is for. `manage.py makemigrations`, read the file, commit it with
the model change in the same commit.

**`UNIQUE constraint failed: offers_offer.slug` when migrating**
Stale rows from an older seed conflicting with a new constraint. Delete `preview.sqlite3`
and re-run migrate + seed. This is a *development* answer only; on a real database the
equivalent is a data migration with a written plan (rule #7).

**A test fails with `403` where you expected `200`**
Almost always a role, not a bug. Creating or updating an offer needs `Membership.MANAGER` or
above; the default in the test factories is `AGENT`. Fixing it by lowering the required role
makes the test pass for the wrong reason.

**A test fails with `404` where you expected `403`**
Also almost always correct. Read [[Multi-Tenancy]]: a *foreign row id* is 404 (it was never
in the queryset), a *foreign agency id in the path* is 403 (agency ids are not secret). The
tests assert those two separately on purpose — `assertIn(status, (403, 404))` would pass
while the bug is present.

**`TypeError: NinjaAPI.__init__() got an unexpected keyword argument 'csrf'`**
You followed a Django Ninja 0.x tutorial. In 1.x, CSRF belongs to the cookie auth class, not
to the API. See [[Auth Flow]].

**`RuntimeError: Model class ... doesn't declare an explicit app_label`**
You ran a script directly instead of through `manage.py`. Django has to be set up first.

---

## Before you commit

```bash
./scripts/check.sh
```

And the secrets check from [[The Seven Rules]]:

```bash
git diff --staged | grep -iE "sk-|secret|password|api[_-]?key|BEGIN.*PRIVATE"
```

If that prints anything with a real value in it, stop. (`preview-password` in the seed file
will match — that one is fine, and knowing *why* it's fine is the point of the exercise: it
grants access to fake agencies in a scratch SQLite file and appears nowhere else.)

---

## Open questions

- Postgres locally, or keep SQLite for development? CI already runs Postgres, so the risk
  today is a bug that only appears in CI. Running it locally costs a Docker container and
  removes that whole class of surprise.
- Should `seed_preview` grow a `--minimal` flag? It currently creates a full demo, which is
  right for looking at the app and slightly heavy when you just want two rows to test against.

---

Related: [[Start Here]] · [[Migrations]] · [[Data Model Overview]] · [[The Seven Rules]] ·
[[End-to-End Testing]] · [[API Endpoints]]
