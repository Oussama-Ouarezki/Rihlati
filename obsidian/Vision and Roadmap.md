# Vision and Roadmap

> [!info] What this note is
> Your product vision (as told on 2026-08-01), turned into a structured plan. When the
> vision changes, this note changes — tell me and I'll keep it true. Anything marked
> **your call** is a business decision I will not invent.

**One sentence:** a centralized, easy-to-navigate marketplace where Algerian travelers find
verified agency offers — and where agencies get leads plus a client-management system good
enough to run the whole rihla, from reservation to the bus seat.

---

## Who pays, and for what — the three revenue pillars

**1. Offer quotas → subscriptions.** Already enforced ([[Plan Limits and Quotas]]). Free
plan is capped; publishing more offers is the first reason to pay.

**2. Consented introductions of high-intent clients.** The consent trail is already built
into every [[Lead]] precisely so this is legal to sell later.

**2b. Prepaid credits → promotion.** Buy credits once, spend them on promoted listings,
agency placement, or the subscription itself. Designed in [[Credits and Promotion]] — and
the shape is forced by Algeria's rails: one manual CCP/BaridiMob confirmation, then many
automatic deductions. Comes with a product risk stated plainly in that note: what you sell
(visibility) competes with what travelers come for (an honest comparison), so promoted
slots must be labelled, capped, and never able to override a trust signal.

> [!warning] The legal line — verify before building
> *Per-agency* tracking of a client's spending and behaviour is that agency's own CRM data.
> *Cross-agency* aggregation — "this phone number is a high-ticket client, pay to know
> that" — is trading in personal data under Law 18-07 and needs a lawyer's sign-off
> **before** it is built, not after. Until then, everything stays per-agency.

**3. Premium client management.** The manifest, tracked links, analytics, export. This is
the pillar you chose to build first, and it is the right one: a tool an agency opens every
day is a tool it will pay to keep.

### The middle-plan anchor

You want three plans with the middle one the obvious buy. The standard mechanics:

- **Free** exists to create inventory — enough to exist, never enough to run a business on.
- **Pro** contains *everything an agency actually uses daily* — the manifest, tracked
  links, assignment, export. One agency's monthly value, priced at "one client's worth".
- **Business** is unlimited + prestige extras, priced high **partly so Pro looks cheap**.
  Some agencies will buy it anyway; its main job is being the anchor.

The gates live in one file — `packages/shared/src/plans.ts`, yours to edit. **The DZD
prices are your call** and don't exist in code yet.

---

## The account model (settled)

Exactly what you asked for, and already built: one person registers, creates the agency,
becomes its `owner`, and invites staff as `manager` or `agent` (your "moderators"). The
same account can be a traveler at the same time — no second login. See [[User]] and
[[Agency]]. The signup survey will decide which experience to show first.

---

## Feature map

### Built and tested today

Search with price/destination/date filters ([[Search and Filters]]) · offer pages · public
inquiry with consent ([[Lead]]) · lead inbox with stages and quality labels
([[Client Quality Labels]]) · offer quotas ([[Plan Limits and Quotas]]) · spam flagging
([[Duplicate and Spam Control]]) · agency verification flow · [[Auth Flow]] ·
[[Audit Log]] · agency FAQ (the [[Agency Chatbot]]'s future knowledge base) ·
**time-series post analytics** — views/WhatsApp taps/calls/inquiries per offer per day,
collecting for every agency from day one ([[Offer Analytics]]) · the **[[Trip Manifest]]**
— your differentiator, reservation per family with headcount, 🟡🟢🔴 bus check-in from a
phone, CRM→manifest bridge · **[[Tracked Links]]** — named links for your Facebook and
Instagram posts, with the click→client number that is also your sales pitch · the web app
itself ([[Web App]]): public marketplace + a fully self-service agency console in three
languages — offers, leads, manifest, links, stats, FAQ · 178 tests.

### Next, in your chosen order

**1. The core web slice** — search (card grid) → offer page → inquiry → inbox → login.
Nothing else matters until this loop works end to end in a browser.

**2. ~~Trip manifest & bus check-in~~ — BUILT.** See [[Trip Manifest]].

**3. ~~Tracked share links~~ — BUILT.** See [[Tracked Links]].

**3b. [[Trip Programme]]** — the itinerary as a milestone timeline, with per-checkpoint
attendance: agencies build and tick it, buyers compare it, travelers open "votre prochaine
étape" to find the 4am meeting point, guides get a per-stop headcount. Schema + API built
(2026-08-01); console UI and the traveler page not built yet.

**4. ~~Google login~~ — BUILT** (needs your credentials to switch on) · **5. Signup survey + plan restructure** · **6. Traveler accounts &
saved offers** · **7. Reviews UI** (backend already supports verified reviews).

### Later (designed-for, not built)

Payments and the credit ledger (local rails — CIB/Edahabia via PSP, manual CCP/BaridiMob;
**verify providers**) · promoted listings and the top-agencies page — designed in
[[Credits and Promotion]], fields already in the schema · cross-agency client reputation (**lawyer first**) ·
WhatsApp Business API (wa.me links come free, the API is a project) ·
the **[[Agency Chatbot]]** — you're building this one yourself; the room is prepared (FAQ
table + endpoints live, plan flag exists, full build guide in that note) ·
mobile app (Expo; the API is already the hard part).

---

## Design direction (settled 2026-08-01)

- **Card grid, Marketplace-style.** Photo-first cards, filter chips on top — the pattern
  Algerians already know from Facebook Marketplace. Photos sell trips.
- **Blue and white, minimal.** Fewer widgets, more offers.
- **French by default**, with Arabic (RTL) and English in a language switcher. Every
  string goes through i18n keys ×3 — FR and AR are the contract, EN may lag behind.
  RTL is why the CSS uses logical properties everywhere; that was decided on day one.
- Offer audience tags (familial / hommes / femmes / couples…) as a **curated filterable
  list**, extended the same way offer kinds are — free-form tags can come later but can't
  be filtered efficiently.

---

## "Collect as much data as possible" — with two guard-rails

Yes to **behavioural** data: searches run, filters used, offers viewed, links clicked,
click→inquiry conversion, response times. That's what feeds agency analytics and your own
product decisions, and it's cheap to collect from day one.

Guard-rails:
1. **Behaviour, not identities.** IPs stored hashed, phones masked in logs — rule #4 in
   [[The Seven Rules]] already enforces this mechanically.
2. **Data about identifiable people** (spending per phone number, cross-agency profiles)
   is Law 18-07 territory — per-agency only until a lawyer says otherwise.

---

## Open questions — yours

- DZD prices for the three plans, and what exactly Business adds beyond "unlimited".
- The signup survey questions (storage will be versioned JSON — you can change questions
  without a migration).
- English: full translation or best-effort? FR/AR stay the contract either way.
- Cross-agency client reputation: what, exactly, would you want an agency to be able to
  see about a stranger's phone number? Write the sentence, then we ask a lawyer if it's legal.

---

Related: [[Plan Limits and Quotas]] · [[Client Quality Labels]] · [[Lead]] ·
[[Search and Filters]] · [[API Endpoints]] · [[Decision Log]] · [[The Seven Rules]]
