# Lead

A traveler's inquiry about a trip: who they are, what they want, and where the agency has got to
with them.

**This is the most commercially important table in the app.** It's what agencies would pay for,
and it's what the whole monetization plan sits on. It is also the most sensitive — it holds real
people's phone numbers.

Defined in `apps/leads/models.py`, which also holds `LeadNote`, `LeadActivity`, `Tag` and
`LeadTag`.

---

## What's in the table

```python
class Lead(UUIDModel):
    agency      FK(Agency, CASCADE)                 # the tenant column
    offer       FK(Offer, PROTECT)                  # what they asked about
    traveler    FK(User, null=True, SET_NULL)       # if they had an account
    client      FK(Client, null=True, SET_NULL)     # the person, across inquiries

    full_name   CharField(150)
    phone_e164  CharField(20, db_index=True)        # +213...
    message     TextField(blank=True)

    status      choices=STATUSES, default=NEW
    quality     choices=Quality, default=UNRATED
    source      choices=Source,  default=MARKETPLACE
    lost_reason CharField(200, blank=True)

    assigned_to        FK(User, null=True, SET_NULL)
    next_action_at     DateTimeField(null=True)
    first_responded_at DateTimeField(null=True)
    estimated_value_centimes BigIntegerField(null=True)

    consent_given_at, consent_text_version, consent_ip_hash, consent_user_agent
    tracked_link FK(TrackedLink, null=True, SET_NULL)
```

Three `on_delete` values, three different business statements — this model is the clearest place
to see that **`on_delete` is a product decision, not a technicality**:

- `agency` is **CASCADE**: an agency that ceases to exist takes its inbox with it.
- `offer` is **PROTECT**: *you cannot delete an offer that has leads.* The database refuses. Leads
  are the record of real people who asked real questions; they must not disappear because someone
  tidied a catalogue.
- `traveler` is **SET_NULL**: the lead survives the account. Which brings us to the most important
  design decision in this table.

---

## Why contact details are copied, not linked

`full_name` and `phone_e164` are stored on the lead **even when `traveler` points at a real User**
who has the same name and number. The model comment says why:

```python
# Copied, not linked: an inquiry must work with no account, and the
# agency's record of who inquired in March must survive that person
# changing their number or deleting their profile.
```

Three reasons, and this is the single most transferable idea in the note:

1. **An inquiry must work with no account.** `traveler` is `null=True` and `create_inquiry` is
   `auth=None`. Forcing signup before the one action that makes you money is the most expensive
   mistake a marketplace can make.
2. **A lead is a historical record.** If someone later deletes their account or changes their
   number, the agency's record of *who inquired in March* must stay intact. That's a business
   document, not a view of current state.
3. **The agency owns its copy.** A traveler exercising a data-deletion request removes their
   *account*; whether the agency's commercial record goes with it is a separate question with a
   separate — and legal — answer.

> [!info] The general rule
> **A transactional record snapshots the facts it depends on; it does not point at them.** An
> invoice stores the price at the time of sale, not a foreign key to the current price. A lead
> stores the phone number as given, not a pointer to a mutable profile. Getting this backwards
> produces a system where changing your name rewrites history.

The same instinct is why `agency` is denormalised from `offer.agency` rather than reached through
it — see the tenancy section below.

### The person behind the inquiry

`Lead.client` points at a [[Client]] — the same person across every inquiry. It is `SET_NULL`,
so deleting the client does not delete the record of what they asked, and the snapshotted
`full_name` / `phone_e164` above remain the authority for *this* inquiry. Editing the client
profile never rewrites March's lead. `client_for_contact` is the one rule that links a new lead
to a person; every creation door calls it. See [[Client]].

---

## The consent trail

Four columns, written once at submission and never updated:

```python
consent_given_at       # when
consent_text_version   # exactly which wording they agreed to
consent_ip_hash        # from where — hashed, never raw (Rule 4)
consent_user_agent     # on what
```

`consent_text_version` is the important one, and the module docstring above it explains it better
than a paraphrase:

```python
# The exact wording a traveler agreed to. Bumped — never edited in place —
# whenever the consent text changes, so an old lead still answers "what did
# this person actually agree to?". Storing `consent_given=True` alone makes
# that question unanswerable, and unanswerable is legally the same as no
# consent. VERIFY the wording itself against Algerian law 18-07 with a lawyer.
CONSENT_TEXT_VERSION = "2026-08-06.fr.v1"
```

**This is also what separates the business model from an illegal one.** Selling a data list and
selling a *consented introduction* are different things, and only the second is a business.

### The wording is served, not duplicated

```python
@public_router.get("/consent-text", response=ConsentOut, auth=None)
def consent_text(request):
    """The form fetches the wording it is about to record agreement to, so the
    checkbox label and the stored version can never drift apart."""
```

The HTML form does the same thing a different way — `apps/pages/forms.py` uses
`forms.BooleanField(label=CONSENT_TEXT, required=True)`, importing the same constant. One
source, three consumers (API clients, the server-rendered form, the stored version). This is
[[One Rule, Two Entry Points]] applied to a legal artefact rather than a validation rule, and the
stakes are higher: two doors that record agreement to two different sentences is exactly the
thing you cannot fix afterwards.

### Consent is a hard gate, not a flag

```python
if not payload.consent:
    raise HttpError(422, "Le consentement est requis pour transmettre vos coordonnées.")
```

`consent: bool` on `LeadIn` has **no default**. The comment is explicit about why:

```python
# Unchecked box → no lead. Not a default-true field, and not something the
# server assumes: the whole point is that it was a deliberate act.
```

A field with `= True` as its default is a field a client can omit, and an omitted checkbox that
records agreement is not agreement. Two tests pin this — `test_an_unchecked_consent_box_creates_nothing`
on the API and `test_an_unticked_consent_box_creates_nothing_here_either` on the HTML form. The
duplicated test is deliberate: both doors, always.

`hash_ip()` is worth reading for a general lesson:

```python
def hash_ip(request):
    """Salted with SECRET_KEY so the hash is useless outside this deployment,
    and irreversible so the log is not itself the leak it exists to prevent."""
```

Without the salt, an IP hash is trivially reversible — there are only four billion IPv4
addresses, so a rainbow table of every possible hash fits on a laptop. Hashing without salting a
small keyspace is security theatre.

> [!warning] Verify the wording with an Algerian lawyer
> `CONSENT_TEXT` is a plausible French sentence written by a developer. Whether it satisfies Law
> 18-07 is a legal question and I will not guess at it. The *mechanism* is right; the *text* needs
> review before a real person's number is collected. See [[Decisions You Must Make]].

---

## The pipeline

```python
NEW, CONTACTED, QUOTED, NEGOTIATING = "new", "contacted", "quoted", "negotiating"
BOOKED, TRAVELLED, LOST = "booked", "travelled", "lost"
TERMINAL_STATUSES = {TRAVELLED, LOST}
```

Seven stages, French labels, no transition table — any status can move to any other. That's
deliberate for a CRM: a real sale jumps around (a lead goes straight from `new` to `booked`
because the client walked in that afternoon), and a state machine that forbids it just teaches
staff to lie to the software.

`TERMINAL_STATUSES` is the one place the order matters — the "due for a callback" filter excludes them,
because chasing a callback on a trip that already happened is noise.

`lost_reason` will, after a few hundred leads, be the most valuable data you own: it tells you
*why* Algerian travelers don't buy, which is a report nobody else in the market has.

### Two derived timestamps

```python
def touch_first_response(self):
    if self.first_responded_at is None and self.status != self.NEW:
        self.first_responded_at = timezone.now()
```

Set once, by the model, on the first status change away from `new`. Never accepted from a client —
it's not on `LeadUpdate`. It feeds *"vous répondez en 12 minutes en moyenne"*, which is the most
persuasive number you can show a prospective agency and a fairer search-ranking signal than
recency. **It cannot be backfilled**, which is why it exists now rather than when the dashboard
that shows it does.

Note the `if ... is None` guard: this is called on *every* update, and without it the "first"
response time would be overwritten by the most recent one. A one-line method with a subtle
invariant is exactly the kind of thing that belongs on the model rather than copied into three
call sites — and it *is* called from three: `update_lead`, the HTML CRM view, and
`apps/trips/api.py`.

`next_action_at` powers "due for a callback today" — in practice *the* screen an agency opens every
morning, and the reason they keep using the CRM instead of a notebook.

### What the update endpoint checks

`LeadUpdate` has six optional fields and every one is checked before it's written:

```python
if "status" in changes and changes["status"] not in dict(Lead.STATUSES): 422
if "quality" in changes and changes["quality"] not in Lead.Quality.values: 422
if "assigned_to_id" in changes and changes["assigned_to_id"]:
    assignee = User.objects.filter(pk=..., memberships__agency_id=agency_id).first()
    # Membership-scoped: assigning a lead to a user outside the agency
    # would hand them an inbox they have no right to.
```

The `choices=` argument on a Django field **does not validate on `save()`** — it only affects
forms and the admin. `Lead(status="deleted").save()` succeeds silently. So the check has to be
written, at both doors, and the HTML view does the same `dict(Lead.STATUSES)` lookup. Everything
absent from `LeadUpdate` — `full_name`, `phone_e164`, `agency`, `offer`, `consent_*` — cannot be
changed through the API at all.

The assignee check is the one that isn't obvious. It's an *authorization* check wearing a
validation error's clothes: nothing stops a manager sending a valid UUID belonging to a user at
another agency, and without the `memberships__agency_id` filter that user would appear in a lead
list they have no membership for.

> [!warning] `next_action_at` is typed `str | None`, then assigned to a `DateTimeField`
> `setattr(lead, "next_action_at", "2026-09-01T10:00:00Z")` works — Django parses ISO strings on
> save. `"demain matin"` raises Django's `ValidationError` at save time, which the error handler
> turns into a `400` with a French Django sentence in it, rather than the `422` with a field name
> that every other bad field on this schema produces.
>
> It should be `datetime | None` so Pydantic rejects it at the boundary. Same class of bug as the
> `departure_date: str` one in [[Validation at the Boundary]] — the difference is that one 500'd
> and this one merely produces the wrong error. Logged in [[Known Gaps]].

---

## Notes vs Activities — two tables, on purpose

| | `LeadNote` | `LeadActivity` |
|---|---|---|
| Written by | a person | the system |
| Content | "client wants a window seat, calling back Thursday" | `status_changed: new → contacted` |
| Editable | yes | **never** |
| Base class | `UUIDModel` (has `updated_at`) | plain `Model` (no `updated_at`) |
| Purpose | working memory | audit trail |

The docstring makes the argument:

> Separate from LeadNote deliberately: if staff could edit the activity timeline it would be
> worthless as evidence in a dispute, and if the system wrote into notes, real notes would drown
> in noise. One table for both looks simpler and destroys both purposes.

**The design axis is editability, not subject matter.** That's the reusable idea: whenever you're
deciding whether two things belong in one table, ask who writes them and whether either can be
rewritten afterwards. If the answers differ, they're two tables.

`LeadActivity` enforces it structurally rather than by convention:

```python
def delete(self, *args, **kwargs):
    raise ValueError("Lead activities are append-only.")
```

And it deliberately does **not** inherit `UUIDModel`, because `updated_at` on an append-only table
is a column that can only ever lie.

> [!info] This is not `AuditLog`
> `LeadActivity` is the *agency's* timeline — what staff see on the lead page. `AuditLog` is
> *yours*, for answering "who changed this and when" across the whole platform. `update_lead`
> writes both, which is not redundancy: one is a product feature with a French verb in it, the
> other is a security record with `before`/`after` payloads. See [[Audit Log]].

---

## `source` decides whether you can charge

```python
BILLABLE_SOURCES = {Source.MARKETPLACE, Source.TRACKED_LINK}

@property
def is_billable(self):
    return self.source in self.BILLABLE_SOURCES
```

Five sources: `marketplace_inquiry`, `tracked_link`, `walk_in`, `direct_call`, `imported`. Only
the first two are billable, and the docstring states the rule plainly:

> Never charge an agency for a lead they brought themselves. If you do, they stop logging their
> own clients, and the pipeline data every future feature depends on becomes fiction.

You would be charging a small fee to blind yourself. `is_billable` is exposed on `LeadOut` today
and nothing acts on it — it's the hook [[Credits and Promotion]] will attach to, and it exists
now so that leads collected before billing exists are already correctly classified.

`source` is set by the server in `create_inquiry`, never sent: `MARKETPLACE` by default, promoted
to `TRACKED_LINK` only if the submitted code resolves to a link **belonging to the offer's own
agency** (`agency_id=offer.agency_id`). Without that filter, one agency's campaign code could be
pasted onto another's inquiry.

There's a test named for the attack: `test_a_client_cannot_set_is_billable`.

---

## Tenant isolation

`agency` is non-null and denormalised from `offer.agency`. The model docstring gives two reasons,
and the second one is easy to miss:

> the tenant filter then never has to join, and an offer changing hands later cannot silently move
> a historical lead into another agency's inbox.

The first is the [[Multi-Tenancy]] argument: the safe query is also the lazy query, and people
take the lazy path. The second is a correctness argument about time — a lead is a record of what
was true in March, and reaching through `offer.agency` would make it a view of what's true today.

Every write derives the tenant from server-controlled data:

```python
lead = Lead(
    agency=offer.agency,      # derived
    offer=offer,              # from publicly_visible(), not Offer.objects
    traveler=request.user if request.user.is_authenticated else None,
    ...
)
```

`LeadIn` has no `agency_id`, no `status`, no `quality`, no `source` field — its docstring names
the attack: *"a client that could set `quality: vip` would be writing into someone else's CRM."*
`Strict` rejects a payload that includes them anyway.

Two second-order protections in the same handler:

- `offer` comes from `Offer.publicly_visible()`, so a draft or unverified-agency offer's id —
  even a real one — cannot receive a lead. Test: `test_inquiry_on_a_hidden_offer_is_404`.
- The response is a bare confirmation, not the lead:

  ```python
  """Echoing the created row back would let anyone POST a plausible payload and
  read an id they can then try elsewhere. The traveler has no use for it; the
  agency reads it from their inbox."""
  ```

  Test: `test_the_response_does_not_echo_the_created_lead`. Returning the created object is the
  reflex, and here the reflex hands out a capability.

The required isolation test exists on both doors: `test_other_agency_cannot_read_lead` (API) and
`test_member_cannot_move_another_agencys_lead` (HTML). Both assert `404`, not `403` — `403`
confirms the row exists.

---

## The indexes

```python
ordering = ["-created_at"]
indexes = [
    # Every index leads with `agency` because every query on this table
    # is tenant-scoped: there is no "find lead 123" without "belonging
    # to my agency".
    models.Index(fields=["agency", "status", "-created_at"]),
    models.Index(fields=["agency", "quality"]),
    models.Index(fields=["agency", "assigned_to", "next_action_at"]),
    models.Index(fields=["agency", "phone_e164"]),
]
```

**The security design and the performance design point the same way**, which is usually a sign the
design is right: the column you must filter by is also the column that makes the filter fast. See
[[Indexes and Why Queries Get Slow]] for why the leading column is the one that matters.

The last one — `[agency, phone_e164]` — is why phone normalisation matters. An index on
`phone_e164` is useless if the same person is stored as `0551234567` once and `+213551234567`
another time: you get two rows for one human and can never recognise a repeat client.
`validate_dz_phone` runs on every inquiry at both doors for exactly this reason.

> [!tip] `list_leads` searches with `icontains` on three columns
> `full_name`, `phone_e164` and `message`, OR'd together. **No index helps a leading-wildcard
> `LIKE '%…%'`** — this reads every lead the agency has. That's fine at a few thousand rows per
> agency and it is the query to revisit first when a big agency complains the inbox is slow.

The pipeline endpoint aggregates in SQL rather than Python, with the reason written down:
*"doing it in Python means loading every lead an agency has ever had to render one row of a
summary."*

---

## Tags: a table, not `choices`

```python
class Tag(UUIDModel):
    """An agency-invented label. A *table*, not `choices`, because the values
    are the agency's decision — unlike Lead.status, which is yours."""
```

This is the general rule for "should this be an enum or a table", and it isn't about how many
values there are:

> **Whose decision is it?** If you decide the values, they're `choices` and changing them is a
> migration you control. If the user decides, it's a table.

`Lead.status` is yours: the pipeline is the product, and an agency inventing a "peut-être" stage
would break every funnel report. `Tag` is theirs: "VIP", "Ramadan 2027", "call back after
l'Aïd" — you cannot enumerate those and shouldn't try.

`UniqueConstraint(["agency", "name"])` stops two "VIP" tags in one agency splitting the list in
half. `LeadTag` is the join table with `UniqueConstraint(["lead", "tag"])`, and it carries its own
`agency` column so tag queries stay scoped without a join through the lead.

---

## Open questions

- **Are contact details revealed immediately, or after the agency responds in-platform?** This
  decides whether you can ever charge for a lead. Today `phone_e164` is in `LeadOut` the moment
  the lead lands. See [[Decisions You Must Make]].
- **How many agencies does one inquiry go to?** One (exclusive, higher value per lead) or several
  (better for the traveler, more competition)? Today: exactly one, because the lead derives from a
  single offer. Changing that later is a schema change, not a tweak.
- **Can a traveler see their own inquiry history?** `Lead.traveler` exists for it and nothing
  reads it. It's one of the few real reasons for a traveler to make an account at all.
- **How long do leads live?** "Forever" is a decision, and it's the one you make by not making
  one. Retention has a legal dimension in Algeria — verify, don't assume.
- **Should `estimated_value_centimes` be manual, or default from `offer.price_centimes`?** Manual
  today, so it's usually empty, which makes the pipeline value column mostly zeroes.
- **Is `quality` an agency-private judgement or a platform-wide signal?** If a traveler flagged
  `spam` by three agencies should be blocked from inquiring at all, `quality` needs to roll up
  somewhere — and that's a very different, much more dangerous feature. See
  [[Client Quality Labels]].

---

Related: [[Data Model Overview]] · [[Client]] · [[Offer]] · [[Agency]] · [[Multi-Tenancy]] · [[Audit Log]] ·
[[Client Quality Labels]] · [[Validation at the Boundary]] · [[One Rule, Two Entry Points]] ·
[[Decisions You Must Make]] · [[Indexes and Why Queries Get Slow]] · [[Credits and Promotion]] ·
[[Tracked Links]] · [[Known Gaps]]
