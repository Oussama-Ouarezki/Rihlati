# Validation at the Boundary

## The rule

**Everything arriving from outside is hostile until proven otherwise.** Not "probably fine".
Not "the form already checked it". Hostile.

The "boundary" is the line where data enters the application. Validation happens *exactly
there*, once, before any handler sees it. Past that line, the code can assume the data is
well-formed — and that assumption is what makes the rest of the code simple.

---

## Why the form's validation doesn't count

Your inquiry form checks that the phone number looks Algerian. Good — instant feedback, fewer
mistakes. That's a **user experience** feature.

It is not a security feature, because the form runs on the user's computer. They can send the
request with `curl` without ever loading your page.

So: validate in the browser *for the user*, validate on the server *for the system*. Same
rule, both places — which is what [[One Rule, Two Entry Points]] is about.

---

## What "invalid" covers

More than wrong types.

| Problem | Example | Consequence if unchecked |
|---|---|---|
| Wrong type | `price_centimes: "cheap"` | crash, or garbage saved as a price |
| Wrong type, subtler | `departure_date: "2026-08-01"` as a `str` | **a real 500 — see below** |
| Out of range | `seats_total: 4000000` | nonsense on the page |
| Too long | 4 MB of text in a name | database bloat, slow pages, memory |
| Wrong format | `phone_e164: "call me"` | you can never contact the lead |
| **Extra fields** | `{title_fr, status: "published"}` | **privilege escalation** |
| Missing field | no consent record | no legal basis to contact anyone |
| Contradictory | `seats_left` > `seats_total` | you sell seats that don't exist |

That "extra fields" row is the dangerous one.

> [!danger] The second row is not hypothetical — it happened here
> `OfferIn.departure_date` was typed `str` instead of `date`. It looked harmless. It was not:
> the string reached `fingerprint_for()`, which called `.isoformat()` on it, and **every
> single offer-create returned 500**. It also made `validate_date_range` compare two strings,
> which happens to work for ISO-8601 and would silently not for anything else.
>
> The same bug was on the *public* search filters, `date_from` and `date_to` — so the garbage
> arrived unauthenticated. `?date_from=hello` typed as `str` reaches the ORM and raises there.
> Typed as `date`, it's a 422 naming the parameter, before a query is even built.
>
> Both are fixed. The lesson is the one this whole note is about: **parse at the boundary,
> and the rest of the code cannot receive a date that isn't one.** A type hint that Pydantic
> reads is a real check; a type hint Python ignores is a comment.

---

## Mass assignment: the bug worth understanding properly

Say the create-offer handler took the request body and handed it to the ORM:

```python
# DON'T
Offer.objects.create(**payload.dict())
```

An agency sends:

```json
{
  "title_fr": "Omra Ramadan 2026",
  "price_centimes": 32000000,
  "status": "published",
  "is_featured": true,
  "quality_score": 100,
  "agency": "a-competitor's-id"
}
```

Four fields they must never control:

- `status: "published"` — skipped the review queue entirely
- `is_featured: true` — free promoted placement, the thing you planned to *sell*
- `quality_score: 100` — bought the top of the search results
- `agency` — created an offer **in someone else's name**

Nobody attacked anything. They added four keys to some JSON.

**The fix** is that `OfferIn` in `apps/offers/api.py` lists the allowed fields and simply does
not have the others. The comment on it says so out loud:

```python
    # Note what is NOT here: agency, slug, status, is_featured, quality_score,
    # fingerprint, duplicate_status, report_count. Those are server-owned. A
    # field absent from the schema is a field a client cannot set, which is a
    # stronger guarantee than a handler remembering to ignore it.
```

And the tenant comes from the URL that `require_membership` already authorized, never from
the body. `ServerOwnedFieldTests` in `apps/offers/tests.py` runs exactly this attack and
asserts the request is rejected.

The general principle: **allowlist, never denylist.** A list of permitted fields stays correct
when you add a new column. A list of forbidden fields is one migration away from being
silently wrong.

> [!danger] There is no `fields = "__all__"` in a Ninja schema, and that's a feature
> DRF has `Meta.fields = "__all__"`, which reads like "expose the model" and means "accept
> every column this model will ever have, including ones added by someone else, next year,
> who wasn't thinking about this endpoint."
>
> Ninja's `ModelSchema` can do something similar, and this codebase deliberately doesn't use
> it for inputs. Every input field is written out by hand, and that typing cost is the point:
> it makes adding a server-owned field to an input schema a visible act.
>
> The same trap exists on the HTML side as `ModelForm` with `fields = "__all__"`. Check
> `apps/pages/forms.py` — the fields are listed.

---

## Unknown fields: the default is wrong, so we changed it

**Pydantic's default is to ignore keys it doesn't recognise.** Send
`{"title_fr": "X", "stauts": "published"}` — note the typo — and you get a `201`, the offer is
created, `stauts` is dropped on the floor, and the client believes the status was set. It
wasn't. Nothing anywhere reports a problem.

That's why `Strict` exists in `apps/common/schemas.py`, and why it is four lines:

```python
class Strict(Schema):
    model_config = ConfigDict(extra="forbid")
```

Every input schema in the codebase inherits it. A loud `422` beats a quiet success.

Worth being precise about what this catches, because it's not the attacker. The allowlist
above already stopped them — `stauts` was never going to become `status`. What `extra="forbid"`
catches is **the honest client that believes a write landed when it didn't**: a typo in a
mobile app, a renamed field in a JS client, a field you removed last month that something
still sends.

> [!info] Django vs NestJS
> Zod's `z.object()` **strips** unknown keys and `z.strictObject()` **rejects** them, so the
> NestJS repo picks per case: strip at the top level (a confused client sending `status` is
> friendlier to ignore), reject inside `attributes` (a typo like `nightsInMaccah` must be
> loud, or you store data nothing reads and never find out).
>
> Here, everything rejects. Pydantic offers the same choice per-model — `extra="ignore"` is
> one line — but a half-applied rule is worse than a consistent one, so the strict version is
> the base class and any exception would have to be written down. There are none today.

---

## Normalize while validating

Validation is also the moment to put data in canonical form. A phone number should be
accepted as `0551 23 45 67`, `+213551234567` or `00213551234567` — and always stored as
`+213551234567`.

Because normalization happens *inside* validation, no handler ever sees a non-normalized
number. The alternative — normalizing "later, in the handler" — means some path eventually
forgets, and you get two rows for one person that never match as a repeat client.

> [!warning] Honest state
> `apps/common/validators.py` currently *rejects* anything not already in `+213…` form rather
> than normalizing to it. That's stricter and simpler, and it pushes the problem onto the
> traveler, who typed their own number the way Algerians actually write it. Normalizing is the
> better answer and it isn't written yet.
>
> The regex `^\+213[5-7]\d{8}$` is also **a guess at the valid mobile prefixes**, and the
> comment above it says so. It gates real signups. Verify it against current ARPCE allocations
> before launch — exactly the kind of local fact `CLAUDE.md` says never to invent.

---

## Never trust these, ever

Not even from a logged-in user:

- **Who they are** — comes from the session, never a `user_id` in the body
- **Which tenant they're acting in** — the URL says which, `require_membership` says whether
- **What they're allowed to do** — checked server-side, per request, from the database
- **What something costs** — the client sends an item id, never an amount
- **Anything about time** — use the server clock; a client can claim any timestamp
- **Counts and totals** — recount server-side. "I have 3 offers, let me publish another" is
  not evidence; `published_offer_count()` is.

The third one is [[Authentication vs Authorization]]. The fourth is rule #6 in
[[The Seven Rules]], and it's why every payment checklist is so boring: taking a price from
the client is *the* classic way to buy a 400 000 DZD Omra for one dinar.

---

## Why the error carries a code, not a sentence

Every error leaves through one envelope, in `apps/common/errors.py`:

```json
{
  "code": "VALIDATION_FAILED",
  "details": { "phone_e164": ["Numéro algérien attendu, au format +213…"] },
  "requestId": "a1b2c3d4e5f60718"
}
```

The client switches on `code`. It never greps the message, because the message is going to be
translated and a UI that matches on French strings breaks the day someone fixes a typo.

Because `details` is keyed by field name, a form can highlight the exact input. A single
`"Bad request"` is technically correct and practically useless. The handler for Ninja's
validation error does that reshaping by hand — Pydantic reports a list of `{loc, msg, type}`,
and it becomes `{field: [messages]}`.

> [!warning] Honest state — the messages are French sentences
> The NestJS repo emits translation *keys* (`validation.phoneInvalid`) and lets each client
> look them up, after a bug where an Arabic, correctly right-to-left signup page showed a
> French sentence in red under the password box. The server doesn't know what language the
> reader speaks; a request carries a token and a body, not a person.
>
> This repo has the same bug and not yet the fix. Django's `gettext` can translate on the
> server using `Accept-Language`, which is a genuinely simpler answer than the key-passing a
> JS stack needs — but it isn't wired up, and `details` currently carries French prose
> regardless of who is reading. See [[Decisions You Must Make]].

> [!warning] Don't leak internals in errors
> Never return a stack trace, a SQL fragment, or a database column name to a client. That's
> what `DEBUG=False` is for, and it's why `DEBUG` is an environment variable rather than a
> guess about which machine you're on. Log the detail with the request id; return the request
> id. They quote the id, you find the log. See [[The Seven Rules]] rule 4.

---

## Why this matters more than it looks, for what you want to build next

You're learning this to eventually wire LLMs into real backends. Keep this note in mind when
you do.

An LLM calling an API sends **malformed input as a matter of routine, not as an attack**. It
will invent a field name that sounds right. It will pass a date as "next Ramadan". It will
confidently send `status: "published"` because the word appeared in its context.

A human client is wrong occasionally, by accident. A model is wrong constantly, plausibly, and
at speed.

Every protection in this note — allowlists, `extra="forbid"`, parsing dates as dates,
deriving the tenant server-side — stands unchanged against an agent. Build it before the
agent, not after. And notice which of the two bugs in the box at the top of this note would
have been *harder* to find if an agent were the caller: not the 500, which is loud, but the
silently-dropped field, which looks like success on both sides.

---

## Open questions

- Should the API translate its own error messages using `Accept-Language`, or emit codes and
  let each client translate? Django makes the first one easy; the second is the only thing
  that works when the client isn't a browser.
- Should `validate_dz_phone` normalize instead of reject? It's friendlier and it's a
  data-quality improvement (no duplicate rows per person), at the cost of accepting input you
  then have to be confident you transformed correctly.

Related: [[The Seven Rules]] · [[Offer]] · [[Authentication vs Authorization]] ·
[[One Rule, Two Entry Points]] · [[Multi-Tenancy]] · [[What the API Is]]
