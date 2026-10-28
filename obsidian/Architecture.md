# Architecture

[[System Overview]] answers *why the code is shaped this way*. This note answers a different
question: **what actually runs, what holds state, and how a change gets from your editor into
it.** Read that one first if you have not — this is the physical half.

It exists because the shape of the system on paper and the set of moving parts you have to
keep alive are not the same list, and the second one is what breaks on a Tuesday.

---

## The whole running system

```
                    ┌──────────────────────────────────────┐
  browser  ────────►│  ONE Django process                  │
                    │                                      │
                    │   config/urls.py ──┬── apps/pages/   │──► HTML
                    │                    └── config/api.py │──► JSON
                    │                                      │
                    │   apps/common/  (tenancy · auth ·    │
                    │                  errors · logging)   │
                    └───────────────┬──────────────────────┘
                                    │
                                    ▼
                      ┌─────────────────────────┐
                      │  ONE database           │   ← all state lives here
                      │  Postgres, or SQLite    │      rows, sessions,
                      │  when DATABASE_URL is   │      refresh tokens,
                      │  unset                  │      the audit log
                      └─────────────────────────┘

                      Sentry / GlitchTip  ← errors only, and only if SENTRY_DSN is set

                      Ollama (127.0.0.1:11434)  ← one optional call, only if CHAT_ENABLED=1
```

**That is the entire inventory.** No queue, no worker, no Redis, no search engine, no object
store, no second service — with one deliberate exception: the offer assistant asks a local
model over HTTP ([[Agency Chatbot]]). It is optional, synchronous, and off unless enabled, so
it changes nothing about the rest of this note. The rule still holds for everything else:
each new component is a thing that can be down while everything else looks fine, and none has
earned its place yet.

Two consequences follow directly, and they are the load-bearing part of this note:

- **Anything slow happens while the traveler waits.** There is no background job. If sending a
  notification email is added tomorrow, it runs inside the request that created the lead, and
  a slow mail server becomes a slow inquiry form. That is the moment a queue stops being
  premature.
- **The process is not the truth; the database is.** Restarting Django loses nothing, because
  nothing important is held in memory — sessions and refresh tokens are rows. This is why the
  app can be redeployed at any moment without a maintenance window, and it is worth protecting.

> [!warning] One thing *is* held in memory, and it is a bug at two processes
> `CACHES` is `LocMemCache` (`config/settings.py`), and the login rate limits in
> `apps/common/throttling.py` count in that cache. Local memory is **per process**. Run two
> web workers and an attacker gets twice the login attempts; run four and they get four times.
> Nothing warns you, and the limit still *looks* enforced.
>
> The day the app runs on more than one process, the cache has to become something shared —
> Redis, or Postgres via `django.core.cache.backends.db`. Filed here rather than in
> [[Auth Flow]] because it is not a flaw in the rate limit; the rate limit is correct. It is a
> deployment decision that silently invalidates one.

---

## What each directory is responsible for

The rule: **a file has one job, and you can say the job in one line.** If you cannot, it is
two files.

| Path | The one job |
|---|---|
| `config/settings.py` | reads the environment; decides nothing at runtime |
| `config/urls.py` | maps a URL to a view — the HTML door |
| `config/api.py` | mounts the `NinjaAPI` with `auth=API_AUTH` — the JSON door, deny-by-default |
| `config/wsgi.py` | the handle a web server grabs onto |
| `apps/common/tenancy.py` | `require_membership`, `scoped()` — the only sanctioned way to reach a tenant row |
| `apps/common/auth.py` | who the caller is, on the API side |
| `apps/common/errors.py` | turns any failure into `{code, details, requestId}` |
| `apps/common/middleware.py` | `RequestIdMiddleware` — stamps the id everything else logs |
| `apps/common/logging.py` | JSON lines, phone numbers redacted at the exit |
| `apps/common/quotas.py` · `throttling.py` | how much you may have · how fast you may ask |
| `apps/<feature>/models.py` | the rules, on the model, so both doors get them |
| `apps/<feature>/api.py` | the JSON handlers for that feature |
| `apps/pages/views.py` | the HTML handlers for **every** feature |
| `apps/*/migrations/` | the schema's history, one file per change |

Note the asymmetry: JSON handlers live *with* their feature, HTML handlers all live together
in `apps/pages/`. That was a real choice — pages cut across features (the dashboard shows
offers *and* leads *and* trips) and splitting them by feature would have meant a template
importing from four apps. The cost is that `apps/pages/views.py` is the longest file in the
repo and will eventually have to be split by screen rather than by feature.

---

## The four states of "the app"

This is the part that bit on 2026-08-09 and the reason this note exists.

**Your code and your database are two separate artifacts that version independently.** Git
moves one of them. Nothing moves the other unless you say so.

| | code | schema | data |
|---|---|---|---|
| fresh clone, migrated, seeded | new | new | new | ✅ works |
| **pulled new code, forgot `migrate`** | new | **old** | old | ❌ 500s |
| migrated but not re-seeded | new | new | **old** | ❌ looks empty |
| migrated, seeded | new | new | new | ✅ works |

Rows 2 and 3 both present as "nothing works", and neither says why:

- **Row 2** — the code selects a column the table does not have. `no such column:
  offers_offer.departure_wilaya_code`, on the home page, naming a field you never touched.
- **Row 3** — subtler and worse, because there is no error at all. A migration that adds a
  column gives every existing row the default. `Agency.status` defaults to `draft`, and
  `Offer.publicly_visible()` requires `status=VERIFIED` — so agencies created before
  verification existed silently became unverified, every offer vanished from search, and each
  offer page returned a perfectly correct 404. **Zero exceptions, zero log lines, empty
  marketplace.**

`manage.py migrate && manage.py seed_preview` after every pull. See [[Local Setup]].

> [!tip] Row 3 is not only a local-fixtures problem
> On a laptop the answer is to re-seed. In production there is nothing to re-seed — the
> defaulted rows are real customers. The lesson generalises: **when you add a column with a
> default, you have just written that value into every existing row, and you have to decide
> whether it is the right answer for rows that existed before the question did.** Sometimes
> the default is fine. Sometimes it needs a `RunPython` backfill in the same migration. It is
> never automatically correct. [[Migrations]] has the mechanics.

---

## How a change reaches the running app

```
edit code
   │
   ├─ model changed? ──► manage.py makemigrations ──► READ THE FILE
   │                                                  (rule 7; generated code
   │                                                   that touches live data)
   ▼
./scripts/check.sh        lint · format · system checks · missing-migration · tests
   │                      One script. CI runs this exact file, not a copy of its
   │                      contents — see .github/workflows/ci.yml.
   ▼
push ──► CI on real Postgres ──► branch protection blocks merge if red
   │
   ▼
deploy ──► manage.py migrate ──► restart process
           ^^^^^^^^^^^^^^^^^^ the step with no undo
```

Two things about that diagram are deliberate.

**`makemigrations --check` is inside `check.sh`, not a habit.** A model change with no
migration works perfectly on your machine, because your database already has the column. It
fails on a fresh deploy, which is the worst place to learn.

**CI runs against real Postgres, not SQLite.** A missing `agency_id` in a `WHERE` clause, a
constraint that rejects a legal value, a `JSONField` lookup that only works on one backend —
all invisible to SQLite. Local SQLite is a convenience for *you*; it is not what the tests are
allowed to believe.

---

## Configuration is the whole environment surface

Every difference between your laptop and production is an environment variable, and there are
only six that matter. Nothing else in the code asks what environment it is in — no
`if PRODUCTION:` anywhere, which is why the laptop and the server run the same code paths.

| Variable | Unset means | Set it in production because |
|---|---|---|
| `DATABASE_URL` | SQLite at `preview.sqlite3` | one file cannot serve concurrent writers |
| `DJANGO_SECRET_KEY` | a hardcoded dev string | it signs sessions; the default is public |
| `DJANGO_DEBUG` | **`1` — on** | `DEBUG=1` renders settings, SQL and env on any error page |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | otherwise the real hostname is rejected |
| `SENTRY_DSN` | error reporting is inert | rule 4 — an unhandled 500 nobody sees is not handled |
| `LOG_LEVEL` | `INFO` | — |

> [!danger] `DJANGO_DEBUG` defaults to on
> `os.environ.get("DJANGO_DEBUG", "1") == "1"`. A deploy that forgets this variable is a deploy
> that publishes its own settings module to anyone who can trigger an error. The default is
> chosen for the laptop; the risk lands on the server. If a deployment path is ever built, it
> should refuse to start rather than trust the default — the same reasoning that made
> `seed_preview` refuse to run outside `DEBUG` after it was found capable of wiping a
> production database with no confirmation.

---

## What is deliberately absent

Not oversights. Each is a component that would have to be kept alive, and none has a problem
yet that justifies it:

- **No queue / worker.** Nothing needs to outlive its request. Revisit when email or SMS ships.
- **No Redis.** Only the rate-limit counters want shared memory, and there is one process.
- **No search service.** Postgres handles filtering at this catalogue size. [[Search and Filters]]
  says where that stops being true.
- **No CDN or object store.** Offers carry image *URLs*; nothing is uploaded. [[Image Uploads]].
- **No cache layer.** Correct queries with the right indexes first; a cache over a slow query
  hides the slow query. [[Indexes and Why Queries Get Slow]].

## What is absent and should not be

Honesty, not a plan:

- **There is no deployment configuration at all.** No `Dockerfile`, no `Procfile`, no
  `gunicorn` in `requirements.txt`, no `STATIC_ROOT`, no WhiteNoise, and none of the
  `SECURE_*` settings — `SECURE_HSTS_SECONDS`, `SECURE_SSL_REDIRECT`,
  `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`. `manage.py check --deploy` will list them.
  Today `runserver` is the only way this application has ever been started, and `runserver` is
  explicitly not for production.
- **No end-to-end test.** The suite drives Python, never a browser. The five pages that matter
  have no screenshot assertion. [[The Seven Rules]] rule 7.
- **Backups are unrehearsed.** [[Restore From Backup]] exists as a document and has never been
  executed, which by rule 5 means there is no backup.

---

## Open questions — yours

- **Where does this run?** A VPS in France, a VPS in Algeria, or a managed platform. It changes
  the deployment work above, and it changes what you can honestly tell an agency about where
  their clients' phone numbers are stored. *(Whether Algerian law constrains hosting personal
  data abroad is a real question and I will not invent the answer — verify it with a lawyer
  before it is architecture.)*
- **One process or several?** The moment the answer is "several", `LocMemCache` becomes a
  security bug rather than a shortcut. Cheap to fix in advance, embarrassing to discover.
- **When does the first background job appear?** Whichever feature needs it — email, SMS,
  nightly duplicate scans — is the one that pays for the queue.

---

Related: [[System Overview]] · [[The Seven Hops of a Request]] · [[Migrations]] ·
[[Multi-Tenancy]] · [[Local Setup]] · [[The Seven Rules]] · [[Decision Log]]
