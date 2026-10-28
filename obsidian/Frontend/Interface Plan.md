# Interface Plan

> [!info] What this note is
> The design pass, written down before it starts, so nothing gets dropped and a fresh
> session can pick it up cold. Nothing here adds features — every screen listed already
> works. This is about whether it looks like something you'd hand 400 000 DZD to.
>
> Status: **executed 2026-10-28** — whole product, English-only. The plan below is kept as
> the record of what was wrong and why; [[Templates and Pages]] describes the system that
> replaced it. Every screen was rebuilt on the tokens in `styles/input.css`: warm paper
> canvas, white 2xl cards, one brand-blue accent, sand tints for warmth, visible focus rings,
> a skip link, 44px touch targets, semantic status pills, empty states with a next action,
> and desktop tables that become stacked record cards under `md`.

The honest starting position: the current UI is **functional, not designed**. It was built
to prove the flows work, with default Tailwind spacing, system fonts and no rhythm. That
was the right order — but it means the visual layer is the least considered part of the
whole project.

---

## 1. Why this matters more here than in most apps

Rihlati asks a stranger to trust an agency with the price of a car, for a trip they cannot
inspect in advance, in a market where travel scams are a real and recent memory. **The
interface is the trust signal.** An agency's own Facebook page looks amateur; if Rihlati
looks the same, it has added nothing.

That gives one test to apply to every decision below:

> Does this make a nervous first-time buyer feel like an adult is running this?

---

## 2. Principles (settled — do not relitigate)

| Principle | Where it came from |
|---|---|
| **Blue and white, minimal** | your call, 2026-08-01 |
| **Card grid, Facebook-Marketplace-familiar** | your call — Algerians already know it |
| **Less bloated** | your call — fewer widgets, more offers |
| **Mobile is the primary device** | most Algerian travelers browse on a phone |
| **Arabic is a first-class design target, not a translation** | [[Decision Log]] 018 |
| No component library, no animation library | keeps the page honest — this frontend ships one CSS file and almost no JavaScript |

---

## 3. Phase 0 — the design system (do this FIRST)

Everything after this is cheap; skipping it means every screen re-invents spacing and the
result never coheres. All of it lives in one place: the `@theme` block in `styles/input.css`,
compiled to `static/app.css` by `npm run css`.

### 3.1 Colour ☐

Today: `brand` blue plus Tailwind defaults, chosen without thought.

Decide and record:

- **Brand blue** — one hue, 5 steps (50/100/200/600/700/800 exist; audit whether all are used)
- **A single accent for money/price** — currently `brand-700`; consider whether price
  deserves its own colour so it reads instantly in a grid
- **Semantic set**: success (checked-in), warning (pending review, suspected duplicate),
  danger (no-show, spam label), neutral. These are used ad-hoc today — inline `bg-emerald-50`
  / `bg-amber-50` / `bg-rose-50` classes scattered through `_offer_card.html`,
  `agency_manifest.html` and the status pills. **Unify them into component classes** next to
  `.field-input`, which is already the precedent: a style used on three pages belongs in
  `@layer components`, not typed a fourth time.
- **Dark mode: explicitly NOT doing it.** Say so here so nobody starts.

### 3.2 Typography ☐

Today: system font stack, default Tailwind sizes. This is the single biggest "looks cheap"
lever.

- Choose **one** font that renders Latin *and* Arabic well. Candidates worth testing:
  IBM Plex Sans Arabic, Noto Sans Arabic, Cairo, Rubik. **Self-host it** — drop the woff2
  into `static/` and declare `@font-face` in `styles/input.css`. No Google Fonts CDN: one
  fewer third party, no request leaving the country on every page load, and faster in
  Algeria.
- Define a **type scale** — 5 sizes, not 12. Display / heading / body / small / caption.
- **Arabic needs different metrics.** Latin line-height that looks airy is cramped in
  Arabic; Arabic often wants ~1.15× the Latin size and more line-height. Set this per
  `:lang(ar)`, not per component.
- Decide numerals: Western (0123) or Eastern Arabic (٠١٢٣) in the AR locale. **Prices and
  phone numbers should almost certainly stay Western** — but that is a real decision, and
  currently it is an accident.

### 3.3 Spacing, radius, elevation ☐

- One spacing rhythm (4px base). Audit: cards currently mix `p-3`, `p-4`, `p-5`.
- One radius scale. Currently `rounded-xl` and `rounded-2xl` are used interchangeably.
- Shadows: currently only `hover:shadow-md` on cards. Decide whether elevation means
  anything in this design, or whether borders carry it. Pick one — mixing both is what
  makes an interface feel unresolved.

---

## 4. Phase 1 — the screens, in order of how many people see them

### 4.1 The offer card ☐ — **highest leverage component in the app**

`templates/pages/_offer_card.html`, included by both the search grid and anywhere else a
listing appears. Every visitor sees dozens of these; it decides whether the grid reads as a
marketplace or a spreadsheet.

Problems now:
- Photo has no fallback treatment beyond a grey ✈ — an offer with no photo looks broken
- The price, agency name, rating, verified tick and departure all compete at similar weight
- The `seats_left` urgency badge appears at ≤10 with no visual hierarchy
- Nothing indicates offer *kind* except a small chip

Good looks like: photo dominant; **price unmistakably the second thing you read**; agency
+ verified badge as quiet trust signal; one urgency cue maximum. Test it by squinting —
price and photo should survive.

### 4.2 Search / home ☐

`templates/pages/search.html`, rendered by `views.search`.

- The filter bar is **11 controls in a row**. On mobile it wraps into a wall. Needs to
  collapse into "Filtres" opening a sheet, with 2–3 quick chips visible (Type, Destination).
- No result count ("124 offres") — people need to know the filter did something.
- No sort control visible on mobile.
- Empty state is one grey sentence; should suggest *which* filter to relax.
- **Keep filters in the URL.** That is deliberate ([[Templates and Pages]]) and must survive the redesign.
- Consider: themed rows before any search (Omra / Voyages organisés / Visas), Marketplace-style.
  ← **open question, your call** (currently: straight to grid)

### 4.3 Offer detail ☐

`templates/pages/offer_detail.html`, rendered by `views.offer_detail`.

- Single hero image only, and there is not even an array to draw from: `cover_image_url` is
  one `URLField`. A gallery needs the schema change described in [[Image Uploads]] first.
- The attributes list is a flat two-column dump of the `attributes` JSON. For Omra this is the
  *comparison table* buyers actually decide on — group it: Hébergement / Transport /
  Inclus / Groupe.
- **Distance to the Haram is buried in that list.** It is arguably the single most
  important number in this market and deserves promotion to the hero facts.
- The inquiry form sits at the bottom of a long page with no sticky call-to-action on
  mobile. Needs a sticky bar: price + "Demander" + WhatsApp.
- **There is no FAQ section**, styled or otherwise — no FAQ table exists (see
  [[Agency Chatbot]]). The questions travelers repeat are currently answered one WhatsApp
  message at a time.

### 4.4 Inquiry form ☐ — **the only conversion event**

The form at the bottom of `offer_detail.html`, posting to the same view. Every point of
friction here costs a real lead.

- Errors appear only after submit — which, with a server-rendered form, means a full round
  trip and a scroll back to find the red text. Live phone validation on blur is the one place
  a few lines of JavaScript clearly earn their keep.
- No visible progress/disabled feedback beyond text change.
- Success state replaces the form — good — but gives no next step ("voir d'autres offres").
- The consent checkbox is legally load-bearing ([[Lead]]); it should look deliberate, not
  like fine print, without being alarming.

### 4.5 Login / signup ☐

`templates/pages/login.html` — and the signup pages that **do not exist yet**: there is no
self-service registration at all, for travelers or for agencies. Every account today is made
with `manage.py createsuperuser` or in the Django admin. Design login and signup together so
the entry experience is one thing rather than two eras.

### 4.6 The agency console ☐

> [!important] The CRM half is already decided — see **[[CRM Redesign]]**
> The owner said "I don't even get it" about the client screen, which is the strongest
> usability signal this project has had. That note holds the fix: an "Aujourd'hui" work
> screen instead of a table, five stages instead of eight, and quality labels that stop
> competing with stages. Do that first; the styling below folds into it.

`templates/pages/agency_*.html`, all extending `agency_base.html`. Different audience,
different rules: this is a **work tool** used daily, so
density is a feature, not a flaw. It should feel closer to a spreadsheet than to the
marketplace.

- The nav is 6 text links that will not fit a phone. Needs a proper responsive pattern.
- The lead inbox is a flat list; on mobile the row wraps badly. Consider card-per-lead
  below `sm`.
- The stats bar chart is thirty flexbox divs with no axis, no labels, no tooltip beyond
  `title`. Either give it axes or state plainly it is a sparkline.
- The manifest check-in screen is **already the most considered screen in the app** (built
  for one hand at 4am). Use it as the quality bar for the rest.

---

## 5. Phase 2 — cross-cutting ☐

| Item | Why |
|---|---|
| **Mobile audit, every screen** | primary device; nothing was designed phone-first |
| **Loading states** | a server-rendered page has no spinner state to design — but a slow POST has no feedback at all today, and a double-submitted inquiry is a duplicate lead |
| **Empty states** | every list needs one that says what to do next, not just "rien" |
| **Error states** | `DEBUG=False` still serves Django's stock 500 page, unstyled. A `500.html` and `404.html` in `templates/` is an hour of work |
| **404** | exists, minimal |
| **Focus states / keyboard** | never audited; forms must be usable without a mouse |
| **Contrast check** | slate-400 on white is used for meaningful text in places — likely fails WCAG AA |
| **Touch targets** | 44px minimum; several console buttons are smaller |
| **`prefers-reduced-motion`** | if any animation is added |

---

## 6. Phase 3 — brand ☐

- **Logo.** None exists; the header is the word "Rihlati" in brand blue.
- **Favicon, OG image.** No OG image means every WhatsApp share looks like a broken link —
  and WhatsApp is how this market shares things. **Arguably the highest-value item in this
  whole note.**
- Per-offer OG images (title + price + photo) would make shared links sell themselves.

---

## 7. Definition of done for the design pass

- [ ] One `@theme` block holds every colour, size and radius; no ad-hoc values in templates
- [ ] Every screen usable at 360px wide
- [ ] Arabic checked visually on every screen, not just RTL-correct
- [ ] Every list has an empty state; `404.html` and `500.html` exist and are styled
- [ ] Browser screenshots updated **deliberately** and the diffs reviewed — see the warning
      below
- [ ] Lighthouse mobile ≥ 90 performance, ≥ 95 accessibility
- [ ] Still almost no JavaScript: any script added is a deliberate, named exception

> [!danger] There are no screenshot tests to fail
> Rule 7 asks for browser coverage with visual assertions on the five pages that matter —
> search, offer detail, inquiry submission, the agency lead inbox, login. **None of it exists
> in this port.** So a design pass here has nothing catching an accidental change, and the
> honest sequence is: build that coverage first, take the baselines, *then* redesign. Doing it
> the other way round means every diff is unreviewable because everything moved at once.
>
> When it does exist: **do not** blanket-update baselines. Review each diff, confirm the
> change was intended, then update. Forcing you to look is the entire value. See
> [[The Seven Rules]] rule 7.

---

## 8. What NOT to do

- No component library (MUI, shadcn, Chakra). "Less bloated" was the brief, and this
  frontend currently ships essentially no JavaScript at all. Copy a pattern, don't import a
  framework — and note that most of what a component library sells is interactivity a
  server-rendered page does not need.
- No animation library. CSS transitions only, sparingly.
- No dark mode.
- No redesign of the **data model** dressed up as a design change — if a screen needs a
  field that does not exist, that is a separate task, decided separately.
- No carousels on the search grid. Marketplace shows a grid; the grid works.

---

## 9. Open questions — yours

1. **Logo and exact brand blue.** Everything in Phase 0 waits on this. Current blue is
   `#1d4ed8`-family, picked arbitrarily by me.
2. **Home page: straight to the grid (current), or themed rows first?**
3. **Arabic numerals:** Western `123` or Eastern `١٢٣` for prices and dates in the AR locale?
4. ~~**English:** keep at best-effort, or drop it?~~ Settled: the interface is English-only
   (owner's call, 2026-10-28). A second language is a future i18n pass, not a mixed-language
   UI.
5. **Font budget:** a self-hosted Arabic+Latin family is ~150–250 kB. Acceptable, or stay
   on system fonts and spend the weight elsewhere?

---

Related: [[Templates and Pages]] · [[Search and Filters]] · [[Offer Analytics]] · [[Trip Manifest]] ·
[[The Seven Rules]] · [[Vision and Roadmap]] · [[Decision Log]]
