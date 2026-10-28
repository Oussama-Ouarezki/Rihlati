# Templates and Pages

> [!success] Built — the public slice and the agency console
> Code: `apps/pages/` (views, forms, URLs) + `templates/`. Live: search → offer detail →
> inquiry form, the traveler's own trip page, and a console with the lead inbox, lead
> detail, the client directory and client page, offer editor, programme editor, trip
> manifest, bus check-in, settings, and the staff verification queue.

Django templates, server-rendered, no build step for the HTML. For a marketplace, SEO is
oxygen: an agency joins Rihlati so that someone googling « omra ramadan alger prix » finds
*their* offer. A client-rendered app is invisible to that search, which is why every page
here arrives as finished HTML.

> [!info] Django vs NestJS
> The NestJS repo has a separate Next.js application in `apps/web/`, talking to the API over
> HTTP with tokens in httpOnly cookies. Here the pages are **inside the same Django project
> as the API**, so they skip the network hop and query the ORM directly.
>
> That is a real simplification and a real loss, and both are worth naming:
> **gained** — no second deployment, no token plumbing, no duplicated types, and a session
> cookie Django already manages. **lost** — the API is no longer proved to be sufficient by
> the fact that the UI can only use the API. Here a page *could* quietly grow a rule the API
> does not have. [[One Rule, Two Entry Points]] is the note about how that is prevented.

---

## The two doors, and the one lock

The pages and the JSON API are **two doors onto the same models**. That is the whole
architectural bet of this port, and the failure mode it invites is obvious: a rule enforced
at one door and forgotten at the other.

The defence is that every rule that could drift lives in a module both doors import:

| Rule                               | Lives in                         | Used by                                     |
| ---------------------------------- | -------------------------------- | ------------------------------------------- |
| what a traveler may see            | `Offer.publicly_visible()`       | `search`, `offer_detail`, `POST /inquiries` |
| may this user touch this agency    | `apps/common/tenancy.py`         | every console view, every agency API route  |
| how many offers a plan may publish | `apps/common/quotas.py`          | the offer editor and `POST …/publish`       |
| what a valid phone number is       | `apps/common/validators.py`      | `InquiryForm`, `ClientForm` and the API schemas |
| how a list is filtered and sorted  | `OfferFilters` + `apply_filters` | the search page and `GET /offers`           |

The last one is worth staring at. `apps/pages/views.py::search` parses the query string into
the **same Pydantic schema the JSON API validates against**, then calls the same
`apply_filters`. A bad `?sort=` in the URL bar therefore fails identically in both places,
instead of one of them quietly ordering by a column of its own choosing.

> [!important] The navbar is not the security
> `base.html` hides the "Verification" link from non-staff, and `agency_settings.html` hides
> the verification form from a manager. **Neither of those is a permission.** The view behind
> each one re-derives it — `require_membership_or_404(...)`, `request.user.is_staff` — and
> `apps/pages/tests.py` asserts the manager gets a 404 when they POST the form they cannot
> see. Rule #2, in the only place it counts.

---

## The page map

**Traveler side — no account needed:**

| URL | View | Template |
|---|---|---|
| `/` | `search` | `pages/search.html` + `pages/_offer_card.html` |
| `/offers/<uuid>/` | `offer_detail` | `pages/offer_detail.html` + `pages/_programme.html` |
| `/mon-voyage/<code>/` | `my_trip` | `pages/my_trip.html` + `pages/_programme.html` |
| `/roadmap/` | `roadmap` | `pages/roadmap.html`, data in `apps/pages/roadmap.py` |

**Agency console — login plus a membership at the agency in the URL:**

| URL | What it is |
|---|---|
| `/dashboard/` | picks your agency, or `no_agency.html` if you have none |
| `/a/<agency>/offers/` | the catalogue, with quota state |
| `/a/<agency>/offers/new/`, `…/<offer>/` | the offer editor (manager) |
| `/a/<agency>/offers/<offer>/programme/` | the milestone editor + duplicate-day + copy-from |
| `/a/<agency>/offers/<offer>/manifest/` | who is actually going |
| `/a/<agency>/offers/<offer>/checkpoint/<milestone>/` | the 4am bus screen |
| `/a/<agency>/leads/`, `…/<lead>/` | the CRM inbox and one lead |
| `/a/<agency>/clients/`, `…/<client>/` | the client directory and one person |
| `/a/<agency>/settings/` | profile, verification submission (owner), quota |

**Staff:** `/verification/` — the FIFO queue, `request.user.is_staff` only.

Note the shape of the console URLs: **the agency id is in the path, always.** It is never
read from the session, never from a cookie, never from a hidden input. That is deliberate —
an id in the URL is an id the server must check, and a server that must check is a server
that does. An "current agency" stored in the session is the version of this that silently
serves the wrong tenant after someone opens two tabs.

---

## Templates worth reading before the rest

**`pages/_programme.html`** is included by three different pages — the public offer, the
traveler's trip, and the agency editor — because a programme that reads differently in the
agency's screen and the family's screen is how a group ends up at the wrong terminal.

Two things in it are load-bearing:

- **Times are printed exactly as stored**, never converted. `time_of_day` is a string, and
  04:30 must read as 04:30 to a family in Oran, an agent in Alger and a guide in Jeddah.
  Converting it is the bug, not the feature. See [[Trip Programme]].
- **"You are here" comes from ticked-off steps, not from the clock.** The bus leaves when
  the bus leaves. A marker driven by the current time confidently announces a departure that
  has not happened, which is exactly the moment a traveler stops trusting the page.
- **The road is drawn, not authored.** `static/road.js` measures the pins and draws one curve
  through them; each pin's emoji comes from `apps/pages/templatetags/programme.py`, which a
  test holds to `MilestoneKind` exactly. Card heights come from real content, so a hand-placed
  path would drift on the first long meeting point. Without the script the programme still
  renders over a straight band: the itinerary is content, the curve is decoration.

**`pages/my_trip.html`** is reached by a capability URL: the 32-hex code *is* the credential.
What is deliberately absent, and must stay absent: the passenger list, what anyone paid, and
any CRM note. The view sets `noindex`, and `base.html` renders the meta tag from that flag
rather than hardcoding it in one template — so the second such page cannot forget. A
capability URL that gets indexed is not a secret any more.

**`pages/agency_checkpoint.html`** is designed for one thumb, on a phone, in an airport, at
4am, on a bad connection. One card per family, one button per attendance status, and **no
JavaScript at all** — every tap is a plain form POST. A check-in screen that needs a working
connection to record a tap is a screen that loses the count.

---

**`pages/agency_client_detail.html`** is one person's whole history on one screen: profile,
notes, tags, trips, demands, and a merged chronology. The chronology is computed by
`_client_timeline` from `LeadActivity`, reservations and notes — a fourth activity table
would only be a third place for the same facts to disagree. The six-tab agency nav scrolls
horizontally on a narrow screen (`overflow-x-auto`) rather than wrapping into two rows, so
"Settings" stays reachable on a phone without changing the layout of the page below it.

---

## Decisions worth knowing

- **Filters are a plain GET form, zero JavaScript.** Filters land in the URL, so "Omra under
  300,000 from Oran" is a link someone pastes into the family WhatsApp group where
  everyone opens the same results. Client-side filter state feels smoother and loses exactly
  that. URL params are human units (DZD); the view multiplies by 100 into centimes — money
  never leaves the database as a float (see [[Offer]] on `price_centimes`).
- **Every form is a Django `Form`/`ModelForm`, never a hand-parsed `request.POST`.**
  `OfferForm` lists its fields explicitly, so `status`, `is_featured` and `quality_score` are
  simply not writable from a browser. Same discipline, same reason as the Pydantic schemas —
  see [[Validation at the Boundary]].
- **Sessions for pages, tokens for the API.** A browser gets Django's session cookie with
  CSRF; a mobile client gets a JWT. No token ever touches JavaScript here, because there is
  no JavaScript holding one. [[Auth Flow]] has the split.
- **Plain `<img>` for cover photos.** Agency photos are pasted URLs on arbitrary hosts. When
  uploads land there will be one domain and thumbnailing becomes worth doing — [[Image Uploads]].
- **The card is photo-first**: photo, price bold, agency + verified ✓. Photos sell trips, and
  the rest of the card answers the two questions asked before tapping — how much, and who is it.
- **`{% widthratio %}` draws the quota bar.** Thirty divs, not a charting library. "Less
  bloated" was the brief.

---

## Styling and RTL

Tailwind v4, compiled ahead of time to `static/app.css` by `npm run css`. That is the only
Node in this project, and it produces a CSS file — there is no JavaScript bundle, no
hydration, nothing to fail on a slow phone.

There is exactly one shipped script, `static/road.js`, and it draws the trip programme's
road through its pins. It is decoration, not structure: the steps, their text and their
emoji all render without it, over a straight band. It holds no state, fetches nothing, and
`prefers-reduced-motion` keeps the road while stopping the dashes.

Arabic flips the whole layout with **one attribute**: `dir="rtl"` on `<html>` in `base.html`.
That works only because the templates use logical utilities (`ms-*`, `me-*`, `ps-*`,
`text-start`) rather than `ml-*`/`text-left`. There is not one `[dir='rtl']` override in the
stylesheet, and that absence is the proof the rule is being followed. Retrofitting RTL is a
rewrite; the discipline is cheap only if it starts on day one.

> [!note] The interface is English-only, on purpose
> `LANGUAGE_CODE = "en"`, `LANGUAGES = [("en", "English")]`, and every template and view
> string is written in English. `BaseForm`/`StyledFormMixin` copy, validation messages, CRM
> activity labels, the assistant's system prompt and the seeded demo content all follow the
> same rule. Arabic offer titles remain content — they render inline with `dir="rtl"` — but
> the chrome around them is English.
>
> The URL `/mon-voyage/<code>/` keeps its French path deliberately: it is a capability URL
> already printed on itineraries, and changing it would break links in the wild. Treat it as
> a frozen identifier, not as copy.
>
> Adding French or Arabic later is a translation pass, not a redesign: wrap the strings in
> `{% translate %}`, run `makemessages`, and decide whether the language lives at `/ar/` or
> in a cookie. The URL is the better answer for the same reason the filters are: a forwarded
> link opens in the language the sender chose.

---

## Running it

```bash
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview   # fake data, no real names or numbers
.venv/bin/python manage.py runserver
npm run css:watch                          # only if you are editing classes
```

`seed_preview` prints the demo logins. It leaves one agency **pending** on purpose, so the
verification queue has something in it and the "unverified agencies are invisible" rule is
visible rather than merely asserted in a test.

---

## The visual language

Tailwind v4 tokens in `styles/input.css` define the whole system; templates compose classes
rather than writing one-off CSS.

- **Surfaces:** a warm paper canvas (`--color-canvas: #f7f5f0`) under white cards with a
  2xl radius and a very soft shadow. Warmth is restrained — sand tints live in eyebrows,
  empty-state icons and the hero band, never in a second accent colour.
- **One accent:** brand blue (`brand-50` … `brand-900`) for actions, links, focus rings and
  the active tab. Amber is reserved for attention ("due for a callback"), emerald for
  success, rose for destructive actions. A status is always a `pill` — colour plus text,
  never colour alone.
- **Type:** system font stack, tight tracking on headings, `text-balance` on h1–h3, and a
  three-step hierarchy: `.eyebrow` → `.page-title` → `.page-lede`.
- **Controls:** `.btn` is 40px minimum, `.field-input` carries a 4px focus halo, and every
  interactive element gets a visible `focus-visible` ring. The skip link is the first tab
  stop on every page.
- **Records:** `.data-table` above `md`, stacked record cards below it. The CRM never asks a
  phone user to pan a table sideways.
- **Empty states** are a dashed card with an icon, one sentence explaining what would appear,
  and a next action where one exists.
- **The road** keeps its own rules: it is decoration drawn over content, and it stops moving
  under `prefers-reduced-motion`.

**[[Interface Plan]]** holds the screen-by-screen critique that drove the pass.

---

## Open questions — yours to decide

- **French and Arabic UI.** The product ships English-only today. A second language is an
  i18n pass (see the note above), and the first decision inside it is URL prefix vs cookie.
- **The logo and the exact blue.** The brand colour is a `#1d4ed8` family, picked arbitrarily.
- **Sections or straight to the grid?** Should `/` show rows (Omra, voyages organisés) before
  any search, or the grid immediately? Currently: the grid.
- **Is the console usable on a phone?** The manifest and checkpoint screens were built for
  one, the lead inbox was not. Agencies in Algeria work from phones more than laptops.
- **No pagination on search.** Fine at four offers, wrong at four hundred. The API caps
  `limit` at 50; the page does not surface a next link yet.

---

Related: [[System Overview]] · [[One Rule, Two Entry Points]] · [[API Endpoints]] ·
[[Search and Filters]] · [[Trip Programme]] · [[Trip Manifest]] · [[Auth Flow]] ·
[[Interface Plan]] · [[CRM Redesign]] · [[The Seven Rules]]
