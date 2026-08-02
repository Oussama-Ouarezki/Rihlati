# The Seven Rules

Your list of what goes wrong in AI-built apps, turned into rules the code has to obey.

The enforceable version lives in `CLAUDE.md` at the repo root — that's the file I read
before writing anything. This note explains *why* each rule exists and what it looks like
here.

Violating one is a bug, not a style disagreement.

---

## 1. No secrets in code

**The failure:** an API key committed to the repo, or shipped to the browser in frontend
code. Anyone who clones the repo — or opens devtools — has it.

**Here:**
- Secrets live in `.env`, which `.gitignore` covers on **line 2**, before the first commit
  ever happened. That ordering matters: a secret committed once is in git history forever,
  even if you delete it in the next commit.
- Only `.env.example` is committed, with empty values.
- Anything named `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` is **published to the world**. Never a
  secret there.
- Your `.env` was generated with random secrets, mode `600`, and git was verified not to
  see it.

**Check yourself:** `git diff --staged | grep -iE "sk-|secret|password|api[_-]?key"`

**If a real key ever appears:** rotate it today. Not after launch. Deleting the line does
nothing — the old commit still has it.

---

## 2. The UI is never the security

**The failure:** the delete button is hidden from non-admins, but `DELETE /agencies/abc`
answers anyone who calls it. Attackers don't use your interface.

**Here:**
- Deny by default: `JwtAuthGuard` is registered globally, so every endpoint needs a logged-in
  user unless explicitly marked `@Public()`. Forgetting a check leaves the door **locked**.
- Role checks run in a server-side guard, never inferred from anything the client sent.
- `userId`, `agencyId`, `role` and prices are read from the session and the database —
  never from the request. Server-owned fields are simply **absent from the input schemas**, so
  Zod strips them; there is a test proving `isPlatformAdmin: true` in a signup body does
  nothing, and another proving `agencyId`/`status`/`isFeatured` in an offer body do nothing.
- The role is re-read from the database **every request**, not taken from the token. Fire
  someone at 09:00 and they lose access at 09:00, not whenever their token expires.

Full explanation: [[Authentication vs Authorization]] and [[Auth Flow]].

---

## 3. One user must never see another's data

**The failure:** make two accounts, create data in the first, fetch it by id from the
second. It works far more often than anyone expects.

**Here:** the whole of [[Multi-Tenancy]]. Four layers:
- every tenant table has a non-null `agencyId`
- `AgencyMembershipGuard` runs on **any route with an `:agencyId` parameter** — the thing that
  makes a route tenant-scoped is the same thing that switches the guard on, so there is no
  decorator to forget
- every query uses `findFirst({ id, agencyId })` and `updateMany`, never `findUnique({ id })`.
  **An ESLint rule fails the build** if anyone writes the unsafe form on a tenant table
- **every resource has a test where Agency B tries it and gets `404`** — 17 of them in
  `apps/api/test/tenant-isolation.e2e.test.ts`, against a real Postgres

A missing row and a forbidden row return the same `404`. `403` would confirm the row exists,
which is enough to count a competitor's clients without reading one. One test asserts the two
responses are identical in status, code **and** message.

**A feature without that test is not done.**

---

## 4. Errors and logs from day one

**The failure:** users don't report bugs. They leave, silently, and you never find out.

**Here:**
- Sentry (or self-hosted GlitchTip) in the API and web app before the first real user.
- Structured JSON logs with a `requestId` on every request, returned to the client — so a
  user can quote an id and you can find the exact request.
- **Never logged:** tokens, passwords, OTP codes, full phone numbers, payment identifiers.
  There's a `maskPhone()` function for this, with a test.
- An unhandled `500` is an incident.

Status: **logging built, Sentry not yet.**

- `AppLogger` writes one JSON object per line and **redacts at the exit** rather than trusting
  every future caller to remember: password, token, secret, OTP, NIF and card fields become
  `[redacted]`; phone fields are masked automatically.
- `requestId` on every request, echoed in the `X-Request-Id` header **and** inside every error
  body. An inbound one is honoured only if it matches `[A-Za-z0-9._-]{8,64}`, so a client
  cannot inject newlines and forge log lines.
- `AllExceptionsFilter` translates Prisma errors instead of forwarding them — `P2002` would
  otherwise tell the caller your exact constraint and column names. A client never sees a
  stack trace, and there is a test asserting it.
- An ESLint rule fails the build on logging a full phone number.

**Error reporting is wired** (`src/common/observability/sentry.ts`). It works with Sentry
or a self-hosted GlitchTip — same protocol, and [[Decision Log|Decision 017]] picks
GlitchTip. No DSN configured = a silent no-op, which is why local and CI stay quiet; and
`loadConfig()` **refuses to boot production** without one.

Two details worth knowing:
- Only **unexpected** errors are reported. A 404 or a validation failure is the app working
  correctly, and flooding a tracker with those is how people learn to ignore the alerts.
- Everything leaving for the tracker goes through the **same `redact()`** the logs use. A
  crash report naturally carries the request that caused it — which here means a traveler's
  phone number — and an error tracker is very much "anywhere".

**Still to do:** set `SENTRY_DSN` when you deploy, and add the browser SDK to the web app.

---

## 5. Backups are only real once restored

**The failure:** everyone has backups. Almost nobody has restored one. Until you have, you
have hope.

**Here:** `npm run db:restore-rehearsal` — one command that dumps, restores into a scratch
database, checks the rows and the CHECK constraints, then **starts the real API against the
restored data** and confirms an agency can log in, sees its own leads, and gets a 404 for
another agency's. Scripted rather than a checklist, because a procedure you have to remember
at 3am is a procedure you will get wrong at 3am.

Status: **procedure rehearsed 2026-08-01, passed in 3 seconds. Production backups: none.**

That distinction matters and the runbook keeps both lines separate. A rehearsal against a
local Docker Postgres proves the *steps*; it proves nothing about your provider's PITR, your
off-site copy, or whether anyone can find the dump at 3am. Still needed before launch:
managed Postgres with PITR, a nightly dump to *separate* storage, encryption, and one
rehearsal against the real thing. See [[Restore From Backup]].

> [!warning] `docker compose down -v` deletes your local database
> Without `-v` your data survives. With it, gone. Worth knowing before you type it.

---

## 6. Money never comes from the client

**The failure:** the frontend sends the price. Webhook signatures unverified. Someone buys a
400 000 DZD Omra for 1 dinar by editing one number.

**Here:** no payment code exists yet. When it does:
- prices and plan tiers are read from the **database**, server-side; the client sends an
  item id and nothing else
- every webhook verifies its signature and is idempotent (dedupe on the provider's event id)
- payment state changes only on a verified webhook — **never** on a client redirect saying
  "success"

**Algeria note:** Stripe doesn't operate there, so the boring-and-correct Stripe checklist
everyone recommends doesn't apply directly. Local CIB/Edahabia rails plus manual
CCP/BaridiMob confirmation. Same principle, different provider. Verify current terms
yourself. See [[Plan Limits and Quotas]].

---

## 7. Nothing changes silently

**The failure:** the AI edited something in a part of the app you weren't looking at. You
find out from a user.

**Here:**
- Typecheck, lint and tests run in CI on every change (`.github/workflows/ci.yml`).
- **187 checks**: 96 unit tests in `packages/shared`, 82 integration tests in `apps/api`
  against a real Postgres, and 9 Playwright browser tests. They have caught six real bugs I
  wrote: a price-bucketing function that split offers at band boundaries,
  `z.coerce.boolean()` turning `"false"` into `true`, an agent-scoping filter that could be
  widened by a query parameter, two `OR` clauses silently overwriting each other in search,
  a money ceiling four times larger than its database column, and a login form that wiped
  the user's email after a wrong password.
- ESLint with type-aware rules. Three custom rules encode mistakes already made, so nobody
  has to catch them by eye again: no `z.coerce.boolean()`, no `findUnique` on a tenant table,
  no logging a full phone number.
- Migrations reviewed by hand — the CHECK constraints in
  `20260801090500_check_constraints/` were written by hand precisely because Prisma cannot
  express them.
- One shared type definition, so changing a field surfaces every place that uses it.

Status: **live.** CI runs typecheck, lint, unit + integration tests, **and Playwright** on
every push, plus a secret scan over full history.

**Playwright covers the five pages** with a behaviour assertion *and* a screenshot each:
search, offer detail, inquiry submission, login, agency lead inbox — plus an Arabic RTL
check. Nine tests, ~7 seconds. On its very first run it found a **real production bug**:
`MAX_PRICE_CENTIMES` was four times larger than the `Int` column could hold, so a big price
filter crashed the search with a 500. It also caught a login form that wiped the user's
email after a wrong password. Both fixed, both now pinned by tests.

> [!warning] CI is only half of this rule
> The other half is a GitHub setting: protect `main` and require the `check` job to pass.
> Until you click that, CI is a notification — and people learn to scroll past notifications.

---

## Where each rule stands

| Rule | Status | What is still missing |
|---|---|---|
| 1 — No secrets in code | ✅ enforced | — (CI scans the diff and full history) |
| 2 — UI is never security | ✅ enforced | admin back-office endpoints not built |
| 3 — No cross-tenant reads | ✅ enforced | add a test per new resource, always |
| 4 — Errors and logs | 🟡 partly | set `SENTRY_DSN` on deploy; browser SDK for the web app |
| 5 — Tested backups | 🟡 partly | **procedure rehearsed; production backups do not exist yet** |
| 6 — Money not from client | ⬜ n/a | no payment code exists yet |
| 7 — Nothing silent | ✅ enforced | switch on branch protection in GitHub |

> [!warning] Rule 5 is still the one to watch
> The **procedure** is proven: `npm run db:restore-rehearsal` dumps, restores into a scratch
> database, and confirms the real API can serve the restored data *with tenant isolation
> intact*. Passed 2026-08-01 in 3 seconds.
>
> What that does **not** prove: your hosting provider's PITR, an off-site copy, or that
> anyone can find the dump at 3am — because there is no production database yet. See
> [[Restore From Backup]]. Do not launch until that line has a date too.

> [!note] Two rules are one setting away from done
> Rule 7 needs **branch protection** switched on in GitHub (require the `check` job), and
> rule 4 needs a **`SENTRY_DSN`** in the deploy environment. Neither is code.

---

Related: [[Multi-Tenancy]] · [[Authentication vs Authorization]] ·
[[Validation at the Boundary]] · [[Start Here]]
