# CRM Redesign

> [!info] Decided 2026-08-01, not yet built.
> The trigger was the owner saying **"I don't even get it"** about the client-management
> screen. He commissioned it and read every note — if it does not land for him it will not
> land for an agency owner in Oran. That is a design failure, not a user failure, and this
> note is the fix.

**Implement in this order. Every decision below is already made — do not reopen them.**

> [!success] Partly built — the client directory, not the "Aujourd'hui" screen
> A person-level [[Client]] directory now exists at `/a/<agency>/clients/`: one row per phone,
> a page per person with notes, tags, every inquiry, every trip and a merged chronology. That
> delivers Decision 4's first two chain links (offer → client, manifest row → client) and gives
> Decision 3's "Ce client" section somewhere to live later.
>
> **Not built:** the dashboard itself (`/dashboard/` still lands on a table), stage collapsing,
> the month aggregate, and the "Rappeler quand ?" prompt. Those remain M6. Client-level status,
> quality and callbacks are still deliberately on [[Lead]], not on the person.
>
> The French labels below ("À rappeler", "Nouveau", "Rappeler quand ?") are the vocabulary
> of this 2026-08-01 note. The shipped UI is English — "Due for a callback", "New",
> "When should we call back?" — and the underlying `?due=1` / `?status=` parameters are
> unchanged.

---

## What was wrong

1. **Two vocabularies at once.** Every client carried a *stage* (8 values) **and** a
   *quality* (7 values), as two peer dropdowns with two colour systems and no explanation.
   Stage is *where the sale is*; quality is *what kind of person*. Obvious while writing
   the code, invisible on screen.
2. **Eight stages is brochure thinking.** "Devis envoyé" and "Négociation" as separate
   columns is Salesforce vocabulary, not Algerian travel-agency vocabulary.
3. **It opened on a database, not on a day.** A list of everything sorted by date. Nothing
   said *what should I do right now* — which is the only question a CRM has to answer.
4. **The chain was invisible.** Client → offer → departure lived in three separate tabs, so
   you could not see that Fatima booked the Omra leaving on the 10th with 4 seats left.

None of this needed new data. `next_action_at`, `first_responded_at` and the `LeadActivity`
timeline were already being recorded — they were just never surfaced.

---

## Decision 1 — the CRM opens on "Aujourd'hui"

`/dashboard/` lands on a **work screen**, not a table. The full client list stays where it
is, at `/a/{agency_id}/leads/`, one click away.

```
Bonjour Karim                                Mardi 12 août

🔴 À RAPPELER AUJOURD'HUI                            3
   Fatima Zerrouki   0551 23 45 67
   Omra Ramadan · 3 pers · promis rappel lundi
                              [ Appeler ]  [ WhatsApp ]

🟡 NOUVEAUX, JAMAIS CONTACTÉS                        5
   Mohamed A. · Leila M. · +3                  [ Voir ]

🚌 PROCHAIN DÉPART — dans 6 jours
   Omra Ramadan · 34/40 places · 12 confirmés  [ Liste ]

Ce mois : 23 clients · 8 réservés · 34% ✓
```

**Each block answers a question, in priority order:** who is waiting on a promise I made ·
who has been ignored · what is about to leave · am I doing better than last month.

The API already supports almost all of it:

| Block | Source | Exists? |
|---|---|---|
| À rappeler | `?due=1` on the page and on `GET /api/agencies/{id}/leads` (`next_action_at <= now`, terminal statuses excluded) | ✅ built |
| Jamais contactés | `?status=new` plus `first_responded_at is null` | ⚠ the status filter exists; the null check does not |
| Prochain départ | the manifest at `/a/{agency_id}/offers/{id}/manifest/` | ✅ built, but nothing surfaces "the next one" |
| Ce mois | counts by status for the month | ❌ **needs a small aggregate**; `agency_leads` already does the all-time version in one query |

> [!tip] The one behaviour that makes this work
> "À rappeler" is only useful if `next_action_at` actually gets set. So **after any call
> action, prompt for the next step**: *"Rappeler quand ?"* with quick buttons (demain ·
> dans 3 jours · lundi). Without that prompt the block stays empty and the redesign fails.

---

## Decision 2 — five stages on screen, eight in the database

| On screen | Written to the database | Plain meaning |
|---|---|---|
| **Nouveau** | `new` | quelqu'un a demandé, personne n'a répondu |
| **En discussion** | `contacted` *(also displays `quoted`, `negotiating`)* | vous lui parlez, prix envoyé, ça négocie |
| **Réservé** | `booked` | il a dit oui, place gardée |
| **Parti** | `travelled` | il a voyagé — dossier fermé |
| **Perdu** *(aside)* | `lost` | n'a pas abouti, avec la raison |

There is no `paid` status in this port; money is not modelled at all yet. If "l'argent est
arrivé" turns out to be the distinction agencies actually track, it is a new value — and see
[[Credits and Promotion]] first, because a payment state that no ledger backs is a number
someone will dispute.

### Why the enum is NOT being changed

Collapsing the stored values would be a destructive migration that throws away a distinction
bigger agencies may later want — and it cannot be undone. Instead the grouping is a **display
layer** over the existing values. Same pattern as everything else here: the data model
absorbs, the UI simplifies.

`Lead.STATUSES` in `apps/leads/models.py` currently holds seven, not eight — there is no
`paid`. The grouping belongs next to them, on the model, because both entry points need it:

```python
# What the UI shows, over the statuses the database keeps.
STATUS_GROUPS = {
    "nouveau": [NEW],
    "en_discussion": [CONTACTED, QUOTED, NEGOTIATING],
    "reserve": [BOOKED],
    "parti": [TRAVELLED],
    "perdu": [LOST],
}
```

On the model rather than in the view or the template, for the reason
[[One Rule, Two Entry Points]] gives: `agency_leads` renders the page and `list_leads` answers the API, and a
grouping defined in one of them is a grouping the other disagrees with.

> [!warning] The subtlety that will bite
> When the user picks "En discussion" on a lead already at `quoted`, **do not write
> `contacted`** — that silently demotes them. Rule: *if the current status is already inside
> the chosen group, leave it alone.* Write the group's first value only when moving in
> from outside. Worth a unit test.

Filtering by a group means `status__in=[...]`. The filter is already there in both doors —
`?status=` on the page and on `GET /api/agencies/{id}/leads` — and takes a single status
today, so it needs to accept a group name as well. One place each, since both read the same
dict.

---

## Decision 3 — quality labels stay, but stop competing

The labels (`spam` · `troll` · `cold` · `warm` · `serious` · `vip`) were explicitly
requested and feed later features. The mistake was **presentation**, not existence.

- **Remove the quality dropdown from the main edit form.** It is not a peer of stage.
- Set it from the client's own page, in its own small control — a menu on the client's
  name, or a distinct "Ce client" section. One decision at a time.
- In lists, show it **only when set**, as a small badge. `unrated` is the default and should
  render nothing at all, so most rows stay quiet.
- Marking someone `spam`/`troll` is a judgement about a real person and is already audited
  separately ([[Client Quality Labels]]). Keep that.

---

## Decision 4 — show the chain

Wherever a client appears, the offer and its departure should be one hop away, and vice
versa. Concretely:

- Client page → the offer they asked about → **and its departure date + seats left**
- Departure manifest row → the client's CRM card
- Offer page in the console → "7 clients ont demandé cette offre"

The data already links (`Lead.offer`, `Reservation.lead`, both nullable on purpose — a
walk-in was never a lead); only the UI is missing.

---

## Build order

1. `STATUS_GROUPS` on `Lead` + the "don't demote" rule + tests — pure logic, no UI
2. Collapse the filter tabs to the five group names on both doors
3. Rebuild `/dashboard/` as "Aujourd'hui"
4. The month-summary aggregate
5. The "Rappeler quand ?" prompt after a call action ← *makes block 1 work*
6. Move quality out of the edit form
7. Chain links

---

## Open questions — yours

- **"Ce mois" — which number matters most to you?** Currently proposed: clients received,
  booked, conversion %. Response time is also available (`first_responded_at`) and is the
  metric agencies are actually sold on.
- Should **"Parti"** clients disappear from the main list after a while? A CRM that never
  forgets slowly becomes unusable.

---

Related: [[Interface Plan]] · [[Client]] · [[Client Quality Labels]] · [[Lead]] · [[Trip Manifest]] ·
[[Templates and Pages]] · [[API Endpoints]]
