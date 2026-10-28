@AGENTS.md
# Rihlati — Travel Agency Marketplace (Algeria) · Django edition

Two-sided marketplace + CRM. Travelers find verified agency offers (Omra, Hajj, organized trips,
visas); agencies get qualified leads and work them in a built-in CRM. "Emploitic, but for voyages."

**Status:** greenfield, no monetization in v1 — but no schema decision may block it later.
**Stack:** Django + **django-ninja** (not DRF) serving the JSON API, plus server-rendered HTML from
the same models. No separate frontend app. This is the same product as the NestJS/Prisma repo on a
second stack; when you explain something, say whether it's backend design or stack trivia.

---

## THE SEVEN RULES

Non-negotiable. Violating one is a bug, not a style preference.

**1 — No secrets in code.** Secrets live in `.env` (gitignored) and the host's secret manager.
Only `.env.example` is committed, with empty values. `config/settings.py` reads every secret via
`os.environ`. Never put a secret in a template context — anything rendered ships to the browser.
A key that has touched a commit is burned; rotate it.

**2 — The UI is never the security.** Every endpoint authorizes itself, server-side.
Deny-by-default is set once on the `NinjaAPI` instance in `config/api.py` (`auth=API_AUTH`), so
forgetting to write anything gives you a *locked* route. `auth=None` is the only exit and grepping
it lists the entire public surface. HTML pages get `@login_required` / `LoginRequiredMixin` — two
entry points into the same models means two places to get authz wrong, so guard and test both.
Roles (`traveler` / `agency_agent` / `agency_owner` / `admin`) are checked in code, never inferred
from a body, query param, or header. Never trust a client-sent `user_id`, `agency_id`, `role`, or
`price` — derive them from `request.user` and the URL segment you already authorized.

**3 — Tenant isolation lives in the data layer.** "One user sees another's data" is the
marketplace-killer.
- Every tenant-scoped model has a non-null `agency` FK.
- Never `Model.objects.get(pk=...)` on tenant data. Use `scoped()` / `get_scoped_object()` and
  `require_membership_or_404()` from `apps/common/tenancy.py` rather than re-deriving per view.
- Missing row and forbidden row both return **404**. Never leak existence.
- IDs are UUIDs (`UUIDModel` in `apps/accounts/models.py`), never sequential ints.
- **Required per resource:** create as Agency A, fetch as Agency B, assert 404. No test, not done.

**4 — Errors and logs from day one.** Sentry/GlitchTip wired before the first real user. Structured
JSON logs with a `request_id` echoed to the client (`apps/common/errors.py::envelope`). Never log
tokens, passwords, OTP codes, full phone numbers, or payment ids. A handled error returns a typed,
translated `code` the client switches on — never the human string. An unhandled 500 is an incident.
`DEBUG` is an env var precisely because `DEBUG=True` in prod leaks settings, SQL, and environment.

**5 — Backups are only real once restored.** Managed Postgres + PITR, nightly dump to separate
object storage, restore rehearsed into a scratch DB before launch and quarterly after
(`obsidian/Runbooks/Restore From Backup.md`, with last-verified date). SQLite is local-dev only;
nothing may depend on SQLite-only behaviour.

**6 — Money never comes from the client.** Prices, tiers, and lead costs are read from the DB
server-side; the client sends an item ID, never an amount. Payment webhooks verify their signature
and are idempotent (dedupe on provider event id). State changes on a verified webhook only, never
on a client "success" redirect. Stripe does not operate in Algeria — rails will be local
(CIB/Edahabia via a local PSP, plus manual CCP/BaridiMob). Verify provider terms before building.

**7 — Nothing changes silently.** Lint + tests in CI on every PR; red CI blocks merge. The five
pages that matter (search, offer detail, inquiry submit, agency lead inbox, login) have test-client
tests asserting on rendered content, not just status codes. Read every migration by hand before
committing it; no destructive migration without a written plan. `makemigrations --check --dry-run`
runs in CI. When editing, change what was asked — if a fix needs unrelated code, say so first.

### Enforced mechanically

| Rule | By |
|---|---|
| 1 | `.gitignore`; `secrets` job in `.github/workflows/ci.yml` scans full history; `tests_house_rules.py::SecretsTests` |
| 2 | `auth=API_AUTH` on the `NinjaAPI` in `config/api.py`; `AuthorizationTests` pins the exact list of `auth=None` routes |
| 3 | `apps/common/tenancy.py`; `TenantScopeTests` + `MembershipCheckTests` ban unscoped `.objects.get(`; cross-tenant tests in `apps/offers/tests.py`, `apps/pages/tests.py` |
| 4 | `register_exception_handlers` in `apps/common/errors.py`; `LoggingTests` bans a raw phone in a log call |
| 6 | `MoneyTests` bans `FloatField` anywhere |
| 7 | `./scripts/check.sh` = lint + format + django checks + missing-migration + tests. CI runs that same script. |

`apps/common/tests_house_rules.py` is this repo's answer to custom ESLint rules: an `ast` visitor in
the test suite, readable in a minute, pointing at the exact file and line. **When a mistake happens
twice, add a check there instead of a comment.**

---

## Working agreements

- **Ask before assuming** on product/business logic. Guessing produces confident, wrong code.
- **Small, reviewable changes.** One app or one vertical slice per task.
- **Validate at the boundary.** Every body/query/param goes through a `ninja.Schema` or a Django
  form first. Input schemas inherit `Strict` from `apps/common/schemas.py` (`extra="forbid"`),
  because silently-ignored unknown fields are where privilege-escalation bugs hide.
- **A rule is written once.** Shared validation lives in `apps/common/validators.py` and is imported
  by both the schema and the HTML form. Written twice = will disagree with itself.
- **Rate limiting is per source, never per account.** Account lockout hands an attacker a DoS button
  aimed at your own users. Rates live in `apps/common/throttling.py` (currently login `10/15m`,
  refresh `30/15m`, inquiry `20/1h`). Every public write route carries a throttle.
- **No bare `except:`. No `# type: ignore` without a written reason.** A swallowed exception is a
  500 you never hear about.
- **Every new endpoint ships with:** auth/role check, input schema, tenant-isolation test, and an
  entry in `obsidian/Backend/API Endpoints.md`.
- **Never invent an Algerian legal, tax, or payment fact.** Flag it: "verify this."

## Before saying a task is done

Answer these four out loud, briefly — they are the review, not decoration:

1. **Is this the most secure way?** Authz server-side, tenant-scoped query, input rejected at the
   boundary, no secret introduced, nothing sensitive logged.
2. **Is this the most efficient way?** No N+1 (`select_related`/`prefetch_related`), an index behind
   every filter and ordering, no query inside a loop, no full-table count on a hot path.
3. **What regression could this introduce?** Name the blast radius: what else reads this model,
   this queryset, this template, this migration.
4. **What must be tested before shipping?** Name the tests, then run `./scripts/check.sh`.

Done = lint passes, tests pass (including tenant isolation), no missing migration, no secret,
endpoint authorizes server-side, errors reach Sentry, vault note is true, strings translatable.
**Anything less — say what's missing.** Never report done on a partial result.

## Pre-ship security pass

Run before any launch or public deploy, and after any auth/payment change. Each line is a task for
the matching sub-agent below:

1. Rate limiting on every endpoint that a stranger can reach; auth routes throttled per source.
2. Scan the whole codebase (and git history) for hardcoded API keys, tokens, passwords.
3. All sensitive config in env vars — nothing exposed in a template, a `<script>`, or a commit.
4. All user input sanitized; oversized and malformed payloads rejected at the boundary.
5. Full security audit — report remaining vulnerabilities, ranked, with file and line.

## Sub-agents

Use these for scoped, repeatable *tasks* — they keep the audit's file-reading out of the main
context. Definitions in `.claude/agents/`.

| Agent | Use for |
|---|---|
| `security-audit` | The five pre-ship items above. Read-only, reports findings; does not edit. |
| `tenant-isolation-test` | Writing/checking the cross-tenant 404 test for a new resource. |
| `preflight` | Running `./scripts/check.sh` and diagnosing what failed. |
| `vault-sync` | Making `obsidian/` true again after a code change. |

Do the actual feature work in the main thread — that is where Oussama is watching and learning.
Delegate the mechanical sweeps.

---

## The documentation vault — `obsidian/`

This is how the owner learns the codebase. It is a deliverable, held to the standard of code, and
updated **in the same change as the code**:

| Changed | Update |
|---|---|
| `apps/*/models.py` | matching note in `obsidian/Data Model/` |
| a business rule (quotas, ranking, statuses) | matching note in `obsidian/Backend/` |
| endpoint shape or permissions | `obsidian/Backend/API Endpoints.md` |
| a decision with real alternatives | append to `obsidian/Decisions/Decision Log.md` |

Writing rules: explain **why, not what** (a note that restates the code should be deleted); plain
language, jargon defined on first use or linked to `[[Glossary]]`; `[[wikilinks]]` between notes
(names are unique across folders, so link by name); every feature note ends with **open questions**
naming what is still the owner's call — never invent an answer to a business question; record the
alternative that lost and why; a bug found and fixed is worth a sentence. No secrets, real user
data, or real phone numbers. Notes marked **Designed, not built here** exist in the NestJS repo but
not this one — keep the banner honest, don't delete the note.
**If a note contradicts the code, the code is right and the note is a bug.**

## Teaching plan

Oussama is learning backend engineering here (aiming at wiring LLMs into real backends later); he
watches rather than types. Build one vertical slice at a time and narrate each layer. At these
moments, **stop and go deep** — even if it "was covered conceptually already":

| Trigger | Teach | Note |
|---|---|---|
| First URLconf + view + queryset | URLconf is the door, view is the brain, ORM is the hands. Django folds Nest's controller+service into one view; when a view stops being about HTTP, that logic moves to a model method or manager. | `Concepts/What the API Is.md` |
| First `.filter(agency_id=...)` | Scope every query by session, never trust a client id, missing and forbidden both 404. The reason the API layer exists. | `Concepts/Multi-Tenancy.md` |
| First schema/form validation | Input is hostile at the boundary; unknown keys are dropped silently unless you forbid them — the same discipline later stops a malformed LLM tool-call from corrupting data. | `Concepts/Validation at the Boundary.md` |
| First auth check | Authentication (who you are) vs authorization (what you may do) become two actual lines. Django gives you the first for free, which is why people never notice the second. | `Concepts/Authentication vs Authorization.md` |
| Schema past ~2 models | Relations, `related_name`, column vs `JSONField`. | `Data Model/Data Model Overview.md` |

Everything else — search, quotas, ratings, client labels, payments, i18n/RTL, backups — build
correctly, give the business reason in one sentence, don't stop to teach unless asked.

## Language & locale (architectural)

Arabic + French from day one. Arabic is RTL: **logical CSS properties only** (`margin-inline-start`,
never `margin-left`) — retrofitting RTL is a rewrite. No hardcoded user-facing strings, ever; all
copy through `{% translate %}` / `gettext`. Money is DZD stored as **integer centimes** in a
`BigIntegerField` — never `FloatField`, never a Python `float` in or out. Phones E.164 (`+213…`),
datetimes UTC (`USE_TZ = True`), displayed Africa/Algiers.
