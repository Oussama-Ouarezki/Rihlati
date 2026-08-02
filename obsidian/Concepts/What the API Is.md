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
website would say: "give me all rows from `leads` where `agencyId = 'agency-42'`."

That sentence is written *in the browser*. On the user's computer. Which they control.

So they open the developer tools, change `agency-42` to `agency-43`, and read a competitor's
entire client list. Nothing stopped them, because the only thing that decided which agency
to ask about was code running on their own machine.

**That's problem #3 on your list, and this is where it comes from.** The fix isn't to hide
the code better — you can't, it's on their computer. The fix is that the browser never gets
to name the agency at all.

With an API:

1. The browser says: "give me my leads." That's the whole request. No agency id in it.
2. The API looks at the login token attached to the request, and figures out *for itself*
   which agency this user belongs to.
3. The API asks the database for that agency's leads only.
4. The browser gets the answer.

The user can tamper with step 1 all they like. There's nothing in it to tamper with. See
[[Multi-Tenancy]] for how this is enforced structurally rather than by remembering.

---

## The shape of one request

Someone submits an inquiry on an Omra offer:

```
   Browser                    API                        Database
      │                        │                             │
      │  POST /offers/xyz/     │                             │
      │  inquiries             │                             │
      │  {name, phone,         │                             │
      │   message, consent}    │                             │
      │───────────────────────►│                             │
      │                        │ 1. rate limit: not spam?    │
      │                        │ 2. valid input? phone real? │
      │                        │    consent actually given?  │
      │                        │ 3. does offer xyz exist     │
      │                        │    and is it published?     │
      │                        │────────────────────────────►│
      │                        │◄────────────────────────────│
      │                        │ 4. create the lead, owned   │
      │                        │    by THAT offer's agency   │
      │                        │────────────────────────────►│
      │                        │ 5. notify the agency        │
      │                        │ 6. write the audit record   │
      │  201 { leadId }        │                             │
      │◄───────────────────────│                             │
```

Steps 1–6 are the API's job. Every one of them is a rule the browser cannot skip, because
the browser isn't the one doing them.

Notice step 4: the agency isn't chosen by the traveler. It's looked up from the offer.
A traveler can't send a lead to an agency that doesn't own the offer, because they were
never asked which agency to use.

---

## The three layers inside the API

Each endpoint's code is split in three. This split is the difference between code you can
still change in a year and code you can't.

```
Controller  ──►  Service  ──►  Prisma (database)
```

**Controller** — the door. Reads the HTTP request, checks permission, validates input,
calls the service. Contains no business rules. Should be boring and about 10 lines.

**Service** — the brain. "An agency on the free plan can't publish a sixth offer."
"Moving a lead to `booked` records the timestamp." All rules live here. Knows nothing
about HTTP, which is why it can be tested without starting a server.

**Prisma** — the hands. Actually reads and writes rows.

Why bother? Because the rule "free plan caps at 5 offers" must apply whether the request
came from the website, the phone app, an admin tool, or a bulk import. If that rule lived
in the controller, you'd write it four times and get it wrong three times.

---

## What "REST" means, briefly

A convention for naming things. The URL names a *thing*; the HTTP verb names the *action*.

| Verb | URL | Means |
|---|---|---|
| `GET` | `/offers` | list offers |
| `GET` | `/offers/abc` | fetch offer `abc` |
| `POST` | `/offers` | create an offer |
| `PATCH` | `/offers/abc` | change part of offer `abc` |
| `DELETE` | `/offers/abc` | remove offer `abc` |

Just a convention, but a shared one — any developer joining can guess your URLs.

**One rule that isn't just convention:** `GET` must never change anything. Browsers,
search engines and proxies all assume `GET` is safe and will fetch URLs speculatively.
A `GET /offers/abc/delete` will eventually be triggered by something that was only looking.

---

## Status codes worth knowing

| Code | Meaning | When |
|---|---|---|
| `200` | OK | it worked |
| `201` | Created | a `POST` made something |
| `400` | Bad Request | your input was invalid |
| `401` | Unauthorized | you're not logged in (badly named — it means *unauthenticated*) |
| `403` | Forbidden | you're logged in but not allowed |
| `404` | Not Found | doesn't exist — **or exists and isn't yours** |
| `409` | Conflict | clashes with current state, e.g. email taken |
| `429` | Too Many Requests | rate limited |
| `500` | Server Error | we broke. An incident, always. |

> [!important] Why forbidden data returns 404, not 403
> If `GET /leads/<someone-else's-id>` returned `403`, that's a confirmation the lead
> exists. Loop through ids and you can count a competitor's clients without reading one.
> A missing row and a forbidden row must be indistinguishable. See [[Multi-Tenancy]].

---

## What the API is *not*

- **Not the database.** The database stores; the API decides.
- **Not the website.** No HTML, no colours, no layout.
- **Not trusted with anything from outside.** Every input is hostile until validated.
  See [[Validation at the Boundary]].

---

Related: [[System Overview]] · [[Multi-Tenancy]] · [[Authentication vs Authorization]] ·
[[Glossary]]
