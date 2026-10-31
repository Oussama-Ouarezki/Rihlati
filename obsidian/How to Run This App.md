# How to Run This App

Getting the Django build of Rihlati running on your machine. It is deliberately short:
two Python packages, one SQLite file, no Docker required.

---

## One-time setup

```bash
python3 -m venv .venv

.venv/bin/pip install -r requirements.txt -r requirements-dev.txt

# No .env needed for local SQLite dev
# Every setting in config/settings.py reads through os.environ.get() with a development default
.venv/bin/python manage.py migrate

# Fill it with fake agencies, offers, leads, a programme and a manifest
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

> That is a deliberate trade and it cuts both ways. `DJANGO_DEBUG` defaults to **on**, so an
> unconfigured deployment is a leaky one; the same is true of `DJANGO_SECRET_KEY`, whose
> fallback is the literal string `dev-only-not-a-real-secret`. Both are safe here and both are
> a production bug the moment this runs anywhere public — which is why "`DJANGO_DEBUG`
> refusing to default to on when a real hostname is configured" is written into **M7** in
> [[Milestone Plan]] rather than left to whoever does the deploy remembering.

> Copy `.env.example` to `.env` when you want to point at Postgres or turn Sentry on. Not
> before.

---

## Every day

```bash
.venv/bin/python manage.py runserver
```

The app listens on **`localhost:8000`**. Check it is alive:

```bash
curl -s localhost:8000/api/offers | head -c 200
```

An unauthenticated `GET /api/offers` returning offers is the correct answer — it is one of
the ten deliberately public endpoints ([[API Endpoints]]).

---

## After pulling new code, run these two before `runserver`

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
exactly what it is supposed to, to data that is out of date. See [[Architecture]] for the table
of which combinations of code, schema and data are valid.

---

## Key commands

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
| `manage.py graph_models ... -o db-schema/schema-clean.png` | an ER diagram image |
| `manage.py test` | every test |
| `ruff check . --fix` | fix what the linter can fix on its own |
| `ruff format .` | reformat |
| `./scripts/check.sh` | all of the above. **Run before you commit.** |
| `npm run css` | rebuild `static/app.css` after editing a template's classes |

> [!info] Why there is still a `package.json`
> Only for Tailwind. The CSS is compiled from `styles/input.css`, whose `@theme` block is
> copied verbatim from the Next.js app so both builds render the same brand. No JavaScript
> ships to the browser from it.

---

## Seeded logins

`seed_preview` creates three agencies. Every account uses the password `preview-password`
(a local fixture, not a credential — it is in the seed file in plain sight for that reason):

| Login | Agency | Notes |
|---|---|---|
| `amina` | Dar Essalam Voyages (Alger) | owner; has the Omra programme, the manifest, a review |
| `karim` | Wahran Tours (Oran) | owner; has a draft Hajj offer and a tracked link |
| — | Sahara Évasion (Ghardaïa) | **pending**, on purpose, so `/admin/` has a queue to work |

The third agency has no login by design. An empty verification queue makes
[[Agency Verification]] look like a feature that doesn't exist.

---

## API access

### Interactive API browser: `/api/docs`

The OpenAPI document is generated from the same Pydantic schemas the handlers validate against,
so it cannot drift from the code. Every endpoint, every field, every response shape, and a
"Try it out" button. When [[API Endpoints]] and `/api/docs` disagree, `/api/docs` is right.

### Login (public endpoint, no token needed to get a token)

```bash
curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"karim","password":"preview-password"}'
```

The response contains the memberships, and the `agency` id in there is what you
put in `/api/agencies/{agency_id}/leads`. See [[Auth Flow]] for why there are two tokens and
what the refresh one is for.

Access tokens last 15 minutes; refresh tokens rotate on use and are revoked wholesale on
logout.

---

## See tenant isolation with your own eyes (90 seconds)

This teaches more than the note does:

1. Log in as `karim` (Wahran Tours, Oran).
2. Go to `/` and open an offer belonging to **Dar Essalam**. Copy its id out of the URL.
3. Paste that id into *your own* agency's edit URL: `/a/<your-agency-id>/offers/<their-offer-id>/`.
4. **404.** Not "forbidden" — as far as that page is concerned, the row does not exist.

That is [[Multi-Tenancy]], and step 4 is the whole point: the row was never in the queryset,
so there was nothing to reject.

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