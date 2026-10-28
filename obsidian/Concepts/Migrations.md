# Migrations

> [!tip] In plain words
> Editing a model in `models.py` is just a wish on paper — nothing in the real database
> changes yet. `makemigrations` writes down the change; `migrate` is what makes it real. Like
> a phone installing pending updates, it applies whatever hasn't happened yet, in order,
> without erasing what's already there. It never "refreshes" (wipes and reloads) — it only
> adds on top.

## What they are

A **migration** is a recorded change to the database structure: add a column, add a table, add
an index. Each one is a file, they're numbered, and they run in order.

You never edit the database by hand. You edit the model and run two commands:

```bash
.venv/bin/python manage.py makemigrations   # write the change down
.venv/bin/python manage.py migrate          # apply it
```

Django compares your models to the migrations it already has, works out the difference, and
writes a file like `apps/offers/migrations/0002_offer_cover_image_url.py`:

```python
class Migration(migrations.Migration):
    dependencies = [("offers", "0001_initial")]
    operations = [
        migrations.AddField(
            model_name="offer",
            name="cover_image_url",
            field=models.URLField(blank=True, max_length=500),
        ),
    ]
```

Two things to notice, because they explain most of Django's migration behaviour.

**It's Python, not SQL.** The same file produces `ALTER TABLE` on Postgres and the
table-rebuild dance SQLite requires. You can also read it, and — importantly — **edit it**. A
migration is code you own, not an opaque artefact.

**`dependencies` is a graph, not a sequence.** Migrations across apps form a directed graph,
which is how Django knows `leads.0001` must run after `offers.0001` (because `Lead` has a
foreign key to `Offer`). When you eventually hit a confusing migration error, it is almost
always this graph telling you something true.

> [!info] Django vs Prisma
> Prisma diffs `schema.prisma` against the live database and writes raw SQL. Django diffs your
> models against **its own migration history** and writes Python.
>
> That difference has one consequence worth knowing: Django's picture of "current state" is
> the sum of the migration files, not the actual database. If the two disagree — because
> someone ran a manual `ALTER TABLE` — Django doesn't notice, and will generate a migration
> that fails. The database is not the source of truth here; the migration files are.

## Why not just change the database directly

Because there are at least three databases: yours, the production server's, and whatever a
future teammate has. If changes were made by hand they'd drift apart within a week, and you'd
have no idea which one was correct.

Migrations are committed to git, so the structure travels with the code that needs it. The
commit that adds `Offer.expires_at` also contains the migration creating the column — check
out that commit and both exist together.

## The check that catches the most common mistake

```bash
.venv/bin/python manage.py makemigrations --check --dry-run
```

`./scripts/check.sh` runs this on every commit and CI runs the same script.

The failure it prevents: you edit a model, run the app, everything works — because *your*
database already has the column from an earlier experiment, or because SQLite was lenient.
You commit. The next fresh deploy has a model expecting a column that no migration creates,
and it fails at runtime with a `ProgrammingError` in production.

`--check --dry-run` says "would you need to write a migration right now?" and exits non-zero
if the answer is yes. **This is the single highest-value line in the check script**, because
the mistake is invisible locally by construction.

## The dangerous ones

Adding a nullable column is safe. These are not:

**Dropping a field** deletes its data, immediately, no confirmation.

**Renaming a field** is worse, because Django cannot tell a rename from "drop the old one, add
a new empty one". It will *ask you interactively* — `Did you rename offer.title to
offer.title_fr? [y/N]` — and the default is **no**, which means drop-and-add, which means the
data is gone. Answering that prompt carelessly, or running `makemigrations --noinput` in a
script, silently empties a column.

**Adding a `NOT NULL` column to a table with rows** makes Django stop and demand a one-off
default. Whatever you type there is written into every existing row, forever. That prompt
deserves more thought than it usually gets.

**Adding a `unique=True` column to a table with rows** cannot work in one step, and unlike the
case above Django does *not* stop to warn you. Every existing row is given the same default,
so the first row is fine and the second one violates the constraint. The fix is always the
same three operations in one migration: add the column without `unique`, `RunPython` a value
into every row, then `AlterField` to add the constraint.

**Adding an index to a large table** locks it while the index builds. Fine at 1 000 rows; an
outage at 10 million. Postgres has `CREATE INDEX CONCURRENTLY`, and Django exposes it as
`AddIndexConcurrently` from `django.contrib.postgres.operations` with `atomic = False` on the
migration.

> [!danger] Read every generated migration before committing it
> `CLAUDE.md` rule 7. `makemigrations` is a code generator, and generated code that touches
> live data is exactly the code you should read most carefully. Look for `RemoveField`,
> `RenameField`, and `AlterField` on a populated column.

For a rename with real data, the safe shape is **four steps across two deploys**: add the new
column, write to both, backfill the old rows, then drop the old column once nothing reads it.
Slower and boring, and it never loses anything.

> [!example] There is already a destructive migration in this repo — go read it
> `apps/accounts/migrations/0002_auditlog_refreshtoken_remove_agency_is_verified_and_more.py`
> contains a `RemoveField` on `Agency.is_verified`. That column became a `@property` computed
> from `status`, so the boolean genuinely had to go — a stored flag and a status field that
> can disagree is a bug waiting to happen, and only one of them can be the truth.
>
> It was free here because the database held nothing but seed data. With real agencies it
> would be the four-step dance above: add `status`, backfill it from `is_verified`, ship the
> code that reads `status`, and only then drop the boolean. **The migration is identical; the
> circumstances are what made it safe.** That is the distinction to carry forward — nothing
> about the file warns you.
>
> There are nine migrations in the repo today. Read all nine; it takes ten minutes and it is
> the fastest way to see how the schema actually grew.

> [!bug] This exact bug shipped, and here is why nothing caught it — 2026-08-09
> `offers/0003` added `Offer.slug` as `SlugField(unique=True)` in a single `AddField`. On a
> fresh clone it applied perfectly. On the preview database, which already had five offers, it
> gave all five the default `''` and died on the second:
>
> ```
> django.db.utils.IntegrityError: UNIQUE constraint failed: new__offers_offer.slug
> ```
>
> Migrations run in a transaction, so nothing was corrupted — the whole migration rolled back.
> But that left the database at `offers/0002` while the code expected `0003`, and the symptom
> was the *home page* returning 500 on `no such column: offers_offer.departure_wilaya_code`.
> The error names a column nobody touched, three features away from the actual cause. That gap
> between symptom and cause is the thing to remember.
>
> **Why the test suite was green the whole time:** every test starts from an empty database,
> and an empty table accepts any migration at all. `makemigrations --check` did not help
> either — it only asks whether a migration is *missing*, never whether one *works*.
>
> The fix is the three-step shape above. The guard against a repeat is
> `apps/offers/tests_migrations.py`, which rewinds to `0002`, inserts three offers whose
> natural slug collides, rolls forward, and asserts three distinct readable slugs. It is the
> only test in the repo that runs a migration against rows, which is the only way this class
> of bug is visible. See [[Architecture]] for where migrations sit in the release path.

## Data migrations

Structure isn't the only thing that changes. Sometimes you need to *move* data —
backfill a new column, split a field, normalise every phone number to E.164.

```bash
.venv/bin/python manage.py makemigrations --empty offers
```

then write a `RunPython` operation. Two rules for these:

**Use `apps.get_model("offers", "Offer")`, never `from apps.offers.models import Offer`.** The
imported model is today's version; the migration must run against the version of the model
*as it was at that point in history*, or it breaks the day you add a field. `apps.get_model`
gives you the historical one.

**Always write the reverse function**, even if it's `migrations.RunPython.noop`. A migration
with no reverse cannot be rolled back, which turns a bad deploy into a restore. See
[[Restore From Backup]].

## The four commands worth knowing

| Command | Does |
|---|---|
| `makemigrations` | write a migration for model changes |
| `migrate` | apply unapplied migrations |
| `showmigrations` | list every migration and whether it's applied — **the first thing to run when something is confusing** |
| `sqlmigrate offers 0002` | print the SQL a migration would run, without running it |

`sqlmigrate` is the one people don't discover for years. Before any migration you're unsure
about, print its SQL and read it. That's the actual truth of what will happen to the database.

Production runs `migrate` and never `makemigrations` — it applies exactly what's in git, so
what runs on the server is what you reviewed.

## Before it matters

Right now there's no production database and no real data, so migrations are free. Break
whatever you like:

```bash
rm preview.sqlite3
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview
```

Squashing or deleting the whole `migrations/` folder and regenerating from scratch is also
fine today, and will never be fine again after the first real row.

The moment one real agency has one real lead, that stops being true. This is the cheapest time
to get the schema shape right, which is why [[Data Model Overview]] is worth reading carefully
now rather than later.

> [!warning] SQLite is lying to you a little
> `DATABASE_URL` is unset locally, so migrations are tested against SQLite and CI runs them
> against Postgres. SQLite rebuilds tables for most schema changes and is far more permissive
> about constraints and column types, so a migration that passes locally can still fail on
> Postgres.
>
> CI catching it is the safety net, and the better fix is running Postgres locally too. See
> [[Local Setup]].

---

Related: [[Data Model Overview]] · [[Local Setup]] · [[Indexes and Why Queries Get Slow]] ·
[[The Seven Rules]] · [[Restore From Backup]]
