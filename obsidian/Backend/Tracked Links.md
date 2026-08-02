# Tracked Links

> [!success] Built
> Code: `apps/api/src/modules/tracked-links/`, `apps/web/src/app/l/[code]/route.ts`,
> console page at `/console/links`. Tests: `apps/api/test/tracked-links.e2e.test.ts` (11).

The question every agency asks and none can answer today: **"which of my posts actually
brings clients?"**

An agency creates a named link, pastes it under its Facebook or Instagram post, and Rihlati
counts two numbers — clicks, and how many of those became real inquiries.

---

## Clicks are vanity; clients are the number

The console shows the click count in grey and the **client count in brand blue, twice the
size**. That is not decoration: an agency optimising for clicks optimises for the wrong
thing, and the layout is the cheapest way to say so.

It is also **Rihlati's own sales pitch**. "Your Ramadan post: 40 clicks, 3 clients" is a
sentence no other channel gives an Algerian agency, and it is the argument for the paid
plan.

## The chain, end to end

1. Agency creates a link → gets `rihlati.dz/l/a1b2c3d4` and copies it into a post.
2. A traveler taps it. `/l/{code}` lives on the **web** domain (the one people see and
   trust — an `api.` subdomain in a Facebook post looks like phishing). The route is thin:
   it asks the API to count the click and say where to go, then redirects **302**. Never
   301 — a permanent redirect gets cached by the browser and the click stops being counted
   from the second tap onwards.
3. The destination carries `?ref={code}`. The page stores it in **`sessionStorage`**.
4. The inquiry form sends the `ref` back. The API resolves it → the lead gets a
   `trackedLinkId`, and the link's `inquiryCount` increments **in the same transaction as
   the lead**, so "3 clients" and the inbox can never disagree.
5. The inbox shows `↗ post Facebook Ramadan` next to the client's name.

> [!note] Why sessionStorage, not a cookie or localStorage
> A cookie would be sent to the API on every request — this is marketing metadata, not
> something the server needs unprompted. `localStorage` would persist for months, so a
> visit in June would still credit March's post; that is not attribution, it is fiction.
> One visit, one session, one credited source.

## Counters, not a time series

Deliberately different from [[Offer Analytics]], which *is* daily. A tracked link **is its
own time bucket** — the "Ramadan post" link is Ramadan data — and the agency asks "which
post works", never "how did post X trend in March". Offer-level dailies already exist if
trend is what's wanted.

## What can go wrong, and what happens instead

| Situation | Behaviour | Why |
|---|---|---|
| Code is unknown or the link was deleted | redirect to the home page | the link is printed in someone's post **forever**; a 404 there is a lost customer |
| The offer was paused or archived | redirect to that agency's filtered catalogue | a dead trip should still land somewhere useful |
| `ref` belongs to another agency | lead created, attribution silently dropped | agency B must not be credited for agency A's client |
| `ref` is garbage | lead created normally | a stale marketing code must **never** cost an agency an inquiry |
| Click counting fails | redirect proceeds | a metrics hiccup must not break a redirect a real traveler is waiting on |

Every row of that table has a test.

## Permissions and limits

`manager` to create — a tracked link is a marketing asset, not day-to-day agent work.
Reading the list is member-level. An agency cannot point a link at another agency's offer
(404), or it could farm clicks on a competitor's page.

Plan-gated by count: **free 2, pro 50, business unlimited** — one link proves the idea, a
campaign per post is the paid use. Deleting frees a slot; the delete is soft, so leads
already attributed keep their source rather than having history quietly rewritten.

## Bugs found while building this — both worth remembering

1. **The i18n middleware swallowed `/l/{code}`**, rewriting it to `/fr/l/{code}` — a page
   that does not exist, so *every* tracked link 404'd. Short links are excluded from the
   locale matcher now, with a comment saying why.
2. **My own ESLint rule caught a real weakness.** Attribution originally fetched the link
   by code and compared `agencyId` afterwards. The rule for CLAUDE.md #3 flagged it, and it
   was right: the check now lives in the WHERE clause, so a later edit cannot drop it.

## Open questions — yours

- **Should clicks be deduplicated?** Today every tap counts, so one person refreshing
  inflates the number. Hashed-IP dedupe within an hour is ~10 lines. Trade-off: the count
  gets more honest and less flattering.
- **QR codes** for printed posters and shop windows — the same links, rendered. Small.
- **UTM passthrough** if agencies also run Meta ads, so the two systems agree.

---

Related: [[Offer Analytics]] · [[Lead]] · [[Plan Limits and Quotas]] · [[API Endpoints]] ·
[[Web App]] · [[Vision and Roadmap]] · [[The Seven Rules]]
