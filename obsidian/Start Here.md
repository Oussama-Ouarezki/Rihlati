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
> hands-on sessions, each ending in something you must be able to do from memory before
> moving on.

> [!warning] This is the Django build
> There are two Rihlati repositories: one on **NestJS + Prisma + Next.js**, and this one on
> **Django + Django Ninja**. Same product, same seven rules, same vault — a different engine.
> Wherever the two genuinely differ, the note says so in a **Django vs NestJS** section.
> Those sections are the most valuable thing in here: they're how you tell a real backend
> idea apart from a framework's private vocabulary.
>
> Notes describing something designed but not written here carry a **Designed, not built
> here** banner. The banner is not a to-do list you owe anyone — it's how the vault stays
> honest about what the code actually does.

> [!danger] This repo used to be DRF, and the vault used to say so
> An earlier version of this backend was built on Django REST Framework. It was migrated to
> **Django Ninja**, and every note here has been corrected. If you find a note mentioning
> `serializers`, `permission_classes`, `AllowAny` or `AgencyScopedMixin`, that note is stale
> and it is a bug — tell me. Those names do not exist in the code any more. The reasoning
> behind the switch is [[Decision Log]] #D-01.

---

## Reading order

**1 — Vocabulary first.** Nothing else makes sense without it.
- [[Glossary]] — every term I use, in plain language

**2 — The big picture.**
- [[Vision and Roadmap]] — your product vision, structured: who pays, what's next, what's yours to decide
- [[Roadmap]] — the phase map: preview → pilot → launch, what gates each step, and what would make us stop
- [[Milestone Plan]] — what is built, what is next, and what "done" means for each step
- [[System Overview]] — one project, two front doors, and why the shape is what it is
- [[Architecture]] — the physical half: what runs, what holds state, how a change reaches it
- [[What the API Is]] — what "backend" actually means in practice
- [[The Seven Hops of a Request]] — one real request traced end to end, the shape every endpoint repeats

**3 — The concepts that decide whether the app is safe.**
- [[Multi-Tenancy]] — how Agency A is stopped from reading Agency B's clients
- [[Authentication vs Authorization]] — two different things, constantly confused
- [[Validation at the Boundary]] — never trust anything arriving from outside
- [[One Rule, Two Entry Points]] — why a validation rule is written once and imported twice
- [[The Seven Rules]] — your list, turned into rules the code must obey

**4 — The database.** This is the part hardest to change later, so read it carefully.
- [[Data Model Overview]] — the whole map on one page
- [[User]] · [[Agency]] · [[Offer]] · [[Lead]] — the four tables that matter most
- [[Audit Log]] — who changed what, kept append-only
- [[Migrations]] — how the schema changes without losing data
- [[Indexes and Why Queries Get Slow]] — the one performance idea you actually need

**5 — The API, now that it exists.**
- [[Auth Flow]] — accounts, tokens, sessions, and which one goes where
- [[API Endpoints]] — every endpoint, and who is allowed to call it
- [[Templates and Pages]] — the site travelers see, rendered by the same Django that serves the API
- [[Interface Plan]] — the design pass, screen by screen: what's unfinished and what good looks like

**6 — How specific features work.**
- [[Search and Filters]] — price, destination, dates
- [[Agency Verification]] — the badge, and who is allowed to grant it
- [[Trip Programme]] — the day-by-day itinerary, the biggest feature in the app
- [[Trip Manifest]] — who is actually going, and who is actually here
- [[Tracked Links]] — which Facebook post actually brought buyers
- [[Offer Analytics]] — counters per day, no third-party script
- [[Duplicate and Spam Control]] — flagging, not deleting
- [[Plan Limits and Quotas]] — offer caps, and where your paid tier comes from
- [[Client Quality Labels]] — troll → serious → vip
- [[Agency Ratings]] — reviews that agencies can't fake

**7 — Things only you can decide.**
- [[Decisions You Must Make]] — the business calls that are yours
- [[Decision Log]] — what we've already decided, and why

**8 — Doing things.**
- [[Local Setup]] — get it running on your machine
- [[Sub-Agents]] — the four agents that audit, test, check and document, and how to call them
- [[End-to-End Testing]] — the agent that clicks through the app like a user
- [[Restore From Backup]] — the one runbook you must rehearse before launch

---

## Where everything lives

```
rihlati-django-preview/
├── README.md                    the doorway: what this is, how to run it
├── CLAUDE.md                    the rules I must follow when writing code
├── AGENTS.md                    a pointer to CLAUDE.md, for non-Claude tools
├── obsidian/                    you are here — the explanation
├── pyproject.toml               ruff config: the ordinary hygiene layer
├── requirements.txt             two packages: Django, django-ninja
├── scripts/check.sh             lint + format + system checks + migrations + tests
├── .github/workflows/ci.yml     runs check.sh on every push, plus a secrets scan
├── manage.py                    Django's entry point for every command
├── config/                      the project, as opposed to the apps
│   ├── settings.py                  every knob. Secrets read from the environment.
│   ├── api.py                       THE FRONT DOOR: one NinjaAPI, auth set once
│   ├── urls.py                      the top-level map: /api/ vs /
│   └── wsgi.py                      how a web server starts the app
├── apps/                        one folder per part of the domain
│   ├── common/                      THE SPINE. Rules #2, #3 and #4 live here.
│   │   ├── tenancy.py                   require_membership() + scoped() + audit()
│   │   ├── auth.py                      bearer tokens, session auth, refresh rotation
│   │   ├── schemas.py                   Strict — unknown fields are rejected, not ignored
│   │   ├── validators.py                one rule, imported by API and forms alike
│   │   ├── errors.py                    the typed {code, details, requestId} envelope
│   │   ├── quotas.py                    plan limits, read from the database
│   │   ├── logging.py                   JSON logs, with phone numbers masked at the exit
│   │   ├── middleware.py                one request id, followed all the way through
│   │   ├── testing.py                   shared test factories
│   │   ├── tests_house_rules.py         the past bugs, encoded as checks
│   │   └── tests_observability.py       proof the redaction actually redacts
│   ├── accounts/                    User · Agency · Membership · RefreshToken · AuditLog
│   ├── offers/                      the packages, the programme, links, metrics, reports
│   │   └── management/commands/seed_preview.py   fake data for development
│   ├── leads/                       inquiries · clients + the CRM inbox + tags + consent
│   ├── trips/                       reservations, check-ins, the traveler's trip page
│   ├── reviews/                     ratings, tied to a real lead
│   └── pages/                       the server-rendered HTML, over the same models
├── templates/                   the HTML. Same Tailwind tokens as the Next.js app.
└── styles/ · static/            Tailwind input, and the generated stylesheet
```

> [!tip] If you read only three files of code
> `apps/common/tenancy.py` — how Agency B is stopped, in about a hundred lines.
> `apps/offers/models.py` — `publicly_visible()`, the one queryset travelers may see.
> `apps/offers/tests.py` — the proof that both do what they claim.

## Where the two repos put the same idea

Useful when you're reading one and thinking in the other.

| The idea | Django (here) | NestJS repo |
|---|---|---|
| Deny by default | `NinjaAPI(auth=API_AUTH)` in `config/api.py` | `JwtAuthGuard` in `AppModule` |
| The public exception | `auth=None` on a route | `@Public()` |
| Membership check | `require_membership(user, agency_id)` | `AgencyMembershipGuard` |
| Tenant scoping | `scoped(queryset, agency_id)` | scoped `findFirst({ id, agencyId })` |
| Input validation | `ninja.Schema` subclassing `Strict` | Zod schema in `packages/shared` |
| The shared contract | the OpenAPI doc at `/api/docs` | `packages/shared` |
| The schema | `apps/*/models.py` | `prisma/schema.prisma` |
| Schema history | `apps/*/migrations/` | `prisma/migrations/` |
| Encoded past bugs | `apps/common/tests_house_rules.py` | `no-restricted-syntax` in `eslint.config.mjs` |
| One command before commit | `./scripts/check.sh` | `npm run check` |
| The traveler-facing site | `templates/` + `apps/pages/` | `apps/web` (Next.js) |

## What you edit vs what I edit

| You edit | Why |
|---|---|
| `obsidian/Decisions/*` | The business calls are yours |
| `CLAUDE.md` — the working agreements section | It's your instruction to me |

Everything else, ask me and I'll change it — not because you can't, but because most
files have a test that must change with them, and I'll catch that.

> [!warning] Never edit `.env`
> It holds secrets. It is deliberately invisible to git. If you think you need to change
> it, ask first — see [[The Seven Rules]] rule 1.

## Open questions

- Should this repo chase feature parity with the NestJS one, or stay a deliberately smaller
  comparison build? That decision changes what "Designed, not built here" means — a backlog,
  or a permanent footnote. See [[Milestone Plan]].
- If Django wins the stack decision, does the NestJS vault get retired, or do both stay and
  drift? Two vaults describing one product is how both become wrong.
