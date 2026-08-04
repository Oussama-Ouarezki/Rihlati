# API Endpoints

> [!success] Built
> Code: `apps/api/src/modules/`. Base path `/v1`. `/health` sits outside the prefix.
> Every endpoint below exists and is covered by tests.

Read [[What the API Is]] first if "endpoint" is still a fuzzy word.

---

## How to read the permission column

| Marking | Meaning |
|---|---|
| **public** | no account needed. Rate limited, and never reads tenant data. |
| **logged in** | any valid access token. This is the **default** — see below. |
| **member** | must belong to the agency in the URL, any role |
| **manager** / **owner** | that role or higher at that agency |
| **verified** | the agency must be verified by Rihlati |
| **admin** | Rihlati staff (`isPlatformAdmin`) |

> [!tip] Deny by default
> `JwtAuthGuard` is global. An endpoint with no decorator requires a logged-in user. You
> cannot forget to protect a route; you can only explicitly open one with `@Public()`.
>
> And any route whose path contains `:agencyId` is automatically tenant-guarded, because the
> guard keys off that parameter alone. See [[Multi-Tenancy]].

---

## Health

| Method | Path | Permission |
|---|---|---|
| GET | `/health` | public |

Returns `{ status: "ok" }` and nothing else. No version, no hostname, no migration state — a
health endpoint is public by necessity and every extra field is free reconnaissance.

---

## Media

| Method | Path | Permission |
|---|---|---|
| GET | `/media/{key}` | public |

Note the missing `/v1`. Both `/health` and `/media` are in the `exclude` list of
`setGlobalPrefix` in `main.ts`, because an image URL gets stored in the database and pasted
into pages — it should not carry an API version that we may want to bump.

This route exists **only in development**, where images are written to local disk. In
production `STORAGE_DRIVER=s3` and the controller returns 404 for everything, because the
object store serves its own URLs. See [[Image Uploads]].

---

## Auth — `/v1/auth`

| Method | Path | Permission | Rate limit |
|---|---|---|---|
| POST | `/auth/register` | public | 5 / hour / IP |
| POST | `/auth/login` | public | 10 / 15 min / IP |
| POST | `/auth/refresh` | public | 60 / hour / IP |
| POST | `/auth/oauth/google` | public | 20 / hour / IP |
| POST | `/auth/logout` | logged in | default |
| GET | `/auth/me` | logged in | default |
| GET | `/auth/me/providers` | logged in | default |
| PATCH | `/auth/me` | logged in | default |
| POST | `/auth/me/avatar` | logged in | 20 / hour |
| DELETE | `/auth/me/avatar` | logged in | default |

`/auth/refresh` is public because an *expired* access token is exactly when you call it — the
refresh token in the body is the credential. Full detail in [[Auth Flow]].

`GET /auth/me` returns the user **and their memberships**, which is how a client knows which
agencies to offer in a switcher.

`PATCH /auth/me` accepts **only** `displayName` and `locale`. It cannot set `avatarUrl` — a
picture is uploaded as bytes and the server names the file, see [[Image Uploads]]. It cannot
change `email` or `phone` either: those are what you log in with, so changing one is an
account-recovery flow (needs the current password and a verification round trip), not a
profile edit. Neither flow exists yet.

`POST /auth/me/avatar` is `multipart/form-data` with a single `file` part, and returns the
updated user. See [[Image Uploads]] for what the server does to that file before storing it.

---

## Offers, public — `/v1/offers`

| Method | Path | Permission |
|---|---|---|
| GET | `/offers` | public |
| GET | `/offers/by-slug/{slug}` | public — counts a view ([[Offer Analytics]]) |
| POST | `/offers/{offerId}/events` | public, 120 / hour / IP — the metrics beacon |
| POST | `/offers/{offerId}/reports` | public, 10 / hour / IP |
| POST | `/tracked-links/resolve` | public, 120 / hour / IP — counts a click |

`/tracked-links/resolve` is a POST because it changes state: a counting endpoint behind a
GET gets fetched by every link previewer and proxy in the chain. The public short URL
`/l/{code}` lives on the **web** app and calls this. See [[Tracked Links]].

`GET /offers` is the marketplace search and the busiest endpoint in the app. Filters:
`q`, `kind`, `minPriceCentimes`, `maxPriceCentimes`, `destinationCountry`, `destinationCity`,
`departureWilayaCode`, `departureFrom`, `departureTo`, `minDurationDays`, `maxDurationDays`,
`agencySlug`, `verifiedAgenciesOnly` (default **true**), `includeFlaggedDuplicates`
(default false), `sort`, `cursor`, `limit`. See [[Search and Filters]].

By slug, not by id: the public URL is `/offres/omra-ramadan-2027…`, which is what SEO and a
link pasted into a WhatsApp group need. Ids stay internal.

Reporting is public so a traveler can flag a scam without signing up — the people most likely
to spot one have not committed to an account yet. **A report never hides an offer, at any
count.** See [[Duplicate and Spam Control]].

---

## Agencies, public — `/v1/agencies`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies` | public |
| GET | `/agencies/by-slug/{slug}` | public |
| GET | `/agencies/by-slug/{slug}/faq` | public |

Only `verified` agencies appear. An unverified agency does not exist publicly — including
its FAQ.

The FAQ list shows only **enabled** entries and is bounded by the 50-per-agency cap, which
is why it carries no cursor. These entries are also the future knowledge base of the
[[Agency Chatbot]].

---

## Inquiries — `/v1/inquiries`

| Method | Path | Permission |
|---|---|---|
| POST | `/inquiries` | **public**, 5 / hour / IP |

The marketplace's one conversion event, and the reason it is public: requiring an account here
would kill it.

Three things about this endpoint are load-bearing:

1. **`agencyId` is derived from the offer, never sent.** Otherwise anyone could post leads into
   any agency's inbox — including a competitor's, filled with garbage.
2. **Contact details are snapshotted onto the lead**, not referenced through an account. The
   inquiry must survive the traveler deleting their account, and must work when they never had
   one.
3. **`consent` must be literally `true`** (`z.literal(true)`, not `z.boolean()`), and the
   consent trail is written in the same insert. "We asked them in March" cannot be
   reconstructed in June.

The same person asking the same agency about the same offer within 6 hours gets the existing
lead back rather than creating a second one — reported as success, because the traveler did
what was asked and telling them "duplicate" only makes them submit again another way.

Returns only `{ id, createdAt, agencyName }`. The lead is never echoed back.

---

## An agency's own offers — `/v1/agencies/{agencyId}/offers`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agencyId}/offers` | member |
| GET | `/agencies/{agencyId}/offers/{offerId}` | member |
| POST | `/agencies/{agencyId}/offers` | manager |
| PATCH | `/agencies/{agencyId}/offers/{offerId}` | manager |
| PATCH | `/agencies/{agencyId}/offers/{offerId}/status` | manager + **verified** |
| DELETE | `/agencies/{agencyId}/offers/{offerId}` | manager |

`agent` cannot create offers — an agent works leads.

Drafting is allowed **before** verification: an agency should be able to prepare its catalogue
while Rihlati checks its licence. `verified` is required only on the status route, where the
offer starts moving towards being seen by a traveler.

### The status route is where the money lives

Status changes follow `OFFER_STATUS_TRANSITIONS` in `packages/shared`. `draft → published` is
not in that table, so **the review step cannot be skipped by anyone**, including admins.

Only Rihlati staff may set `published` or `rejected`. An agency asks (`pending_review`); a
human decides. Without this, "verified agency" is self-service and the badge is worthless.

Publishing is also where the **plan quota** is enforced — counted inside the transaction, from
the database, against the limit in `packages/shared/src/plans.ts`. See
[[Plan Limits and Quotas]]. Returns `409 OFFER_LIMIT_REACHED` with `{ plan, limit, current }`
so the UI can say "5 of 5 used, upgrade".

`DELETE` is a **soft delete**. Leads point at offers, and a traveler's inquiry must keep making
sense after the agency removes the listing.

---

## The CRM — `/v1/agencies/{agencyId}/leads`

| Method | Path | Permission |
|---|---|---|
| GET | `/agencies/{agencyId}/leads` | member |
| GET | `/agencies/{agencyId}/leads/{leadId}` | member |
| POST | `/agencies/{agencyId}/leads` | member |
| PATCH | `/agencies/{agencyId}/leads/{leadId}` | member |
| POST | `/agencies/{agencyId}/leads/{leadId}/notes` | member |

Inbox filters: `q`, `stage`, `quality`, `source`, `offerId`, `assignedToUserId`, `dueOnly`,
`sort`, `cursor`, `limit`.

> [!important] An `agent` sees only the leads assigned to them
> Enforced in the **WHERE clause**, not the UI, and on **both** the list and the detail
> endpoint. Filtering the list but not the detail is the classic version of this bug: the
> agent reads an id from a screenshot and fetches it directly.
>
> An agent passing `?assignedToUserId=<colleague>` cannot widen their view — their filter is
> overwritten. There is a test for each of these.

`PATCH` changes stage, quality label, assignment and values. **Contact details are not
editable** — they are the traveler's own submission, and an agency rewriting them would destroy
the meaning of the consent record.

Assigning leads to staff is gated on the plan (`leadAssignment`) and returns
`402 FEATURE_NOT_IN_PLAN`. The assignee must be a member of the same agency — otherwise an
agency could assign a lead to an outsider's user id, and that person's inbox would start
returning rows from a tenant they do not belong to.

Changing a lead's quality to `spam` or `troll` writes a dedicated [[Audit Log]] entry — it is a
judgement about a real person that can later cost them access. See [[Client Quality Labels]].

The first move off `new` stamps `firstRespondedAt`, once, and nothing can set it back.
Response time is the metric agencies are sold on, so it is measured rather than self-reported.

---

## Agency management — `/v1/agencies`

| Method | Path | Permission |
|---|---|---|
| POST | `/agencies` | logged in, 3 / hour / IP |
| GET | `/agencies/{agencyId}` | member |
| PATCH | `/agencies/{agencyId}` | manager |
| POST | `/agencies/{agencyId}/submit-for-review` | owner |
| POST | `/agencies/{agencyId}/logo` | manager, 20 / hour |
| DELETE | `/agencies/{agencyId}/logo` | manager |
| GET | `/agencies/{agencyId}/faq` | member (sees disabled entries too) |
| POST | `/agencies/{agencyId}/faq` | manager |
| PATCH | `/agencies/{agencyId}/faq/{faqId}` | manager |
| DELETE | `/agencies/{agencyId}/faq/{faqId}` | manager |
| GET | `/agencies/{agencyId}/analytics/offers` | member + **plan gate** (`analytics`) |
| GET | `/agencies/{agencyId}/departures` | member |
| GET | `/agencies/{agencyId}/offers/{offerId}/manifest` | member |
| POST | `/agencies/{agencyId}/reservations` | member |
| PATCH | `/agencies/{agencyId}/reservations/{id}` | member |
| POST | `/agencies/{agencyId}/reservations/{id}/trip-link` | member |
| GET | `/agencies/{agencyId}/offers/{offerId}/milestones` | member |
| POST | `/agencies/{agencyId}/offers/{offerId}/milestones` | manager |
| POST | `/agencies/{agencyId}/offers/{offerId}/milestones/reorder` | manager |
| PATCH | `/agencies/{agencyId}/offers/{offerId}/milestones/{milestoneId}` | manager |
| POST | `/agencies/{agencyId}/offers/{offerId}/milestones/{milestoneId}/completion` | member |
| DELETE | `/agencies/{agencyId}/offers/{offerId}/milestones/{milestoneId}` | manager |
| GET | `/agencies/{agencyId}/milestones/{milestoneId}/check-ins` | member |
| PATCH | `/agencies/{agencyId}/milestones/{milestoneId}/check-ins/{reservationId}` | member |
| GET | `/agencies/{agencyId}/tracked-links` | member |
| POST | `/agencies/{agencyId}/tracked-links` | manager + **plan gate** (count) |
| PATCH | `/agencies/{agencyId}/tracked-links/{linkId}` | manager |
| DELETE | `/agencies/{agencyId}/tracked-links/{linkId}` | manager |

The manifest routes are member-level on purpose — bus check-in is agent work. Details and
the reasoning in [[Trip Manifest]].

The milestone **editing** routes need `manager` — same bar as editing the offer they belong
to. Reading the programme and **checking a family in at a checkpoint** are both member-level:
an agent needs to see the plan, and check-in at a checkpoint is exactly the same kind of
bus-side work as the manifest. `GET .../check-ins` on a milestone with `checkpointType: none`
returns `422 VALIDATION_FAILED` — it isn't a checkpoint, there's nothing to list. Full design,
including the mandatory/optional default rule, in [[Trip Programme]].

`POST .../milestones/{id}/completion` is the odd one out: a **write that is member-level**.
Ticking a step off is bus-side work done by the accompagnateur — usually the most junior
person on the trip — so gating it on `manager` would mean passing a phone around at 4am. It
takes `{ isDone: boolean }` rather than being a one-way "done", because the tap that matters
right after a wrong tap is the undo. One tick advances the "vous êtes ici" marker on every
traveler's map at once.

`POST .../reservations/{id}/trip-link` mints this family's `/mon-voyage/{code}` link if they
haven't got one, and is **idempotent** — an existing code is returned, never rotated. Rotating
would silently break a link already sitting in the family's WhatsApp thread, and that failure
lands at 4am on the person who needs it most.

The analytics endpoint returns the daily views/clicks/inquiries series — zero-filled, so a
chart can plot it as-is. Collection itself is never gated; see [[Offer Analytics]] for why.

---

## The traveler's trip page — `/v1/trips`

| Method | Path | Permission |
|---|---|---|
| GET | `/trips/{code}` | **public**, 30 / hour / IP |

The one endpoint in the API that is **not scoped by a session's tenant** — because there is no
session. The caller is a family with a WhatsApp link and no account, which is deliberate:
a [[Lead]] becomes a [[Trip Manifest|Reservation]] without anyone signing up.

What replaces the tenant scope is the code itself. `Reservation.publicCode` is 128 random bits
and globally unique, so it names exactly one reservation across every agency — there is no id
to swap for a neighbour's. **The code is the authorization.** That holds only while two things
stay true, and both are enforced in code:

1. **The rate limit is the security control**, not decoration. "Unguessable" without a limit
   means "unguessable at whatever rate the attacker's bandwidth allows."
2. **The response is a hand-built allow-list** — never a spread of the row. The test
   `apps/api/test/trips.e2e.test.ts` asserts the exact key set, so a column added to
   `reservations` next month fails the build rather than shipping to a forwarded link.

A wrong code, a cancelled booking, a deleted offer and a closed agency all return the same
`404`. Distinguishing them would make the endpoint an oracle that confirms which codes exist.

Full design and the list of what this page must never contain: [[Trip Programme]] §5.

`POST /agencies` makes the caller the `owner`, in one transaction with the agency — an agency
with no owner would be unreachable by everyone including its creator.

**One agency per person, for now.** Not a technical limit: without it, one signup creates fifty
agencies and fifty times the free offer quota, which defeats the quota entirely.

`GET /agencies/{agencyId}` returns live quota usage:
`limits: { publishedOffers: { used, limit }, seats: { used, limit } }`.

Editing the RC/NIF/licence of a **verified** agency sends it back to `pending_review`.
Otherwise the flow is: get verified with a real RC, then quietly swap in a different one and
keep the badge.

---

## Every error looks the same

```json
{
  "error": {
    "code": "OFFER_LIMIT_REACHED",
    "message": "…",
    "fields": { "slug": ["validation.slugTaken"] },
    "details": { "plan": "free", "limit": 5, "current": 5 },
    "requestId": "0198a0b1-…"
  }
}
```

The **code** is what clients switch on — the message is for developers, and the app is Arabic
and French, so the API has no business choosing which one a user reads. Full list in
`packages/shared/src/errors.ts`.

`fields` follows the same rule one level down: each entry is a **key**, not a sentence. The
client looks `validation.slugTaken` up in its own message file and prints Arabic, French or
English. The keys are listed in `packages/shared/src/validation-messages.ts`, and a test fails
if a schema emits one that no locale translates. See [[Validation at the Boundary]].

`requestId` is also returned as the `X-Request-Id` header and appears in every log line for
that request. A user quotes it, you find the exact failure. That is what makes rule #4 usable.

> [!warning] `NOT_FOUND` means both "does not exist" and "belongs to another agency"
> Identical status, code and message. Any difference turns the API into a tool for
> enumerating other agencies' data. There is a test asserting the two responses match exactly.

`INSUFFICIENT_ROLE` **is** a 403, though — a member already knows the agency exists, so hiding
the reason would only confuse them.

---

## Open questions — yours to decide

- **Should an `agent` see unassigned leads?** Right now they see only what is assigned to them,
  so a brand-new inquiry is invisible until a manager assigns it. For a two-person agency that
  may be friction rather than safety.
- **Should travelers be able to list their own inquiries?** There is no `/me/inquiries` yet.
  It needs a decision about what a traveler may see of an agency's CRM state — probably
  nothing beyond "received".
- **Staff invitations are not built.** The schema and `inviteMemberSchema` exist; the endpoint
  does not, because it needs email or SMS delivery to be useful.
- **The admin back-office is not built** — verification, duplicate resolution and report triage
  are direct database work today. Fine now, not fine at 50 agencies.
- **Saved offers** (`SavedOffer`) has a table and no endpoints yet.

---

Related: [[Auth Flow]] · [[Multi-Tenancy]] · [[Search and Filters]] ·
[[Plan Limits and Quotas]] · [[Duplicate and Spam Control]] · [[Client Quality Labels]] ·
[[Validation at the Boundary]] · [[Audit Log]] · [[The Seven Rules]]
