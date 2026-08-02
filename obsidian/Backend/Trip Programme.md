# Trip Programme (milestones)

> [!info] Status: **built end to end** (2026-08-02) — schema, API, console editor with
> tick-off, the offer-page map, and the traveler page. Remaining polish in §8, item 6.
> An offer's programme used to be one free-text blob in `Offer.description`. It is now a
> structured list of **milestones**, which the agency edits as a list and every client reads
> as a **map** — a serpentine path of nodes, split by day, showing where the group is.

---

## 1. Why this earns its place

Omra and Hajj are not "a holiday". They are a **schedule** — and travelers care about it
with an intensity you do not see in normal tourism. Three concrete problems today:

1. **Buyers compare programmes, not prices alone.** "9 nuits Mecque / 5 Médine, ziyarat
   incluses" is the product. As a wall of text it cannot be compared between two agencies.
2. **"Where do we meet?" is answered by WhatsApp voice note at 23h the night before.**
   Every agency does this. It is the single most repeated question in the business, and it
   gets asked once per family.
3. **During the trip nobody knows what is next — or who's actually there.** The traveler
   asks the accompagnateur; the accompagnateur repeats himself forty times. And he is
   personally responsible for every family on the trip, so at any stop that matters — the
   airport, the return bus — he needs a real headcount, not a guess.

One structured list fixes all four, because the same data serves all four needs.

---

## 2. Three audiences, one list

| Who | When | What they need |
|---|---|---|
| **Buyer** | before paying | the whole programme, comparable, on the public offer page |
| **Agency / guide** | while building the offer, then during the trip | edit the milestones; **tick them off** as they happen; at the stops that matter, **check off every family by name** (§6) |
| **Traveler** | during the trip | *what is next, at what time, and where exactly do I stand* |

Same rows. Different views. That is what makes it worth building rather than three features.

---

## 3. The data

One offer is one departure in this model (that is how [[Trip Manifest]] already works), so
milestones hang off the offer.

```prisma
enum MilestoneKind {
  meeting      // rendez-vous — the one that matters at 4am
  transport    // bus, transfer
  flight
  hotel        // check-in / check-out
  ritual       // omra, tawaf, sa'i — the point of the trip
  ziyara       // visits
  meal
  free_time
  other
}

/// Set per milestone by the agency when they build the programme. See §6.
enum CheckpointType {
  none        // informational only — no attendance tracked (most milestones)
  mandatory   // must check in fresh every time — never defaults to no_show
  optional    // attendance tracked; a no_show can default forward to the
              // next optional checkpoint — see §6
}

model OfferMilestone {
  id       String @id @default(uuid(7))
  agencyId String              // denormalized tenant key (rule #3)
  offerId  String

  title       String
  description String?
  kind        MilestoneKind @default(other)

  /// Day of the trip. 0 = departure day. Combined with Offer.departureDate
  /// this becomes a real date WITHOUT storing one — see §4.
  dayOffset Int     @default(0)
  /// "04:30". Null means "sometime that day", which is honest and common.
  timeOfDay String?

  locationName String?   // "Aéroport Houari Boumediene"
  /// The sentence a traveler reads at 4am. Be specific: "Terminal 1,
  /// porte 3, à côté du café" — not "l'aéroport".
  meetingPoint String?
  mapUrl       String?   // a plain maps link; no SDK, no API key

  sortOrder Int @default(0)

  checkpointType CheckpointType @default(none)

  /// Ticked by the agency as the trip actually happens — drives the public
  /// "vous êtes ici" marker. Independent of per-family attendance (§6): the
  /// group can move on even if one family is still being chased down.
  completedAt       DateTime?
  completedByUserId String?

  @@index([offerId, dayOffset, sortOrder])
  @@index([agencyId])
}
```

`Offer.description` **stays** — as a short prose introduction. The milestones become the
programme section beneath it.

---

## 4. Why `dayOffset`, not a date

Storing an absolute datetime per milestone looks simpler and is worse:

- An agency builds the programme **before** fixing the departure date, or reuses last
  season's. `dayOffset` makes the programme a reusable template.
- When the departure moves by three days — which happens — you would otherwise edit twelve
  rows by hand and get one wrong.
- With `Offer.departureDate` set, `dayOffset + timeOfDay` renders as a real date. One
  source of truth, no drift.

> [!note] Timezone
> `timeOfDay` is **local to where the traveler is standing** — Algiers for the departure,
> Saudi time once there. Do not convert. A programme that says "04:30" must say 04:30 to
> everyone reading it, and quietly shifting it by an hour is how people miss a bus.
> Store the string; label the day with the destination when it differs.

---

## 5. How the traveler sees it — and the security decision

A traveler has usually **not got an account** (that is deliberate — [[Lead]] works without
one). So the trip page cannot be behind a login.

**Capability URL:** each [[Trip Manifest|Reservation]] gets a random `publicCode`, and
`/mon-voyage/{code}` shows that traveler their trip. The agency sends the link once, by
WhatsApp, on confirmation.

What that page shows:

- **Next milestone, large** — the one thing they opened it for
- Meeting point, time, and a map link
- The full programme below, with completed steps ticked
- The agency's phone / WhatsApp button

> [!danger] What that page must NEVER show
> A capability URL is guessable-by-sharing: whoever has the link, has access. That is
> acceptable **only** because the page contains this traveler's own booking and a
> programme that is already public.
>
> It must not contain: **the passenger list**, other travelers' names or phones, prices
> paid, or CRM state ([[Client Quality Labels]] — imagine a traveler seeing they are
> labelled `troll`). The code must be ≥128 bits of randomness, and the endpoint rate
> limited. If it ever needs to show more, it needs real auth instead.

---

## 6. Per-checkpoint attendance

The guide is personally responsible for everyone on the trip, so at some stops he needs to
know — by name — who's actually there. That's a different question from "is this family
still booked" ([[Trip Manifest|Reservation.status]], untouched by any of this): it's
*"did this specific family show up to THIS specific stop"*, asked again at every stop that
matters.

**`checkpointType` is set per milestone, by the agency, when they build the programme** —
so it is exactly as customizable as the milestone list itself. Most milestones stay `none`
(no attendance tracked at all — a ziyara description, a meal). The agency marks the stops
that need a headcount as `mandatory` or `optional`:

- **`mandatory`** — a flight, the departure bus, the return bus. Every family must be
  checked in **fresh** here, every time. This never auto-guesses; a wrong default at a
  mandatory stop can mean a family left behind.
- **`optional`** — an excursion, a ziyara, anything a family can reasonably skip (they
  stayed at the hotel, or switched hotels mid-trip). Missing one of these is normal, not a
  red flag.

**A family's attendance is stored once per (checkpoint, family)** — `MilestoneCheckIn` —
not on the reservation itself, so a family can be `checked_in` for the outbound flight and
still `expected` (not yet arrived) for a ziyara three days later. Same 🟡🟢🔴⚪ vocabulary,
same free any-status-to-any-status transitions, same audit-log accountability as the
existing manifest.

> [!note] The one default that carries forward
> If a family is `no_show` at one **optional** checkpoint, the next optional checkpoint
> defaults to `no_show` too, instead of the guide having to re-mark the same absent family
> at every single stop. It's only ever a *default* — one tap (**"push them back"**) flips it
> to `checked_in` the moment they show up again, and that only affects that one checkpoint.
> `mandatory` checkpoints never inherit this — they always start fresh at `expected`.

```prisma
/// One family's attendance at ONE checkpoint milestone. Created lazily — the
/// first time a guide opens that checkpoint's list for that family — never
/// pre-created for every reservation, so adding a checkpoint mid-trip needs
/// no backfill.
model MilestoneCheckIn {
  id            String @id @default(uuid(7))
  agencyId      String              // denormalized tenant key
  milestoneId   String
  reservationId String

  status ReservationStatus @default(expected)   // reuses the manifest's enum

  checkedInAt       DateTime?
  checkedInByUserId String?

  @@unique([milestoneId, reservationId])
  @@index([agencyId])
  @@index([reservationId])
  @@index([milestoneId, status])
}
```

See [[Decision Log]] #019 for why `Reservation.status` was deliberately left alone rather
than redefined to carry this.

---

## 7. The UI

> [!important] The client interface is not the agency interface
> The agency is **editing a schedule**: it wants density, ordering, every field, and the
> attendance screens. The client is **reading a journey**: it wants the shape of the trip
> and one answer — what happens next.
>
> Same rows, two products. The agency keeps the list editor at
> `/console/offers/{id}/programme`. Every client-facing surface gets the **programme map**
> below. Building one component for both audiences was tried on paper and rejected: the
> shared thing would have been a list with half its columns hidden, which serves neither.

### 7.1 The programme map — `ProgrammeMap.tsx`

What both client surfaces render. Not a list: a **serpentine path of nodes**, scrolled
vertically, one node per milestone.

```
      Jour 1  10 févr.
                  ( ✓ )
              ┌───────────┐
              │  Réunion  │
              │   18:00   │
              └───────────┘
      Jour 2  11 févr.
                        ( ✓ )
                    ┌───────────┐
                    │  Départ   │
                    │   04:30   │
                    └───────────┘
                  (( 🏨 ))  ← current: day colour, halo, slow pulse
              ┌───────────┐
              │Installation│
              └───────────┘
               [Vous êtes ici]
      Jour 3  12 févr.
            ( 🕋 )
        ┌───────────┐
        │   Omra    │
        └───────────┘
```

Why each piece is the way it is:

- **A path, not a list.** A 15-day Omra is forty rows of text. As a path you see the shape of
  the trip — how many days, where the weight is, how far along the group is — before reading
  a single word.
- **The wave runs across the whole programme, never restarting per day.** The first attempt
  restarted the cycle at each day and it looked broken: an Omra with one step on most days put
  every node dead centre and no snake appeared at all. The path is continuous, so its geometry
  has to be.
- **Days are marked by a chip at the edge and by colour**, not a full-width band. A band cuts
  the path in half, and the path is the point.
- **Every cell has a fixed height.** That is what lets each connector be computed as
  arithmetic — we know the lateral offset of the next node before rendering — rather than
  measured after paint. No refs, no resize observers, and it renders correctly on the server.
  The cost: a title that grew to a third line would spill into the node below, so the height
  and the two-line clamp are one decision, not two.
- **The tile is opaque.** The path runs behind it; a connector crossing the glyphs makes both
  unreadable. This is also why the title is capped — see §7.3.
- **A node carries an icon, a short title, a time. Nothing else.** Everything else opens in a
  sheet on tap. Someone standing in an airport at 4am reads one thing.
- **RTL mirrors the wave.** The lateral offset is a physical `translateX`, so Arabic flips its
  sign — otherwise the path would curve against the reading direction.

### 7.2 The current node — "vous êtes ici"

The first milestone the agency has **not ticked off** (`completedAt IS NULL`). Computed
server-side, in `TripsService`.

> [!note] Why not the clock?
> A programme says 04:30, but the bus leaves when the bus leaves. Deriving "where we are"
> from `departureDate + dayOffset + timeOfDay` would confidently announce that a delayed
> group had already boarded. The agency ticking a step is a deliberate act by somebody who
> is standing there; the clock is a guess. See also §4 on why times are never converted.

The current node gets the day's colour, a halo ring in the same hue, and a slow 2.4s pulse.
The pulse is **decorative and must stay decorative**: it is disabled under
`prefers-reduced-motion`, and the ring plus the "vous êtes ici" label identify the node
without any motion at all.

A buyer on the offer page passes no current node — the trip has not started, so a
"you are here" marker would be a lie.

### 7.3 Title length is a schema decision, not a style one

`MILESTONE_TITLE_MAX = 60`, enforced in the shared Zod schema and mirrored into the console
form's `maxLength` from the same constant.

Agencies write long descriptive titles by habit. On a node tile a long title is an
unreadable smear, and truncating it at render just hides the problem after the fact. A title
that needs truncating is a title nobody can read while walking through an airport — the rest
belongs in `description`, which the traveler opens with one tap. The form shows a live
counter that turns orange near the limit, so the cost is visible while typing.

### 7.4 Traveler's live view — `/mon-voyage/{code}`

```
┌──────────────────────────────────────────┐
│  VOTRE PROCHAINE ÉTAPE                   │
│                                          │
│   🚌  Départ vers l'aéroport             │
│       Jour 2 · 11 févr. · 04:30          │
│                                          │
│   📍 Point de rendez-vous                │
│      Parking de l'agence, devant         │
│      l'entrée principale                 │
│                                          │
│      [ Ouvrir dans Maps ]                │
└──────────────────────────────────────────┘

  [ WhatsApp à l'agence ]   [ Appeler ]

  Le programme complet
  … the map, with the current node marked …
```

"Votre prochaine étape" is the whole feature; the map is supporting detail. The agency's
phone sits directly under it, because the moment the programme stops matching reality, a
human is the feature.

The page is `robots: noindex, nofollow`. The URL **is** the credential — a search engine or
a link-unfurling bot that followed it would publish a family's itinerary. This is the one
page on the site where being findable is a bug.

### 7.5 Getting the link to the family

The traveler page is useless if nobody reaches it, so the link lives on the manifest row,
next to the family it belongs to: a WhatsApp button pre-filled with the message and the URL,
plus a preview link for the agent. A reservation created before `publicCode` existed shows
"créer le lien" instead, which mints one — see the idempotency note in [[API Endpoints]].

### 7.3 Agency editor — `/console/offers/{id}/programme`

- Add / reorder (drag or up-down buttons) / delete
- Each row: kind (icon), title, day, time, location, meeting point, map link,
  **attendance tracking: off / mandatory / optional**
- **Duplicate a day** — Omra programmes repeat, and retyping five identical days is how
  agencies give up on a feature
- **Copy the programme from another offer** — the single biggest time-saver, because next
  season's Ramadan trip is last season's with new dates

### 7.4 Agency live view — ticking milestones and checking people off

Lives beside the [[Trip Manifest]] check-in screen, same design rules: one hand, bad light,
big targets. Two related but separate taps:

- Tick "Départ vers l'aéroport" as **done** (the milestone-level `completedAt`) → every
  traveler's page advances to the next step at once.
- Open a **checkpoint** milestone → the same thumb-sized, colour-coded family list as the
  manifest, scoped to just that stop. Tapping a family checks them in for *this* checkpoint
  only — their status at every other checkpoint is untouched.

---

## 8. Build order

1. ~~`OfferMilestone` + `MilestoneCheckIn` models, migration, shared enums~~ — **BUILT**
   (2026-08-01). `packages/shared/src/milestones/schemas.ts`.
2. ~~Agency CRUD endpoints for milestones~~ — **BUILT** (2026-08-01).
   `apps/api/src/modules/milestones/milestones.{controller,service}.ts`. Tenant-isolation
   test in `apps/api/test/milestones.e2e.test.ts`.
3. ~~Checkpoint attendance endpoints~~ — **BUILT** (2026-08-01).
   `checkpoint-attendance.{controller,service}.ts` — lazy row creation, the
   optional-carries-forward default and the mandatory-never-defaults rule from §6, both
   covered by tests including the "push them back" case.
4. ~~Public read: milestones on the offer detail response~~ — **BUILT** (2026-08-02).
   `OfferDetail.milestones`, buyer-shaped via `toBuyerMilestone`.
5. ~~The programme map component~~ — **BUILT** (2026-08-02).
   `apps/web/src/components/ProgrammeMap.tsx`, used by both client surfaces. §7.1.
6. The console editor's remaining time-savers: duplicate-day and copy-from-offer.
   (The editor itself, with the attendance-tracking toggle, is built.)
7. ~~`Reservation.publicCode` + `/mon-voyage/{code}` traveler page~~ — **BUILT** (2026-08-02).
   Migration `20260802100000_reservation_public_code`, `TripsService`, and the page at
   `apps/web/src/app/[locale]/mon-voyage/[code]/page.tsx`. Security tests in
   `apps/api/test/trips.e2e.test.ts`.
8. ~~Tick-off in the console + the "vous êtes ici" marker~~ — **BUILT** (2026-08-02).
   `POST .../milestones/{id}/completion`, member-level (§7.2 and open question 3).
9. *Later:* notify travelers when a milestone completes (needs task #18 notifications)

**Next:** item 6 — duplicate-day and copy-from-offer in the editor. Retyping five identical
Omra days is how an agency gives up on this feature, and next season's Ramadan trip is last
season's with new dates.

---

## 9. Deliberately not doing

- **No live GPS / bus tracking.** Enormous scope, needs a driver app, and solves a smaller
  problem than "where do I stand at 4am".
- **No maps SDK.** A plain maps URL opens the app the traveler already has. No API key, no
  bundle cost, works offline-ish.
- **No per-traveler personalisation** of the programme in v1. Everyone on the departure
  sees the same list.
- **No auto-computed `Reservation.status` from checkpoint attendance.** Being absent at
  every optional stop does not automatically flip the booking-level status to `no_show` —
  that stays a deliberate, separate call by the agency.

---

## 10. Open questions — yours

1. **Should the programme be required before an offer can be published?** It would raise
   quality across the marketplace and give buyers something to compare — but it is friction
   for an agency posting its first offer. (My inclination: not required, but it feeds
   `qualityScore` so complete programmes rank higher.)
2. **Prayer times** — worth showing alongside the Omra programme, or is that a religious
   responsibility you do not want to take on? It is a real product question, not a
   technical one.
3. ~~**Who may tick a milestone or check off a family?**~~ — **decided 2026-08-02: any
   member.** Both the tick-off and checkpoint check-in are member-level, like the manifest;
   only *editing* the programme needs `manager`. The accompagnateur is usually the most
   junior person on the trip, and gating operational taps on `manager` means passing a phone
   around at 4am. Pinned by a test (an agent can tick off, but gets 403 renaming a step).
4. ~~**Should a traveler be able to see the programme before booking, with meeting points
   hidden?**~~ — **decided provisionally on 2026-08-02: yes, hidden.** A buyer sees the whole
   programme; `meetingPoint` and `mapUrl` come back `null` until they have a booking
   (`toBuyerMilestone` vs `toTravelerMilestone`, and a test pins both). The reasoning: a
   meeting point only matters once you are going, and publishing "parking de l'agence, 4h30,
   devant l'entrée" on an indexable page hands a competitor the agency's routine and hands
   anyone else a place to stand. **This is still your call** — it is two words in one mapper
   to reverse, and the pre-purchase view is genuinely less useful without them.
5. **Should the editor suggest a default `checkpointType` by `kind`** (e.g. `flight`/
   `transport` pre-checked as `mandatory`)? Saves a step for the common case; a wrong
   suggestion silently accepted is also how a real mandatory stop ends up `none`.

---

Related: [[Trip Manifest]] · [[Offer]] · [[Lead]] · [[Interface Plan]] · [[Web App]] ·
[[API Endpoints]] · [[Decision Log]] · [[The Seven Rules]]
