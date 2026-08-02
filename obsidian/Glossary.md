# Glossary

Every term I use. If I use a word that isn't here, tell me and I'll add it.

---

## The pieces of the app

**Backend / API** — the program that holds all the rules and is the only thing allowed to
touch the database. Lives in `apps/api`. See [[What the API Is]].

**Frontend** — what the user sees and touches. The website (`apps/web`) and later the
phone app. It has no rules of its own; it asks the API for everything.

**Endpoint** — one specific thing the API can do, addressed by a URL and a verb.
`POST /offers` creates an offer; `GET /offers/abc` fetches one.

**Client** — confusingly, two meanings. (1) Any program calling the API — the website is
a "client". (2) A traveler who buys a trip. I'll say **traveler** for the person and
**client app** for the program.

**Monorepo** — one folder holding several projects (`api`, `web`, `shared`) that share
code. Avoids copying the same types into three places.

**Modular monolith** — one program divided inside into modules with walls between them.
Not microservices (many separate programs). See [[System Overview]].

---

## Database words

**Schema** — the definition of the database: what tables exist, what columns each has,
what types those are. Ours is `apps/api/prisma/schema.prisma`. See [[Data Model Overview]].

**Table** — a spreadsheet-like collection of one kind of thing. `offers` is a table.

**Row / record** — one entry in a table. One specific Omra offer is a row.

**Column / field** — one piece of information on every row. `priceFromCentimes` is a column.

**Model** — Prisma's word for a table.

**Primary key** — the column uniquely identifying a row. Ours is always `id`.

**Foreign key** — a column holding another row's id, linking the two. `Lead.agencyId`
points at the agency that owns the lead.

**Relation** — the link itself. "An agency *has many* offers."

**Index** — a lookup structure that makes finding rows fast. Without one, the database
reads every row. With one, it jumps straight there. See [[Indexes and Why Queries Get Slow]].

**Migration** — a recorded change to the schema (add a column, etc.), applied in order so
your machine and the server always match. See [[Migrations]].

**ORM** — a library that lets you query the database in TypeScript instead of raw SQL.
Ours is **Prisma**.

**Enum** — a column that may only hold one of a fixed list of values. `LeadStage` is an
enum: `new`, `contacted`, `quoted`…

**JSON column** — a column holding flexible structured data instead of one value. We use
exactly one, `Offer.attributes`. See [[Offer]].

**Soft delete** — marking a row deleted (`deletedAt`) instead of removing it, so it can be
recovered and history stays intact.

**Denormalized** — a copy of data kept somewhere for speed, e.g. `Agency.ratingCount`
instead of counting reviews on every page load. Fast, but must be kept in sync.

**Seed** — a script that fills an empty database with fake data so you can click around.

---

## Security words

**Authentication (authn)** — *who are you?* Logging in.

**Authorization (authz)** — *are you allowed to do this?* Checked separately, on every
request. See [[Authentication vs Authorization]].

**Session** — the server's memory that you are logged in, for this request.

**JWT (JSON Web Token)** — a signed string proving who you are, sent with every request.
Signed, so it can't be forged; readable, so it must never contain secrets.

**Access token** — short-lived JWT (15 min) sent with each request.

**Refresh token** — long-lived token (30 days) used only to get a new access token. Stored
**hashed** in the database, so a database leak doesn't hand over live sessions.

**Hash** — a one-way scramble. You can check a password against a hash but never recover
the password from it. Passwords are *never* stored, only their hashes.

**Tenant** — one customer's isolated space. Here, one agency. See [[Multi-Tenancy]].

**Tenant isolation** — the guarantee Agency A can never see Agency B's data. The single
most important security property of this app.

**Guard** — a piece of code that runs before an endpoint and can refuse the request.
Where authorization lives.

**Deny by default** — everything is forbidden unless explicitly allowed. Forgetting a rule
leaves a door *locked*, not open.

**IDOR (Insecure Direct Object Reference)** — the bug where changing an id in a URL shows
you someone else's data. Problem #3 on your list.

**Rate limiting** — capping how often one caller may hit an endpoint, to stop brute-force
and spam.

**PII (Personally Identifiable Information)** — names, phone numbers, emails. Never goes
in logs. See [[The Seven Rules]] rule 4.

---

## Code words

**Type** — a description of a value's shape, checked before the code runs. TypeScript's
whole point.

**Schema (validation)** — a runtime description of allowed input. Ours are written with
**Zod**. Confusingly the same English word as database schema; context tells them apart.

**Zod** — the library we validate with. One definition gives both a runtime check and a
TypeScript type.

**DTO (Data Transfer Object)** — the expected shape of a request body. Ours are Zod schemas.

**Module** — a folder grouping one feature's controller, service and tests.

**Controller** — receives HTTP requests, validates input, calls a service. Thin. No logic.

**Service** — where the actual business rules live. Testable without HTTP.

**Middleware / Interceptor** — code running around every request (logging, request ids).

**Dependency injection (DI)** — NestJS hands a service its dependencies instead of the
service constructing them. Makes tests able to substitute fakes.

**Decorator** — the `@Something()` syntax above a class or method. Metadata NestJS reads.

**Cursor pagination** — "give me the 20 after this id", rather than "page 500". Stays fast
at any size and never shows a row twice.

---

## Money and locale

**Centimes** — 1/100 of a dinar. All money is stored as a whole number of centimes.
150 000,00 DZD is `15000000`. Never a decimal — see [[The Seven Rules]] and `money.ts`.

**DZD** — Algerian dinar.

**E.164** — the one phone format we store: `+213551234567`. Every input is converted to it.

**Wilaya** — Algerian province. 58 of them. Used for "departure from" and agency location.

**i18n (internationalization)** — supporting multiple languages. No text is ever hardcoded.

**RTL (right-to-left)** — Arabic's reading direction. Affects layout, not just text, which
is why it's decided now rather than later.

**Locale** — a language + region, e.g. `ar` or `fr`.

---

## Marketplace words

**Two-sided marketplace** — a product with two different user groups needing each other.
Here: travelers and agencies.

**Supply / demand side** — agencies supply offers; travelers demand them.

**Cold start** — the chicken-and-egg problem of an empty marketplace. See
[[Decisions You Must Make]].

**Lead** — a traveler's inquiry about an offer: the contact details plus what they want.
The thing you eventually charge for. See [[Lead]].

**Pipeline** — the stages a lead moves through: `new → contacted → quoted → … → travelled`.

**CRM (Customer Relationship Management)** — the tool an agency uses to track its leads.
Your "gestion des clients".

**Conversion** — a traveler actually becoming a paying customer.

**Churn** — a customer leaving.

**Verification** — your manual check of an agency's registre de commerce and tourism
licence. See [[Agency]].
