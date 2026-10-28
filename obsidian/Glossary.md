# Glossary

Every term I use. If I use a word that isn't here, tell me and I'll add it.

---

## The pieces of the app

**Backend / API** — the program that holds all the rules and is the only thing allowed to
touch the database. Here it is the whole Django project. See [[What the API Is]].

**Frontend** — what the user sees and touches. Here it's Django templates rendered by the
same process; later, possibly a phone app. It has no rules of its own.

**Endpoint / operation** — one specific thing the API can do, addressed by a URL and a verb.
`POST /api/agencies/{id}/offers` creates an offer; `GET /api/offers/{id}` fetches one.

**Client** — (1) a program calling the API; (2) a person an agency knows, identified by their
phone number and tracked across every inquiry and trip. Context usually disambiguates; say
**client app** for the program and [[Client]] for the person.

**Modular monolith** — one program divided inside into parts with walls between them. Not
microservices (many separate programs). See [[System Overview]].

**Django app** — a folder holding one part of the domain: its models, its router, its tests.
`apps/offers` is an app. Confusingly *not* the same word as "the app" meaning the product.

**`config/`** — the Django *project*: settings, the URL map, the API root. Everything that is
about the program as a whole rather than about any one part of the domain.

**`manage.py`** — the entry point for every command: `runserver`, `migrate`, `test`, `shell`.
It sets `DJANGO_SETTINGS_MODULE` and hands off to Django.

---

## Database words

**Schema** — the definition of the database: what tables exist, what columns each has, what
types those are. Ours is the set of `apps/*/models.py` files. See [[Data Model Overview]].

**Table** — a spreadsheet-like collection of one kind of thing. `offers_offer` is a table.

**Row / record** — one entry in a table. One specific Omra offer is a row.

**Column / field** — one piece of information on every row. `price_centimes` is a column.

**Model** — Django's word for a table. A Python class inheriting `models.Model`.

**Primary key** — the column uniquely identifying a row. Ours is always `id`, a UUID.

**Foreign key** — a column holding another row's id, linking the two. `Lead.agency_id` points
at the agency that owns the lead.

**Relation** — the link itself. "An agency *has many* offers."

**`related_name`** — the name you use to walk a relation backwards. `related_name="offers"` on
`Offer.agency` is what makes `agency.offers.all()` work.

**`on_delete`** — what happens to this row when the row it points at is deleted. `CASCADE`
deletes it too; `PROTECT` refuses the delete; `SET_NULL` empties the column. Every foreign key
must choose, and the choice is a business decision — `Reservation.offer` is `PROTECT` because
deleting a departure someone booked should be a decision, not an accident.

**QuerySet** — Django's lazy description of a database query. `Offer.objects.filter(...)`
doesn't hit the database until you iterate it. That laziness is what makes
`scoped(queryset, agency_id)` possible: you can narrow a query *before* it runs.

**Manager** — the `.objects` attribute on a model. Where custom querysets live.

**Index** — a lookup structure that makes finding rows fast. Without one, the database reads
every row. With one, it jumps straight there. See [[Indexes and Why Queries Get Slow]].

**Constraint** — a rule the *database itself* enforces, not the application.
`CheckConstraint(price_centimes > 0)` means no code path anywhere can write a negative price,
including a shell session and a bug.

**Migration** — a recorded change to the schema, applied in order so your machine and the
server always match. Django generates them with `makemigrations`. See [[Migrations]].

**ORM (Object-Relational Mapper)** — a library that lets you query the database in Python
instead of raw SQL. Django's is built in — no separate package, unlike Prisma in the NestJS
repo.

**`choices`** — a column restricted to a fixed list of values, declared in Python.
`Lead.STATUSES` is one. Django's nearest thing to a database enum, but enforced at the
application layer by default rather than in the database.

**`TextChoices`** — the nicer syntax for the same thing: a class of named constants that also
carries the human label. `MilestoneKind` and `AttendanceStatus` use it.

**JSON column** — a column holding flexible structured data instead of one value. We use one:
`Offer.attributes`. See [[Offer]].

**Denormalised** — a copy of data kept somewhere for speed, e.g. `Agency.rating_count` instead
of counting reviews on every page load. Fast, but must be kept in sync — and *any denormalised
counter without a reconciliation job eventually lies*. Ours has `recompute_rating()`.

**Seed** — a script that fills an empty database with fake data so you can click around.
Ours is `manage.py seed_preview`.

---

## Security words

**Authentication (authn)** — *who are you?* Logging in.

**Authorization (authz)** — *are you allowed to do this?* Checked separately, on every
request. See [[Authentication vs Authorization]].

**Session** — the server's memory that you are logged in. In Django it is a row plus an
HttpOnly cookie. Used by the browser half of the app.

**Bearer token** — a signed string sent in an `Authorization` header, used by programs
instead of a cookie. Ours are made with `django.core.signing`, not a JWT library —
[[Auth Flow]] explains why that's a deliberate choice and not a shortcut.

**Access token** — short-lived (15 min), sent with each request.

**Refresh token** — long-lived (30 days), used only to get a new access token. Stored
**hashed**, so a database leak doesn't hand over live sessions. Single-use: reuse means two
parties hold it, so the whole family is revoked.

**Token family** — every refresh descends from one login. Revoking the family logs out both
the victim and the thief. The theft gets detected by the victim's own normal activity.

**Hash** — a one-way scramble. You can check a value against a hash but never recover the
value. Passwords are *never* stored, only their hashes.

**CSRF (Cross-Site Request Forgery)** — the attack where a form on someone else's site makes
a request to ours, and your browser helpfully attaches your cookie. A **cookie** problem, not
an authentication problem in general — bearer tokens are immune, because a browser never
attaches one on its own.

**Tenant** — one customer's isolated space. Here, one agency. See [[Multi-Tenancy]].

**Tenant isolation** — the guarantee Agency A can never see Agency B's data. The single most
important security property of this app.

**Scoping** — narrowing a query by the session's tenant *before it runs*, so another tenant's
rows were never in it. `scoped(queryset, agency_id)`. Not a check afterwards — a check can be
refactored away; a filter inside the queryset has nothing to skip.

**Deny by default** — everything is forbidden unless explicitly allowed. Forgetting a rule
leaves a door *locked*, not open. Ours is `NinjaAPI(auth=API_AUTH)`, set once.

**Capability URL** — a URL whose secret path *is* the credential. `GET /api/my-trip/{code}`.
Acceptable only when what it reveals is the holder's own data and nothing else.

**IDOR (Insecure Direct Object Reference)** — the bug where changing an id in a URL shows you
someone else's data. The one this app is built to make structurally impossible.

**Rate limiting** — capping how often one caller may hit an endpoint, to stop brute-force
and spam.

**PII (Personally Identifiable Information)** — names, phone numbers, emails. Never goes in
logs. See [[The Seven Rules]] rule 4.

**Audit log** — an append-only record of who changed what. Not a log file: a table, which
nothing may update or delete. A log that can be edited is not evidence. See [[Audit Log]].

---

## Code words

**Type hint** — Python's `x: int` syntax. Unlike TypeScript it is *not* checked when the code
runs — Python ignores it. What makes ours real is Pydantic, which reads the hint and enforces
it at the boundary.

**Pydantic** — the validation library underneath Django Ninja. Turns a type hint into an
actual runtime check.

**Schema (validation)** — a runtime description of allowed input. Ours are `ninja.Schema`
subclasses. Confusingly the same English word as database schema; context tells them apart.

**`Strict`** — our base schema, in `apps/common/schemas.py`. Sets `extra="forbid"` so unknown
fields are rejected instead of silently ignored. See [[Validation at the Boundary]].

**Django Ninja** — the library that turns a typed Python function into an HTTP endpoint,
validates its input with Pydantic, and generates the OpenAPI document. See [[Decision Log]]
#D-01 for why it and not DRF.

**OpenAPI** — a machine-readable description of every endpoint, generated at `/api/docs`. The
Django answer to the NestJS repo's `packages/shared`: a client generates its types from it
rather than hand-writing a second copy.

**DRF (Django REST Framework)** — the older, heavier alternative to Ninja. This repo used it
and moved off it. If you find `serializer` or `permission_classes` in a note, that note is
stale.

**Router** — Ninja's grouping of related endpoints, mounted onto the API in `config/api.py`.
The rough equivalent of a NestJS controller.

**Handler / view** — the function that runs for one endpoint. In `apps/*/api.py` for JSON, in
`apps/pages/views.py` for HTML.

**Form** — Django's HTML-side input validation, in `apps/pages/forms.py`. The second door onto
the same rules the schemas enforce. See [[One Rule, Two Entry Points]].

**Template** — an HTML file with `{{ }}` placeholders, in `templates/`.

**Middleware** — code running around every request. Ours creates the request id.

**Management command** — a script runnable through `manage.py`. `seed_preview` is one.

**`transaction.atomic()`** — a block where either every write lands or none do. Audit rows go
*inside* the same block as the change they record, or the log is missing exactly the entries
from the requests that crashed.

**`ast`** — Python's module for reading Python source as a tree. `tests_house_rules.py` uses
it to check the code itself, which is how a rule with no linter gets enforced anyway.

**ruff** — our linter and formatter. Fast, and has no user-defined rules — which is why the
house rules are tests.

---

## Money and locale

**Centimes** — 1/100 of a dinar. All money is stored as a whole number of centimes.
150 000,00 DZD is `15000000`. Never a float — `MoneyTests` bans `FloatField` outright.

**DZD** — Algerian dinar.

**E.164** — the one phone format we store: `+213551234567`. Every input is converted to it.

**Wilaya** — Algerian province. The code is stored as a two-character **string**, because
`"01"` must never become `1`.

**i18n (internationalization)** — supporting multiple languages. No text should ever be
hardcoded. (Honest state: the templates currently are. See [[System Overview]].)

**RTL (right-to-left)** — Arabic's reading direction. Affects layout, not just text, which is
why it's decided now rather than later.

**Wall-clock time** — a time that means the same thing wherever you are standing.
`OfferMilestone.time_of_day` is a *string*, `"04:30"`, deliberately not a time field: a
programme that says 04:30 must say 04:30 to everyone reading it. See [[Trip Programme]].

---

## Marketplace words

**Two-sided marketplace** — a product with two different user groups needing each other.
Here: travelers and agencies.

**Supply / demand side** — agencies supply offers; travelers demand them.

**Cold start** — the chicken-and-egg problem of an empty marketplace. See
[[Decisions You Must Make]].

**Lead** — a traveler's inquiry about an offer: the contact details plus what they want. The
thing you eventually charge for. See [[Lead]].

**Billable lead** — one Rihlati brought (marketplace or tracked link), as opposed to one the
agency brought itself (walk-in, direct call). Never charge for the second kind, or agencies
stop logging their own clients and your pipeline data becomes fiction.

**Pipeline** — the stages a lead moves through: `new → contacted → quoted → negotiating →
booked → travelled | lost`.

**CRM (Customer Relationship Management)** — the tool an agency uses to track its leads and the
people behind them. Your "gestion des clients": the [[Lead]] pipeline plus the [[Client]]
directory.

**Manifest** — the list of who is actually going on a departure. A [[Lead]] is a question; a
`Reservation` is a commitment. See [[Trip Manifest]].

**Checkpoint** — a milestone where the agency records who is physically present. See
[[Trip Programme]].

**Conversion** — a traveler actually becoming a paying customer.

**Consent trail** — *when* someone agreed, to *which exact wording*, from a hashed IP. Storing
`consent = True` alone makes "what did this person agree to?" unanswerable, and unanswerable
is legally the same as no consent.

**Verification** — your manual check of an agency's registre de commerce and tourism licence.
See [[Agency Verification]].
