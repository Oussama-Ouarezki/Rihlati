# Client

One person the agency knows, as opposed to one inquiry they received.

A [[Lead]] is a question asked at a moment. A `Client` is the person across moments: the same
phone number coming back six months later, the family that booked twice, the walk-in who never
filled a form. The client directory sits beside the pipeline, not inside it — the pipeline is
still the [[Lead]] inbox.

Defined in `apps/leads/models.py`, next to `ClientNote` and `ClientTag`.

---

## What's in the table

```python
class Client(UUIDModel):
    agency      FK(Agency, CASCADE)
    full_name   CharField(150)
    phone_e164  CharField(20)

    unique_together = (agency, phone_e164)
```

**That is the whole profile.** Deliberately small. Everything else an agency might want to
remember about a person — preferences, family, "call her in the evening" — lives in
`ClientNote`, and labels live in `ClientTag`.

The reasoning is the same one that shaped [[Lead]]: a person is not a deal. A deal has a status,
a quality rating and a callback date. A person has a name and a phone number and a history of
both. Mixing the two produces a table where "VIP" and "negotiating" have equal status, which is
how CRMs become spreadsheets again.

| Table | Written by | Editable | Answers |
|---|---|---|---|
| `Client` | the system / staff | yes | who is this person today? |
| `ClientNote` | a human | yes | what should we remember about them? |
| `ClientTag` | a human | yes (attach/detach) | which of our labels apply? |

`ClientTag` reuses the existing `Tag` vocabulary rather than inventing a second one. An agency
that labels a lead "VIP" can label the same person "VIP" without maintaining two lists of
labels in two places.

---

## Identity is the phone number

A client is unique per `(agency, phone_e164)`. That is the only identity rule, and it is the
reason `validate_dz_phone` runs at every door: `0555111222` and `+213555111222` are one person,
and if the database has both, the CRM has two clients with half the history each.

The unique constraint is the enforcement, not a convention:

```python
models.UniqueConstraint(
    fields=["agency", "phone_e164"], name="unique_client_phone_per_agency"
)
```

Two agencies may each have a client with the same number — they are different people *to those
agencies*, and one agency must never learn that another has the same customer.

---

## Snapshots vs the profile

`Lead.full_name` / `Lead.phone_e164` and `Reservation.full_name` / `Reservation.phone_e164`
stay exactly as they were. Editing a client does **not** rewrite history:

> Correcting a spelling in the client profile does not change what the inquiry said in March.

This is the same rule as [[Lead]]'s "copied, not linked". The client is the mutable view of the
person today; the lead and the reservation are records of a moment. `Lead.client` and
`Reservation.client` are nullable `SET_NULL` foreign keys, so deleting a client unlinks the
history but never deletes it.

---

## One linking rule

Every creation door calls the same function, `apps/leads/services.py::client_for_contact`:

```python
client, _created = Client.objects.get_or_create(
    agency=agency,
    phone_e164=phone_e164,
    defaults={"full_name": full_name.strip()},
)
```

The doors:

- the public inquiry form (HTML)
- `POST /api/inquiries` (JSON)
- a reservation created from the manifest
- a reservation created through the API
- `seed_preview`

`get_or_create` is race-safe because of the unique constraint: two simultaneous inquiries from
the same number converge on one row. An existing client's name is left alone — the first
spelling may be a typo, but silently rewriting the profile on every form submission is worse,
because the profile is staff-owned.

> [!info] One rule, two entry points
> The HTML door and the JSON door call the same service rather than each writing the rule. Two
> copies of "how do we recognise a returning person" drift the first time one gets a bug fix.
> See [[One Rule, Two Entry Points]].

---

## Reading the directory

`ClientQuerySet` owns everything the page and the API share, so they cannot disagree about what
"à venir" or "répété" means:

```python
.with_stats()     # lead_count, trip_count, last_trip_on
.upcoming()       # at least one non-cancelled reservation with a future departure
.for_filter(name)
.search(term)     # name, or a phone typed in any shape
```

Stats are annotations, not properties. Rendering fifty clients is still one query, not fifty.

`search` is the interesting one: it strips non-digits from the term, so `0555 11 12 22` finds
`+213555111222`. A plain `icontains` on the stored column never would, because the stored value
has no leading zero.

Filters are intentionally blunt:

- **À venir** — has an upcoming, non-cancelled booking
- **Répétés** — two or more trips
- **Sans voyage** — zero trips

Client-level status, quality and callback dates are **not** here. They stay on [[Lead]], where
they describe a deal. A person is not "negotiating"; a person is someone who has an open deal.

---

## Routes and pages

| Route | Name | Page |
|---|---|---|
| `GET /a/<agency>/clients/` | `agency-clients` | directory, search, chips, add-client form |
| `GET /a/<agency>/clients/<id>/` | `agency-client-detail` | profile, notes, tags, trips, demands, chronology |

The detail chronology is computed, not stored: `LeadActivity` events, reservations and notes are
merged and sorted in `_client_timeline`. A fourth activity table would only be a third place for
the same facts to disagree.

Adding a client by hand is supported for walk-ins and phone calls. Tags and new-tag creation are
manager-only; notes and profile edits are not.

---

## Backfill

`Client` arrived after leads and reservations existed, so two migrations link the history:

1. `leads.0003_…` creates the models and builds one client per `(agency, phone)` from the
   *earliest* inquiry, then links every lead.
2. `trips.0002_reservation_client` links each reservation to its lead's client, or creates a
   client from the booking's phone for a walk-in.

Split across apps because a single migration would make leads depend on trips and trips on
leads. `apps/leads/tests_migrations.py` seeds two inquiries from one number, a second agency and
a walk-in booking, then rolls both migrations forward and asserts one client per person per
agency and zero unlinked rows.

---

## API

| Method | Path | What |
|---|---|---|
| `GET` | `/api/agencies/<id>/clients` | list, `q`, `filter`, `limit`, `offset` |
| `POST` | `/api/agencies/<id>/clients` | add a person, optional first note |
| `GET` | `/api/agencies/<id>/clients/<client_id>` | profile + leads + trips + notes + tags |
| `PATCH` | `/api/agencies/<id>/clients/<client_id>` | name and phone |
| `GET`/`POST` | `…/clients/<client_id>/notes` | read / add a note |
| `POST`/`DELETE` | `…/clients/<client_id>/tags/<tag_id>` | attach / detach a label |

Duplicate phone numbers are `409` with a French sentence, not a database `500`. Every query is
scoped by `agency_id` in the same way as the rest of the CRM — see [[Multi-Tenancy]].

---

## Deliberately not in v1

- **Merging duplicate clients.** Needs a policy for which name, notes and tags win.
- **CSV import/export.** The next thing an agency will ask for, and the easiest way to create
  thousands of duplicate phone numbers.
- **Client-level callbacks / quality.** Stays on [[Lead]] until there is evidence agencies want
  the person-level version.
- **Archiving.** Deleting a client unlinks history; there is no soft delete yet.
- **"Aujourd'hui" client view.** The milestone plan's M6.

---

Related: [[Lead]] · [[Data Model Overview]] · [[Multi-Tenancy]] · [[Templates and Pages]] ·
[[API Endpoints]] · [[CRM Redesign]] · [[One Rule, Two Entry Points]]
