# API Endpoints

> [!success] Built
> Code: `apps/*/api.py`, mounted in `config/api.py`. Base path **`/api`**.
> Interactive docs at **`/api/docs`**, generated from the same schemas that validate the
> requests — so this note and the code cannot disagree for long about *shapes*. What this
> note adds is the part OpenAPI cannot express: **why** each permission is where it is.

Read [[What the API Is]] first if "endpoint" is still a fuzzy word.

> [!info] Django vs NestJS
> The NestJS repo versions its API at `/v1` and documents it by hand. Here the version lives
> in `NinjaAPI(version="1.0.0")` and the document is generated. That is the whole argument for
> [[One Rule, Two Entry Points|Django Ninja over DRF]]: the schema is the contract, not a
> second description of it.

---

## How to read the permission column

| Marking | Meaning | In code |
|---|---|---|
| **public** | no account needed | `auth=None` on the route |
| **logged in** | any valid access token or session | the default — nothing written |
| **member** | belongs to the agency in the URL, any role | `require_membership(user, agency_id)` |
| **manager** / **owner** | that role or higher at that agency | `require_membership(..., Membership.MANAGER)` |
| **staff** | Rihlati staff | `require_staff(request)` |

> [!tip] Deny by default, and how to check it in one command
> `auth=API_AUTH` is set once, on the `NinjaAPI` object in `config/api.py`. A route that says
> nothing is a **locked** route. The only exit is writing `auth=None`, which means the entire
> public surface of this application is one grep:
>
> ```bash
> grep -rn "auth=None" apps/*/api.py
> ```
>
> Eleven lines today. If that list grows and nobody can say why, that is the bug.
> Compare: in the NestJS repo the same job is done by a global `JwtAuthGuard` and `@Public()`.
> Same inversion, different spelling. See [[Authentication vs Authorization]].

Membership is checked in a plain function call at the top of the handler, not in a decorator.
Why that is a deliberate loss as well as a gain is written up in
[[The Seven Hops of a Request]] §"where the guard went".

---

## Auth — `/api/auth`

| Method | Path | Permission |
|---|---|---|
| POST | `/auth/login` | **public** |
| POST | `/auth/refresh` | **public** |
| POST | `/auth/logout` | logged in |
| GET | `/me` | logged in |

`/auth/refresh` is public because an *expired* access token is exactly when you call it — the
refresh token in the body is the credential. Full mechanics in [[Auth Flow]].

**Login answers the same way for a wrong password and an unknown username.** Distinguishing
them is a free account-enumeration oracle: an attacker learns which of 10 000 guessed
usernames exist without ever logging in.

**Logout revokes every refresh token the user holds, not just the one presented.** A partial
logout that leaves a stolen token alive is worse than no logout at all, because the person
clicking it now believes they are safe.

`GET /me` returns the user **and their memberships**, which is how a client knows which
agencies to offer in a switcher. The roles come from the database on every call — they are
deliberately *not* in the token, so removing someone bites immediately instead of at the next
token expiry.

---

## Public catalogue — `/api/offers`

| Method | Path | Permission |
|---|---|---|
| GET | `/offers` | **public** |
| GET | `/offers/{offer_id}` | **public** — counts a view |
| POST | `/offers/{offer_id}/report` | **public** |
| GET | `/agencies/{agency_id}/reviews` | **public** |
| POST | `/reviews` | **public** |
| GET | `/consent-text` | **public** |

`GET /offers` is the marketplace search and the busiest endpoint in the app. Filters live in
`OfferFilters` in `apps/offers/api.py`: `q`, `kind`, `wilaya`, `price_min`, `price_max`,
`date_from`, `date_to`, `sort`, `limit`, `offset`. See [[Search and Filters]].

> [!important] `limit` is capped in the schema, not in the handler
> `limit: int = Field(20, ge=1, le=50)`. An unbounded `limit` is a one-request denial of
> service, and the cap belongs somewhere it cannot be forgotten by the next person who writes
> a list endpoint. The same `OfferFilters` class is what the HTML search page parses its query
> string with, so a bad `sort=` fails identically in both places.

`sort=quality` orders by `quality_score`, **not** featured-first. A paid slot that outranks a
better listing is how a marketplace loses the travelers the agencies are paying to reach.

Reporting is public so a traveler can flag a scam without signing up — the people most likely
to spot one have not committed to an account yet. **A report never hides an offer, at any
count.** See [[Duplicate and Spam Control]].

`GET /consent-text` exists so the checkbox label a client renders and the
`consent_text_version` the server stores cannot drift apart. See [[Lead]].

**Reviews require a lead that reached a terminal state.** `ReviewIn` has no `agency_id` — it
comes from the lead. A client that names the agency it is rating can rate one it never dealt
with, which on a marketplace where agencies in the same wilaya know each other by name is a
weapon. See [[Agency Ratings]].

---

## Inquiries — `/api/inquiries`

| Method | Path | Permission |
|---|---|---|
| POST | `/inquiries` | **public** |

The marketplace's one conversion event, and the reason it is public: requiring an account here
would kill it. Note the asymmetry — **write-open, read-locked**. Anyone may create a lead;
only the agency that received it may ever read one.

Four things about this endpoint are load-bearing:

1. **`agency_id` is derived from the offer, never sent.** Otherwise anyone could post leads
   into any agency's inbox — including a competitor's, filled with garbage.
2. **The offer is looked up through `Offer.publicly_visible()`, not `Offer.objects`.** An
   inquiry against a draft, an archived offer, or an unverified agency's listing must 404, or
   the "verified agencies only" promise is decorative.
3. **`consent` must be literally `True`**, and the consent trail is written in the same insert:
   timestamp, text version, hashed IP, user agent. "We asked them in March" cannot be
   reconstructed in June.
4. **The response is `{"detail": …}` and nothing else.** Echoing the created row back would let
   anyone POST a plausible payload and read an id they could then try elsewhere.

---

## An agency's own offers — `/api/agencies/{agency_id}/offers`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}/offers` | member |
| POST | `/agencies/{agency_id}/offers` | manager |
| PUT | `/agencies/{agency_id}/offers/{offer_id}` | manager |
| POST | `/agencies/{agency_id}/offers/{offer_id}/publish` | manager + **verified** |
| POST | `/agencies/{agency_id}/offers/{offer_id}/archive` | manager |
| GET | `/agencies/{agency_id}/offers/{offer_id}/metrics` | member |
| GET | `/agencies/{agency_id}/quota` | member |

An `agent` cannot create offers — an agent works leads.

Drafting is allowed **before** verification: an agency should be able to prepare its catalogue
while Rihlati checks its licence. Verification is required only on `publish`, where the offer
starts moving towards being seen by a traveler.

> [!important] What `OfferIn` leaves out is the security
> The schema has no `agency`, `slug`, `status`, `is_featured`, `quality_score`, `fingerprint`,
> `duplicate_status` or `report_count`. **A field absent from the schema is a field a client
> cannot set** — and because `Strict` sets `extra="forbid"`, sending one is a 422 rather than a
> silent no-op. An agency that could PUT `is_featured: true` would promote itself for free.
> See [[Validation at the Boundary]].

Publishing is where the **plan quota** is enforced, counted from the database inside the
transaction. It returns **409**, not 403: the caller is allowed to publish offers, there is
just no room. 403 would tell them to go find a permission they already have. See
[[Plan Limits and Quotas]].

---

## Programme — the milestone routes

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}/offers/{offer_id}/milestones` | member |
| POST | `/agencies/{agency_id}/offers/{offer_id}/milestones` | manager |
| PUT | `/agencies/{agency_id}/milestones/{milestone_id}` | manager |
| DELETE | `/agencies/{agency_id}/milestones/{milestone_id}` | manager |
| POST | `/agencies/{agency_id}/offers/{offer_id}/milestones/reorder` | manager |
| POST | `/agencies/{agency_id}/offers/{offer_id}/milestones/duplicate-day` | manager |
| POST | `/agencies/{agency_id}/offers/{offer_id}/milestones/copy-from` | manager |
| POST | `/agencies/{agency_id}/milestones/{milestone_id}/complete` | member |
| POST | `/agencies/{agency_id}/milestones/{milestone_id}/uncomplete` | member |

Editing the programme needs `manager` — the same bar as editing the offer it belongs to.

`complete` / `uncomplete` are the odd ones out: **writes that are member-level**. Ticking a
step off is bus-side work done by the accompagnateur, usually the most junior person on the
trip, so gating it on `manager` would mean passing a phone around at 4am. And `uncomplete`
exists because the tap that matters right after a wrong tap is the undo.

`reorder` re-fetches every milestone id **inside the tenant scope** before writing. A client
sending another agency's milestone id must move nothing, not everything.

`copy-from` is the one place in this API where a **client sends the id of tenant data**
(`source_offer_id`). It is scoped exactly like the target: you may copy from *your* offers
only. Otherwise this endpoint reads any agency's programme, which is the thing agencies
compete on. Copies deliberately drop `completed_at` — **a copy is a plan, not something that
already happened**, and inheriting a tick would park the "vous êtes ici" marker somewhere the
group has never been.

Both bulk copies refuse past `MILESTONE_MAX_PER_OFFER` (200) with a 409. That is a limit on
one programme's sanity, not a plan gate.

Full design in [[Trip Programme]].

---

## The manifest and the checkpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}/offers/{offer_id}/reservations` | member |
| POST | `/agencies/{agency_id}/reservations` | member |
| PATCH | `/agencies/{agency_id}/reservations/{reservation_id}` | member |
| GET | `/agencies/{agency_id}/offers/{offer_id}/checkpoints` | member |
| GET | `/agencies/{agency_id}/milestones/{milestone_id}/checkpoint` | member |
| POST | `/agencies/{agency_id}/milestones/{milestone_id}/checkpoint/{reservation_id}` | member |

Member-level throughout, on purpose: bus check-in is agent work. Reasoning in
[[Trip Manifest]].

Creating a reservation decrements `seats_left`; cancelling one gives the seats back, and
un-cancelling takes them again. Seats move in the same transaction as the reservation, because
a manifest that disagrees with the seat count is a family without a seat.

`GET .../checkpoint` **creates the check-in rows lazily**, one per non-cancelled reservation,
the first time the screen is opened. That is what lets a checkpoint invented mid-trip need no
backfill, and a booking made this morning simply appear.

---

## The CRM — `/api/agencies/{agency_id}/leads`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}/leads` | member |
| GET | `/agencies/{agency_id}/leads/{lead_id}` | member |
| PATCH | `/agencies/{agency_id}/leads/{lead_id}` | member |
| GET | `/agencies/{agency_id}/pipeline` | member |
| GET | `/agencies/{agency_id}/leads/{lead_id}/notes` | member |
| POST | `/agencies/{agency_id}/leads/{lead_id}/notes` | member |
| GET | `/agencies/{agency_id}/leads/{lead_id}/activity` | member |
| GET | `/agencies/{agency_id}/tags` | member |
| POST | `/agencies/{agency_id}/tags` | manager |
| POST | `/agencies/{agency_id}/leads/{lead_id}/tags/{tag_id}` | member |
| DELETE | `/agencies/{agency_id}/leads/{lead_id}/tags/{tag_id}` | member |

`PATCH` changes stage, quality label, assignment and estimated value. **Contact details are
not editable** — they are the traveler's own submission, and an agency rewriting them would
destroy the meaning of the consent record attached to it.

The assignee must be a member of the same agency. Otherwise an agency could assign a lead to
an outsider's user id, and that person's inbox would start returning rows from a tenant they
do not belong to.

The first move off `new` stamps `first_responded_at`, once, and nothing sets it back. Response
time is the metric agencies are sold on, so it is measured rather than self-reported.

Notes and activity are **two tables on purpose**: notes are editable working memory, activity
is append-only and written by the system. If staff could edit the timeline it would be
worthless as evidence in a dispute; if the system wrote into notes, real notes would drown in
noise. See [[Client Quality Labels]] and [[Audit Log]].

`GET /pipeline` is a single grouped aggregate, not one count per stage. Seven round trips to
render one header is the kind of thing that is invisible on a laptop and obvious on a phone in
Ghardaïa.

---

## The client directory — `/api/agencies/{agency_id}/clients`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}/clients` | member |
| POST | `/agencies/{agency_id}/clients` | member |
| GET | `/agencies/{agency_id}/clients/{client_id}` | member |
| PATCH | `/agencies/{agency_id}/clients/{client_id}` | member |
| GET | `/agencies/{agency_id}/clients/{client_id}/notes` | member |
| POST | `/agencies/{agency_id}/clients/{client_id}/notes` | member |
| POST | `/agencies/{agency_id}/clients/{client_id}/tags/{tag_id}` | member |
| DELETE | `/agencies/{agency_id}/clients/{client_id}/tags/{tag_id}` | member |

A client is one person per agency, identified by `phone_e164`. `GET` accepts the same `q`,
`filter`, `limit` and `offset` as the HTML directory, and the two share `ClientQuerySet` so
"à venir" and "répété" cannot mean two different things at two doors. See [[Client]].

`POST` exists for the walk-in who never filled the public form; it accepts a first note in the
same request. A phone number already used in the agency is a `409`, not a `500` from the unique
constraint. `PATCH` changes name and phone only — status, quality and callbacks stay on the
lead, because they describe a deal rather than a person.

The detail response carries the person's leads, reservations, notes and tags, so a client app
gets one screen's worth of data in one request. Deleting a client unlinks its leads and
reservations (`SET_NULL`); it never deletes the history.

---

## Agency management and tracked links

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agency_id}` | member |
| PUT | `/agencies/{agency_id}` | owner |
| POST | `/agencies/{agency_id}/submit-for-review` | owner |
| GET | `/agencies/{agency_id}/audit` | owner |
| GET | `/agencies/{agency_id}/tracked-links` | member |
| POST | `/agencies/{agency_id}/tracked-links` | manager |
| PUT | `/agencies/{agency_id}/reviews/{review_id}/reply` | manager |

`AgencyProfileIn` has no `status`, no `plan`, no `credit_balance_centimes`. **An agency that
could PATCH its own `status` would verify itself**, and the badge is the only reason a traveler
hands their phone number to a stranger.

Submitting for review is `owner`, not `manager`: it is a legal declaration about the company,
and an agent hired last week should not be able to make it. The HTML page enforces the same
split — see `agency_settings` in `apps/pages/views.py`.

Replying to a review is `manager` and **there is no delete**. A calm public answer to a bad
review is the single most useful thing an agency can do here, and the most trusted signal a
reader gets. See [[Agency Ratings]].

Tracked links let an agency answer "which Facebook post actually worked?" — see
[[Tracked Links]].

---

## The traveler's own trip — `/api/my-trip/{code}`

| Method | Path | Permission |
|---|---|---|
| GET | `/my-trip/{code}` | **public** |

The one endpoint in the API that is **not scoped by a session's tenant** — because there is no
session. The caller is a family with an SMS link and no account, which is deliberate: a [[Lead]]
becomes a reservation without anyone signing up.

What replaces the tenant scope is the code itself. `Reservation.public_code` is 128 random bits
from `secrets.token_hex(16)` and globally unique, so it names exactly one reservation across
every agency — there is no id to swap for a neighbour's. **The code is the authorization.**

That is only acceptable while the page shows nothing its holder does not already know: their
own booking, and a programme the agency publishes anyway. It must **never** show the passenger
list, what anyone paid, or a CRM note. `MyTripOut` is a hand-built allow-list with that
sentence written above it, and `apps/pages/tests.py` asserts a second family's name and phone
number are absent from the rendered page. If one of those fields ever needs to appear, this
endpoint needs a real login — not a longer code.

A wrong code, a cancelled booking and a closed agency all return the same `404`.

> [!warning] Not yet built: a rate limit
> "Unguessable" without a request limit means "unguessable at whatever rate the attacker's
> bandwidth allows". 128 bits makes that a very long wait, but the limit is still the control
> and it is missing here. Listed in the open questions below.

---

## The per-offer assistant — `/api/chat/offers/{offer_id}`

| Method | Path | Permission |
|---|---|---|
| POST | `/chat/offers/{offer_id}` | **public** |

The traveler asks a question about one listing and gets an answer grounded in that listing's
row, its programme, and its agency's profile. Public because travelers have no account;
**throttled at 30 messages per hour per IP** and capped at 12 turns per conversation.

The body has exactly two fields:

```json
{"message": "le visa est-il inclus ?", "token": "…"}
```

`token` is absent on the first turn. The response carries it back, and it is the only
credential for the rest of the conversation:

```json
{"token": "…", "reply": "Oui, le visa est inclus.", "related_offers": [
  {"id": "…", "url": "/offers/…/", "title": "…", "price_centimes": 4200000,
   "departure_date": "2026-12-27", "seats_left": 12}
]}
```

Four properties matter more than the shape:

1. **The offer is the scope, and it is resolved like every public read.**
   `Offer.publicly_visible()` — a draft, an archived listing, or an unverified agency's offer
   is a 404 here too. The assistant is not a side door onto a hidden listing.
2. **The token names one conversation, not one user.** 128 random bits from
   `secrets.token_hex(16)`, the same capability-URL pattern as `Reservation.public_code`. A
   token from another offer, a guessed token and an expired token all return the same 404.
3. **History is server-side.** The browser never sends its transcript; the server rebuilds
   the last six turns from `ChatMessage` rows. A client can therefore influence only the
   newest question, never a forged assistant turn.
4. **Related offers are chosen by the server.** The same same-agency rows that fed the model
   become the cards, with URLs built by `reverse()`. The model never selects a slug or a
   price. No sibling offers means an empty list.

The model is local (Ollama) in v1, behind `apps/chat/llm.py`; if it is down the route returns
**503 `UNAVAILABLE`** and writes nothing, so a retry starts from a clean turn. See
[[Agency Chatbot]] and [[Decision Log]] 031.

---

## The back office — `/api/admin`

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/verification-queue` | **staff** |
| POST | `/admin/agencies/{agency_id}/decision` | **staff** |
| POST | `/admin/agencies/{agency_id}/suspend` | **staff** |
| GET | `/admin/reconcile-ratings` | **staff** |

This is the **first deliberately cross-tenant surface in the app**, and it deserves the
paragraph.

Every other endpoint in this document answers *"what may this agency see?"*, enforced by
`agency_id` in a `WHERE` clause ([[Multi-Tenancy]]). These answer *"what may Rihlati see?"*,
and the answer is everything: the queue returns the registre de commerce, the NIF and the
licence number of agencies the caller has no relationship with. That is the job — you cannot
review a stranger's documents without reading them.

Which means the whole protection is `require_staff(request)`, one boolean read **from the
database on every request**, never from a token claim. A bug there exposes every agency at
once, where a bug in a tenant-scoped query exposes one.

**Three rules the endpoints enforce:**

1. **Only a legal transition is accepted.** `Agency.STATUS_TRANSITIONS` is the table; an agency
   someone else already decided gets a 409. See [[Agency Verification]].
2. **A decision requires a written note, minimum five characters — including an approval.**
   A badge nobody had to justify is a badge that means nothing, and six months later that note
   is the only record of why this agency passed.
3. **The queue is ordered by `submitted_for_review_at`, oldest first.** A queue that is not
   FIFO quietly means whoever complains loudest gets reviewed first.

The decision writes an [[Audit Log]] row **in the same transaction** as the status change, with
`decided_by` set. That is exactly the record you want when a verified agency later turns out to
be fraudulent, and exactly the one that cannot be reconstructed afterwards.

`GET /admin/reconcile-ratings` is the other half of the denormalised counter on `Agency`:
`rating_sum` and `rating_count` are fast to read and **will** eventually disagree with the
reviews table. A cached number with no reconciliation job is a number that lies, so the job
exists from the start rather than after someone notices. See [[Agency Ratings]].

Django's own `/admin/` is a second door onto verification, and it goes through the same state
machine and writes the same audit row — see `apps/accounts/admin.py`. The admin is never a way
around a rule.

---

## Every error looks the same

```json
{
  "code": "VALIDATION_FAILED",
  "details": {"phone_e164": ["Numéro algérien attendu, au format +213…"]},
  "requestId": "a1b2c3d4e5f60718"
}
```

The **code** is what clients switch on — the sentence is for developers, and the app is Arabic
and French, so the API has no business choosing which one a user reads. The mapping lives in
`STATUS_TO_CODE` in `apps/common/errors.py`.

`details` is keyed by field name, so a form can highlight the exact input. A single
"Bad request" is technically correct and practically useless.

`requestId` is also the `X-Request-Id` header and appears in every log line for that request.
A user quotes it, you find the exact failure. That is what makes rule #4 usable.

> [!warning] `NOT_FOUND` means both "does not exist" and "belongs to another agency"
> Identical status, code and body. Any difference turns the API into a tool for enumerating
> other agencies' data. `apps/offers/tests.py` asserts the two responses match.

One deliberate exception: passing an `agency_id` in the **path** that you are not a member of
returns **403**, not 404. You already know that agency exists — you typed its id — so hiding
the reason would only confuse a member who lost a role. The 404 rule protects *rows*, not
agency ids. This asymmetry is the kind of thing that looks like an inconsistency until someone
writes down why, so: this is why.

**Anything not handled above is left to Django.** An unhandled 500 is an incident, and
swallowing it into a tidy envelope is how an incident becomes a mystery.

---

## Open questions — yours to decide

- **Rate limiting is partial.** `/auth/login`, `/auth/refresh`, `/inquiries` and the assistant
  are throttled; `/offers/{id}/report` and `/my-trip/{code}` still want one, and each wants a
  different limit. This remains a launch blocker, not a nice-to-have.
- **Should an `agent` see every lead, or only the ones assigned to them?** Today they see all
  of their agency's. For a two-person agency that is right; at fifteen people it probably is
  not. The NestJS repo took the other side — assigned-only, enforced in the `WHERE` clause.
- **Registration is not an endpoint here.** Accounts are made in the Django admin or the shell.
  See [[Accounts]] for the chicken-and-egg reasoning and what a real signup flow would need.
- **Staff invitations are not built.** Adding a colleague means a `Membership` row created by
  hand.
- **Nobody is told when an agency joins the verification queue.** It sits there until staff
  open the page — fine for one person checking daily, wrong the first week it is missed.
- **Image uploads are URL-only.** An agency pastes a link; nothing is stored or resized here.
  See [[Image Uploads]] for what changes when that stops being acceptable.

---

Related: [[Auth Flow]] · [[Multi-Tenancy]] · [[Search and Filters]] ·
[[Plan Limits and Quotas]] · [[Duplicate and Spam Control]] · [[Client Quality Labels]] ·
[[Validation at the Boundary]] · [[Audit Log]] · [[Trip Programme]] · [[Trip Manifest]] ·
[[The Seven Rules]]
