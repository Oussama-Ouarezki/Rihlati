# Start Here

This vault is the explanation of Rihlati. The code is the *what*; this is the *why*.

Open this folder as a vault in Obsidian (`File → Open folder as vault`) so the wiki-links
become clickable and the graph view works.

> [!info] How to use this
> Read the reading order below once, top to bottom. After that, treat it as a reference:
> when you don't understand something in the code, find its note here and ask me about it.
> If a note is missing or wrong, tell me — keeping this accurate is part of my job.

> [!tip] Want to learn the code itself, not just read about it?
> The list below is *what* to read. [[How to Study This Codebase]] is *how* — seven
> hands-on sessions, about ten hours, each ending in something you must be able to do
> from memory before moving on.

---

## Reading order

**1 — Vocabulary first.** Nothing else makes sense without it.
- [[Glossary]] — every term I use, in plain language

**2 — The big picture.**
- [[Vision and Roadmap]] — your product vision, structured: who pays, what's next, what's yours to decide
- [[System Overview]] — one API, many faces, and why the shape is what it is
- [[What the API Is]] — what "backend" actually means in practice
- [[The Seven Hops of a Request]] — one real request traced end to end, the shape every endpoint repeats

**3 — The concepts that decide whether the app is safe.**
- [[Multi-Tenancy]] — how Agency A is stopped from reading Agency B's clients
- [[Authentication vs Authorization]] — two different things, constantly confused
- [[Validation at the Boundary]] — never trust anything arriving from outside
- [[The Seven Rules]] — your list, turned into rules the code must obey

**4 — The database.** This is the part hardest to change later, so read it carefully.
- [[Data Model Overview]] — the whole map on one page
- [[User]] · [[Agency]] · [[Offer]] · [[Lead]] — the four tables that matter most

**5 — The API, now that it exists.**
- [[Auth Flow]] — accounts, tokens, and how a stolen session is detected
- [[API Endpoints]] — every endpoint, and who is allowed to call it
- [[Web App]] — the site travelers see: three languages, RTL, and why the filters are just URLs
- [[Interface Plan]] — the design pass, screen by screen: what's unfinished and what good looks like

**6 — How specific features work.**
- [[Search and Filters]] — price, destination, dates
- [[Duplicate and Spam Control]] — flagging, not deleting
- [[Plan Limits and Quotas]] — offer caps, and where your paid tier comes from
- [[Client Quality Labels]] — troll → serious → vip
- [[Agency Ratings]] — reviews that agencies can't fake

**7 — Things only you can decide.**
- [[Decisions You Must Make]] — the eight business calls that are yours
- [[Decision Log]] — what we've already decided, and why

**8 — Doing things.**
- [[Local Setup]] — get it running on your machine
- [[Restore From Backup]] — the one runbook you must rehearse before launch

---

## Where everything lives

```
Rihlati/
├── README.md                  the doorway: what this is, how to run it
├── CLAUDE.md                  the rules I must follow when writing code
├── AGENTS.md                  a pointer to CLAUDE.md, for non-Claude tools
├── obsidian/                  you are here — the explanation
├── eslint.config.mjs          lint rules, incl. three that encode past bugs
├── .github/workflows/ci.yml   typecheck + lint + test on every push
├── packages/shared/           shapes and rules used by every app
│   └── src/plans.ts               your prices and limits — yours to edit
├── e2e/                       Playwright: the five pages that matter
├── scripts/restore-rehearsal.sh   rule #5, in one command
├── apps/api/                  the backend. All permissions and logic.
│   ├── prisma/schema.prisma       the database definition
│   ├── prisma/migrations/         schema history, applied in order
│   ├── prisma/seed.ts             fake data for development
│   ├── src/config/                env validation — the API won't boot if it's wrong
│   ├── src/common/auth/           THE GUARDS. Rules #2 and #3 live here.
│   ├── src/common/                logging, errors, audit, validation, Sentry
│   ├── src/modules/               auth · agencies · offers · leads ·
│   │                              reservations · tracked-links
│   └── test/                      93 integration tests, real Postgres
└── apps/web/                  the marketplace + the agency console
    ├── messages/{fr,ar,en}.json   every user-facing string
    ├── src/app/[locale]/          public pages + /console
    └── src/lib/                   API client, session cookies, server actions
```

> [!tip] If you read only three files of code
> `src/common/auth/agency-membership.guard.ts` — how Agency B is stopped.
> `src/common/auth/jwt-auth.guard.ts` — how "logged out by default" works.
> `test/tenant-isolation.e2e.test.ts` — the proof that both do what they claim.

## What you edit vs what I edit

| You edit | Why |
|---|---|
| `obsidian/Decisions/*` | The business calls are yours |
| `CLAUDE.md` — the working agreements section | It's your instruction to me |
| `packages/shared/src/plans.ts` | Your prices and limits, one table |

Everything else, ask me and I'll change it — not because you can't, but because most
files have a test that must change with them, and I'll catch that.

> [!warning] Never edit `.env`
> It holds secrets. It is deliberately invisible to git. If you think you need to change
> it, ask first — see [[The Seven Rules]] rule 1.
