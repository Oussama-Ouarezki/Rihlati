# Rihlati — Travel Agency Marketplace (Algeria)

Two-sided marketplace + CRM. Travelers discover verified travel-agency offers (Omra, Hajj,
organized trips, visa help). Agencies receive qualified leads and manage them in a built-in CRM.
Think "Emploitic, but for voyages."

**Status:** greenfield. No monetization in v1 — but every schema decision must not block it later.

---

## THE SEVEN RULES

These are non-negotiable. They exist because AI-built apps fail the same seven ways every time.
Violating one is a bug, not a style preference. Check them before saying any task is done.

### 1. No secrets in code, ever
- Secrets live in `.env` (gitignored) and in the host's secret manager in production.
- `.gitignore` must cover `.env*` **before the first commit**. Only `.env.example` is committed,
  with empty values.
- Nothing prefixed `NEXT_PUBLIC_` / `EXPO_PUBLIC_` may hold a secret. Those ship to the browser.
- Any key that has ever touched a commit is burned. Rotate it, don't reuse it.
- Before every push: `git diff --staged | grep -iE "sk-|secret|password|api[_-]?key|BEGIN.*PRIVATE"`

### 2. The UI is never the security
Hiding a button is a UX choice, not a permission. **Every endpoint authorizes itself, server-side.**
- No endpoint is public unless explicitly marked so. Auth is deny-by-default at the router level.
- Role checks (`traveler` / `agency_agent` / `agency_owner` / `admin`) happen in a guard on the
  server, never inferred from a request body or header the client controls.
- Never trust client-sent `userId`, `agencyId`, `role`, or `price`. Derive them from the session.

### 3. Tenant isolation is enforced in the data layer
"One user can see another user's data" is the #1 marketplace-killer. Structural defense:
- Every tenant-scoped table has a non-null `agency_id`.
- **Every query is scoped by the session's tenant.** No raw `findUnique({ id })` on tenant data —
  always `findFirst({ where: { id, agencyId: session.agencyId } })`.
- A missing row and a forbidden row both return `404`. Never leak existence.
- IDs are UUIDv7 or CUID, never sequential integers.
- Required test for every tenant-scoped resource: create as Agency A, fetch as Agency B, assert 404.
  A feature without this test is not done.

### 4. Errors and logs exist from day one
- Sentry (or GlitchTip self-hosted) wired into API, web, and mobile **before** the first real user.
- Structured JSON logs with a `requestId` on every request; propagate it to the client response.
- Never log tokens, passwords, OTP codes, full phone numbers, or payment identifiers.
- An unhandled 500 is an incident. A handled error returns a typed, translated error code.

### 5. Backups are only real once restored
- Managed Postgres with PITR. Nightly logical dump to separate object storage.
- A restore is rehearsed into a scratch database **before launch**, and quarterly after.
  The runbook is `obsidian/Runbooks/Restore From Backup.md`, with the last-verified date.
- Untested backups are hope, not backups.

### 6. Money never comes from the client
Applies the moment monetization ships.
- Prices, plan tiers, and lead costs are read from the **database**, server-side. The client sends
  an item ID, never an amount.
- Every payment webhook verifies its signature and is idempotent (dedupe on provider event id).
- Payment state changes only on a verified webhook, never on a client "success" redirect.
- Note: Stripe does not operate in Algeria. Rails will be local (CIB/Edahabia via a local PSP,
  plus manual CCP/BaridiMob transfer confirmation). Verify current provider terms before building.

### 7. Nothing changes silently
- Typecheck + lint + tests run in CI on every PR. Red CI blocks merge.
- Playwright covers the five pages that matter: search, offer detail, inquiry submission,
  agency lead inbox, login. Screenshot/visual assertions on each.
- Migrations are reviewed by hand. No destructive migration without an explicit written plan.
- When editing, change what was asked. If a fix requires touching unrelated code, say so first.

---

## How these rules are enforced mechanically

Prefer adding a check here over trusting anyone to remember:

| Rule | Enforced by |
|---|---|
| 1 — secrets | `.gitignore`; the `secrets` job in `.github/workflows/ci.yml` scans full history |
| 2 — server-side authz | `JwtAuthGuard` registered globally in `AppModule`; `@Public()` is the only exit |
| 3 — tenant isolation | `AgencyMembershipGuard` fires on any route with `:agencyId`; ESLint bans `findUnique`/`update` on tenant tables; `apps/api/test/tenant-isolation.e2e.test.ts` |
| 4 — logs | `AppLogger` redacts at the exit; ESLint bans logging a raw phone number |
| 7 — nothing silent | `npm run check` = build shared + typecheck + lint + test, and CI runs it |

The three custom ESLint rules in `eslint.config.mjs` each encode a bug that already happened.
When a mistake gets made twice, add a rule rather than a comment.

## The documentation vault — `obsidian/`

`obsidian/` is an Obsidian vault and it is **how the owner learns this codebase**. He reads
it and asks questions against it, so it is a deliverable, not a nice-to-have. Treat it with
the same standard as code.

**Keeping it true is part of every task, in the same change as the code:**

| When you change | Update |
|---|---|
| `prisma/schema.prisma` | the matching note in `obsidian/Data Model/` |
| a business rule (quotas, ranking, statuses) | the matching note in `obsidian/Backend/` |
| an endpoint's shape or permissions | `obsidian/Backend/API Endpoints.md` |
| a decision with alternatives | append to `obsidian/Decisions/Decision Log.md` |
| anything a beginner would find surprising | say so where it lives |

Rules for writing in the vault:
- **Explain why, not what.** The code says what. If a note only restates the code, delete it.
- Plain language. Define jargon on first use, or link `[[Glossary]]`.
- Use `[[wikilinks]]` between notes — that is how he navigates. Note names are unique across
  folders, so link by name alone.
- Every note about a feature ends with an **open questions** section naming what is still
  the owner's decision. Do not invent an answer to a business question.
- When a design was chosen over a real alternative, record the alternative and why it lost.
  A bug that was found and fixed is worth a sentence — that is how the same mistake stops
  recurring.
- Never put secrets, real user data, or real phone numbers in a note.

If a note contradicts the code, the code is right and the note is a bug — fix it.

## Working agreements for Claude

- **Ask before assuming** on product/business logic. Guessing here produces confident, wrong code.
- **Small, reviewable changes.** One module or one vertical slice per task.
- **Types are the contract.** Shared Zod schemas define API input/output; both server and clients
  import them. No hand-written duplicate interfaces.
- **Validate at the boundary.** Every request body/query/param parses through a schema before
  touching a handler. Reject unknown fields.
- **No `any`. No `// @ts-ignore`.** If types fight you, the model is wrong — fix the model.
- **Every new endpoint ships with:** an authz guard, input validation, a tenant-isolation test,
  and an entry in the API docs.
- **Never invent an Algerian legal, tax, or payment fact.** Flag it and say "verify this."
- Explain the *why* in plain language when a decision is architectural — the owner is learning.

## What Oussama is actually learning here

He's building Rihlati to learn backend engineering, with an eye toward eventually offering
AI-automation services to businesses (an "AI agency" model — wiring LLMs into real backends
so they can act on real data, not just chat). Rihlati's own domain rules are the vehicle, not
the point.

Build features piece by piece (see "Small, reviewable changes" above), one vertical slice at
a time, and narrate each layer as it's written — he's watching and asking questions to learn
NestJS, not typing it himself yet. Use the build order below as the actual teaching plan: when
a task hits one of these moments, that is the point to slow down, explain it thoroughly, and
check he's following before moving on — not to front-load the explanation earlier or skip past
it because "we covered this conceptually already."

**When you write the first controller + service + Prisma call (any endpoint, even the
simplest read):** stop and walk through why the split exists — controller is the door,
service is the brain, Prisma is the hands. This is the transferable "how to design a backend"
skill, not a NestJS-only detail. Every endpoint after this one should feel like a repeat of
the same shape, so make sure it lands here, at the first one.
→ `obsidian/Concepts/What the API Is.md`

**When you write the first tenant-scoped query (any `findFirst({ where: { id, agencyId }})`):**
stop and go deep. This is the pattern that repeats in every SaaS backend he'll ever build:
scope every query by session, never trust a client-sent id, missing and forbidden both return
404. Don't let this one pass as "just another query" — it's the reason the API layer exists
at all.
→ `obsidian/Concepts/Multi-Tenancy.md`

**When you add the first `@Body()` DTO / Zod schema validation on an endpoint:** explain why
input is treated as hostile at the boundary, and flag explicitly that this same discipline is
what will later keep an LLM tool-call from corrupting data — malformed input from an agent is
guaranteed, not just possible.
→ `obsidian/Concepts/Validation at the Boundary.md`

**When you write the first auth guard (login, JWT, session check):** this is where
authentication (who are you) and authorization (what are you allowed to do) stop being an
abstract distinction and become two lines of actual code — point at both, don't conflate them.
→ `obsidian/Concepts/Authentication vs Authorization.md`

**When the schema grows past one or two tables:** enough to explain relations and why a
column is a column vs. JSON `attributes`, not more. This is "understand schema design in
general," not "memorize Rihlati's tables."
→ `obsidian/Data Model/Data Model Overview.md`

**Everything else — search, quotas, ratings, client labels, payments, i18n/RTL, backups:**
build them correctly per the seven rules, mention the business reasoning in a sentence, but
don't stop to teach. These are Rihlati-specific or launch-specific, not part of the
transferable skill set he's after right now — unless he asks.

## Language & locale (architectural, not cosmetic)

- Arabic + French from day one. Arabic is RTL: use logical CSS properties (`margin-inline-start`,
  not `margin-left`) everywhere. Retrofitting RTL is a rewrite.
- No hardcoded user-facing strings. Ever. All copy goes through i18n keys.
- Money is DZD, stored as **integer centimes**. Never floats for money.
- Phone numbers stored E.164 (`+213...`). Dates stored UTC, displayed Africa/Algiers.

## Definition of done

A task is done when: types pass, lint passes, tests pass (including the tenant-isolation test),
no secret was introduced, the endpoint authorizes server-side, errors report to Sentry,
and user-facing strings are translated. Anything less — say what's missing.
