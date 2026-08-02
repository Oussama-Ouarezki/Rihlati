# Web App

> [!success] Built — public slice AND the agency console
> Code: `apps/web/`. Live: search (card grid) → offer detail → inquiry form, plus
> `/connexion` and `/console` — lead inbox with stage tabs, lead detail (stage/quality/
> notes), the analytics dashboard (with the honest paid-plan lock screen), and the FAQ
> editor. All three languages, RTL included.
> Also live: **offer create/edit** for all seven kinds, the trip manifest and bus
> check-in, and tracked links.

Next.js, server-rendered. For a marketplace, SEO is oxygen: an agency joins Rihlati so
that someone googling "omra ramadan alger prix" finds *their* offer — a client-rendered
app is invisible to that search, which is why this is Next.js and not a plain React SPA.

---

## How it fits the system

The web app is **a client of the API like any other** — it holds no business rules and no
database access. Every request shape it sends and every response it renders is typed by
[[The Shared Package|@rihlati/shared]], so a field cannot exist in a form and not on the
server. The inquiry form even validates with the *same* function the API uses
(`normalizeAlgerianPhone`), so the browser can never accept a phone the server refuses.

Deleting the whole web app would remove pages, not possibilities: everything it can do,
anyone with `curl` could already do. That is rule #2 working as intended.

## The three languages

- **French default at `/`, Arabic at `/ar`, English at `/en`** (Decision 018). The locale
  lives **in the URL, not a cookie** — every language version has a shareable, indexable
  address, and a link forwarded on WhatsApp opens in the language the sender chose.
- Arabic flips the entire layout with ONE attribute: `dir="rtl"` on `<html>`. That works
  only because every component uses logical CSS (`ms-*`, `me-*`, `text-start`…) — there is
  not a single `[dir='rtl']` override in the stylesheet, and that absence is the proof the
  rule is being followed.
- All copy lives in `apps/web/messages/{fr,ar,en}.json` — including the labels for offer
  `attributes` ("Distance au Haram", "المسافة إلى الحرم"). Adding a language = one JSON
  file + one line in `src/i18n/routing.ts`.
- Phone/email inputs stay `dir="ltr"` even in Arabic — numbers read left-to-right
  everywhere.

## Design decisions worth knowing

- **Filters are a plain GET form, zero JavaScript.** Filters land in the URL, so "Omra
  under 300 000 from Oran" is a link someone pastes into the family WhatsApp group and
  everyone opens the same results. Client-side filter state would feel smoother and lose
  exactly that. URL params are human units (DZD, dates); one function translates them to
  API centimes.
- **The card grid** is the Marketplace-style layout you picked: photo, price bold in
  brand blue, agency + ★ + verified ✓. One accent color, white and slate for the rest.
- **Plain `<img>`, not `next/image`, for now** — agency photos live on arbitrary hosts,
  and next/image needs a domain allowlist. When uploads move to our R2 bucket there will
  be exactly one domain to allow; the switch is noted in `next.config.ts`.
- **The offer page shows the agency's [[Agency Chatbot|FAQ]]** — same entries the chatbot
  will answer from. A failed FAQ fetch renders nothing; garnish never 500s the page.
- **Contact buttons fire the [[Offer Analytics|metrics beacon]]** with `keepalive`, so the
  tap is counted even though it navigates away — and a beacon failure never blocks the
  contact.

## The session (built)

**No token ever exists in browser JavaScript.** Login is a server action that stores both
tokens in httpOnly cookies; console reads are server components and writes are server
actions, each attaching the Bearer header server-side; refresh rotation runs in the
middleware. Full reasoning and the rejected alternatives: the "web app session" section
of [[Auth Flow]] (Decision 019).

The console itself follows one pattern worth naming: **the web app is a courier, not a
decision-maker.** A stage change is a form post to a server action that forwards to the
API — which re-checks membership, agent scoping and plan gates as it would for any caller.
The analytics page doesn't decide whether the agency may see stats; it renders whatever
the API answers, including the `402` upsell screen for free plans.

## One form, seven offer kinds

The offer form's second half is **generated** from `OFFER_ATTRIBUTE_FIELDS` in
[[The Shared Package|@rihlati/shared]]: a declarative list of what each kind asks for,
rendered as text/number/checkbox/select/multiselect/tags inputs. Labels come from the
`attr.*` and `attrValues.*` i18n keys the public offer page already uses — so the whole
form exists in French, Arabic and English for free.

That list restates what the Zod schemas know, which is duplication. It is safe because a
test pins the two together: every descriptor field must exist in the matching schema, and
`required` must agree. Get them out of step and the build fails, not production.

Consequence worth knowing: **adding an offer kind never means writing a form.** Declare
its fields and the UI appears.

`buildAttributes()` converts the form's strings into the schema's types, and drops empty
values rather than sending `""` — the schemas are `.optional()`, not `.nullable()`, so an
empty box must vanish. Unchecked boxes send nothing at all rather than `false`, because
"not included" rows are noise on the offer page.

## What is deliberately NOT here yet
- **Caching.** Every page fetch is `no-store`: stale inventory is worse than a slower
  page, and real caching should follow measured numbers, not guesses.
- **next/font, animations, component libraries.** "Less bloated" was the brief. System
  fonts render Arabic and French well on every phone in Algeria. The analytics chart is
  thirty flexbox divs, not a 100 kB charting library.

## Running it

```bash
npm run dev:api   # terminal 1 — the API on :4000
npm run dev:web   # terminal 2 — the web on :3000
```

> [!warning] Port 3000 may be busy on your machine
> Something else was already listening on 3000 during testing. If `dev:web` fails with
> `EADDRINUSE`, run `npx next dev -p 3100` inside `apps/web` instead.

## The visual layer is the least finished part

Stated plainly because it is true: this UI is **functional, not designed**. It was built to
prove the flows work — default Tailwind spacing, system fonts, no rhythm. That was the
right order, but it means the surface is the weakest thing here, and in a market where
travel scams are a recent memory, the interface *is* the trust signal.

**[[Interface Plan]]** is the written-down design pass: screen by screen, what is wrong,
what good looks like, and the order to do it in. Start there, not here.

## Open questions — yours

These block the design work, so they are the ones worth answering first (the full list
lives in [[Interface Plan]] §9):

- The **logo and exact blue**. Current brand colour is `#1d4ed8`-family, picked arbitrarily.
- Should the home page show **sections** (Omra row, Voyages organisés row) before any
  search, Marketplace-style, or go straight to the grid? Currently: straight to the grid.
- English: keep as best-effort, or drop until there's demand? It costs a third of every
  copy change — and triples the design work.

---

Related: [[System Overview]] · [[The Shared Package]] · [[Search and Filters]] ·
[[Offer Analytics]] · [[Auth Flow]] · [[Vision and Roadmap]] · [[The Seven Rules]]
