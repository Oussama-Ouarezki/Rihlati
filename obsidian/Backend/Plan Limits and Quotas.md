# Plan Limits and Quotas

Where your paid tier comes from. Also your best spam defence — those turn out to be the
same mechanism, which is a nice thing to discover early.

Everything here lives in **one file**: `packages/shared/src/plans.ts`. This is a file you
can edit yourself.

---

## The table

|                       | `free`    | `pro`     | `business` |
| --------------------- | --------- | --------- | ---------- |
| Published offers      | **5**     | 30        | unlimited  |
| Staff accounts        | 2         | 8         | unlimited  |
| Leads per month       | unlimited | unlimited | unlimited  |
| CRM pipeline board    | —         | ✅         | ✅          |
| Assign leads to staff | —         | ✅         | ✅          |
| Analytics dashboard   | —         | ✅         | ✅          |
| Export leads to CSV   | —         | ✅         | ✅          |
| Promoted listings     | —         | ✅         | ✅          |
| Custom tags           | —         | ✅         | ✅          |
| [[Tracked Links]]     | 2         | 50        | unlimited  |
| [[Agency Chatbot]]    | —         | ✅         | ✅          |

`null` means unlimited in the code.

The chatbot row is a flag for a feature that isn't built yet — deliberately, so that when
it lands, which plan gets it is a one-word product decision, not a schema change. If it
should be the `business` anchor instead of a `pro` seller, flip it in `plans.ts`.

---

## Why leads are never capped

Look at the row that's unlimited on every plan. That's the important one, and it's a
deliberate refusal.

Capping leads looks like the obvious lever — it's the thing agencies want, so charge for
more of it. Two reasons not to:

1. **It caps the value the agency is paying for.** An agency that hits its lead cap on the
   20th of the month stops seeing the product work. They don't upgrade, they leave.
2. **It strands the traveler.** Their inquiry goes into a void nobody reads. They don't know
   why nobody called. They conclude the platform doesn't work — and they were the side you
   spent money to attract.

The principle: **sell capacity and convenience, never sell fewer customers.**

- Capacity → how many offers, how many staff
- Convenience → pipeline board, analytics, export, promotion

The `maxLeadsPerMonth` field exists so the decision stays yours. But it's `null` everywhere,
and there's a test asserting that, so nobody changes it by accident.

---

## Why limits are enforced now, with nobody paying

v1 charges nothing. The limits are still on from day one, because:

> A limit introduced later is a takeaway, and takeaways make customers leave.

If agencies get unlimited offers for a year and you then cap them at 5, you've broken a
promise you didn't know you were making. Start limited and *raise* the cap and every change
is a gift.

Costs nothing to do now. Impossible to do later.

---

## Enforcement: server-side, freshly counted

Publishing an offer checks:

1. **Count** currently published offers for this agency — a fresh `COUNT` from the database.
2. **Resolve** the limit: `publishedOfferLimitOverride` if set, otherwise the plan's.
3. **Compare**: `currentlyPublished < limit`.

Three things worth noticing:

**The count is never taken from the client.** "I have 3 offers, let me publish another" is
not evidence. See [[Validation at the Boundary]].

**Drafts don't count.** Only `published` offers occupy a slot. An agency can prepare
next season's twenty packages and publish five. Limiting drafts would be limiting work, not
limiting attention — and attention is the scarce thing.

**Strict `<`, not `<=`.** At 5 published against a limit of 5, you are full. There's an
explicit test for that off-by-one, because it's the classic place to get this wrong.

---

## The override, and why only admins may set it

`Agency.publishedOfferLimitOverride` raises one agency's cap above its plan.

You will need this immediately. Recruiting your first 40 agencies means saying "post as
many as you like, it's free while we grow" — and you want that per-agency, not a change to
the free plan for everyone.

> [!danger] Platform admins only
> If an agency could set its own override, the quota system would be decoration. This field
> must not appear in any agency-facing request schema.

One subtlety with a test on it: an override of `0` must mean **zero**, not "unset, use the
default". Written as `override || planLimit` — which is the obvious way — `0` is falsy and a
suspended agency silently gets the full free quota back. The code checks explicitly for
`null`/`undefined` instead.

---

## Feature gates

```ts
hasFeature('free', 'crmPipelineBoard')   // false
cheapestPlanWith('crmPipelineBoard')     // 'pro'
```

`cheapestPlanWith` exists so an upgrade prompt can say *"Available on Pro"* by reading the
table, rather than hardcoding "Pro" in the UI. Change the table, every prompt follows.

The API must enforce every gate too, not just hide the button — a `free` agency calling the
export endpoint directly gets `403`. See [[Authentication vs Authorization]].

---

## What is NOT built

No billing. No prices. No payment integration. The fields exist; nothing charges anyone.

When you do get there:

- **Stripe does not operate in Algeria.** The rails are local: CIB/Edahabia cards through a
  local payment provider, plus CCP / BaridiMob transfers confirmed manually by an admin.
  Verify current provider terms yourself — I won't invent them.
- Manual transfer confirmation is why **prepaid credits** are your model: the agency
  transfers 10 000 DZD, you confirm it once, the balance loads, and everything afterwards
  deducts automatically. One reconciliation, on rails that exist today. Fully designed in
  **[[Credits and Promotion]]** — including the ledger (never trust a single mutable
  balance), idempotent top-ups, and the guardrails that stop paid placement from eating
  the marketplace's credibility.
- Rule #6 in [[The Seven Rules]] applies from the first line of payment code: **prices come
  from the database, never from the client.**

See [[Decisions You Must Make]] section 5.

---

## Editing this yourself

`packages/shared/src/plans.ts` is safe for you to change. Edit the numbers, then:

```bash
npm run test --workspace @rihlati/shared
```

The tests check the table stays coherent — plans get more permissive as they get more
expensive, leads stay uncapped, every plan is fully defined. If you break one, it tells you
which.

---

## Open questions for you

- **Are 5 free offers right?** Enough to be genuinely useful, small enough that a serious
  agency wants more. Guess now, change it when you've watched 20 agencies use it.
- **What do the paid tiers cost?** Not a code question — but it's the question that decides
  whether the free tier's limits are generous or stingy.
- **What happens at the cap?** Force archiving an old offer, or show the upgrade? See
  [[Duplicate and Spam Control]].
- **Do verified agencies get a better free tier?** It would reward the thing you most want
  agencies to do.

---

Related: [[Duplicate and Spam Control]] · [[Agency]] · [[Offer]] · [[Decisions You Must Make]]
