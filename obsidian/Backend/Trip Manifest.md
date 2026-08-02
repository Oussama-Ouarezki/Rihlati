# Trip Manifest

> [!success] Built — API and console
> Code: `apps/api/src/modules/reservations/`, pages under `/console/departures`.
> Tests: `apps/api/test/reservations.e2e.test.ts` (6 cases, isolation included).

Your feature, your words: track every client of a rihla — name, phone, where they came
from, **coming / came / not coming** — and check families onto the bus from a phone.

---

## The status model, colour for colour

| Your words | Status | Colour |
|---|---|---|
| "coming" — confirmed, not yet arrived | `expected` | 🟡 |
| "came" — at the bus, counted | `checked_in` | 🟢 |
| "not coming" — didn't show | `no_show` | 🔴 |
| called off before departure day | `cancelled` | ⚪ |

**Transitions are deliberately free — any status to any status.** At a bus at 4am the
most common tap after a tap is *"oops, wrong row"*, and a state machine that refuses the
undo gets obeyed for one departure and abandoned. Accountability comes from the
[[Audit Log]] instead: every status change records who and when, and the check-in stamp
(`checkedInAt`, `checkedInByUserId`) answers "who counted this family?" months later. The
undo clears the stamp, so a corrected mistake leaves no phantom "was counted at 04:12".

## One reservation = one family

Because in Algeria one person reserves for everyone. The row is "Famille Amrani — ×4", and
every number on the page is **sum(peopleCount), never count(rows)** — get that wrong and
the 52-seat bus "fits" 70 people. There's a test that pins exactly this: 3 rows, 7 people.

The departures list shows `people / seatsTotal` per trip. `seatsLeft` on the offer stays
manual and independent — mixing an automatic counter with a hand-edited one produces two
numbers that disagree, and nobody knows which lies. (Open question below.)

## Where reservations come from

1. **From the CRM** — the "Ajouter au départ" button on a [[Lead]]'s card. Contact details
   are copied server-side from the lead, the lead's offer becomes the departure, and the
   lead's `source` shows on the manifest — that's your "where did they come from". One
   reservation per lead, enforced by a unique index. The conversion lands in the lead's
   timeline.
2. **Manually** — the walk-in form at the bottom of the manifest: name, phone, headcount.
3. **Later: the [[Agency Chatbot]]** — its `create_reservation` tool now has a real
   service to call (`ReservationsService`, exported for exactly this).

Contact details are **snapshotted**, same reasoning as [[Lead]]: the 4am list must not
change because someone edited a record the night before.

## Who may do what

Everything here is **member-level — agents included, no role gate**. Check-in at the bus
IS agent work; a manager-only manifest would just mean the owner's phone gets passed
around in the dark. The one nuance: an agent creating a reservation *from a lead* can only
use leads visible to them — the same scoping as their inbox, or "reserving" would become a
way to read a colleague's client. There's a test.

Tenant isolation as everywhere: agency B's requests for A's manifest, reservations or
departures are 404s, tested.

## The check-in screen

Designed for a phone held in one hand next to a bus at 4am: rows the height of a thumb,
one green button per family, row background = status, legible in bad light. The list is
ordered **expected first** — who's missing is the question at the bus — then arrived, then
no-shows. The rest of the console can be dense; this page cannot.

## The programme sits next to this

[[Trip Programme]] is the other half of running a departure: the manifest says **who is
coming**, the programme says **what happens and where to meet**. They share a screen during
the trip — check families onto the bus, then tick "Départ vers l'aéroport" as done and
every traveler's phone advances to the next step.

`Reservation` now has a `publicCode` — 128 random bits — so a booked traveler can open their
own trip page at `/mon-voyage/{code}` without an account. It is minted when the reservation
is created, and each manifest row carries a **WhatsApp button pre-filled with that family's
link**: the traveler page is useless if nobody sends it, so the send lives next to the family
it belongs to rather than behind a menu.

The code is a credential in a URL. Read [[Trip Programme]] §5 and [[Decision Log]] #021
before touching it — in particular, the response is a hand-built allow-list, and the manifest
this page must never contain is the one you are looking at right now.

## Open questions — yours

- **Should a full manifest block new reservations?** Currently no: agencies overbook
  deliberately, and the tool is a mirror, not a policeman. If you want a warning at
  `people > seatsTotal`, it's a one-line banner.
- **Link `seatsLeft` to reservations?** Auto-decrementing the public seat counter from the
  manifest would keep them in sync but takes the number out of the agency's hands. Today:
  independent, agency-managed.
- **A printable manifest** (PDF for the police escort / airport) — commonly required for
  organized trips. Cheap to add; tell me the exact columns the gendarmerie checkpoint
  wants and it exists. **Verify the legal requirements yourself.**

---

Related: [[Lead]] · [[Client Quality Labels]] · [[Agency Chatbot]] · [[API Endpoints]] ·
[[Audit Log]] · [[Vision and Roadmap]] · [[Multi-Tenancy]]
