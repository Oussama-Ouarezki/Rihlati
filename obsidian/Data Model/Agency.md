# Agency

A travel agency. **The tenant** — the unit of ownership and isolation for everything on the
private side of the app. See [[Multi-Tenancy]].

---

## Verification: the actual product

```
registreCommerce   String?   -- RC
nif                String?   -- numéro d'identification fiscale
tourismLicence     String?   -- agrément d'agence de tourisme et de voyage
status             AgencyStatus
verifiedAt         DateTime?
verifiedByUserId   String?
rejectionReason    String?
```

Anyone can build a listings website in a month. What's slow, boring and defensible is being
the place where **every agency has actually been checked**.

Algerians have watched agencies take Omra money and vanish. That fear is your opening, and
it's why these four fields matter more than any feature you could build.

So: check every agency by hand, forever. Record who verified it and when. And **refuse the
ones that fail** — the refusals are what make the badge mean anything. A badge everyone has
is decoration.

> [!important] Write down what "Vérifiée" means, in one sentence, before you launch
> A traveler has to believe it. "We have seen this agency's trade register and tourism
> licence, and confirmed the address" is a claim you can defend. "Trusted partner" is not.
> See [[Decisions You Must Make]] section 4.

### Status

```
draft ──► pending_review ──► verified
                │              │
                └──► rejected  └──► suspended
```

Only `verified` agencies appear publicly, and their offers are invisible until then. This
is enforced as a default in the search query, not as a flag callers pass — a default nobody
can forget.

`suspended` is for an agency that *was* verified and did something wrong. Separate from
`rejected` because it's reversible and because the distinction matters if there's ever a
dispute.

---

## The rating aggregate

```
ratingSum    Int  @default(0)
ratingCount  Int  @default(0)
```

The average is `ratingSum / ratingCount`. Stored rather than computed because listing pages
show it on every card, and counting reviews for twenty agencies on every search would be
slow.

The cost of that speed: these two numbers can drift out of sync with reality. They must be
recomputed whenever a review is published, hidden, or edited — and there should be a
periodic job that recalculates from scratch and shouts if it disagrees. **Any denormalized
counter without a reconciliation job eventually lies.**

Details in [[Agency Ratings]].

---

## Plan and limits

```
plan                         AgencyPlan  @default(free)
publishedOfferLimitOverride  Int?
creditBalanceCentimes        Int         @default(0)
```

`plan` is `free` / `pro` / `business`. What each allows lives in **one** table:
`packages/shared/src/plans.ts`. Nothing anywhere else hardcodes "5 offers".

`publishedOfferLimitOverride` raises the cap for a specific agency — for the partner deals
you'll want when recruiting your first agencies. **Platform admins only.** If an agency
could set its own override, the whole quota system would be decorative.

`creditBalanceCentimes` is unused in v1, reserved for prepaid lead credits.

Full explanation, including where your paid tier comes from: [[Plan Limits and Quotas]].

---

## Moderation counters

```
suspectedDuplicateCount  Int @default(0)
openReportCount          Int @default(0)
```

Denormalized, purely so the admin queue can sort by "who needs looking at". Same
reconciliation caveat as the rating counters.

---

## Contact fields, and one Algeria-specific note

`phone`, `whatsapp`, `email`, `websiteUrl`, `addressLine`, `city`, `wilayaCode`.

`whatsapp` is separate from `phone` on purpose. In Algeria WhatsApp is where business
actually happens, and it's often a different number from the office landline. Pretending
one field covers both means agencies get contacted on a phone nobody answers.

`wilayaCode` is a two-digit string (`"16"` = Alger), never an integer — `"01"` must not
become `1`. The full list of 58 is in `packages/shared/src/wilayas.ts` with French and
Arabic names.

---

## Staff: the `Membership` table

A user isn't a column on `Agency`. They're linked by a `Membership` row carrying the role:

```
User ──── Membership (role: owner | manager | agent) ──── Agency
```

Why this shape:
- One person can work for two agencies. Real: accountants, and owners of small groups.
  With this shape they switch context; they don't need a second login.
- The role is on the **relationship**, so someone can be `owner` at one and `agent` at
  another.
- Removing someone is deleting one row.

Roles and what each can do: [[Authentication vs Authorization]].

---

## Open questions for you

- **Can one agency have several branches** (Alger + Oran) sharing offers but with separate
  lead inboxes? Today: no, they'd be two agencies. Changing this later is a real migration,
  so it's worth deciding now if you expect chains.
- **What happens to leads and offers when an agency is suspended?** Offers should hide
  immediately. Their existing leads presumably stay readable — but if they're suspended for
  fraud, should they still hold travelers' phone numbers?
- **Does a verified agency need re-verification?** A tourism licence expires. An annual
  re-check is more work but it's what keeps the badge honest.

---

Related: [[Data Model Overview]] · [[Multi-Tenancy]] · [[Plan Limits and Quotas]] ·
[[Agency Ratings]] · [[Offer]] · [[Decisions You Must Make]]
