# Rihlati

A two-sided marketplace and CRM for Algerian travel agencies. Travelers discover verified
offers (Omra, Hajj, organized trips, visa help); agencies receive qualified leads and work
them in a built-in CRM. Arabic and French from day one.

Status: pre-launch. No monetization in v1.

## Run it locally

Needs **Node 22+** and **Docker**.

```bash
npm install
npm run db:up                              # Postgres in Docker, on port 5433
npm run build --workspace @rihlati/shared  # api and web both import from it
npm run db:migrate                         # create the schema
npm run db:seed                            # fake agencies, offers and leads
```

Then, in two terminals:

```bash
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

The website needs the API running — it fetches everything from `localhost:4000`.

- **`localhost:3000`** — the public marketplace, what a traveler sees. No login.
- **`localhost:3000/console`** — the agency CRM. Log in with a seeded account.

Seeded logins, the full command list, and what to do when something breaks are in
[`obsidian/Runbooks/Local Setup.md`](obsidian/Runbooks/Local%20Setup.md).

## Before you commit

```bash
npm run check      # build shared + typecheck + lint + test
```

`.env` is gitignored and must stay that way. Only `.env.example` is committed, with empty
values.

## Layout

```
apps/api        NestJS + Prisma + Postgres — the backend
apps/web        Next.js — marketplace and agency console
packages/shared Zod schemas shared by both. The API contract lives here.
e2e             Playwright, on the five pages that matter
obsidian        the documentation vault (see below)
CLAUDE.md       the rules anyone writing code here must follow
```

## Documentation

`obsidian/` is an [Obsidian](https://obsidian.md) vault and it is the real documentation for
this project — it explains *why* things are built the way they are, which the code cannot.
Open the folder as a vault, or just read the Markdown.

Start at [`obsidian/Start Here.md`](obsidian/Start%20Here.md).

If a note ever contradicts the code, the code is right and the note is a bug.
