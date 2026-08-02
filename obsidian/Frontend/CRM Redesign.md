# CRM Redesign

> [!info] Decided 2026-08-01, not yet built.
> The trigger was the owner saying **"I don't even get it"** about the client-management
> screen. He commissioned it and read every note — if it does not land for him it will not
> land for an agency owner in Oran. That is a design failure, not a user failure, and this
> note is the fix.

**Implement in this order. Every decision below is already made — do not reopen them.**

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

None of this needed new data. `nextActionAt`, `firstRespondedAt` and the stage history were
already being recorded — they were just never surfaced.

---

## Decision 1 — the CRM opens on "Aujourd'hui"

`/console` lands on a **work screen**, not a table. The full list moves to
`/console/clients` and stays one click away.

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
| À rappeler | `GET /leads?dueOnly=true` (`nextActionAt <= now`) | ✅ |
| Jamais contactés | `GET /leads?stage=new` + `firstRespondedAt is null` | ✅ (filter client-side, or add a flag) |
| Prochain départ | `GET /agencies/{id}/departures` | ✅ |
| Ce mois | counts by stage for the month | ❌ **needs a small endpoint** |

> [!tip] The one behaviour that makes this work
> "À rappeler" is only useful if `nextActionAt` actually gets set. So **after any call
> action, prompt for the next step**: *"Rappeler quand ?"* with quick buttons (demain ·
> dans 3 jours · lundi). Without that prompt the block stays empty and the redesign fails.

---

## Decision 2 — five stages on screen, eight in the database

| On screen | Written to the database | Plain meaning |
|---|---|---|
| **Nouveau** | `new` | quelqu'un a demandé, personne n'a répondu |
| **En discussion** | `contacted` *(also displays `quoted`, `negotiating`)* | vous lui parlez, prix envoyé, ça négocie |
| **Réservé** | `booked` | il a dit oui, place gardée |
| **Payé** | `paid` | l'argent est arrivé |
| **Parti** | `travelled` | il a voyagé — dossier fermé |
| **Perdu** *(aside)* | `lost` | n'a pas abouti, avec la raison |

### Why the enum is NOT being changed

Collapsing the database enum would be a destructive migration that throws away a
distinction bigger agencies may later want — and it cannot be undone. Instead the grouping
lives in **`packages/shared`** as a display layer over the existing values. Same pattern as
everything else here: the data model absorbs, the UI simplifies.

Add to `packages/shared/src/enums.ts`:

```ts
/** What the UI shows, over the 8 stages the database keeps. */
export const LEAD_STAGE_GROUPS = {
  nouveau:      ['new'],
  en_discussion:['contacted', 'quoted', 'negotiating'],
  reserve:      ['booked'],
  paye:         ['paid'],
  parti:        ['travelled'],
  perdu:        ['lost'],
} as const satisfies Record<string, readonly LeadStage[]>;
```

> [!warning] The subtlety that will bite
> When the user picks "En discussion" on a lead already at `quoted`, **do not write
> `contacted`** — that silently demotes them. Rule: *if the current stage is already inside
> the chosen group, leave it alone.* Write the group's first value only when moving in
> from outside. Worth a unit test.

Filtering by a group means `stage IN (...)`; `leadSearchSchema` currently takes a single
stage, so it needs to accept a group name (or an array) — a small shared-schema change.

---

## Decision 3 — quality labels stay, but stop competing

The labels (`spam` · `troll` · `cold` · `warm` · `serious` · `vip`) were explicitly
requested and feed later features. The mistake was **presentation**, not existence.

- **Remove the quality dropdown from the main edit form.** It is not a peer of stage.
- Set it from the client's own page, in its own small control — a menu on the client's
  name, or a distinct "Ce client" section. One decision at a time.
- In lists, show it **only when set**, as a small badge. `QualityBadge` already returns
  `null` for `unrated`, so most rows stay quiet — that is correct and should stay.
- Marking someone `spam`/`troll` is a judgement about a real person and is already audited
  separately ([[Client Quality Labels]]). Keep that.

---

## Decision 4 — show the chain

Wherever a client appears, the offer and its departure should be one hop away, and vice
versa. Concretely:

- Client page → the offer they asked about → **and its departure date + seats left**
- Departure manifest row → the client's CRM card
- Offer page in the console → "7 clients ont demandé cette offre"

The data already links (`Lead.offerId`, `Reservation.leadId`); only the UI is missing.

---

## Build order

1. `LEAD_STAGE_GROUPS` + the "don't demote" rule + tests — pure logic, no UI
2. Rename the stage labels in `messages/{fr,ar,en}.json` (`stages.*`) and collapse the tabs
3. Move the list to `/console/clients`; build `/console` as "Aujourd'hui"
4. The month-summary endpoint
5. The "Rappeler quand ?" prompt after a call action ← *makes block 1 work*
6. Move quality out of the edit form
7. Chain links

---

## Open questions — yours

- **"Ce mois" — which number matters most to you?** Currently proposed: clients received,
  booked, conversion %. Response time is also available (`firstRespondedAt`) and is the
  metric agencies are actually sold on.
- Should **"Parti"** clients disappear from the main list after a while? A CRM that never
  forgets slowly becomes unusable.

---

Related: [[Interface Plan]] · [[Client Quality Labels]] · [[Lead]] · [[Trip Manifest]] ·
[[Web App]] · [[API Endpoints]]
