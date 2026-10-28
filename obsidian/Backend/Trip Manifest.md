# Trip Manifest

> [!success] Built — JSON API and console pages
> Models: `apps/trips/models.py` (`Reservation`, `MilestoneCheckIn`).
> API: `apps/trips/api.py`. HTML console: `agency_manifest` and `agency_checkpoint` in
> `apps/pages/views.py`, templates under `templates/pages/`.
> Tests: `apps/trips/tests.py` (29 cases, isolation included) plus the page-level cases in
> `apps/pages/tests.py`.

Your feature, your words: track every client of a rihla — name, phone, where they came
from, **coming / came / not coming** — and check families onto the bus from a phone.

---

## The status model, colour for colour

| Your words | `AttendanceStatus` | Colour |
|---|---|---|
| "coming" — confirmed, not yet arrived | `expected` | 🟡 |
| "came" — at the bus, counted | `checked_in` | 🟢 |
| "not coming" — didn't show | `no_show` | 🔴 |
| called off before departure day | `cancelled` | ⚪ |

**Transitions are deliberately free — any status to any status.** At a bus at 4am the
most common tap after a tap is *"oops, wrong row"*, and a state machine that refuses the
undo gets obeyed for one departure and abandoned. Accountability comes from the
[[Audit Log]] instead: every status change records who and when, and the check-in stamp
(`checked_in_at`, `checked_in_by`) answers "who counted this family?" months later. The
undo clears the stamp, so a corrected mistake leaves no phantom "was counted at 04:12".
There is a test for the undo specifically.

## One reservation = one family

Because in Algeria one person reserves for everyone. The row is "Famille Amrani — ×4", and
every number on the page is **sum(`party_size`), never count(rows)** — get that wrong and
the 52-seat bus "fits" 70 people.

## Seats, the one place two numbers must agree

Unlike the NestJS version, `seats_left` here **is** wired to the manifest:

- creating a reservation subtracts `party_size`, in the same `transaction.atomic()`
- a party larger than `seats_left` is refused with **409**, not silently clamped
- cancelling gives the seats back; **un-cancelling takes them again**

That last one is the part worth arguing about. A one-way rule — give back on cancel, never
re-take — is simpler and leaves an offer permanently short of seats the first time an
agency reverses a cancellation, which they do constantly. `_adjust_seats` also clamps at
`seats_total`, so a double-cancel cannot invent seats the bus does not have. Three tests
pin this: take, give back and re-take, and the repeated cancel.

> [!note] Changed from the NestJS design on purpose
> The old note said `seatsLeft` stays manual and independent, "because mixing an automatic
> counter with a hand-edited one produces two numbers that disagree". The counter here is
> automatic, and the disagreement is avoided the other way: the agency edits `seats_total`,
> the app owns `seats_left`. One number has one writer. The old open question is therefore
> answered, and the new one is below.

## Where reservations come from

1. **From the CRM** — reserve from a [[Lead]]. `lead_id` arrives in the body and is
   scoped like every other client-supplied id (`scoped(Lead.objects, agency_id)`), so
   "reserve for lead X" cannot be used to probe a competitor's client list. Converting a
   lead sets it to `booked` and stamps `first_responded_at` — booking someone is a first
   response by any reasonable definition, and without the stamp the response-time metric
   would count this agency slow. Tested.
2. **Manually** — the walk-in form at the bottom of the manifest page: name, phone,
   headcount.
3. **Later: the [[Agency Chatbot]]** — nothing wired yet, but `create_reservation` is a
   plain function a tool call can reach.

Contact details are **snapshotted**, same reasoning as [[Lead]]: the 4am list must not
change because someone edited a record the night before. There is a test that renames the
lead afterwards and asserts the reservation did not follow.

## The checkpoint screen

A milestone with `checkpoint_type` of `mandatory` or `optional` becomes a checkpoint — a
list with one row per family. Two design choices carry the weight:

**Rows are created lazily, on first open.** Not when the milestone is added. So a
checkpoint invented mid-trip needs no backfill, and a reservation made this morning appears
without anyone re-running anything. Opening twice does not duplicate rows.

**A mandatory checkpoint never defaults anyone.** Everyone starts `expected` and somebody
physically confirms each family, because a wrong default at a flight means a family left
behind. An *optional* checkpoint does the opposite: it carries the last optional answer
forward, since a family that skipped yesterday's excursion probably skipped today's, and
re-marking the same absent family at every stop is how a guide stops using the app. It is
only ever a default — one tap changes it. Both halves are tested.

Cancelled families are excluded from the list entirely.

## Who may do what

Everything here is **member-level — agents included, no role gate**. Check-in at the bus
IS agent work; a manager-only manifest would just mean the owner's phone gets passed
around in the dark. `set_check_in` asks for `Membership.AGENT`, which is the floor, not a
restriction.

Tenant isolation as everywhere: agency B's requests for A's manifest, reservations,
checkpoints or check-ins are **404**; B putting A's *agency id* in the path is **403**,
because agency ids are not secret and "you are not a member" leaks nothing
([[Multi-Tenancy]]). Both are asserted separately — `assertIn(status, (403, 404))` would
pass while the bug is present.

## The traveler's page — a URL that is its own password

`Reservation.public_code` is 32 hex characters, `secrets.token_hex(16)` ≈ 128 bits, minted
on save. `GET /api/my-trip/{code}` has `auth=None`: the family gets the link by SMS and
opens it on a phone that may belong to a nephew. Holding the URL **is** the credential —
a *capability URL*.

That is acceptable for exactly one reason: the page shows their own booking and a
programme that is already public. `MyTripOut` is a hand-built allow-list, and the comment
inside it names what must never join: other passengers' phone numbers, price paid, lead
status, CRM notes, the manifest.

> [!danger] The test that matters most in `apps/trips/tests.py`
> `test_the_page_never_carries_the_passenger_list_or_the_crm_note` fetches the page as raw
> bytes and asserts the neighbour's name, the neighbour's code, the CRM note and the
> family's own phone number are all absent. It is a string search on purpose: a
> field-by-field assertion passes when someone adds a nested object. Anything added to
> `MyTripOut` has to get past this first.

A code of the wrong length is a 404 **before any query runs** — `assertNumQueries(0)` pins
it — so a scanner cannot turn this endpoint into a query generator.

"Vous êtes ici" is the first milestone the agency has **not** ticked off. Deliberately not
computed from the clock: the programme says 04:30, but the bus leaves when the bus leaves,
and a clock would confidently announce a delayed group had already boarded. A tick is a
deliberate act by somebody standing there. See [[Trip Programme]] and [[Decision Log]] #021.

## The programme sits next to this

[[Trip Programme]] is the other half of running a departure: the manifest says **who is
coming**, the programme says **what happens and where to meet**. They share a screen during
the trip — check families onto the bus, then tick "Départ vers l'aéroport" as done and
every traveler's phone advances to the next step.

Each manifest row carries a **WhatsApp button pre-filled with that family's link**: the
traveler page is useless if nobody sends it, so the send lives next to the family it
belongs to rather than behind a menu.

## Open questions — yours

- **Should a full manifest block new reservations?** Today it does: a party larger than
  `seats_left` gets a 409. Agencies overbook deliberately, so this may be wrong — the
  alternative is a warning banner and an allowed negative. One flag either way; tell me
  which behaviour a real agency wants.
- **A printable manifest** (PDF for the police escort / airport) — commonly required for
  organized trips. Cheap to add; tell me the exact columns the gendarmerie checkpoint
  wants and it exists. **Verify the legal requirements yourself.**
- **Should the traveler page let a family say "we're not coming"?** It would save the
  agency a phone call and it is one more write on an unauthenticated endpoint. Currently:
  read-only.

---

Related: [[Trip Programme]] · [[Lead]] · [[Client Quality Labels]] · [[Agency Chatbot]] ·
[[API Endpoints]] · [[Audit Log]] · [[Multi-Tenancy]] · [[Vision and Roadmap]]
