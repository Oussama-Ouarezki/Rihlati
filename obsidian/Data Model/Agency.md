# Agency

A travel agency. **The tenant** — the unit of ownership and isolation for everything on the
private side of the app. See [[Multi-Tenancy]].

Defined in `apps/accounts/models.py`. Its docstring is one line and says the whole thing:
*"The tenant. Every private row in the database points at one of these."*

---

## The five groups of columns

The model is long, but it divides cleanly into five blocks, and the blocks are more useful to
remember than the field list.

| Block | Columns | Purpose |
|---|---|---|
| **Identity** | `name`, `slug`, `description`, `city`, `wilaya_code` | who they are, and where |
| **Contact** | `phone`, `whatsapp`, `email`, `website_url`, `logo_url` | how a traveler reaches them |
| **Verification** | `status`, `registre_commerce`, `nif`, `tourism_licence`, `submitted_for_review_at`, `decided_at`, `decided_by`, `decision_note`, `rejection_reason` | the actual product |
| **Plan & money** | `plan`, `published_offer_limit_override`, `credit_balance_centimes` | monetisation, mostly dormant |
| **Denormalised counters** | `rating_sum`, `rating_count`, `open_report_count` | speed, at the cost of a maintenance promise |

```python
class Meta:
    verbose_name_plural = "agencies"
    indexes = [models.Index(fields=["status", "wilaya_code"])]
```

`verbose_name_plural` is there because Django's automatic plural is "agencys", which would
appear in the admin sidebar and in every validation error. A one-line fix that reads as
fussiness until you see it in a screenshot.

The single index is `[status, wilaya_code]`, in that order, because every public listing of
agencies filters `status='verified'` first and *then* narrows by region — a prefix, left to
right. See [[Indexes and Why Queries Get Slow]].

---

## Verification: the actual product

Anyone can build a listings website in a month. What's slow, boring, and defensible is being
the place where **every agency has actually been checked**.

Algerians have watched agencies take Omra money and vanish. That fear is the opening, and it
is why this block of columns matters more than any feature on the roadmap.

So: check every agency by hand, forever. Record who decided and when. And **refuse the ones
that fail** — the refusals are what make the badge mean anything. A badge everyone has is
decoration.

### It is a state machine, not a boolean

```python
STATUS_TRANSITIONS = {
    DRAFT:     {PENDING},
    PENDING:   {VERIFIED, REJECTED},
    REJECTED:  {PENDING},
    VERIFIED:  {SUSPENDED},
    SUSPENDED: {VERIFIED, REJECTED},
}
```

```
draft ──► pending_review ──► verified ──► suspended ──┬──► verified
              ▲   │                                    └──► rejected
              │   └──► rejected
              └────────────┘
```

Read the shape, not just the states. A few things fall out of it that a boolean could never
express:

- **You cannot go from `draft` straight to `verified`.** Somebody has to apply. That is what
  produces `submitted_for_review_at`, and therefore a fair queue.
- **`rejected` is not terminal.** It goes back to `pending`, because "you sent a blurry photo
  of your registre de commerce" should be fixable in an afternoon, not a permanent ban.
- **`suspended` is reversible and separate from `rejected`.** "We caught you doing something"
  and "you never qualified" are different facts, and in a dispute the difference is the whole
  argument.
- **`verified` can only become `suspended`.** You cannot quietly demote a verified agency back
  to `draft` and pretend the badge was never granted.

The comment above the dict says why it is a dict at all:

> Which states a reviewer may move an agency into, from where. A table rather than scattered
> `if`s: anything not listed here is refused, and adding a state means editing one dict instead
> of hunting for branches.

**That is the transferable idea.** Any status field with rules about legal moves wants this
shape. Scattered `if` statements answer "is this move allowed?" in five places that slowly
disagree; a transition table answers it once, and the *default is refuse*.

`can_transition_to()` is the only reader, and every handler that changes status calls it before
touching anything — returning `409 Conflict`, because the caller is entitled to act, just not
from where they're standing.

### `is_verified` is a property, not a column

```python
@property
def is_verified(self):
    return self.status == self.VERIFIED
```

There *used* to be a real `is_verified` boolean; a migration dropped it. This is worth
understanding rather than skipping.

A stored boolean plus a status field is **two sources of truth that can disagree**, and they
will: some code path sets `status='suspended'` and forgets the flag, and now the agency is
suspended in the admin and verified on the marketplace. Deriving one from the other makes
disagreement impossible to express.

The cost is real and worth naming: **you cannot filter a queryset by a property.**
`Offer.publicly_visible()` says `agency__status=Agency.VERIFIED`, not
`agency__is_verified=True`, because the second one is Python and the database has never heard
of it. If that filter ever gets slow, the answer is an index on `status` (there is one), not a
denormalised boolean.

`default=DRAFT` is the security design in one keyword: a new agency is unverified, its offers
are invisible, and becoming visible requires a human to act. **The dangerous state is the one
that takes effort to reach.**

### The decision trail

`decided_by` is a `ForeignKey(User, on_delete=SET_NULL)` — a real person, on the record. Not a
username string, so it survives a rename; `SET_NULL` rather than `CASCADE`, so a staff member
leaving does not delete the history of what they approved.

`decision_note` is **required** by `DecisionIn` in the API, in both directions, and the schema
says why: *"Approving without saying what you checked produces a badge nobody can defend when
it turns out to be wrong."*

`rejection_reason` is shown **verbatim** to the owner, which means it has to be written for
them to read. "docs bad" is a real thing a reviewer will type at 6pm and a real thing an agency
owner will screenshot.

`submitted_for_review_at` looks redundant next to `updated_at` and isn't: `updated_at` moves
every time anyone edits a phone number, so it can't answer *"who has been waiting longest?"* —
the only fair way to order a manual queue. It is kept after the decision too, so "we took nine
days to answer them" stays a measurable fact rather than a feeling. The queue endpoint orders
by it, oldest first, and the comment there is blunt: *a queue that is not FIFO quietly means
whoever complains loudest gets reviewed first.*

> [!note] The harder problem underneath, which no schema fixes
> `registre_commerce`, `nif` and `tourism_licence` are strings an agency **types in itself**.
> They prove nothing on their own, and **there is no public register to check them against** —
> or if there is, I don't know it and neither should you assume it. **Verify this before
> relying on it.**
>
> So the badge means "a human at Rihlati looked at some documents and formed a judgement".
> That's defensible, but only if you say exactly that. Write down what "Verified" means in
> one sentence before launch. *"We have seen this agency's trade register and tourism licence,
> and confirmed the address"* is a claim you can defend if challenged. *"Partenaire de
> confiance"* is not.

Full flow, permissions and open questions: [[Agency Verification]].

---

## `city` and `wilaya_code` — free text next to a code, on purpose

```python
city = models.CharField(max_length=100)
# Two digits as a *string*: "01" must never become 1. See WILAYAS.
wilaya_code = models.CharField(max_length=2, blank=True, db_index=True)
```

Search filters on `wilaya_code`. `city` stays free text for the street-level detail.

If `city` alone were the filter, agencies would type "Alger", "alger", "ALGER", "Algiers",
"الجزائر" and "Alger Centre", and the dropdown would show all six as separate options. The code
is the machine-readable half; the text is the human half. Both are needed and they are not the
same field.

**The two-character string is the detail to remember.** `"01"` as an integer is `1`, and `1`
formatted back is `"1"`, and now Adrar doesn't match anything. Any identifier with a leading
zero — wilaya codes, postal codes, phone prefixes, bank codes — is a string, always, no matter
how numeric it looks.

`blank=True` is deliberate: "départ non précisé" is a real state, and forcing a guess puts wrong
wilayas in the search index. `validate_wilaya_code` allows empty and rejects unknown.

This is the "choices or table?" question from [[Data Model Overview]] with an unusually clear
answer: the list of Algerian wilayas is not the agencies' decision, and it changes roughly
never — so it lives as a constant in `apps/common/wilayas.py`.

---

## The denormalised counters, and the promise they carry

```python
rating_sum = models.PositiveIntegerField(default=0)
rating_count = models.PositiveIntegerField(default=0)
open_report_count = models.PositiveIntegerField(default=0)
```

Stored rather than computed because a listing page shows the average on every card, and
counting reviews for twenty agencies per search would be twenty extra queries.

`rating_average` is a property doing the division, returning `None` — not `0` — when there are
no reviews, because a new agency has *no rating*, and showing it as zero stars is a lie that
punishes exactly the agencies you're trying to recruit.

```python
def recompute_rating(self):
    """Recalculate from the source rows. The reconciliation half of the
    denormalisation trade — call it whenever a review changes, and from a
    periodic job that shouts if the stored numbers disagreed."""
```

> [!important] Any denormalised counter without a reconciliation job eventually lies
> That is a general rule, not a Rihlati one. Every cached count in every system you build
> either has a job that verifies it or is slowly becoming fiction.
>
> Compare `Lead.agency`, which is also denormalised and needs no job at all — because it is
> *immutable by design*, so it cannot drift. **Denormalising a value that never changes is
> free; denormalising one that does is a maintenance commitment.** That distinction is worth
> more than either example.

`recompute_rating()` exists and is called on review changes. There is a staff endpoint that
reconciles across all agencies — and it is a `GET` that writes, which is a bug of its own. See
[[Agency Ratings]] and [[Known Gaps]].

---

## Plan and quota columns

```python
plan = models.CharField(max_length=20, choices=PLANS, default=FREE)
published_offer_limit_override = models.PositiveIntegerField(null=True, blank=True)
credit_balance_centimes = models.BigIntegerField(default=0)
```

`plan` is read by `apps/common/quotas.py` and genuinely enforced today — free agencies stop at
five published offers. Nothing is charged in v1; the limits exist now because retrofitting a
quota onto agencies who already published two hundred offers means either breaking them or
grandfathering them forever.

`published_offer_limit_override` is the interesting one:

> The escape hatch is intentional and admin-only: a real marketplace always has one agency
> with a negotiated arrangement, and without a column for it somebody eventually edits the
> limits table for one tenant.

`credit_balance_centimes` is money, so it is integer centimes, and it is read by nothing yet.
See [[Plan Limits and Quotas]] and [[Credits and Promotion]].

---

## Staff: the `Membership` table

A user isn't a column on `Agency`. They're linked by a `Membership` row carrying the role:

```
User ──── Membership (role: agency_owner | agency_manager | agency_agent) ──── Agency
```

```python
class Meta:
    constraints = [
        models.UniqueConstraint(fields=["user", "agency"], name="unique_membership_per_agency")
    ]
```

Why this shape:

- One person can work for two agencies. Real: accountants, and owners of small groups. With
  this shape they switch context; they don't need a second login.
- The role is on the **relationship**, so someone can be owner at one agency and agent at
  another.
- Removing someone is deleting one row, not editing a user.

The alternative — an `agency_id` column on `User` — caps everyone at one agency forever and
turns "transfer ownership" into a data migration. It looks simpler for exactly as long as it
takes to meet the first accountant who works for three agencies.

The unique constraint is doing real work: it's enforced by the **database**, not by an
`if Membership.objects.filter(...).exists()` check in a handler. Two simultaneous "add this
person" requests both pass an application-level check and both insert; only one passes a
database constraint. Any uniqueness rule that matters belongs in `Meta.constraints`.

`RANK = {AGENT: 1, MANAGER: 2, OWNER: 3}` and the rank comparison in `require_membership` are
covered in [[Authentication vs Authorization]]. Roles are enforced, not merely stored.

---

## The `slug`

`slug = models.SlugField(unique=True)` — globally unique, intended to form a public URL.

Global rather than per-agency because it's an SEO address, and a search engine needs one
canonical URL per page.

> [!warning] Honest state — nothing generates it
> `Offer` has a `save()` override calling `_unique_slug()`, with a de-duplicating loop and a
> comment about not letting a client pick its own. **`Agency` has neither.** `seed_preview.py`
> sets it by hand, and creating an agency any other way would hit the `unique` constraint with
> an empty string on the second try.
>
> The fix is ten lines copied from `Offer`. It hasn't been done because no endpoint creates an
> agency yet — which is itself a gap worth noticing. See [[Known Gaps]].

When it is wired up: **a published slug should not change.** A URL that changes loses its
search ranking and breaks every link already pasted into WhatsApp. When a name changes, keep
the old slug; if one truly must change, the old one needs a redirect.

---

## Open questions

- **Can one agency have several branches** (Alger + Oran) sharing offers but with separate lead
  inboxes? Today: no — they'd be two agencies with two verifications and no shared catalogue.
  Changing this later is a real migration, so it's worth deciding now if you expect chains.
- **What happens to leads when an agency is suspended?** Offers hide immediately — that falls
  out of `status != verified` for free. Their existing leads presumably stay readable, but if
  the suspension is for fraud, should they still hold travelers' phone numbers? That's a legal
  question; **verify it against Algerian data-protection law.**
- **Does a verified agency need re-verification?** A tourism licence expires. An annual re-check
  is more work and it is what keeps the badge honest — a badge granted once and never revisited
  means "was fine in 2026". There is no `verification_expires_at` column, and adding one later
  requires deciding what to do with agencies verified before it existed.
- **Who at Rihlati can verify?** Today: anyone with `is_staff`, which is also the flag that
  opens the Django admin. Verification deserves its own permission before the team is more than
  one person.
- **Should an agency be able to appeal a rejection more than once?** `rejected → pending` has no
  counter on it, so an agency can resubmit indefinitely and re-enter the queue each time. That
  is generous by default rather than by decision.

---

Related: [[Data Model Overview]] · [[Multi-Tenancy]] · [[Offer]] · [[Lead]] · [[User]] ·
[[Agency Verification]] · [[Agency Ratings]] · [[Plan Limits and Quotas]] ·
[[Authentication vs Authorization]] · [[Decisions You Must Make]]
