# What the API Is

You said you'd understand the rest once you understood this part. You're right — so this
note is the one to read twice.

---

## The one-sentence version

**The API is a program that sits in front of the database and answers questions, but only
after checking whether you're allowed to ask.**

That's it. Everything else is detail.

---

## Why it has to exist

Imagine the website talked to the database directly. To show an agency its leads, the
website would say: "give me all rows from `leads` where `agency_id = 'agency-42'`."

That sentence is written *in the browser*. On the user's computer. Which they control.

So they open the developer tools, change `agency-42` to `agency-43`, and read a competitor's
entire client list. Nothing stopped them, because the only thing that decided which agency
to ask about was code running on their own machine.

**That's the marketplace-killer bug, and this is where it comes from.** The fix isn't to hide
the code better — you can't, it's on their computer. The fix is that the browser never gets
to name the agency at all.

With an API:

1. The browser says: "give me my leads." That's the whole request.
2. The API looks at the session or token attached to the request, and figures out *for
   itself* which agency this user belongs to.
3. The API asks the database for that agency's leads only.
4. The browser gets the answer.

The user can tamper with step 1 all they like. There's nothing in it to tamper with. See
[[Multi-Tenancy]] for how this is enforced structurally rather than by remembering.

> [!info] "But Rihlati's URLs *do* contain the agency id"
> They do: `/api/agencies/{agency_id}/offers`. That looks like exactly the mistake above,
> and it is worth understanding why it isn't.
>
> The id in the URL is not *trusted*, it is *checked*. `require_membership(request.user,
> agency_id)` asks the database whether this user has a `Membership` row for that agency.
> If not, the request dies before any query runs. The URL is allowed to say **which** of your
> agencies you mean; it is never allowed to say **that** it is yours.
>
> This shape exists because a real person can belong to two agencies — an accountant, a
> group owner — and "my leads" is then ambiguous. Naming the tenant in the URL and verifying
> it beats inventing a "currently selected agency" hidden in a session, which is one stale
> cookie away from showing someone the wrong inbox.

---

## The shape of one request

Someone submits an inquiry on an Omra offer:

```
   Browser                   Django                       Database
      │                        │                             │
      │  POST /api/inquiries   │                             │
      │  {offer_id, full_name, │                             │
      │   phone_e164, message, │                             │
      │   consent}             │                             │
      │───────────────────────►│                             │
      │                        │ 1. auth=None — public, on   │
      │                        │    purpose, and pinned by   │
      │                        │    a test                   │
      │                        │ 2. Strict schema: unknown   │
      │                        │    fields rejected, types   │
      │                        │    parsed, phone checked    │
      │                        │ 3. consent ticked? no →     │
      │                        │    422, nothing written     │
      │                        │ 4. does that offer exist    │
      │                        │    in publicly_visible()?   │
      │                        │────────────────────────────►│
      │                        │◄────────────────────────────│
      │                        │ 5. create the lead, owned   │
      │                        │    by THAT offer's agency,  │
      │                        │    with a consent trail     │
      │                        │────────────────────────────►│
      │  201 {"detail": "..."} │                             │
      │◄───────────────────────│                             │
```

Every step is a rule the browser cannot skip, because the browser isn't the one doing them.

Three things in that diagram are worth stopping on.

**Step 4 uses `Offer.publicly_visible()`, not `Offer.objects`.** If it used the plain manager,
you could file an inquiry against a *draft* offer, or one belonging to an unverified agency —
and the promise "verified agencies only" would be decorative. One queryset, four callers,
zero chances to forget a condition.

**Step 5 derives the agency.** The traveler is never asked which agency to send the lead to:

```python
lead = Lead(agency=offer.agency, offer=offer, ...)
```

And `LeadIn` — the input schema — simply has no `agency_id` field, nor `status`, nor
`quality`, nor `source`. A field that isn't in the schema is a field a client cannot send, and
`Strict` rejects the whole request if you invent one. That is a stronger guarantee than a
handler remembering to ignore it.

**The response is a confirmation, not the lead.** Echoing the created row back would let
anyone POST a plausible payload, read the returned id, and try it elsewhere. The traveler has
no use for the id; the agency reads the lead from its inbox.

This is traced hop by hop in [[The Seven Hops of a Request]].

---

## The layers inside the API

This is the part that transfers to every backend you will ever write, so read it slowly.

```
config/urls.py  ──►  config/api.py  ──►  Router  ──►  Handler  ──►  Model / helper  ──►  ORM  ──►  Database
   the map          the front door      grouping     the door        the brain          the hands
```

**`config/urls.py`** — the map. `/api/` goes to Ninja, everything else to `apps.pages`.
Contains no logic at all.

**`config/api.py`** — the front door. One `NinjaAPI` instance, with `auth=API_AUTH` set once
for everything. This file has no business logic and is the most important security file in
the project. That's not a contradiction — see [[Authentication vs Authorization]].

**Router** — a grouping of related endpoints, living in the app that owns them
(`apps/leads/api.py`). Mounted onto the API in `config/api.py`, so the URL layout is readable
in one place.

**Handler** — the door for one endpoint. Reads the request, checks membership, and returns a
response. Should be boring.

**Model / helper module** — the brain. "An agency on the free plan can't publish a sixth
offer." "Travelers only ever see published offers from verified agencies." Rules live here.
`Offer.publicly_visible()` and `apps/common/quotas.py` are exactly this: business rules with
names, that any caller can reuse and no caller can get subtly wrong.

**ORM** — the hands. Actually reads and writes rows.

Why bother splitting? Because "free plan caps at 5 published offers" must hold whether the
request came from the website, the API, the Django admin, a management command, or a bulk
import. A rule that lives in a handler has to be written five times, and will be wrong in
three of them.

> [!important] Django vs NestJS — the one you should actually notice
> NestJS makes you write a **controller** and a **service** as separate classes, always.
> Django Ninja gives you one function and no opinion about where business logic goes.
>
> Nest's split is training wheels: it forces the good habit and adds ceremony to trivial
> endpoints. Django's freedom is a loaded gun — the path of least resistance is to put
> everything in the handler, and a codebase where every handler has 80 lines of business
> logic is the single most common way a Django project rots.
>
> **The rule here:** a handler may do HTTP things — parse, authorize, serialize, respond. The
> moment it starts *deciding* something about the business, that decision moves to a model
> method or a module in `apps/common/`. `Offer.publicly_visible()`,
> `Agency.can_transition_to()` and `assert_can_publish()` are the pattern; copy them.
>
> Same principle, different enforcement. Nest enforces it with structure. Django enforces it
> with your judgement, which is why it's written down here.

---

## What "REST" means, briefly

A convention for naming things. The URL names a *thing*; the HTTP verb names the *action*.

| Verb | URL | Means |
|---|---|---|
| `GET` | `/api/offers` | list offers |
| `GET` | `/api/offers/{id}` | fetch one offer |
| `POST` | `/api/agencies/{id}/offers` | create an offer |
| `PUT` | `/api/agencies/{id}/offers/{offer_id}` | replace an offer's editable fields |
| `PATCH` | `/api/agencies/{id}/leads/{lead_id}` | change part of a lead |

Just a convention, but a shared one — any developer joining can guess your URLs.

> [!info] No trailing slashes on `/api/`
> `/api/offers`, not `/api/offers/`. Django's own URLs (the pages, the admin) *do* end in a
> slash, because `APPEND_SLASH` redirects to them. Ninja routes don't. Two conventions in one
> project is mildly annoying and worth knowing about before you spend ten minutes on a 404:
> the API half follows the HTTP-API convention, the HTML half follows Django's.

**One rule that isn't just convention:** `GET` must never change anything. Browsers, search
engines and proxies all assume `GET` is safe and fetch URLs speculatively. A
`GET /offers/abc/delete` will eventually be triggered by something that was only looking.

> [!warning] One endpoint here breaks that rule
> `GET /api/admin/reconcile-ratings` recomputes and writes the denormalised rating counters.
> It is staff-only and it is honest about what it does, but a `GET` that writes is a `GET`
> that a link prefetcher can fire. It should be a `POST`, or better, a management command on
> a schedule. Noted rather than quietly tolerated — see [[Agency Ratings]].

---

## Status codes worth knowing

| Code | Meaning | When |
|---|---|---|
| `200` | OK | it worked |
| `201` | Created | a `POST` made something |
| `302` | Found | a redirect — how the HTML side answers a successful POST |
| `400` | Bad Request | a model-level validation rule said no |
| `401` | Unauthorized | you're not logged in (badly named — it means *unauthenticated*) |
| `403` | Forbidden | you're logged in but not entitled |
| `404` | Not Found | doesn't exist — **or exists and isn't yours** |
| `409` | Conflict | clashes with current state, e.g. the publish quota is full |
| `422` | Unprocessable | the *shape* of your input was wrong — Ninja's validation failure |
| `429` | Too Many Requests | rate limited |
| `500` | Server Error | we broke. An incident, always. |

The `400` / `422` split is worth one sentence, because it trips people up. **422 is the
schema:** wrong type, missing field, unknown field. It happens before your handler runs, and
`details` names the field. **400 is a Django `ValidationError`:** the shape was fine but the
*value* broke a business rule — a phone number that parses as a string but isn't Algerian.

> [!important] Why forbidden data returns 404, not 403
> If `GET /api/agencies/{mine}/leads/{someone-else's-id}` returned `403`, that's a
> confirmation the lead exists. Loop through ids and you can count a competitor's clients
> without reading one. A missing row and a forbidden row must be indistinguishable.
>
> The deliberate exception is the *agency id in the path*: putting another agency's id there
> is a `403`, because agency ids are not secret (they're in every agency's own URLs) and
> "you are not a member of this agency" is what a real user sees when their access was
> revoked while a tab was open. The rule protects rows, not the existence of agencies. See
> [[Multi-Tenancy]].

Rihlati wraps every error in one shape, from `apps/common/errors.py`:

```json
{ "code": "NOT_FOUND", "details": null, "requestId": "a1b2c3d4e5f60718" }
```

The client switches on `code`, never on the English or French message — because the message
is going to be translated, and a UI that greps error strings breaks the day someone fixes a
typo. The `requestId` is the same one in the `X-Request-Id` header and in every server log
line for that request, so "it broke at three o'clock" becomes one search. See
[[The Seven Rules]] rule 4.

One thing deliberately *not* wrapped: an unhandled `500`. Swallowing it into a tidy envelope
is how an incident becomes a mystery.

---

## What the API is *not*

- **Not the database.** The database stores; the API decides.
- **Not the website.** Here Django serves both, which makes it tempting to blur them. Keep
  them separate in your head: `apps/pages/` renders HTML and `apps/offers/` holds the rules,
  and the HTML side gets no extra trust for being "ours". Both doors are guarded, and
  `apps/pages/tests.py` exists because the second door is the one people forget. See
  [[One Rule, Two Entry Points]].
- **Not trusted with anything from outside.** Every input is hostile until validated.
  See [[Validation at the Boundary]].

---

## Open questions

- Should `/api/` be a public, documented product (so an agency could plug its own tooling
  into Rihlati), or an internal detail of the website? That decides whether URL shapes become
  promises you can't break. The OpenAPI document at `/api/docs` is currently reachable by
  anyone who knows the URL, which is a *de facto* answer nobody chose deliberately.

Related: [[System Overview]] · [[Multi-Tenancy]] · [[Authentication vs Authorization]] ·
[[The Seven Hops of a Request]] · [[Validation at the Boundary]] · [[Glossary]]
