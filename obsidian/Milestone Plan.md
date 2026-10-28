# Milestone Plan

What is built, what is next, and what **done** means for each step.

Four other notes link here — [[Start Here]], [[System Overview]], [[Accounts]] and
[[How to Study This Codebase]] — each having promised that some gap it just admitted to is
"a named milestone". This is the list those promises point at.

> [!info] This page is the detail, not the map
> [[Roadmap]] puts the same M1–M7 into phases — preview, pilot, public launch — and names
> the gate that must be true before each one starts. Read that first if you want the
> sequence; read this page when you want to know what "done" means for one item.

> [!info] What "done" means everywhere on this page
> [[The Seven Rules]], repeated here because a milestone that skips one is not finished:
> types and lint pass, `./scripts/check.sh` is green, the endpoint authorizes itself
> server-side, tenant-scoped resources have a **create-as-A / fetch-as-B / assert-404** test,
> no secret was introduced, and the vault note next to the feature is true in the same change.

---

## Built

Not "written" — built, tested, and reachable from a browser.

| | Where |
|---|---|
| Search: type, city, budget, sort, wilaya | [[Search and Filters]] |
| Offer detail, programme, reviews, public inquiry form | [[Offer]] · [[Trip Programme]] |
| Inquiry → Lead with a stored consent trail | [[Lead]] |
| CRM inbox: status, notes, tags, quality labels, due-callback filter | [[Client Quality Labels]] |
| Client directory: one person per phone, notes, tags, all leads and trips | [[Client]] |
| Offers console: create, edit, publish, archive, quota | [[Plan Limits and Quotas]] |
| Trip programme: milestones, duplicate-a-day, copy last season | [[Trip Programme]] |
| Reservations, departure manifest, check-in | [[Trip Manifest]] |
| The traveler's own live trip page, no login | [[Trip Manifest]] |
| Tracked links + campaign attribution | [[Tracked Links]] |
| Reviews tied to a real lead, with agency replies | [[Agency Ratings]] |
| Agency verification queue, staff-only | [[Agency Verification]] |
| Duplicate fingerprinting | [[Duplicate and Spam Control]] |
| Auth: login, 15-min access token, rotating refresh, reuse-revokes-the-family | [[Auth Flow]] |
| Audit log, append-only | [[Audit Log]] |
| Tenancy helpers, typed errors, request ids, redacting JSON logs | [[Multi-Tenancy]] |
| House rules enforced as `ast` tests over the source | `apps/common/tests_house_rules.py` |
| One JSON API with a generated OpenAPI document at `/api/docs` | [[API Endpoints]] |

---

## Next — in this order, and the order is the argument

### M1 · End-to-end tests over the five pages that matter

**Why first:** every milestone below changes a page, and there is currently nothing that would
notice if one of them stopped rendering. The suite drives Python; nothing drives a browser.
Rule 7 names the five pages explicitly: **search · offer detail · inquiry submission · agency
lead inbox · login**.

**Done means:** each of the five is driven in a real browser, asserts on visible text rather
than on element ids, has a screenshot assertion, and runs inside `./scripts/check.sh` so CI
gets it for free.

**Watch out for:** a suite that needs a hand-prepared database. It should build its own state
through the UI or through `seed_preview`, or it rots within a month.

### M2 · Interface translation

**Why here:** it touches *every template*, so doing it after more screens exist costs strictly
more, and it is the rule this repo most visibly violates. `USE_I18N = True`, `LANGUAGE_CODE`
and `LANGUAGES` are all set in `config/settings.py`, and there is **no `gettext` call anywhere
in `apps/`** — verified, zero hits. `LocaleMiddleware` is not installed and there is no
`set_language` route, so Arabic is not one click away; it is unreachable.

**Done means:** `LocaleMiddleware` installed, every user-facing literal wrapped in
`gettext_lazy`, `locale/ar/` and `locale/fr/` compiled, a language switch, and a check in
`scripts/check.sh` that fails the build on a bare French literal in a template — because
without that last part the rule decays the first time someone is in a hurry.

**Already right, do not undo:** `base.html` sets `dir` from `LANGUAGE_CODE`, and the templates
use logical CSS properties throughout. The layout will flip correctly the day the strings
exist. See [[Decisions You Must Make]] §7 — *which* language a first-time visitor sees is
still yours to decide, and today it is French by accident rather than by decision.

### M3 · Log in with a phone number or an email, not a username

**Why:** [[Accounts]] calls this "a real gap, not a design choice". An agency owner in Oran
will remember their phone number; they will not remember a username someone assigned them.
The NestJS repo accepts either in one `identifier` field.

**Done means:** one field accepting a phone number in E.164 or an email, normalised before
lookup, with the **same** error text for "no such account" and "wrong password" — that
identical-message property already exists in [[Auth Flow]] and must survive the change, or the
login form becomes an oracle for which phone numbers are registered.

### M4 · The report review queue

**Why:** `Offer.report_count` and `Agency.open_report_count` are incremented by
`apps/offers/api.py` and **read by nothing** — verified. A counter nobody reads is a feature
that reports abuse into a void, and the traveler who reported it believes something happened.

**Done means:** a staff-only queue in the same shape as the verification queue, a decision
recorded against a named human in the [[Audit Log]], the counters actually decremented on
resolution, and the `dismissed` duplicate status that [[Duplicate and Spam Control]] describes
and the code does not have.

### M5 · Image uploads

**Why:** offers carry image *URLs* today; nothing is stored, and there is no `ImageField` or
`FileField` anywhere. A hotlinked Unsplash URL is fine for a fixture and wrong for an agency's
own photographs of a hotel.

**Done means:** what [[Image Uploads]] specifies — validated content type and size, stripped
EXIF, and files served from somewhere that is not the application process. This is the first
milestone that adds a component to [[Architecture]], and that is the interesting part of it.

### M6 · The CRM redesign

**Why after M1:** [[CRM Redesign]] is fully specified, its decisions are explicitly closed,
and it rebuilds `/dashboard/` around "what do I do right now" instead of a table. It reshapes
screens, which is exactly what M1 exists to protect.

**Done means:** the build order in that note, ending with the *"Rappeler quand ?"* prompt —
without which the "Due for a callback" block stays empty and the whole redesign fails silently.

### M7 · Deploy it somewhere

**Why last, and why it is on the list at all:** `runserver` is the only way this application
has ever been started, and `runserver` is explicitly not for production. There is no
`Dockerfile`, no `gunicorn`, no `STATIC_ROOT`, and none of the `SECURE_*` settings —
`manage.py check --deploy` currently reports six warnings, including `SECURE_SSL_REDIRECT`,
`SESSION_COOKIE_SECURE` and `CSRF_COOKIE_SECURE`.

**Done means:** those six silenced honestly rather than suppressed; `DJANGO_DEBUG` refusing to
default to on when a real hostname is configured; `LocMemCache` replaced if more than one
process runs, because the login rate limit counts in local memory and multiplies by the worker
count ([[Architecture]] explains why that is a security bug and not a performance detail); and
**[[Restore From Backup]] rehearsed into a scratch database with the date written into the
runbook.** Rule 5: until that has happened there is no backup, only hope.

---

## Deliberately not next

Not backlog — decisions already made, recorded so they are not re-litigated:

- **Payments and plan gating.** No `has_feature`, no `cheapest_plan_with`, nothing charges.
  Stripe does not operate in Algeria and the rails will be local; [[Credits and Promotion]]
  holds the design. **v1 ships zero billing code** — see [[Decisions You Must Make]] §5, which
  is still yours to answer.
- **The agency chatbot, beyond v1.** A read-only per-offer assistant now exists — local
  `qwen3:14b`, public route, offer page widget, a dedicated page per offer, agency-owned
  free-text instructions with a manager-only editor, and 90-day conversation expiry
  ([[Agency Chatbot]], [[Decision Log]] 031, 032). It is **not** on the milestone path:
  tools, the FAQ table, the unanswered-question queue, WhatsApp and plan gating are all
  still later, and the model may need to move off the laptop before real travelers use it.
  Treat v1 as a preview to measure, not a milestone that is done.
- **A queue, a cache, a search service.** [[Architecture]] lists what each would have to earn.

---

## Open questions — yours

- **Is feature parity with the NestJS repo the goal?** [[Start Here]] raises this and it
  decides whether the gaps above are a backlog or a footnote. M3 only exists because the
  answer is currently assumed to be yes.
- **What is the first milestone a real agency would notice?** Nothing above is ordered by
  customer value; it is ordered by what is cheapest to do before the code grows. Those are
  different orderings and only you can say which one wins.
- **Does the NestJS vault get retired if Django wins?** Two vaults describing one product is
  how both become wrong.

---

Related: [[Start Here]] · [[Roadmap]] · [[System Overview]] · [[Architecture]] ·
[[The Seven Rules]] · [[Vision and Roadmap]] · [[Decisions You Must Make]] · [[Decision Log]]
