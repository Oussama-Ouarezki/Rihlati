# Validation at the Boundary

## The rule

**Everything arriving from outside the API is hostile until proven otherwise.**

Not "probably fine". Not "the form already checked it". Hostile.

The "boundary" is the line where data enters the API. Validation happens *exactly there*,
once, before any handler sees it. Past that line, code can assume data is well-formed —
that assumption is what makes the rest of the code simple.

---

## Why the form's validation doesn't count

Your inquiry form checks the phone number is 10 digits. Good — instant feedback, fewer
mistakes. That's a **user experience** feature.

It is not a security feature, because the form runs on the user's computer. They can send
the request without ever loading your page.

So: validate in the browser *for the user*, and validate on the server *for the system*.
Same schema, both places — which is the whole reason `packages/shared` exists. One
definition, two enforcement points, no drift.

---

## What "invalid" covers

More than wrong types.

| Problem | Example | Consequence if unchecked |
|---|---|---|
| Wrong type | `priceFromCentimes: "cheap"` | crash, or `NaN` saved as a price |
| Out of range | `hotelStars: 47` | nonsense on the page |
| Too long | 4 MB of text in a name | database bloat, slow pages, memory |
| Wrong format | `phone: "call me"` | you can never contact the lead |
| **Extra fields** | `{ title, status: "published" }` | **privilege escalation** |
| Missing field | no `consentGivenAt` | no legal basis to contact anyone |
| Contradictory | return date before departure | impossible trip listed for sale |

That fifth row is the dangerous one.

---

## Mass assignment: the bug worth understanding properly

Say the create-offer endpoint takes the request body and hands it to the database:

```ts
// DON'T
await prisma.offer.create({ data: req.body });
```

An agency sends:

```json
{
  "title": "Omra Ramadan 2026",
  "priceFromCentimes": 32000000,
  "status": "published",
  "isFeatured": true,
  "agencyId": "a-competitor's-id"
}
```

Three fields they should never control:

- `status: "published"` — skipped your review queue entirely
- `isFeatured: true` — free promoted placement, the thing you planned to *sell*
- `agencyId` — created an offer **in someone else's name**

Nobody attacked anything. They added three keys to some JSON.

**The fix:** a schema that lists allowed fields and *strips everything else*. Look at
`createOfferSchema` in `packages/shared/src/offers/schemas.ts` — `status`, `agencyId`,
`isFeatured` and `qualityScore` aren't in it. Zod's `z.object()` drops unknown keys, so
those fields don't get rejected, they simply never exist. There's a test asserting exactly
that, in `schemas.test.ts`.

The general principle: **allowlist, never denylist.** A list of permitted fields stays
correct when you add a new column. A list of forbidden fields is one migration away from
being wrong, silently.

---

## Where `attributes` fits

[[Offer]] has one JSON column, `attributes`, so an Omra offer and a flight offer can have
different fields without separate tables.

Isn't that a hole in the allowlist? No — each offer kind has its own **strict** schema
(`z.strictObject`), and strict means unknown keys are *rejected*, not stripped. Flexible in
shape, not in discipline. There's a test for that too.

The two behaviours are deliberate:
- Top-level offer fields: **strip** unknowns (someone sending `status` is probably a
  confused client, not an attacker — silently ignoring is friendlier)
- Inside `attributes`: **reject** unknowns (a typo like `nightsInMaccah` must be a loud
  error, or you'd store data nothing ever reads and never find out)

---

## Normalize while validating

Validation is also the moment to put data in canonical form. `algerianPhoneSchema` accepts
`0551 23 45 67`, `+213551234567`, `00213551234567` — and always outputs `+213551234567`.

Because normalization happens *inside* validation, no handler can ever see a
non-normalized phone number. The alternative — normalizing "later, in the service" — means
some path eventually forgets, and you get two rows for one person and can never match a
repeat client. There are ten tests on that function in `phone.test.ts`.

---

## Never trust these, ever

Not even from a logged-in user:

- **Who they are** — `userId`, `agencyId`, `role` come from the session token
- **What things cost** — prices come from the database; the client sends an item id
- **What they're allowed to do** — checked server-side per request
- **Anything about time** — use the server clock; a client can claim any timestamp
- **Counts and totals** — recount server-side. "I have 3 offers, let me publish another"
  is not evidence.

That third one is [[Authentication vs Authorization]]. The second is rule #6 in
[[The Seven Rules]], and it's why every payment integration checklist is so boring: prices
from the client is *the* classic way to buy a 400 000 DZD Omra for 1 dinar.

---

## What good validation feels like

Error messages that name the field and say what's wrong, in the user's language:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [
    { "path": "attributes.makkahHotelStars", "message": "Doit être entre 1 et 5" },
    { "path": "contactPhone", "message": "Numéro de téléphone algérien invalide" }
  ]
}
```

Because paths are structured, the form can highlight the exact input. A single
`"Bad request"` is technically correct and practically useless.

> [!warning] Don't leak internals in errors
> Never return a stack trace, an SQL fragment, or a database column name to a client. Log
> those with a request id; return the request id to the user. They quote the id, you find
> the log. See [[The Seven Rules]] rule 4.

---

Related: [[The Seven Rules]] · [[Offer]] · [[Authentication vs Authorization]] ·
[[The Shared Package]]
