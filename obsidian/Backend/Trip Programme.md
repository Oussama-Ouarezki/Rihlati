# Trip Programme (milestones)

> [!info] Status: **built end to end** (2026-08-02) — schema, API, console editor with
> tick-off, the offer-page map, and the traveler page. Remaining polish in §8, item 6.
> An offer's programme used to be one free-text blob in `Offer.description`. It is now a
> structured list of **milestones**, which the agency edits as a list and every client reads
> as a **road map** — a winding road with a marker at each stop, showing where the group is.

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

`apps/offers/models.py`, trimmed to the decisions:

```python
class MilestoneKind(models.TextChoices):
    MEETING = "meeting", "Rendez-vous"      # the one that matters at 4am
    TRANSPORT = "transport", "Transport"    # bus, transfer
    FLIGHT = "flight", "Vol"
    HOTEL = "hotel", "Hôtel"                # check-in / check-out
    RITUAL = "ritual", "Rite"               # omra, tawaf, sa'i — the point
    ZIYARA = "ziyara", "Ziyara"
    MEAL = "meal", "Repas"
    FREE_TIME = "free_time", "Temps libre"
    OTHER = "other", "Autre"


# Set per milestone by the agency when they build the programme. See §6.
class CheckpointType(models.TextChoices):
    NONE = "none", "Aucun pointage"                 # informational only
    MANDATORY = "mandatory", "Pointage obligatoire"  # fresh every time
    OPTIONAL = "optional", "Pointage facultatif"     # can default forward


class OfferMilestone(UUIDModel):
    # Denormalised tenant key (rule 3): the tenant filter never has to join,
    # so the safe query is also the lazy query.
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="milestones")
    offer = models.ForeignKey(Offer, on_delete=models.CASCADE, related_name="milestones")

    title = models.CharField(max_length=MILESTONE_TITLE_MAX)   # 60
    description = models.TextField(blank=True)
    kind = models.CharField(max_length=20, choices=MilestoneKind.choices,
                            default=MilestoneKind.OTHER)

    # Day of the trip, 0 = departure day. With Offer.departure_date this
    # renders a real date WITHOUT storing one — see §4.
    day_offset = models.PositiveSmallIntegerField(default=0)
    # "04:30". Empty means "sometime that day", which is honest and common.
    time_of_day = models.CharField(max_length=5, blank=True)

    location_name = models.CharField(max_length=150, blank=True)
    # The sentence a traveler reads at 4am. "Terminal 1, porte 3, à côté du
    # café" — not "l'aéroport".
    meeting_point = models.CharField(max_length=300, blank=True)
    map_url = models.URLField(max_length=500, blank=True)  # a link, no SDK

    sort_order = models.PositiveSmallIntegerField(default=0)
    checkpoint_type = models.CharField(max_length=20, choices=CheckpointType.choices,
                                       default=CheckpointType.NONE)

    # Ticked by the agency as the trip actually happens — drives the public
    # "vous êtes ici" marker. Independent of per-family attendance (§6): the
    # group can move on even if one family is still being chased down.
    completed_at = models.DateTimeField(null=True, blank=True)
    completed_by = models.ForeignKey(User, null=True, blank=True,
                                     on_delete=models.SET_NULL)

    class Meta:
        ordering = ["day_offset", "sort_order", "created_at"]
        indexes = [
            models.Index(fields=["offer", "day_offset", "sort_order"]),
            models.Index(fields=["agency"]),
        ]
```

> [!note] Two limits that are schema decisions, not style ones
> `MILESTONE_TITLE_MAX = 60` — a title that needs truncating is a title nobody can read
> while walking through an airport, so the form shows a live counter and the cost is visible
> while typing. `MILESTONE_MAX_PER_OFFER = 200` — the ceiling the bulk-copy operations in
> §7.6 refuse to cross, because "duplicate this day" is one tap and a programme with 4 000
> steps in it is one tap repeated by an accident.

`Offer.description` **stays** — as a short prose introduction. The milestones become the
programme section beneath it.

---

## 4. Why `day_offset`, not a date

Storing an absolute datetime per milestone looks simpler and is worse:

- An agency builds the programme **before** fixing the departure date, or reuses last
  season's. `day_offset` makes the programme a reusable template.
- When the departure moves by three days — which happens — you would otherwise edit twelve
  rows by hand and get one wrong.
- With `Offer.departure_date` set, `day_offset + time_of_day` renders as a real date. One
  source of truth, no drift.

> [!note] Timezone
> `time_of_day` is **local to where the traveler is standing** — Algiers for the departure,
> Saudi time once there. Do not convert. A programme that says "04:30" must say 04:30 to
> everyone reading it, and quietly shifting it by an hour is how people miss a bus.
> Store the string; label the day with the destination when it differs.

---

## 5. How the traveler sees it — and the security decision

A traveler has usually **not got an account** (that is deliberate — [[Lead]] works without
one). So the trip page cannot be behind a login.

**Capability URL:** each [[Trip Manifest|Reservation]] gets a random `public_code`, and
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

**`checkpoint_type` is set per milestone, by the agency, when they build the programme** —
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

`apps/trips/models.py`:

```python
class MilestoneCheckIn(UUIDModel):
    """One family's attendance at ONE checkpoint.

    Rows are created lazily — the first time a guide opens a checkpoint's list —
    so adding a checkpoint mid-trip needs no backfill.
    """

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE)   # tenant key
    milestone = models.ForeignKey(OfferMilestone, on_delete=models.CASCADE)
    reservation = models.ForeignKey(Reservation, on_delete=models.CASCADE)

    # Reuses the manifest's own vocabulary — see [[Trip Manifest]].
    status = models.CharField(max_length=20, choices=AttendanceStatus.choices,
                              default=AttendanceStatus.EXPECTED)
    checked_in_at = models.DateTimeField(null=True, blank=True)
    checked_in_by = models.ForeignKey(User, null=True, blank=True,
                                      on_delete=models.SET_NULL)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["milestone", "reservation"],
                                    name="one_checkin_per_family_per_checkpoint"),
        ]
        indexes = [
            models.Index(fields=["agency"]),
            models.Index(fields=["milestone", "status"]),
        ]
```

The unique constraint is the whole safety of the lazy creation: two guides opening the same
checkpoint on two phones at the same moment cannot produce two rows for one family, and the
one that loses the race reads the row the other just wrote.

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
> `/a/{agency}/offers/{id}/programme/`. Every client-facing surface gets the **programme map**
> below. Building one component for both audiences was tried on paper and rejected: the
> shared thing would have been a list with half its columns hidden, which serves neither.

### 7.1 The programme map — `components/roadmap/`

What both client surfaces render. Not a list: a **road**. It runs across the screen, folds
back at the edge with a rounded U-turn, and carries a marker at each stop.

```
   ╭──● Réunion ══════● Départ ══════● Vol Alger ══════● Installation ╮
   │     18:00           04:30          07:15            16:00        │
   │                                                                  │
   ╰──● Ziyarat ══════● Transfert ═══● Ziyarat ═══════● Omra ─────────╯
        Médine          Médine         Makkah          tawaf
```

Why each piece is the way it is:

- **A road, not a list.** A 15-day Omra is forty rows of text. As a route you see the shape
  of the trip — how long it is, how far along the group is — before reading a single word.
- **Horizontal, folding back.** The first build ran vertically, one stop per row, and was
  nearly a thousand pixels tall for nine steps while the right half of every desktop screen
  sat empty. Four stops to a row cuts the height by two thirds. See [[Decision Log]] #020.
- **Four strokes of the same curve** make the asphalt: a pale shoulder, dark slate, the
  travelled stretch in brand colour, and a white dashed centre line. Drawing a real road as
  one closed shape would need an inner and outer contour offset from a centre line — genuine
  computational geometry. Stacked strokes fake it exactly, for free, and stay aligned around
  the turns because there is only ever one curve.
- **The curve is generated from the stop positions, never measured.** This is the piece worth
  understanding — [[Decision Log]] #022 has the reasoning. It is also why the travelled
  stretch is exact: it is the same builder run over the first N stops.
- **The SVG is stretched, and the strokes opt out.** `preserveAspectRatio="none"` lets the
  road fill a box whose shape it does not control; `vectorEffect="non-scaling-stroke"` stops
  that stretch from squashing the asphalt into something thick one way and thin the other.
  Removing either one breaks it.
- **A marker carries an icon, a short title and a time. Nothing else.** Everything else opens
  in a sheet on tap. Someone standing in an airport at 4am reads one thing.
- **RTL mirrors the road.** The x axis is flipped when building the points, so Arabic starts
  on the right and runs the other way. One mirroring rule, in one place.

### 7.2 The current node — "vous êtes ici"

The first milestone the agency has **not ticked off** (`completed_at IS NULL`). Computed
server-side, in `TripsService`.

> [!note] Why not the clock?
> A programme says 04:30, but the bus leaves when the bus leaves. Deriving "where we are"
> from `departure_date + day_offset + time_of_day` would confidently announce that a delayed
> group had already boarded. The agency ticking a step is a deliberate act by somebody who
> is standing there; the clock is a guess. See also §4 on why times are never converted.

The current node gets the day's colour, a halo ring in the same hue, and a slow 2.4s pulse.
The pulse is **decorative and must stay decorative**: it is disabled under
`prefers-reduced-motion`, and the ring plus the "vous êtes ici" label identify the node
without any motion at all.

A buyer on the offer page passes no current node — the trip has not started, so a
"you are here" marker would be a lie.

### 7.3 Title length is a schema decision, not a style one

`MILESTONE_TITLE_MAX = 60` is declared once, in `apps/offers/models.py`, and imported by
every place that enforces it: the column itself (`title = models.CharField(max_length=...)`),
the Pydantic schema `MilestoneIn` in `apps/offers/api.py`, and the console form's `maxlength`
attribute in `apps/pages/forms.py`. Three doors, one number — the reason it lives on the model
instead of being retyped in each is [[One Rule, Two Entry Points]].

Agencies write long descriptive titles by habit. On a node tile a long title is an
unreadable smear, and truncating it at render just hides the problem after the fact. A title
that needs truncating is a title nobody can read while walking through an airport — the rest
belongs in `description`, which the traveler opens with one tap.

> [!note] The live counter is not built
> The browser's own `maxlength` stops the typing, silently: the field simply refuses the
> 61st character with no explanation. A counter that turns orange near the limit would make
> the cost visible while typing. Small, and not done.

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
plus a preview link for the agent. A reservation created before `public_code` existed shows
"créer le lien" instead, which mints one — see the idempotency note in [[API Endpoints]].

### 7.6 Agency editor — `/a/{agency}/offers/{id}/programme/`

- Add / reorder (**drag a row**, or the up-down buttons — the drag is a shortcut, the
  buttons are the path that works on a touchscreen and by keyboard) / delete
- Each row: kind (icon), title, day, time, location, meeting point, map link,
  **attendance tracking: off / mandatory / optional**
Two bulk actions sit **above** the add form, because on an empty programme the fastest route
to a finished one is copying last season's, and an agency that has started typing step 1 by
hand will never scroll back up to discover that:

- **Duplicate a day** — pick a source day and a target day. Omra programmes repeat, and
  retyping five identical days is how agencies give up on a feature. The target is *explicit*,
  not "the next day": the console proposes source + 1 because that is the order agencies build
  in, but the server never guesses. Only days that already have steps are offered as a source
  — a button that can only fail is worse than no button.
- **Copy the programme from another offer** — the single biggest time-saver, because next
  season's Ramadan trip is last season's with new dates. Because `day_offset` is a *relative*
  integer (§4), the whole shape transplants with no date arithmetic at all; that is the payoff
  for that decision.

Both are **additive**. They append to the end of the target and never move or delete an
existing step, so an unwanted copy is undone by deleting the new rows. Copies keep
`checkpoint_type` — it is part of the plan being copied — and drop `completed_at`: a copied step
has not happened yet. Both stop at 200 steps per offer (`MILESTONE_MAX_PER_OFFER`) with a
translated message. See [[Decision Log]] 029 for the alternatives that lost.

### 7.7 Agency live view — ticking milestones and checking people off

Lives beside the [[Trip Manifest]] check-in screen, same design rules: one hand, bad light,
big targets. Two related but separate taps:

- Tick "Départ vers l'aéroport" as **done** (the milestone-level `completed_at`) → every
  traveler's page advances to the next step at once.
- Open a **checkpoint** milestone → the same thumb-sized, colour-coded family list as the
  manifest, scoped to just that stop. Tapping a family checks them in for *this* checkpoint
  only — their status at every other checkpoint is untouched.

---

## 8. Build order

1. ~~`OfferMilestone` + `MilestoneCheckIn` models and migration~~ — **BUILT**.
   `apps/offers/models.py`, `apps/trips/models.py`.
2. ~~Agency CRUD endpoints for milestones~~ — **BUILT**. `apps/offers/api.py`, manager-level.
   Tenant-isolation tests in `apps/offers/tests.py`.
3. ~~Checkpoint attendance endpoints~~ — **BUILT**. `apps/trips/api.py` — lazy row creation,
   the optional-carries-forward default and the mandatory-never-defaults rule from §6, both
   covered by tests including the "push them back" case.
4. ~~Public read: milestones on the offer detail response~~ — **BUILT**.
   `OfferDetailOut.milestones`, buyer-shaped so the CRM fields cannot leak into it.
5. ~~The shared programme timeline~~ — **BUILT**. `templates/pages/_programme.html`, included
   by the public offer page, the traveler page and the agency editor. §7.1.
6. ~~The editor's time-savers: duplicate-day and copy-from-offer~~ — **BUILT**.
   `POST …/milestones/duplicate-day`, `POST …/milestones/copy-from`, and the two forms in
   `templates/pages/agency_programme.html`. §7.6 and [[Decision Log]] 029.
7. ~~`Reservation.public_code` + `/mon-voyage/{code}` traveler page~~ — **BUILT**.
   `apps/trips/models.py`, `apps/pages/views.py::my_trip`, `templates/pages/my_trip.html`.
   Security tests — wrong code 404s, a second family never appears — in `apps/pages/tests.py`.
8. ~~Tick-off in the editor + the "vous êtes ici" marker~~ — **BUILT**.
   `POST …/milestones/{id}/complete`, member-level (§7.2 and open question 3).
9. *Later:* notify travelers when a milestone completes (needs the notifications work)

**Next:** item 9 — notifying travelers when a milestone completes. It is the one piece that
turns "vous êtes ici" from something a family has to open the page to discover into something
that reaches them. It is blocked on the notifications work (task #18), not on this feature.

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
   programme; `meeting_point` and `map_url` come back `null` until they have a booking
   (`toBuyerMilestone` vs `toTravelerMilestone`, and a test pins both). The reasoning: a
   meeting point only matters once you are going, and publishing "parking de l'agence, 4h30,
   devant l'entrée" on an indexable page hands a competitor the agency's routine and hands
   anyone else a place to stand. **This is still your call** — it is two words in one mapper
   to reverse, and the pre-purchase view is genuinely less useful without them.
5. **Should the editor suggest a default `checkpoint_type` by `kind`** (e.g. `flight`/
   `transport` pre-checked as `mandatory`)? Saves a step for the common case; a wrong
   suggestion silently accepted is also how a real mandatory stop ends up `none`.

---

Related: [[Trip Manifest]] · [[Offer]] · [[Lead]] · [[Interface Plan]] · [[Templates and Pages]] ·
[[API Endpoints]] · [[Decision Log]] · [[The Seven Rules]]
