# Migrations

> [!tip] In plain words
> Editing `schema.prisma` is just a wish on paper — nothing in the real database changes yet.
> Running `db:migrate` is what makes it real: like a phone installing pending updates, it
> applies whatever changes haven't happened yet, in order, without erasing anything already
> there. It never "refreshes" (wipes and reloads) — it only adds on top.

## What they are

A **migration** is a recorded change to the database structure — add a column, add a table,
add an index. Each one is a file, they're numbered, and they run in order.

You never edit the database by hand. You edit `apps/api/prisma/schema.prisma` and run:

```bash
npm run db:migrate
```

Prisma compares the file to the actual database, writes a migration for the difference,
applies it, and regenerates the TypeScript types.

## Why not just change the database directly

Because there are at least three databases: yours, the production server's, and whatever a
future teammate has. If changes were made by hand, they'd drift apart within a week and
you'd have no idea which was correct.

Migrations are committed to git, so the structure travels with the code that needs it. The
commit that adds `Offer.expiresAt` also contains the migration creating the column — check
out that commit and both exist together.

## The two commands

| Command | Where | Does |
|---|---|---|
| `prisma migrate dev` | your machine | create + apply a migration |
| `prisma migrate deploy` | production | apply existing migrations, never create |

Production never *creates* migrations. It applies exactly what's in git, so what runs on the
server is what you reviewed.

## The dangerous ones

Adding a nullable column is safe. These are not:

**Dropping a column** deletes its data. Immediately, with no confirmation beyond Prisma's
warning.

**Renaming a column** is worse, because Prisma can't tell a rename from "drop the old one,
add a new empty one" — which is what it will often do. The data goes silently.

**Adding a `NOT NULL` column to a table with rows** fails, or fills every existing row with a
default you may not have thought about.

**Adding an index to a large table** locks it while it builds. Fine at 1 000 rows; an outage
at 10 million (Postgres has `CREATE INDEX CONCURRENTLY` for this).

`CLAUDE.md` rule #7: **no destructive migration without a written plan.** For a rename, the
safe shape is four steps across two deploys — add the new column, write to both, backfill,
then drop the old one once nothing reads it.

## Before it matters

Right now there's no production database and no real data, so migrations are free. Break
whatever you like:

```bash
npm run db:down
docker volume rm rihlati_pgdata
npm run db:up && npm run db:migrate
```

The moment one real agency has one real lead, that stops being true. This is the cheapest
time to get the schema shape right, which is why [[Data Model Overview]] is worth reading
carefully now rather than later.

---

Related: [[Data Model Overview]] · [[Local Setup]] · [[Indexes and Why Queries Get Slow]]
