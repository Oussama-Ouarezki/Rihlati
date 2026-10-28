# Tracked Links

> [!success] Built
> Model and `resolve()`/`count_click()`: `apps/offers/models.py::TrackedLink`.
> Redirect: `apps/pages/views.py::tracked_link_redirect`, routed at `/l/{code}/`.
> Console: `/a/{agency}/links/` (`templates/pages/agency_links.html`).
> API: `GET`/`POST /api/agencies/{id}/tracked-links`.
> Tests: `TrackedLinkTests` in `apps/pages/tests.py` (13).

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

1. A manager creates a link → gets `rihlati.dz/l/a1b2c3d4` and copies it into a post. The
   code is **server-generated** (`TrackedLink.new_code()`). Letting the agency choose one
   means collisions, guessable codes, and a race on the unique index.
2. A traveler taps it. `/l/{code}/` is at the **root of the site's own domain**, not on an
   `api.` subdomain — a link that looks technical under a Facebook post looks like phishing,
   and travelers who have been scammed before do not tap it. The view counts the click and
   redirects **302**. Never 301: a permanent redirect gets cached by the browser, so from the
   second tap onwards the click never reaches the server, the counter freezes, and the agency
   concludes the post stopped working.
3. The destination carries `?ref={code}`.
4. The offer page puts that code in a **hidden input** on the inquiry form, so it survives
   the POST. The view resolves it → the lead gets a `tracked_link`, its `source` becomes
   `tracked_link`, and `lead_count` increments **in the same transaction as the lead**, so
   "3 clients" and the inbox can never disagree.
5. The inbox shows the campaign next to the client's name.

> [!note] Why a hidden input, not a cookie or a session
> A cookie would be sent on **every** request from then on — this is marketing metadata that
> exactly one request needs, and a cookie here drags a consent banner onto the page whose
> whole job is to load fast and be trusted. A server session would persist for weeks, so a
> visit in June would still credit March's post; that is not attribution, it is fiction.
> One visit, one form, one credited source.
>
> The obvious objection is that a hidden input is client-controlled. It is — and it buys
> nothing, because `TrackedLink.resolve(ref, agency_id=offer.agency_id)` is scoped to the
> agency being contacted. The worst a forged `ref` achieves is crediting a campaign that
> agency already owns.

> [!important] `count_click()` uses `F()`, not read-modify-write
> Two people tapping the same post in the same second is the *normal* case for this feature,
> and `link.click_count += 1; link.save()` reads a stale number and loses one of them. The
> database does the addition. Same reason, same shape as the `lead_count` update above.

## Counters, not a time series

Deliberately different from [[Offer Analytics]], which *is* daily. A tracked link **is its
own time bucket** — the "Ramadan post" link is Ramadan data — and the agency asks "which
post works", never "how did post X trend in March". Offer-level dailies already exist if
trend is what's wanted.

## What can go wrong, and what happens instead

| Situation | Behaviour | Why |
|---|---|---|
| The link has no offer (an agency advertising its page) | redirect to the catalogue | a campaign is not always about one departure |
| `ref` belongs to another agency | lead created, attribution silently dropped | agency B must not be credited for agency A's client |
| `ref` is garbage or the campaign is gone | lead created normally | a shared post outlives the campaign; a stale code must **never** cost an agency an inquiry |

Every row of that table has a test.

> [!warning] One row is currently wrong, on purpose
> An **unknown code 404s** today, where the design above says it should land on the home
> page. That link is printed in someone's Facebook post *forever*, and a 404 there is a lost
> customer who concludes the agency is fake.
>
> It is a 404 anyway because the alternative — silently redirecting every unknown `/l/…` to
> the catalogue — makes the route an open scanner: anyone can probe eight-hex codes and read
> "exists / does not exist" from the status. The honest fix is a friendly 404 template
> saying "cette campagne n'existe plus, voici nos offres", which is a page nobody has
> written yet. Listed below.

## Permissions

`manager` to create — a tracked link is a marketing asset carrying the agency's name in
public, not day-to-day agent work. Reading the list is member-level, because an agent
genuinely needs to know where a lead came from.

An agency cannot point a link at another agency's offer. The scoping lives in the **form's
queryset** (`Offer.objects.filter(agency=agency)`), not in a check after the fact — an
unscoped `ModelChoiceField` would happily validate a foreign id, and nothing downstream looks
at that value again. Same rule as everywhere: the tenant filter belongs in the query, so a
later edit cannot drop it. See [[Multi-Tenancy]].

**Not plan-gated yet.** The intended shape is free 2 / pro 50 / business unlimited — one link
proves the idea, a campaign per post is the paid use — but `quotas.py` has no link limit
today. See [[Plan Limits and Quotas]].

## Open questions — yours

- **Should clicks be deduplicated?** Today every tap counts, so one person refreshing
  inflates the number. Hashed-IP dedupe within an hour is ~10 lines. Trade-off: the count
  gets more honest and less flattering, and the flattering number is the one that sells the
  paid plan. That tension is the actual question.
- **The friendly 404 page** described in the callout above.
- **Deleting a campaign.** There is no delete at all right now. When there is, it must be
  soft — leads already attributed keep their source rather than having history quietly
  rewritten under an agency that is looking at last month's numbers.
- **QR codes** for printed posters and shop windows — the same links, rendered. Small.
- **UTM passthrough** if agencies also run Meta ads, so the two systems agree.

> [!note] A bug worth remembering from the NestJS build
> Attribution originally fetched the link by code and compared the agency id *afterwards*.
> The custom lint rule for rule #3 flagged it, and it was right. Here the same protection is
> the `agency_id=` argument to `resolve()` and the scoped form queryset — in the WHERE
> clause both times, never in an `if` after the row is already in hand.

---

Related: [[Offer Analytics]] · [[Lead]] · [[Plan Limits and Quotas]] · [[API Endpoints]] ·
[[Templates and Pages]] · [[Vision and Roadmap]] · [[The Seven Rules]]
