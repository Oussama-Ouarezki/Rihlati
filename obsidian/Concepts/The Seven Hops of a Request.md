# The Seven Hops of a Request

[[What the API Is]] explains why the API exists. This note is the other half: what actually
*happens*, hop by hop, when one real request runs.

Read it with the files open. The point is not the offer detail page — it's that **every
endpoint in this codebase is the same seven hops in the same order**. Once you can see the
shape once, reading a module you've never opened takes minutes instead of hours.

The request we follow: a traveler clicks an offer on the marketplace.

```
GET /v1/offers/by-slug/omra-ramadan-2026
```

---

## Hop 1 — the browser asks

`apps/web/src/lib/api.ts`

```ts
return get<OfferDetail>(`/v1/offers/by-slug/${encodeURIComponent(slug)}`);
```

That is the entire frontend contribution to this request. It builds a URL and asks for it.

An HTTP request is only ever four things: a **method** (`GET` = read, change nothing), a
**path**, some **headers**, and sometimes a **body**. There is no magic under it. This one
carries no login token, because this route is public.

`OfferDetail` comes from `@rihlati/shared` — the same type the API promises to return. One
definition, both sides. That is what [[The Shared Package]] is for: if the API changes shape
and the website doesn't, the build fails instead of the page quietly breaking.

## Hop 2 — the guard runs before any of our code

`JwtAuthGuard` is registered globally in `apps/api/src/app.module.ts`. It fires on every
route in the application without any route asking it to.

**Its default answer is no.** 401, request over.

This route survives because of one line in `offers.controller.ts`:

```ts
@Public()
```

That decorator is the only exit. This is the whole reason the default is deny: *forgetting*
gets you a locked door, not an open one. The dangerous state requires someone to type
something visible and greppable. You can audit every public route in this app with one
search for `@Public()` — you could never audit "every route someone remembered to protect."

This hop is **authentication** — *who are you?* Here: nobody, and that is allowed.
Authorization (*what may you do?*) is a different question, answered later. See
[[Authentication vs Authorization]].

## Hop 3 — the input is treated as hostile

```ts
getBySlug(@Param('slug', slugParam()) slug: string)
```

`slugParam()` is a pipe. The URL segment passes through it **before** the method body is
entered. Wrong shape, and the request dies here with a 400 — the service never sees it.

Note what the type is doing, because this trips up everyone:

> The parameter is typed `string` **because** it already passed validation — not *instead*
> of validating it.

TypeScript is erased at runtime. It describes what you intend, and stops you contradicting
yourself while writing. It cannot stop a stranger sending `{}` down a socket at 3am. The
pipe can. See [[Validation at the Boundary]].

## Hop 4 — the controller hands off

```ts
return this.offers.getPublicBySlug(slug);
```

One line. No `if`, no database call, no business decision.

**This split is the transferable skill in this whole note**, so it's worth stating flatly:

| Layer | Knows about | Knows nothing about |
|---|---|---|
| **Controller** — the door | HTTP: URLs, status codes, headers | what an offer is |
| **Service** — the brain | the rules: what "published" means, who may see what | HTTP |
| **Prisma** — the hands | tables and rows | the rules |

The test of whether the split is real: if you added a command-line script or a nightly job
that needed offer data, it would call `getPublicBySlug` directly and nothing would break.
The rules are not tangled up in the door.

When that boundary erodes — a permission check written in the controller, a status code
thrown from the service — nothing breaks today. It breaks the day a second caller appears,
and then the fix is a rewrite. That is why it's worth keeping clean while it costs nothing.

## Hop 5 — the service decides

`apps/api/src/modules/offers/offers.service.ts`

```ts
const offer = await this.prisma.offer.findFirst({
  where: {
    slug,
    status: 'published',
    deletedAt: null,
    agency: { deletedAt: null },
  },
  select: OFFER_PUBLIC_DETAIL_SELECT,
});
if (!offer) throw notFound('Offre');
```

Four conditions in the `where`. **Only one of them came from the user.**

The other three are policy, written as a query. A draft offer, a deleted offer, an offer
belonging to a deleted agency — none are fetched and then filtered out in JavaScript. They
are never fetched at all.

That distinction matters more than it looks. Filtering after the fact works right up until
someone refactors the loop, adds an early return, or reuses the fetch somewhere else — and
the filter silently stops applying. Filtering in the `where` cannot be accidentally skipped,
because there is nothing to skip. **Permission belongs in the query, not after it.**

`select: OFFER_PUBLIC_DETAIL_SELECT` is an explicit column list rather than "everything".
Add a private column to that table tomorrow and it does not quietly start appearing in
public JSON. The default is *not exposed*.

**And the 404:** if the offer doesn't exist, 404. If it exists but is a draft, also 404 —
not 403. A 403 would confess *"this exists, you just can't have it"*, which hands a stranger
free reconnaissance. Missing and forbidden must be indistinguishable from outside. This is
the same rule as [[Multi-Tenancy]], applied to visibility instead of ownership.

## Hop 6 — SQL, and the line that isn't here

Prisma turns hop 5 into roughly:

```sql
SELECT id, slug, title, ... FROM "offers"
WHERE slug = $1 AND status = 'published' AND "deletedAt" IS NULL
LIMIT 1;
```

`$1` is a **parameter**, not text glued into the string. That is why SQL injection is not
something you have to think about here — the query structure is fixed before the value
arrives, so a value can never become instruction.

Now the important part: **what is deliberately missing from this query.** Compare with the
agency-side method further down the same file:

```ts
where: {
  agencyId: tenant.agencyId,   // ← the tenant scope, and it is not optional
  deletedAt: null,
  ...
}
```

`tenant.agencyId` comes from the **session**, never from the URL or the body. That one line
is the entire defence against Agency B reading Agency A's data.

It is also why `findUnique({ where: { id } })` is banned by ESLint in this repo: `findUnique`
can only match a unique key, so it *structurally cannot* also require `agencyId`. The rule
isn't taste — the safe version is impossible to write with that function.

The public offer detail has no `agencyId` because it is genuinely public. `status:
'published'` is doing the same job in its place. Different condition, same principle: **the
where-clause is where permission lives.**

## Hop 7 — back up, and out

`toOfferDetail(offer)` maps the database row to the shared `OfferDetail` shape — a second
deliberate gate between *what is stored* and *what is shown*.

Then Nest serialises to JSON, returns `200`, and it arrives back at hop 1 as a typed object
the page renders.

One line in this hop is worth copying as a habit:

```ts
await this.metrics.recordView(offer.agency.id, offer.id);
```

`recordView` swallows its own errors. If analytics bookkeeping fails, the traveler still
sees the page. **A secondary concern is never allowed to break the primary one.** Deciding
which is which, per feature, is a real design judgment — see [[Offer Analytics]].

---

## The same seven hops, everywhere

| Hop | Public offer detail | An agency reading its own leads |
|---|---|---|
| 1 Browser asks | no token | session cookie sent |
| 2 Guard | `@Public()` — let through | token verified, membership checked |
| 3 Validate | `slugParam()` | body/query through a Zod schema |
| 4 Controller | one-line hand-off | one-line hand-off |
| 5 Service | `status: 'published'` in the `where` | `agencyId: tenant.agencyId` in the `where` |
| 6 SQL | parameterised | parameterised |
| 7 Map out | `toOfferDetail` | `toLead` |

Only hops 2 and 5 really differ between endpoints. That is the payoff: **when you open a
module you have never seen, read its guard and its `where` clause. That is the feature.**

---

## Seeing it happen

```bash
npm run db:up && npm run db:seed
npm run dev:api      # terminal 1
npm run dev:web      # terminal 2
```

Open `localhost:3000` with DevTools on the **Network** tab and click an offer. Find
`by-slug/...` in the list — that is hop 1 and hop 7, the request and the JSON that came
back. Then `npm run db:studio` and find the same row in the `offers` table.

Same data, three views: what the browser asked for, what the API answered, what is actually
stored. Full commands in [[Local Setup]].

---

## The second pass

Read these seven hops again asking one question at each: **what would an attacker try here,
and what stops them?**

- Hop 2 — remove the cookie. Guess another agency's id in the URL.
- Hop 3 — send `slug=../../etc/passwd`, a 10MB string, an array where a string belongs.
- Hop 5 — request a draft offer by its real slug. Request a deleted agency's offer.
- Hop 6 — put a `'` in the slug and look for a SQL error.

Every one of those is already answered above. The first pass tells you what the code does;
the second tells you why it is shaped that way, and that is the pass that makes the shape
yours. See [[The Seven Rules]].

---

## Open questions

Business calls, not engineering ones — these are yours:

- **Should a *paused* offer 404 like a draft, or show a "no longer available" page?** Right
  now anything not `published` is a 404. A dedicated page is friendlier to a traveler
  following an old WhatsApp link, but it confirms the offer exists — acceptable for a
  paused public listing, arguably not for a draft. These may deserve different answers.
- **Should a view from the agency's own staff count in `recordView`?** Today it does. That
  inflates an agency's own numbers, and once ranking or pricing depends on views, it becomes
  an incentive to refresh your own page.
- **How long should a slug keep working after an offer is renamed?** Slugs are shared in
  WhatsApp messages that outlive the offer. Currently a rename breaks every old link.

---

Related: [[What the API Is]] · [[Multi-Tenancy]] · [[Validation at the Boundary]] ·
[[Authentication vs Authorization]] · [[The Seven Rules]] · [[The Shared Package]] ·
[[Local Setup]] · [[Offer]]
