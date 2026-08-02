# Local Setup

Getting Rihlati running on your machine. You have Node 22 and Docker already, so this is
short.

---

## One-time setup

```bash
cd ~/Desktop/Rihlati

# 1. install everything (all workspaces at once)
npm install

# 2. start the local database
npm run db:up

# 3. build the shared package (api and web import from it)
npm run build --workspace @rihlati/shared
```

Your `.env` already exists with generated secrets. **Don't commit it, don't edit it, don't
share it.** See [[The Seven Rules]] rule 1.

---

## Every day

```bash
npm run db:up        # start Postgres (skip if already running)
npm run dev:api      # the API, restarts on save
npm run dev:web      # the website, restarts on save — separate terminal
```

The API listens on **`localhost:4000`**. Check it is alive:

```bash
curl localhost:4000/health
# {"status":"ok"}
```

The website listens on **`localhost:3000`** and needs the API running to show anything —
it fetches offers, leads, everything, from `localhost:4000` on every page.

---

## Run the website

```bash
npm run db:up
npm run dev:api      # terminal 1
npm run dev:web      # terminal 2
```

Then open **http://localhost:3000**. That's the public marketplace — the same thing a
traveler sees. French is the default and lives at the bare URL; Arabic is
`localhost:3000/ar`, English `localhost:3000/en` ([[Decision Log]] #018).

**The agency console** is the part you're usually testing: **http://localhost:3000/console**.
It redirects to a login page if you're not signed in. Use one of the seeded accounts below —
`baraka@rihlati.test` / `rihlati-dev-password` is the one with real offers and leads already
in it, which is usually more useful than starting from an empty agency.

> [!tip] Port 3000 already taken
> Something else on your machine may already be using it. `next dev` will just pick the next
> free port (3001, 3002…) and print which one — read its terminal output rather than
> assuming 3000. If you want to force a specific port: `cd apps/web && npx next dev -p 3100`.

### Log in as a seeded account

`npm run db:seed` creates fake agencies and leads. Every account uses the password
`rihlati-dev-password`:

| Account | Who |
|---|---|
| `admin@rihlati.test` | Rihlati staff — the only one who can publish an offer |
| `baraka@rihlati.test` | owner of Voyages El Baraka (free plan, has leads) |
| `nour@rihlati.test` | owner of Nour Travel (pro plan) |
| `agent@rihlati.test` | an `agent` at El Baraka — sees only assigned leads |
| `voyageur@rihlati.test` | a traveler |

```bash
# get a token
curl -s -X POST localhost:4000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"baraka@rihlati.test","password":"rihlati-dev-password"}'

# the public search needs no token at all
curl -s 'localhost:4000/v1/offers?limit=2'
```

The response to `login` contains `user.memberships[0].agencyId` — that is the id you put in
`/v1/agencies/{agencyId}/leads`. See [[API Endpoints]].

---

## Test it

Two different things people mean by "test", and Rihlati has both:

### By hand, in a browser

The fastest way to check a change actually works — not just that it compiles.

1. `npm run dev:api` and `npm run dev:web` running, Postgres up, database seeded
   (`npm run db:seed` if you haven't).
2. **As a traveler:** `localhost:3000` — search, open an offer, submit an inquiry with
   consent. No login needed; this is the marketplace.
3. **As an agency:** `localhost:3000/console`, log in with `baraka@rihlati.test` /
   `rihlati-dev-password`. The inquiry you just submitted should appear in **Clients**
   within a page refresh — that loop (public inquiry → agency inbox) is the single most
   important thing in the product to keep working.
4. **As a different agency**, to sanity-check tenant isolation yourself: log in as
   `nour@rihlati.test` and confirm you do NOT see El Baraka's leads or offers anywhere.

### Automated

```bash
npm run check       # build + typecheck + lint + every unit/integration test
npm run test:e2e    # Playwright: the five pages that matter (rule #7)
```

`test:e2e` builds a **production** build first (`test:e2e:build`) and boots its own API +
website on ports 4200/3200, separate from your dev servers — so it's safe to run while
`dev:api`/`dev:web` are still up. It checks both real behaviour (does the form actually
submit) and takes a screenshot of each page, compared pixel-for-pixel against the saved one
in `e2e/five-pages.spec.ts-snapshots/`.

> [!warning] Changed something visual on purpose?
> The screenshot comparison will fail — correctly, that's its job. Look at the diff Playwright
> prints, confirm the new look is the one you meant, then run `npm run test:e2e:update` to
> save the new screenshots. Never update them without actually looking first; that's how a
> real regression slips through disguised as "oh, the test's just outdated."

---

## Every command

| Command | Does |
|---|---|
| `npm run db:up` | start Postgres in Docker |
| `npm run db:down` | stop it, **keeps your data** |
| `npm run db:migrate` | apply schema changes, regenerate the Prisma client |
| `npm run db:studio` | open a browser UI to browse and edit rows |
| `npm run db:seed` | fill an empty database with fake agencies and offers |
| `npm run dev:api` | run the API in watch mode |
| `npm run dev:web` | run the website in watch mode |
| `npm run test` | run every test in every workspace (needs Postgres running) |
| `npm run test:e2e` | Playwright: the five pages that matter, behaviour + screenshots |
| `npm run test:e2e:update` | regenerate the screenshots after an intentional visual change |
| `npm run typecheck` | check types without building |
| `npm run lint` | ESLint across the whole repo |
| `npm run lint:fix` | fix what ESLint can fix on its own |
| `npm run check` | build shared + typecheck + lint + test. **Run before you commit.** |

> [!danger] `docker compose down -v` deletes your local database
> The `-v` removes the volume where the data lives. Without it, your data survives a
> restart. Nothing on your machine is backed up — it's a scratch database, which is
> exactly why the real one needs [[Restore From Backup]].

---

## After I change the database schema

Whenever `apps/api/prisma/schema.prisma` changes:

```bash
npm run db:migrate
```

It will ask you to name the change — something like `add_offer_quotas` is fine. This writes
a migration file, applies it, and regenerates the TypeScript types.

If your editor shows red squiggles on Prisma types after a schema change, that's usually
just the regenerated client not being picked up yet. Restart the TypeScript server in your
editor.

See [[Migrations]].

---

## Useful things

### Look at your data

```bash
npm run db:studio
```

Opens on `localhost:5555`. A spreadsheet view of every table — genuinely the fastest way to
build a feel for the schema. Read [[Data Model Overview]] with Studio open beside it.

### Connect with psql

You don't have `psql` installed locally, but the container has it:

```bash
docker exec -it rihlati_db psql -U rihlati -d rihlati
```

`\dt` lists tables, `\d offers` describes one, `\q` quits.

### Start completely fresh

```bash
npm run db:down
docker volume rm rihlati_pgdata
npm run db:up
npm run db:migrate
npm run db:seed
```

---

## When something breaks

**`Environment variable not found: DATABASE_URL`**
You're running a command from the wrong folder, or `.env` is missing. Run from the repo
root. If `.env` is genuinely gone, tell me and I'll regenerate it.

**`Can't reach database server at localhost:5433`**
Postgres isn't running. `npm run db:up`, then `docker compose ps` to confirm it's healthy.

**Port 5433 already in use**
Something else is on it. `docker compose ps` — you may already have it running.
(5433 rather than the usual 5432 is deliberate, so it never fights a Postgres you installed
directly.)

**Types from `@rihlati/shared` not found**
It needs building: `npm run build --workspace @rihlati/shared`. `npm run dev:api` does this
automatically.

**Tests fail after I edited `plans.ts`**
Expected — the tests check the plan table stays coherent. Read the failure message; it names
the rule you broke. See [[Plan Limits and Quotas]].

**Tests fail with `database "rihlati_test" does not exist`**
The API tests use a **separate** database, derived by appending `_test` to your
`DATABASE_URL`, so a test run can never truncate your development data. It is created
automatically on the first run — this error usually means Postgres was not running yet.
`npm run db:up`, then retry.

**`Configuration invalide (.env)`**
The API validates its whole configuration at boot and refuses to start if anything is missing
or looks like a placeholder. The message lists the failing **keys** (never the values — that
output can end up in a CI log). Fix them in `.env` and restart.

**Prisma commands work from `apps/api` but not elsewhere**
`.env` lives at the repo root and the Prisma CLI only looks in its own folder;
`apps/api/prisma.config.ts` loads it explicitly. Run Prisma commands through the npm scripts
(`npm run db:migrate`) rather than calling `npx prisma` from a random directory.

---

## Before you commit

```bash
npm run check
```

And the secrets check from [[The Seven Rules]]:

```bash
git diff --staged | grep -iE "sk-|secret|password|api[_-]?key"
```

If that prints anything with a real value in it, stop.

---

Related: [[Start Here]] · [[Migrations]] · [[Data Model Overview]] · [[The Seven Rules]]
