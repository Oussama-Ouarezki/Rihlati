# Decision Log

What's already been decided, and why. Append-only — when a decision changes, add a new
entry rather than editing the old one, so the reasoning trail stays intact.

For decisions still open, see [[Decisions You Must Make]].

---

## 001 — API first, then web, then mobile

**Date:** 2026-07-29

React Native/Expo can target web, Android and iOS from one codebase, which is why everyone
recommends it. But its web output is a JavaScript blob that search engines index poorly, and
a marketplace in this category lives on organic search — people typing "prix omra 2026" and
"agence voyage Oran". Flutter is worse on that axis.

**Decided:** build the API first, then a server-rendered Next.js website, then an Expo app
against the same API. Shared logic and types, separate UIs.

**Rejected:** Expo + React Native Web for all three (loses search traffic, the main growth
channel). Flutter (same problem, worse). Capacitor (one codebase, but weaker native feel).

**Cost:** two UI codebases instead of one. Accepted because they share types, validation and
the API client — and because the alternative sacrifices the primary way customers arrive.

---

## 002 — NestJS, not Express or Supabase-as-backend

**Date:** 2026-07-29

**Decided:** NestJS + PostgreSQL + Prisma.

NestJS is *rigid* — mandatory modules, guards, dependency injection, validation pipes. For
this project the rigidity is the point: it makes rules #2 and #3 structural instead of
things a person has to remember.

**Rejected:** Supabase as the backend. Faster to start, but its model has the browser talk
to the database directly, so all security becomes row-level-security policies. That's
precisely where "one user can see another user's data" comes from. Managed Postgres, own API.

**Rejected:** bare Express. Nothing stops you doing it wrong.

---

## 003 — Offer schema: shared columns + typed JSON

**Date:** 2026-07-29

The owner didn't know which travel category to start with. Rather than force the choice, the
schema absorbs it: shared columns for everything filterable, one strictly-validated JSON
column per offer kind.

**Decided:** all seven kinds work today. Adding one is four edits and no migration.

**Rejected:** one wide table (120 columns, mostly null). Separate table per kind (searching
across them is unworkable).

**The rule that keeps it honest:** anything users filter or sort by must be a real column.
See [[Offer]].

---

## 004 — Guest inquiries: no account required

**Date:** 2026-07-29

**Decided:** a traveler sends a lead with name + phone + consent. No signup.

Signup in front of the only revenue event is the most expensive wall a marketplace can
build. Accounts exist for saving offers, inquiry history and reviewing — reasons to come
back, not a toll on arriving.

SMS OTP stays unbuilt until abuse actually appears. Every OTP step costs money and loses
real inquiries; adding it should be a response to data, not a precaution.

See [[User]].

---

## 005 — One `User` table for travelers and agency staff

**Date:** 2026-07-29

**Decided:** no `accountType` column. No membership = traveler; membership = agency staff.

The same person is often both — an agency owner books their own family holiday. Two tables
would give them two accounts and no way to know they're one human. It also means auth is
written once, so there isn't a second, less-scrutinised login path.

See [[User]].

---

## 006 — Price is not part of the duplicate fingerprint

**Date:** 2026-07-29
**Supersedes:** an earlier version that bucketed prices into 5 000 DZD bands.

The first implementation bucketed prices so "close" prices matched. A test proved it broken:
149 000 DZD landed in bucket 29 and 150 000 DZD in bucket 30, so a 1 000 DZD edit created a
phantom new offer. **Every fixed bucketing has boundaries, so no band width fixes this** —
the idea was unsound, not mistuned.

**Decided:** price is excluded from the fingerprint entirely. Identity is "which agency,
which trip, which date". Price is an attribute of an offer, not what makes it that offer.
The `priceBucket` function was deleted, with a comment in `money.ts` explaining why, so it
doesn't get re-added.

**Worth remembering:** it typechecked, read plausibly, and was wrong. That's problem #7 in
miniature.

---

## 007 — Duplicates are flagged, never deleted or merged

**Date:** 2026-07-29
**Requested by:** the owner, correcting my initial design.

I built deduplication. The actual goal was **anti-spam** — stopping an agency from flooding
the marketplace with near-identical listings.

**Decided:** nothing is ever deleted or merged. `suspected` demotes in ranking, `confirmed`
leaves the default listing but stays reachable by direct link. Quotas prevent most of the
problem up front; flagging cleans up the rest.

Two-agency matches are explicitly **not** duplicates — different sellers at different prices
is the comparison the marketplace exists to provide.

Reports never auto-hide anything at any count, because rival agencies can report each other
and organising ten reports is a phone call.

See [[Duplicate and Spam Control]].

---

## 008 — Published-offer quotas on from day one

**Date:** 2026-07-29

**Decided:** free = 5 published offers, pro = 30, business = unlimited. Enforced now, with
nobody paying.

A limit introduced later is a takeaway. Start limited and raising the cap is a gift; start
unlimited and capping breaks a promise you didn't know you'd made.

**Decided:** leads are **never** capped on any plan. Capping leads caps the value the agency
is paying for, and strands the traveler whose inquiry goes nowhere. Sell capacity and
convenience, never fewer customers. There's a test enforcing this.

Drafts don't count toward the quota — the scarce thing is attention, not work.

See [[Plan Limits and Quotas]].

---

## 009 — Client quality labels are per-agency

**Date:** 2026-07-29

**Decided:** `Lead.quality` (`spam` → `vip`) belongs to one agency's lead. Agency A marking
someone `troll` doesn't affect what Agency B sees.

One agency's time-waster is another's customer, and shared labels would become a weapon
between rivals.

**Deferred, deliberately:** cross-agency reputation. The data supports it; the *policy*
doesn't exist yet, and silent blacklisting with no appeal is indefensible. Recommendation is
a soft warning to the agency, never an automatic block. See [[Client Quality Labels]].

---

## 010 — Documentation lives in an Obsidian vault

**Date:** 2026-07-29
**Requested by:** the owner.

**Decided:** `obsidian/` is the single documentation location; the old `docs/` folder was
moved into it. Teaching prose lives in the vault, not in code comments — code gets ordinary
comments, the vault carries the explanation.

`CLAUDE.md` requires vault notes to be updated in the same change as the code they describe,
so they can't drift.

---

## 011 — The access token carries no roles or memberships

**Date:** 2026-08-01

The JWT holds three claims: user id, session family id, admin flag. The caller's role at an
agency is read from the `memberships` table on **every** tenant-scoped request. Even the admin
flag in the token is ignored — the guard re-reads it from the database.

This **reverses what the vault previously described**, which said the token carried all
memberships. That note was written before the code and was wrong.

**Rejected:** putting memberships in the token, which is the common pattern and saves one
query per request. It loses because a token is a snapshot. Fire an employee at 09:00 and, with
a 15-minute token, they keep reading your client list until 09:15. In a CRM holding other
people's phone numbers, "revocation happens within 15 minutes" is not good enough to say out
loud to an agency.

**Cost:** one indexed lookup per tenant-scoped request, and the API cannot be scaled to a
stateless edge that has no database. Both are cheap now; if the query ever hurts, cache it with
a short TTL and an explicit invalidation on role change — do not move it back into the token.

---

## 012 — Login is rate limited per IP, never per account

**Date:** 2026-08-01

10 attempts per 15 minutes per IP. There is **no** account lockout after N failures.

This also **reverses an earlier note** that said "rate limited per identifier and per IP".

**Rejected:** per-account lockout, which every security checklist recommends. It loses because
it is a weapon: type wrong passwords at a competitor's owner account and lock them out of
their own CRM during Ramadan booking season. The attacker needs nothing but the email address.
Limiting the source slows guessing without arming anyone.

**Cost:** an attacker with a botnet spreads guesses across many IPs and evades the limit. The
real answer to that is a breached-password check and 2FA on `isPlatformAdmin` accounts, not
lockout. Neither is built yet.

---

## 013 — The tenant is named in the URL path, not a header or `/my/*`

**Date:** 2026-08-01

Tenant-scoped routes are `/v1/agencies/{agencyId}/leads`. `AgencyMembershipGuard` is global and
activates on the presence of the `:agencyId` route parameter.

**Rejected:**
- **`/my/leads`, resolving the agency from the session.** Simpler to read, but it breaks the
  moment someone belongs to two agencies — which happens more than you would think, and the
  data model already supports it. Retrofitting a tenant into every URL later is a rewrite of
  every client.
- **An `X-Agency-Id` header.** Works, but invisible: you cannot tell from a route whether it
  is tenant-scoped, so the guard becomes something you must remember to attach.

The path parameter makes the scoping **structural**: the thing that makes a route
tenant-scoped is the same thing that turns the guard on. There is no decorator to forget.

**Cost:** URLs are longer, and clients must hold an `agencyId`. Also worth being precise about:
`:agencyId` *is* client input — it is safe only because the guard proves membership and builds
`TenantContext` from the database row, never from the URL.

---

## 014 — A platform admin who is also a member acts as the member

**Date:** 2026-08-01

`AgencyMembershipGuard` looks for a membership row first. Only when there is none does it fall
through to the platform-admin path, which grants `owner` rank and sets
`actingAsPlatformAdmin: true` — a flag recorded on every audit row.

So a Rihlati staff member who happens to own an agency acts there as its owner, with their
actions logged as the agency's. To act as staff they need a separate account.

**Rejected:** letting the admin flag always win. It loses because it makes staff action and
ordinary agency action indistinguishable in the audit log, which is precisely the distinction
the log exists to record. It also means your own agency could publish its own offers, which
would quietly defeat the review gate.

**Cost:** you will need two accounts. The test helper had to be rewritten to notice this, which
is a small sign the rule is doing something.

---

## 015 — Rules the database refuses to break live in the database

**Date:** 2026-08-01

**Django form of the decision.** `models.CheckConstraint` in each model's `Meta`, carried into
migrations automatically. Three today: `seats_left <= seats_total` and `price_centimes > 0` on
`Offer`, `1 <= rating <= 5` on `Review`. Plus the `UniqueConstraint`s that encode a rule rather
than an index — one review per traveler per agency, one report per person per offer.

**Rejected:** relying on Pydantic validation alone. The schema stops bad data at the door,
which is most of the value — but it is one door. The seed command, a future CSV import, a data
migration and a `psql` session at 2am all bypass it. A negative price is not an error to
report; it is a state the database should refuse to hold.

**Cost:** far lower than in the NestJS repo, where these had to be hand-written SQL in a
migration because Prisma could not express them — invisible to anyone reading only the schema
file. Here the constraint sits in the model next to the column it constrains, which is the
whole reason this is a smaller entry than it used to be.

> [!warning] There are three, where the NestJS repo had about eighteen
> Non-negative money on every money column, ordered price ranges, ordered dates, E.164 phone
> shape and "a user has an email or a phone" are all enforced only in Python here. They are
> real gaps, not a change of mind — the decision above still says they belong in the database.

---

## 016 — Tests run against a real Postgres, never a mock

**Date:** 2026-08-01

Django's test runner builds a `test_…` database from `DATABASE_URL` and runs every migration
against it. Each `TestCase` runs in a transaction that is rolled back afterwards, so cases do
not see each other's rows.

**Rejected:** mocking the ORM. It loses badly here: a mock returns whatever you told it to, so
a tenant-isolation test against a mock asserts that your mock was configured the way you
configured it. The bugs these tests exist to catch — a missing `agency_id` in a `WHERE` clause,
a unique constraint that does not hold, a `CheckConstraint` rejecting a legal value — are
invisible to a mock by construction.

**Cost:** a database is required to run tests at all.

> [!warning] Locally this decision is currently half-kept
> With no `DATABASE_URL` set, `config/settings.py` falls back to SQLite, so the local suite
> runs on a database that is not the one production uses — it disagrees with Postgres on JSON
> lookups, case sensitivity and constraint enforcement, which is most of what these tests are
> for. CI sets `DATABASE_URL` and runs on Postgres, which is what makes the fallback tolerable
> rather than a lie. Run the suite with a real `DATABASE_URL` before trusting a green local
> run on anything constraint-shaped.

---

## 017 — The production tool stack (terms verified against the web, Aug 2026)

**Date:** 2026-08-01

**Decided:** Hetzner CX32 + Coolify (runs API, web, GlitchTip; ~€8/mo) · Neon Postgres
(free tier now — PITR included even there — Launch plan at real users) · Cloudflare R2 for
files (zero egress) · Brevo for email (300/day free) · GlitchTip self-hosted for errors ·
`wa.me` links for WhatsApp contact · no SMS in v1 · own auth + Google OAuth.

**Rejected:**
- **Supabase as the platform.** Not because it scales badly — it doesn't. Its bundle prices
  in the browser-to-database + RLS model this project deliberately does not use, so it
  collapses to "Postgres + storage" here; it cannot host the NestJS API at all; and PITR is
  a **$100/mo add-on** where Neon includes it for cents. Buying its auth again would mean
  paying twice for the layer already built and tested.
- **Vercel** — the Hobby plan forbids commercial use, and a marketplace is commercial.
- **Railway/Render** — fine products; nothing here Coolify doesn't do at a fifth the price.
- **SMS OTP in v1** — Algeria requires domestic sender-ID pre-registration (~2 weeks),
  Mobilis rejects generic sender IDs, and two-way SMS isn't supported. A project, not a task.

**Cost:** you patch one server; five dashboards instead of one; self-hosting is time.
Everything sits behind a standard interface (Postgres, S3, SMTP, Docker), so any one piece
can be swapped in a day — that reversibility is the point of the whole selection.

---

## 018 — French default, with Arabic and English in a switcher

**Date:** 2026-08-01. **Decided by the owner.**

**Rejected:** Arabic-first (strongest local-market signal, and the Omra audience skews
Arabic — but agency staff work in French and the Emploitic pattern is French-first);
auto-detect (each visitor lands in their own language, but the first impression becomes
unpredictable and harder to reason about).

**Cost:** every user-facing string now exists ×3. FR and AR are the contract; EN is
best-effort and may lag. RTL support is unchanged — Arabic being one click away means the
layout must be flawless in RTL anyway.

---

## 019 — Per-checkpoint attendance is a separate table, not a redefined `Reservation.status`

**Date:** 2026-08-01

[[Trip Programme]] milestones can now be marked `checkpointType: mandatory | optional`, and
a new `MilestoneCheckIn` table tracks each family's attendance per checkpoint — a family can
be checked in for the outbound flight and still not-yet-arrived for a ziyara days later.
`Reservation.status` (the existing, tested [[Trip Manifest]] field) is untouched: it still
means "booked on this departure at all."

Attendance at an **optional** checkpoint (excursions, ziyarat — things a family can
reasonably skip, e.g. a hotel switch mid-trip) defaults to `no_show` if that's what it was
at the previous checkpoint, so a guide isn't re-marking the same absent family at every
stop. A single tap ("push them back") overrides it for that one checkpoint only. **Mandatory**
checkpoints (flights, the departure/return bus) never inherit this default — always fresh,
because a wrong default there can mean a family left behind.

**Rejected:** redefining `Reservation.status` itself to mean "attendance at the current
checkpoint." It would have meant reshaping a field 6 existing e2e tests and the whole
`/console/departures` screen already depend on, to make it do a second job it was never
designed for — for a feature that doesn't actually need the old field to change, only a new
one added beside it.

**Cost:** a family now has up to N+1 status rows instead of 1 (one `Reservation` + one
`MilestoneCheckIn` per checkpoint they've reached) — more rows, and the console has to show
two related-but-different statuses without confusing the guide about which one he's editing.

---

## 020 — Clients read the programme as a map; the agency edits it as a list

**Date:** 2026-08-02

The trip programme renders as a **road map** — a horizontal serpentine road with a marker at
each stop, a dashed centre line, and the travelled stretch in brand colour — on every
client-facing surface (the public offer page and the booked traveler's `/mon-voyage/{code}`).
The agency keeps its list editor in the console. One `Roadmap` component, one prop different:
only the traveler's version marks a current stop.

**Rejected:**
- *A dashed vertical timeline for everyone*, which is what this note used to describe. It is a
  list with decoration. A 15-day Omra is forty rows of text — you cannot see the shape of the
  trip, only read it. The whole reason a traveler opens the page is spatial: where am I, what
  is next.
- *A row of beads on a straight line.* Cheap to build and it reads as a progress bar, which is
  the wrong metaphor — a trip is a route, and a route bends.
- *A different component per surface.* The buyer's view and the traveler's view differ by
  exactly one thing — whether the group has started — so two components would have been the
  same file twice, drifting.
- *Sharing one component with the agency editor.* The shared thing would have been a list with
  half its columns hidden, serving neither audience. Editing and reading are different
  products, not different skins.
- *A one-stop-per-row vertical wave.* Built first, and rejected on sight: nine steps came out
  nearly a thousand pixels tall at every width, and the whole right half of a desktop screen
  sat empty. The serpentine packs four stops into a row and cuts that by two thirds.

**Cost:** the number of columns is a **JavaScript** decision, not a CSS one — the path has to
know where the row breaks in order to draw the U-turn. So the breakpoint lives in
`useRoadPath` behind a `useSyncExternalStore` media query rather than in a Tailwind class,
and the server renders the two-column layout until the client says otherwise.

---

## 022 — The road is generated from its points, not measured from its path

**Date:** 2026-08-02

`pathHelpers.ts` chooses the stop positions first and builds the SVG curve through them.
Markers are then placed at coordinates we already hold.

**Rejected:** *the standard approach* — draw the path, then call `getTotalLength()` and
`getPointAtLength()` to find where to put things. It is what every tutorial shows, and it
loses on three counts here: it needs a real DOM, so nothing can render on the server; it
needs a layout effect, so markers visibly snap into place on a slow phone; and it makes the
"how far along are we" overlay a length calculation instead of what it actually is.

The payoff shows up in the travelled stretch: it is the *same builder run over the first N
points*. It cannot drift from the road underneath it, because it is the same function over
the same numbers.

**Cost:** the curve is ours to get right. A Bézier only passes through its endpoints, so
naïvely feeding points to one puts the road *near* the markers rather than through them —
the turns are hand-built cubics with control points placed outboard of the two stops they
join. Change the layout and that turn maths has to change with it.

---

## 021 — The traveler page is a capability URL, and the rate limit is the security

**Date:** 2026-08-02

`GET /v1/trips/{code}` is public and **not scoped by a tenant**, because there is no session:
a family books without ever creating an account. `Reservation.publicCode` is 128 random bits,
globally unique, stored in the clear — the code *is* the authorization.

**Rejected:**
- *Traveler accounts.* Would work, and would also mean asking a family to create a password
  before they can find out where the bus leaves from. [[Lead]] already works without an
  account on purpose; requiring one here would undo that at the worst moment.
- *Signed, expiring tokens.* The link has to survive months in a WhatsApp thread and be
  re-openable at 4am with no data. An expiry is a support call.
- *Rotating the code on demand.* Rejected for the mint endpoint: rotating silently breaks a
  link the family already has, and the breakage lands on the person who needs it most.
  Issuing is idempotent; revocation, if ever needed, is a separate explicit action.

**Cost:** whoever holds the link, has access — forwarded, screenshotted, pasted anywhere. So
the response is a hand-built allow-list (this family's name and headcount, the already-public
programme and agency contact, nothing else), the endpoint is limited to 30/hour/IP, and the
page is `noindex`. `apps/api/test/trips.e2e.test.ts` asserts the **exact key set**, so a
column added to `reservations` fails the build instead of shipping to a forwarded link. If
this page ever needs to show more, it needs real authentication — not a longer code.

---

## 023 — A picture is uploaded as bytes; the client never names a URL

**Date:** 2026-08-04

No endpoint accepts an image *URL* from a client. The browser posts the file, the server
re-encodes it and picks the filename from a hash of the resulting bytes. `avatarUrl` and
`logoUrl` are absent from every input schema, so Zod strips them.

**Rejected:**
- *Accept a URL and store it.* Much less code, and it is what most tutorials show. It also
  means a user can point their avatar at a server they control and collect the IP address of
  everyone who loads a page showing it — and can swap the content after it passed moderation.
- *Accept the upload but store the original bytes.* Then we are serving a file a stranger
  composed. EXIF GPS from a phone photo leaks the uploader's home address, and a polyglot file
  that is simultaneously a valid JPEG and valid HTML is stored XSS on our own domain.
  Re-encoding through sharp closes both, plus decompression bombs, in one step.
- *Client-side validation only.* Anything decided in a browser can be skipped by not using a
  browser. The client checks are kept, but as a courtesy over a slow connection, not security.

**Cost:** every upload costs CPU to decode and re-encode, and we discard the user's original —
so we cannot ever offer "download the file I uploaded". We also lose intentional metadata like
a photographer's copyright tag. For avatars and logos that is the right trade; for a future
offer gallery aimed at professional photography it may not be.

---

## 024 — Storage is a driver interface: local disk in dev, S3-compatible in production

**Date:** 2026-08-04

`StorageDriver` (`put` / `remove` / `urlFor`) has two implementations, picked once at boot from
`STORAGE_DRIVER`. Nothing outside `modules/uploads` knows which is running.

**Rejected:**
- *Local disk everywhere.* Simplest, and wrong the moment there is more than one server or a
  container is redeployed — every uploaded image vanishes, silently. The config now **refuses
  to boot** if `NODE_ENV=production` and `STORAGE_DRIVER=local`, so this cannot happen by
  accident.
- *The AWS SDK's S3 client used directly in the service.* Same amount of code today, but it
  welds us to AWS. Algeria-adjacent hosting is more likely to be an S3-*compatible* provider
  (Scaleway, Hetzner, Backblaze), so the endpoint is configurable and the driver is behind an
  interface. **Verify the provider's terms and pricing before launch — not yet done.**
- *Storing images as bytes in Postgres.* Keeps backups in one place, and makes the database
  enormous and every backup slow. Object storage is what object storage is for.

**Cost:** two code paths, and the S3 one has never run against a real bucket — it is written
and typechecked, nothing more. That is a real risk flagged in [[Image Uploads]], not a
finished feature.

---

## 025 — The agency review tool is deferred until we know what a review checks

**Date:** 2026-08-04
**Superseded by 027 (2026-08-05)** — the mechanism was built; the criteria question this entry
was waiting on is still open. Kept as written, because the reasoning is what 027 argues against.

Agencies can now sign themselves up and ask to be verified, but nothing can approve them —
no admin page, no verify endpoint, no notification. That is deliberate. The blocker is not
code: **there is no register we can check an agency against**, so building a review screen
first would produce a button that grants a trust badge on a hunch, with no defensible meaning
behind it.

**Rejected:**
- *Ship the admin panel now and figure out the criteria later.* Fastest, and the worst option.
  The moment the button exists it gets used, and « Vérifiée » starts appearing next to agencies
  on the strength of a number they typed in themselves. Undoing a badge is far harder than
  never granting it.
- *Auto-verify everyone so the marketplace has stock.* Solves the cold-start problem by
  destroying the only thing that makes this product different from a Facebook group.
- *Keep verifying by hand in SQL and call it done.* This is the status quo, and it is
  acceptable **only** while the agency count is near zero. It bypasses the audit log, so
  `verifiedByUserId` stays null and nobody can answer "who granted this badge" — which is the
  first question asked after a fraud.

**Cost:** no agency can be verified through the product, so no agency is publicly visible, so
the marketplace has no supply until this is built or done by hand. That is a real launch
blocker and it is now the critical path — not a background nicety.

Full analysis, including the accountability-instead-of-certification model and the argument
that the badge should say what was actually checked, is in [[Agency Verification]].

---

## 026 — Field validation messages are translation keys, not French sentences

**Date:** 2026-08-04

The rule: a validation failure travels as a **key**, and only the layer that knows which
language the person chose turns it into a sentence. This closes a violation of "no hardcoded
user-facing strings": an Arabic reader who mistyped a password got a correctly right-to-left
page with a French sentence under the box.

> [!danger] This decision is **not** honoured in the Django port
> Every message in this codebase is a hardcoded French string — `"Un motif de refus est
> obligatoire."`, `"Places restantes supérieures au total."`, `"Réservé à l'équipe Rihlati."`
> and roughly forty more. `USE_I18N = True` and `LANGUAGE_CODE = "fr"` are set in
> `config/settings.py`, and nothing uses them: there is no `locale/` directory, no `.po` file,
> and no `gettext` / `gettext_lazy` call anywhere in `apps/`.
>
> Only the machine-readable half survived. `apps/common/errors.py` returns a stable `code`
> (`VALIDATION_FAILED`, `FORBIDDEN`, `CONFLICT`, …) which a client can branch on in any
> language — the `details` string beside it is French and always will be until this is fixed.
>
> **What fixing it looks like:** wrap user-facing strings in `gettext_lazy as _`, add
> `LocaleMiddleware`, ship `locale/ar/` and `locale/en/`, and add a check that fails the build
> on a bare string literal reaching a `messages.error()` or an `HttpError`. That last part is
> the one that matters — this rule is broken by forgetting, not by disagreeing, so it needs a
> machine to enforce it exactly like the other house rules. See [[The Seven Rules]].

**Rejected:**

- *Send the browser's `Accept-Language` and have the API translate.* Puts a translation file in
  the API, a second one in the web app, and a third in the eventual mobile app, all needing to
  agree. The server would also be guessing: the header is the browser's setting, not the
  language the person picked on the site.
- *Leave it and fix it when the mobile app exists.* It changes the shape of a public API
  contract, so the cost only goes up. Today there is exactly one client, so the change is a
  find-and-replace. That is why it was done now rather than deferred again.
- *Translate only the input schemas, not the handlers' own messages.* Half the problem. In this
  port it would be well under half: most French strings live in handlers and page views, not in
  schemas.

**Cost:** a schema no longer reads as a sentence — a key needs a lookup to know what it says.
And a key with no translation prints the key itself on the page, which is uglier than the wrong
language. Both are why the fix needs a test that fails when a locale is missing an entry, not
just a convention.

**Also not done:** Pydantic's built-in messages (`Field(min_length=…)`, type errors) come back
in English regardless of locale, and they are what a client sees on a `422`. See the warning in
[[Validation at the Boundary]].

---

## 027 — Build the review *mechanism* now, leave the review *criteria* open

**Date:** 2026-08-05

Supersedes the deferral in **025**, and does so without answering the question 025 was waiting
on. The queue, the verify/reject decision and the audit trail are now built; what a reviewer
should actually *check* is still undecided, because there is still no register to check
against.

The reasoning for splitting it that way: 025 was right that a button granting a badge on a
hunch is worse than no button, but it conflated two things. The **criteria** need an answer we
do not have. The **mechanism** — a queue ordered by who asked first, a decision attributable to
a named person, an audit row written in the same transaction — is correct under every possible
answer to the criteria question, and it was the actual launch blocker: no agency could become
publicly visible through the product at all.

Three choices inside it, each trading convenience for evidence:

- **Verification requires a written note** (`checkedNote`, private, ≥10 chars). One click would
  be faster. But the entire worry in [[Agency Verification]] is the gap between what « Vérifiée »
  claims and what was done, and the only honest moment to record what was done is while looking
  at the documents.
- **An admin may not decide on an agency they belong to** (`403`, `self_review`). Not distrust
  of staff — a badge granted by its own owner proves nothing, and proving something is the
  badge's only purpose.
- **The route parameter is `{id}`, not `{agencyId}`**, which deliberately keeps
  `AgencyMembershipGuard` from firing. The guard would frame the request as *staff acting as
  the agency*, which is right for support work and wrong for judging them.

**Rejected:**

- *Keep waiting for the CNRC answer.* It may never come, and meanwhile no agency can go live.
  The mechanism does not depend on it; only the wording of the badge does.
- *Let the membership guard handle the admin routes by naming the parameter `:agencyId`.*
  Tempting — it is one character and the guard already grants admins `owner` rank. But it
  encodes "the reviewer is acting for this agency", which is the opposite of what a review is,
  and it would have silently allowed an admin to sign off on their own agency.
- *Bootstrap the first admin from an endpoint that only works while zero admins exist.* A
  public "make me god" route armed on every fresh deployment, with a race between deploying and
  registering. A CLI moves the boundary to shell access instead ([[Accounts]]).
- *Collect identity documents in the same slice.* Explicitly refused. It needs a legal answer
  and a private-bucket storage driver; combining them is how a passport lands in the public
  bucket. Still deferred, with the design written down.

**Cost:** the badge still says « Vérifiée » while the review behind it is a plausibility check,
so the wording question from 025 is now *more* urgent, not less — the button exists and will be
used. And manual review is now a standing job with no notification attached to it: the queue is
a page someone has to remember to open.

---

## 028 — One account menu, in the site header, on every page

**Date:** 2026-08-05

The avatar in the top-right corner of the public header is the single place to sign in, see who
you are, and sign out — on the marketplace, on an offer page, and inside the agency console
alike. Signed out, that corner shows « Se connecter » and « Créer un compte » instead. The
console's own header no longer carries a second avatar: it sits ten pixels below the site
header, so there were briefly two.

The session is read **server-side** in `SiteAccountNav`, from the httpOnly cookie. The browser
never receives a "logged in" flag it could flip. Worth being explicit about why that changes
nothing about security: showing the menu is a UX decision, not a permission. Every API route
still authorises itself ([[The Seven Rules]] #2). If someone forged the signed-in header in
their own browser, they would see their own name in a box and every request behind it would
still 401.

**Rejected:**
- *A "Espace agence" link in the header for everyone.* That is what was there. It sent
  travelers — who are most visitors — to a page inviting them to create a travel agency. The
  console link now only appears for someone who is actually in an agency.
- *Leaving the account menu only in the console.* Sign-out then existed on exactly the pages
  agency staff use, and a traveler who had signed up had no way to sign out at all.
- *Two menus, one per header.* Rejected on sight once it was on screen: "where do I sign out"
  must have one answer.
- *Moving the language switcher into the menu on the public site too.* It stays visible in the
  header, because a visitor who landed on the wrong language must not have to open a menu
  labelled with a name they can't read to fix it. Inside the console header there is no room,
  so the console keeps it in the menu.

**Cost:** every page in the public layout now awaits `getSession()`, so every render of the
marketplace makes one call to `/v1/auth/me`. It is `cache()`d per request and it is the same
call the console already made, but it is a call on pages that used to need none — the first
thing to look at if the homepage gets slow.

Two bugs surfaced while building it, both worth a sentence:
- Base UI's `DropdownMenuLabel` throws unless it is inside a `DropdownMenuGroup`. The console
  menu had the same bug and had simply never been opened in a test.
- The login page's title was a styled `div`, so the page had no `<h1>` for a screen reader to
  land on. The e2e assertion looking for a heading had been failing on `main` because of it.
  Now it is an `<h1>` and the test is true.

---

## 029 — Programme bulk copies only ever add rows

**Date:** 2026-08-05

Duplicating a day and copying a programme from another offer both **append** to the end of the
target programme. Neither ever moves, overwrites or deletes an existing step. The target day of
a duplicate is chosen explicitly by the agency — the console proposes source + 1, the server
assumes nothing — and both operations stop at 200 steps per offer
(`MILESTONE_MAX_PER_OFFER`) with `409 MILESTONE_LIMIT_REACHED`.

The reason is undo. An unwanted copy leaves rows the agency can see and delete, one by one, in
the editor they are already looking at. There is nothing to explain and nothing to restore.

`copy-from-offer` is the first endpoint where a client legitimately sends the **id of tenant
data** — `sourceOfferId`. It goes through the same owned-offer check as the target, so naming
another agency's offer id returns 404 and reveals nothing. That case is a test, not a comment:
`apps/api/test/milestones.e2e.test.ts` asserts the 404, asserts the response body does not
contain the source offer's title, and asserts zero rows were written ([[The Seven Rules]] #3).

Copies keep `checkpointType` — an agency that decided "présence obligatoire à l'aéroport" meant
it for next season too — but drop `completedAt` and `completedByUserId`. A copied step has not
happened. Inheriting a tick would park the "vous êtes ici" marker on every traveler's map at a
place the group has never been, and the wrong marker is worse than no marker.

**Rejected:**
- *A "replace the programme" mode.* The obvious ask, and it has no undo: the rows it overwrote
  are gone, and the agency discovers that after the thing they wanted to keep is already gone.
  Additive plus manual delete costs a few taps and can always be stopped halfway.
- *Duplicating a day to "the next day" implicitly.* Reads as convenient until an agency has a
  gap in its day numbering, at which point the server has silently guessed wrong. The picker
  makes the choice visible, and defaulting it to source + 1 keeps the common case one tap.
- *Copying a programme by cloning the offer.* A different feature with different consequences
  — price, seats, dates, publication state. The agency wanted the itinerary, not the offer.
- *No ceiling.* A 14-day Omra is ~50 steps; 200 is unreachable by hand and reachable by
  repeated taps on a copy button. This is a sanity limit on one programme, deliberately **not**
  a plan gate — it must not become a thing to sell.

**Cost:** copying twice by mistake silently doubles the programme. Nothing warns; the agency
sees 16 steps where they expected 8 and deletes half. A "this offer already has a programme —
copy anyway?" confirmation would fix it and is the first thing to add if it happens in practice.

---

## 030 — This repository is Django + Django Ninja, superseding 002

**Date:** 2026-08-09

**Decided:** the same product, the same schema, the same seven rules, the same decisions in
this log — rebuilt on **Django 5.2 + Django Ninja**, with server-rendered templates instead of
a separate Next.js app. Decision 002 (NestJS + Prisma) stands as the record of what the other
repository chose; it no longer describes this one.

The reason is not that NestJS was wrong. It is that most of what NestJS assembles by hand —
an ORM, migrations, an admin, sessions, a user model, a test runner with database rollback —
Django ships with, and the parts this project genuinely cares about (typed input, typed
output, a generated OpenAPI document) are exactly what Ninja adds on top. Fewer moving parts
holding the same rules.

**What carried over unchanged, and this is the point:** deny-by-default auth at the router
(`NinjaAPI(auth=…)` in `config/api.py` instead of a global guard), tenant scoping in the data
layer (`scoped()` instead of a Prisma middleware), one definition of every input schema, a
404 for both missing and forbidden rows, integer centimes, UUID ids, structured logs with a
`request_id`, and a test suite that fails when a handler forgets its gate.

**Rejected:**

- *FastAPI.* Better ergonomics than Ninja in isolation, but it brings no ORM, no migrations,
  no auth, no admin and no template layer — which puts us back to assembling the same pile
  NestJS was assembling, minus NestJS's structure. Ninja is FastAPI's design applied to a
  framework that already has the boring half.
- *Django REST Framework.* The obvious default, and it was the starting point here before
  being replaced. Its serializers are a second, parallel type system that has to be kept in
  agreement with the models by hand, and its OpenAPI output is generated by inspection rather
  than declared. Ninja uses Pydantic, so the schema *is* the type.
- *Keeping the separate SPA.* Two codebases, a client-side router, and an API contract to
  version — for a marketplace whose traffic arrives through search. Server-rendered pages
  index without argument. The trade is real interactivity, paid back with small islands of
  JavaScript where a page genuinely needs it.

**Cost:** the one-repo, one-language convenience of `packages/shared` is gone — the browser
cannot import a Pydantic schema. What replaces it is the OpenAPI document at `/api/docs`,
which a future mobile client generates types from. That is a build step where there used to be
an import, and it is the honest gap: a shared schema *is* the same code, generated types are
only a faithful copy. See [[One Rule, Two Entry Points]].

---

## 031 — The first assistant is a local, read-only, per-offer bot

**Date:** 2026-10-28

**Decided:** v1 of [[Agency Chatbot]] is a public `POST /api/chat/offers/{offer_id}` route
that answers questions about **one** offer using **one** agency's data, in the language the
traveler writes, powered by **`qwen3:14b` on this machine through Ollama**. It is read-only:
no tools, no reservation, no price change. The page keeps its existing inquiry form beside it.

Four sub-decisions are the ones worth remembering:

- **A capability token, not a login.** The first response returns 128 random bits from
  `secrets.token_hex(16)`. It names one conversation, the same pattern as
  `Reservation.public_code`. Requiring an account to ask "le visa est-il inclus ?" would
  produce zero conversations.
- **History in rows, not in the browser.** The client sends only the newest message and the
  token. The server rebuilds the last six turns from `ChatMessage`. A client that could send
  its own transcript could inject an assistant turn claiming a lower price.
- **Context is one offer + its programme + up to three same-agency siblings**, as compact
  JSON. Related-offer cards are rendered from the same deterministic queryset — the model
  never chooses a slug, a price or a link.
- **The read side filters `attributes`.** Until [[Known Gaps]] G1 is fixed, `apps/chat/
  context.py` passes only allowlisted keys with primitive values. Dropping a real key costs
  an answer; repeating a typo costs trust in every other answer.

**Rejected:**

- *The Claude API, as the note previously specified.* No key, no invoice and no traveler text
  leaving the laptop during the preview. The cost is a slower, weaker model — measured here
  at ≈8s cold and ≈1–3s warm, versus a hosted model that would follow the "say you don't
  know" rule more reliably. Revisit before real travelers use it, not before.
- *Tools in v1.* `create_reservation`, price changes, `handoff_to_human` — all deferred.
  Every one of them turns "the bot was helpful" into an authorization surface, and none is
  needed to answer the question that motivated the feature.
- *A vector database or embeddings.* An agency has 5–30 offers. Retrieval is a queryset.
- *An agency-wide bot.* The context is one offer from one agency. A bot that "knows every
  agency" leaks tenants through its mouth, and no guard in `apps/common/tenancy.py` sees it.
- *Storing the transcript only in the browser.* Cheap until someone reloads, and impossible
  to mine for the unanswered-question queue.

**Cost:** three real ones. The local model is the weakest part of the feature and may not be
good enough to leave on in production; the 30/hour and 12-turn caps are sized for one laptop,
not a marketplace; and `purge_chat` is an operator command because there is nowhere to run
cron until M7. The read-side allowlist is a mitigation, not the G1 fix — the write side still
accepts `nightsInMaccah`.

---

## 032 — Each agency writes its own assistant policy, in free text

**Date:** 2026-10-28

**Decided:** an agency can now shape what its assistant says about **booking**, without a
deploy. One optional row per agency — `AgencyAssistant` with `is_enabled` and
`instructions` (free text, 2 000 characters) — edited by a **manager or owner** at
`/a/<agency_id>/assistant/`, audited as `assistant.updated` in the same transaction. A
missing row means "enabled, no extra instructions", so no backfill was needed. The same
change adds a **dedicated assistant page per offer** at `/offers/<offer_id>/assistant/`,
which shares the conversation with the offer-page widget through `sessionStorage`.

Four sub-decisions:

- **Free text, not structured fields.** Deposit percentage, cancellation window, required
  documents and payment method vary enough between agencies that a fixed schema would fit
  almost nobody and be ignored by the rest. A prose block goes into the prompt as one
  `CONSIGNES DE L'AGENCE` section and costs one textarea.
- **Appended after the platform rules, never merged.** The block sits below the seven rules
  and above the `DONNÉES`, and its own heading states that it cannot replace them. The bot
  can say "acompte de 30 %" because the agency wrote it; it still cannot invent a price.
- **Manager-only, and tenant-scoped by the URL.** `require_membership_or_404(..., MANAGER)`
  authorizes the agency in the URL and the form has no `agency` field to forge — the same
  shape as `AgencyProfileForm`. The traveler never sees the editor.
- **`sessionStorage`, not the URL.** The conversation token follows the traveler from the
  widget to the full page under `rihlati-chat:<offer_id>`. A token in a URL ends up in
  history, in `Referer`, and in whatever gets pasted to a friend; keying by offer stops two
  tabs about two trips from swapping conversations.

The full page uses the offer page's own visibility rule (`Offer.publicly_visible()`) and
returns 404 when the deployment switch or the agency switch is off. `is_enabled=False` also
hides the widget and makes the API answer 503 — one switch, three surfaces, nothing deleted.

**Rejected:**

- *Structured instruction fields* (deposit %, cancellation days, document checklist). They
  read well in a form and fit almost no real agency; every exception becomes a request for
  another field. Free text lets the agency describe its actual practice.
- *Per-offer instructions.* The offer row already carries the facts that differ between
  offers; duplicating policy per offer means editing it N times and letting the copies drift.
- *Site-staff-only editing.* The policy is the agency's commercial practice, not platform
  behavior. Platform rules stay in `apps/chat/prompts.py`, where a deploy can review them.
- *A separate preview endpoint.* The full page *is* the preview — it reads the saved
  instructions and runs the real model. A second endpoint would need its own auth, its own
  throttle and its own tests to say the same thing.
- *Putting the token in the full-page URL* so it survives a reload or a share. Reload already
  works from `sessionStorage`; a URL that survives a share is a leak, not a feature.

**Cost:** the prompt now has an agency-controlled section, so a badly written policy can
make answers worse — the fix is a better textarea, not a code change, and there is no
validation beyond length. The editor shows character count only as a hard cap, not as
guidance. Two surfaces mean two places to keep honest when the widget changes, mitigated by
sharing `_chat.html` with a `chat_full_page` flag. And the assistant still has no plan gate:
every verified agency's published offers get it while `CHAT_ENABLED=1`.

---

## 033 — Agencies teach the assistant global Q&A and per-offer instructions

**Date:** 2026-10-29

**Decided:** the assistant now reads from three agency-authored layers after the platform
rules, in this order: global policy (`AgencyAssistant.instructions`), global Q&A
(`AgencyFaq`) and per-offer instructions (`OfferAssistant.instructions`). Both new models
are edited by a **manager or owner** from the existing assistant page; the offer editor lives
at `/a/<agency_id>/offers/<offer_id>/assistant/`. Every write is audited in the same
transaction: `assistant.faq_added`, `assistant.faq_updated`, `assistant.faq_deleted` and
`offer_assistant.updated`.

The shape is deliberately asymmetric:

- **Global Q&A is a table, not prose in the policy block.** Up to 20 entries per agency, each
  a 200-character question and 600-character answer, unique per agency on the exact question,
  with an `is_active` switch. The prompt gets only active rows, oldest first. A table gives a
  future FAQ-mining queue a row to create, and lets one answer be switched off without
  rewriting the policy paragraph.
- **Per-offer instructions are a separate one-to-one row.** `OfferAssistant` belongs to one
  offer, copies `agency` from that offer on save, and is capped at 2 000 characters. A field
  on `Offer` would have loaded instruction text into every listing query; a row is fetched
  only by the assistant path through `select_related("assistant_config")`.
- **The prompt is layered, not concatenated by hand.** `apps/chat/prompts.py` emits
  `AGENCY INSTRUCTIONS`, `AGENCY Q&A` and `OFFER INSTRUCTIONS` blocks after the seven rules.
  Empty layers emit no heading. `DATA` still wins on price, dates, seats and inclusions, and
  the per-offer block overrides agency defaults only where the two disagree.
- **The API contract did not change.** `POST /api/chat/offers/{offer_id}` still accepts the
  same body and returns the same shape. The new content is server-side context, scoped by the
  offer's agency — never accepted from the traveler's request.

**Rejected:**

- *Keeping Decision 032's "no per-offer instructions".* It assumed the offer row already
  carried everything that differs. It does not: airport transfers, a hotel-specific
  cancellation rule or a Ramadan exception are policy that changes per trip but is not a
  field. Repeating those in the global paragraph makes every offer sound like every other.
- *Putting instructions in a new `Offer.assistant_instructions` column.* Simple to write,
  expensive to read: every offer list, sitemap and public query starts carrying a text column
  it does not need. A one-to-one row keeps the hot paths unchanged.
- *One shared textarea with `--- offer: ... ---` delimiters.* It looks cheaper until the
  agency edits the wrong section, or a delimiter appears in the text. Separate rows give
  separate forms, separate caps and separate audit events.
- *Unlimited Q&A entries.* The local model runs with `CHAT_NUM_CTX=8192`. Twenty 800-character
  entries is already a large prompt; an unbounded knowledge base would silently truncate the
  rules or the offer data. The cap is a prompt-budget guard disguised as a product limit.
- *Structured Q&A categories or required fields.* The agency knows the question a traveler
  asks; forcing it into "deposit/cancellation/visa" tabs adds a taxonomy nobody maintains.

**Cost:** the prompt budget is now the feature's real limit. The caps are per field, not a
combined character budget: 20 Q&A entries plus both 2 000-character blocks can approach the
8 192-token context before history, especially in Arabic, so the next change should measure
prompt size rather than add another layer. The unique constraint is exact-match, so "What is
the deposit?" and "what is the deposit?" can both exist. Three editing surfaces (policy, Q&A,
offer) mean more places to keep honest; sharing the assistant page and its navigation is the
mitigation. And the read-side `attributes` allowlist from G1 still applies — this decision does
not make the write side safer.

---

## Template for new entries

```
## NNN — Short title

**Date:** YYYY-MM-DD

What was decided, in one or two sentences.

**Rejected:** the real alternatives, and why each lost.

**Cost:** what this makes harder. (Every decision has one. If you can't name it,
you haven't found the trade-off yet.)
```
