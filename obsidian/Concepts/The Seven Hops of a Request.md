# The Seven Hops of a Request

[[What the API Is]] explains why the API exists. This note is the other half: what actually
*happens*, hop by hop, when one real request runs.

Read it with the files open. The point is not the offer-detail endpoint — it's that **every
endpoint in this codebase is the same seven hops in the same order**. Once you can see the
shape once, reading an app you've never opened takes minutes instead of hours.

The request we follow: a traveler opens an offer on the marketplace.

```
GET /api/offers/0a42b5b3-19b2-477f-9f5a-2816e0ef7192
```

---

## Hop 1 — the request arrives

An HTTP request is only ever four things: a **method** (`GET` = read, change nothing), a
**path**, some **headers**, and sometimes a **body**. There is no magic under it. This one
carries no credentials, because this route is public.

Before any of your code runs, the WSGI server hands it to Django, which wraps it in an
`HttpRequest` object. Everything from here on is that object being passed down a chain.

## Hop 2 — the middleware chain, which runs before anything knows what a view is

`config/settings.py`, `MIDDLEWARE`. This list is a **pipeline**: top to bottom on the way in,
bottom to top on the way out.

```
SecurityMiddleware          → HTTPS headers
RequestIdMiddleware         → ours: stamp request.request_id
SessionMiddleware           → read the session cookie, load the session
CommonMiddleware            → URL normalisation, APPEND_SLASH
CsrfViewMiddleware          → reject a cross-site cookie-authenticated POST
AuthenticationMiddleware    → set request.user (lazily)
MessageMiddleware           → the one-shot "saved!" banner
```

Order is not decorative and getting it wrong is a real bug. `AuthenticationMiddleware`
**must** come after `SessionMiddleware`, because otherwise it reads a user id out of a session
that hasn't been loaded. Django refuses to start if you reverse them — one of the better error
messages in the framework.

`RequestIdMiddleware` sits first after security, and the comment in `config/settings.py` says
why: *so the id exists before anything else can fail and want to mention it.* On the way out it
writes `X-Request-Id` onto the response and logs the exchange. That id is the same one in the
error envelope, which is what turns "it broke around three o'clock" into a single search. See
[[The Seven Rules]] rule 4.

Two details in `apps/common/middleware.py` worth stealing for any project you build:

- **The id is generated, never read from the client.** A client-supplied `X-Request-Id` is a
  free way to poison your own logs: send someone else's id and the two requests become
  indistinguishable in aggregate.
- **The log line has the method, path and status, and nothing else.** No query string, no
  body. A search URL is harmless; `?phone=+213…` on some future endpoint is not, and the
  difference is impossible to enforce once the habit of logging query strings exists.

> [!info] Django vs NestJS
> Nest has interceptors and guards; Django has middleware. The idea is identical — code that
> runs around every request without any route asking for it. The difference worth noting is
> that Django's chain is *ordered and global*, declared in one list you can read in ten
> seconds. That list is the best five-minute summary of what an application does to every
> request, and it is the first thing I would read in an unfamiliar Django project.

One thing this hop **does not** do: authorization. `AuthenticationMiddleware` sets
`request.user` — possibly to `AnonymousUser` — and forms no opinion about whether that user
may do anything. See [[Authentication vs Authorization]].

## Hop 3 — the URLconf, then Ninja's own router

`config/urls.py` is four lines and no logic:

```python
path("admin/", admin.site.urls),
path("api/", api.urls),      # the JSON API, docs at /api/docs
path("", include("apps.pages.urls")),   # the server-rendered pages
```

`api.urls` hands everything under `/api/` to Ninja, which matches against the path declared
on the decorator itself:

```python
@public_router.get("/offers/{uuid:offer_id}", response=OfferOut, auth=None)
def get_offer(request, offer_id):
```

Three things are happening here that are easy to skim past.

**`{uuid:offer_id}` is validation, not documentation.** A path segment that isn't a valid UUID
doesn't match this route at all, so `/api/offers/../../etc/passwd` and `/api/offers/1` both
404 in the router, before a handler exists. Your first line of input validation is the URL
pattern, and it's free.

**The route declares its own path.** Unlike plain Django there is no separate `urls.py` for
API routes and no `name=` to reverse — the decorator is the URL. That is more convenient and
one bit less safe: nothing stops two routers declaring the same path, and the second one
silently loses. `config/api.py` mounts every router in one readable block precisely so you can
eyeball the whole URL layout in one place.

**`auth=None` is the exit from deny-by-default.** See hop 4.

> [!info] The HTML half still reverses by name
> `apps/pages/urls.py` uses `name=` and templates say `{% url 'agency-leads' agency.id %}`.
> Change the path and every caller follows. A hardcoded `/agencies/…/leads` in a template is a
> link that breaks silently the day the path moves — and Django templates fail silently, so
> nothing tells you. See [[One Rule, Two Entry Points]].

## Hop 4 — auth runs before the handler body

`config/api.py` sets one default for the entire API:

```python
api = NinjaAPI(auth=API_AUTH, ...)
```

**Its default answer is no.** 401, request over.

This route survives because of one token on the decorator: `auth=None`. That is the only exit,
and it is the whole reason the default points this way — *forgetting* gets you a locked door,
not an open one. The dangerous state requires someone to type something visible, and
`AuthorizationTests` in `apps/common/tests_house_rules.py` pins the complete list on every
build. You could never audit "every route someone remembered to protect."

This hop is **authentication** — *who are you?* Here: nobody, and that is allowed.

For the agency-scoped sibling route, the equivalent work happens on the handler's first line:

```python
agency = require_membership(request.user, agency_id, Membership.MANAGER)
```

That asks the database whether `request.user` has a `Membership` row for the agency named in
the URL, and whether their rank is high enough. That is **authorization**, and it happens
before a single row of offer data is touched.

> [!info] Why membership is a function call and not a decorator
> A NestJS guard is declared on the route; here it is the first statement in the body. That is
> weaker — a guard cannot be forgotten by writing code below it, a function call can — and it
> is the trade Ninja makes for having no guard concept. The compensation is that
> `require_membership` returns the `Agency`, so the handler *needs* its return value to do
> anything useful. Forgetting it usually means the next line has nothing to work with.

## Hop 5 — the queryset decides what may be seen

`apps/offers/api.py`:

```python
offer = get_object_or_404(
    Offer.publicly_visible().select_related("agency").prefetch_related("milestones"),
    pk=offer_id,
)
```

and in `apps/offers/models.py`:

```python
@classmethod
def publicly_visible(cls):
    return cls.objects.filter(
        status=cls.PUBLISHED,
        agency__status=Agency.VERIFIED,
    ).exclude(duplicate_status=cls.CONFIRMED_DUPLICATE)
```

Three conditions. **None of them came from the user.**

They are policy, written as a query. A draft offer, an offer from an unverified agency, or one
already confirmed as a duplicate listing is not fetched and then filtered out in Python. It is
never fetched at all.

That distinction matters more than it looks. Filtering afterwards works right up until someone
refactors the loop, adds an early return, or reuses the fetch somewhere else — and the filter
silently stops applying. Filtering in the queryset cannot be accidentally skipped, because
there is nothing to skip. **Permission belongs in the query, not after it.**

Notice also *where* the rule lives: on the model, with a name, as a classmethod. Its docstring
names the four callers — the API list, the API detail, the search page, the inquiry endpoint —
and says why: *"the fifth caller written inline is the one that forgets a condition, and the
bug is an unverified agency quietly receiving real leads."*

**And the 404:** if the offer doesn't exist, 404. If it exists but is a draft, also 404 — not
403. A 403 would confess *"this exists, you just can't have it"*, which hands a stranger free
reconnaissance. Missing and forbidden must be indistinguishable from outside. Same rule as
[[Multi-Tenancy]], applied to visibility instead of ownership.

`select_related("agency")` and `prefetch_related("milestones")` are not about permission —
they're about not issuing one extra query per row. See [[Indexes and Why Queries Get Slow]].

## Hop 6 — SQL, and the line that isn't here

The ORM turns hop 5 into roughly:

```sql
SELECT o.id, o.title_fr, ..., a.name, a.city
FROM offers_offer o INNER JOIN accounts_agency a ON a.id = o.agency_id
WHERE o.status = 'published' AND a.status = 'verified'
  AND NOT (o.duplicate_status = 'confirmed_duplicate') AND o.id = %s
LIMIT 1;
```

`%s` is a **parameter**, not text glued into the string. That is why SQL injection isn't
something you have to think about here — the query structure is fixed before the value
arrives, so a value can never become an instruction.

> [!danger] The two ways to lose that guarantee
> `Model.objects.raw()` and `cursor.execute()` with an f-string. Both exist, both are sometimes
> necessary, and both hand you the loaded gun back. If you ever need raw SQL, pass parameters
> as the second argument — `cursor.execute("... WHERE id = %s", [value])` — never format them
> into the string.

Now the important part: **what is deliberately missing from this query.** Compare with a
tenant-scoped read:

```python
offer = get_scoped_object(Offer.objects, agency.id, pk=offer_id)
```

which is `get_object_or_404(queryset.filter(agency_id=agency_id), pk=offer_id)`. That
`agency_id` came from the `Agency` that hop 4 returned, having verified a `Membership` row.
**That one filter is the entire defence against Agency B reading Agency A's data.**

It is also why `Offer.objects.get(pk=…)` is banned by `TenantScopeTests`: `get(pk=…)` matches
by primary key alone, so it *structurally cannot* also require an agency. The rule isn't
taste — the safe version is impossible to write that way.

The public detail route has no agency filter because it is genuinely public.
`status='published'` is doing the same job in its place. Different condition, same principle:
**the filter is where permission lives.**

## Hop 7 — back up, and out

`offer_out(offer)` builds the response dict, and `response=OfferOut` — a `Strict` schema —
declares its shape. Together they are a second deliberate gate between *what is stored* and
*what is shown*.

This is the hop where a private column leaks if you let it. `OfferOut` lists its fields by
hand; it is not generated from the model. Add an `internal_margin_centimes` column tomorrow
and it does not quietly start appearing in public JSON. **The default is not exposed.** See
[[Validation at the Boundary]].

Then Ninja serialises to JSON and returns `200`, and the middleware chain runs in reverse on
the way out — which is where `X-Request-Id` is attached and the exchange is logged.

If anything had raised instead, `register_exception_handlers` in `apps/common/errors.py` would
have turned it into the one envelope: `{code, details, requestId}`. `Http404` → 404,
`Forbidden` → 403, Ninja's validation error → 422 reshaped to `{field: [messages]}`, Django's
`ValidationError` → 400. Everything else is deliberately left alone, because an unhandled 500
is an incident and swallowing it into a tidy envelope is how an incident becomes a mystery.

---

## The same seven hops, everywhere

| Hop | Public offer detail | An agency reading its own leads |
|---|---|---|
| 1 Request arrives | no credentials | session cookie or bearer token |
| 2 Middleware | request id stamped | same, plus `request.user` loaded |
| 3 Route | `{uuid:offer_id}` | `{uuid:agency_id}` and `{uuid:lead_id}` |
| 4 Auth | `auth=None` — let through | `API_AUTH`, then `require_membership` |
| 5 Queryset | `publicly_visible()` | `scoped(Lead.objects, agency.id)` |
| 6 SQL | parameterised | parameterised, plus `agency_id = %s` |
| 7 Out | `OfferOut` | `LeadOut` |

Only hops 4 and 5 really differ between endpoints. That is the payoff: **when you open an app
you have never seen, read its auth line and its queryset. That is the feature.**

---

## Where the HTML pages differ, and why that matters

`apps/pages/` runs the same seven hops with two substitutions: hop 4 is `@login_required` plus
`require_membership_or_404`, and hop 7 renders a template instead of JSON.

Two substitutions, one of which is a downgrade. `auth=API_AUTH` is a Ninja setting and does not
apply to plain Django views — **an undecorated page view is wide open**, and it will look
completely correct in a browser where you happen to be logged in.

There is also a deliberate inversion at hop 4: the pages return **404** where the API returns
403 for a borrowed agency id, because a browser URL gets pasted into WhatsApp far more casually
than an API call does.

That asymmetry is the sharpest edge in this codebase, and it is the entire reason
`apps/pages/tests.py` re-runs every tenant-isolation test against rendered pages. See
[[One Rule, Two Entry Points]].

---

## Seeing it happen

```bash
.venv/bin/python manage.py runserver
```

Open `localhost:8000` with DevTools on the **Network** tab and click an offer. Then open
`localhost:8000/api/docs` — the OpenAPI page renders every operation, generated from the same
type hints the handlers use, and you can fire this exact request from it.

To watch hop 6, drop into the ORM and ask it what SQL it would run:

```bash
.venv/bin/python manage.py shell
>>> from apps.offers.models import Offer
>>> print(Offer.publicly_visible().query)
```

That prints the actual `SELECT`. Full commands in [[Local Setup]].

---

## The second pass

Read these seven hops again asking one question at each: **what would an attacker try here,
and what stops them?**

- Hop 2 — remove the session cookie. Send your own `X-Request-Id` and see it ignored.
- Hop 3 — request `/api/offers/1`. Request `/api/offers/../../etc/passwd`.
- Hop 4 — put another agency's id in the path. Call an agent-rank account against a
  manager-rank route.
- Hop 5 — request a draft offer by its real id. Request an unverified agency's offer.
- Hop 6 — put a `'` in a query parameter and look for a SQL error.
- Hop 7 — look at the JSON and ask what *isn't* in it, and whether that's by design.

Every one of those is already answered above, and most of them exist as an actual test in
`apps/offers/tests.py`. The first pass tells you what the code does; the second tells you why
it is shaped that way, and that is the pass that makes the shape yours. See
[[The Seven Rules]].

---

## Open questions

Business calls, not engineering ones — these are yours:

- **Should an archived offer 404 like a draft, or show a "no longer available" page?** Right
  now anything not `published` is a 404. A dedicated page is friendlier to a traveler following
  an old WhatsApp link, but it confirms the offer exists — acceptable for an expired public
  listing, arguably not for a draft. These may deserve different answers.
- **Should offers get slugs instead of raw UUIDs in public URLs?** `/offers/omra-ramadan-2026`
  is shareable and good for search engines; a UUID is neither. The cost is deciding how long an
  old slug keeps working after a rename, because slugs get pasted into WhatsApp messages that
  outlive the offer.

---

Related: [[What the API Is]] · [[Multi-Tenancy]] · [[Validation at the Boundary]] ·
[[Authentication vs Authorization]] · [[The Seven Rules]] · [[One Rule, Two Entry Points]] ·
[[Local Setup]] · [[Offer]]
