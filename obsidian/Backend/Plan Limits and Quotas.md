# Plan Limits and Quotas

Where your paid tier comes from. Also your best spam defence — those turn out to be the
same mechanism, which is a nice thing to discover early.

Everything enforced lives in **one file**: `apps/common/quotas.py`. This is a file you can
edit yourself.

---

## The table

|                       | `free`    | `pro`     | `business` | enforced? |
| --------------------- | --------- | --------- | ---------- | --------- |
| Published offers      | **5**     | 30        | 200        | **yes** — `PUBLISHED_OFFER_LIMITS` |
| Seats across offers   | unlimited | unlimited | unlimited  | no — `SEAT_LIMITS`, all `None` |
| Leads per month       | unlimited | unlimited | unlimited  | never, on purpose (below) |
| Staff accounts        | 2         | 8         | unlimited  | **not yet** |
| CRM pipeline board    | —         | ✅         | ✅          | **not yet** |
| Assign leads to staff | —         | ✅         | ✅          | **not yet** |
| Analytics dashboard   | —         | ✅         | ✅          | **not yet** |
| Export leads to CSV   | —         | ✅         | ✅          | **not yet** |
| Promoted listings     | —         | ✅         | ✅          | **not yet** |
| Custom tags           | —         | ✅         | ✅          | **not yet** |
| [[Tracked Links]]     | 2         | 50        | unlimited  | **not yet** |
| [[Agency Chatbot]]    | —         | ✅         | ✅          | feature not built |

> [!warning] Only the first row is code. The rest is the plan.
> This is stated bluntly because a table that mixes "enforced" and "intended" without saying
> which is which is how a free agency ends up exporting leads for a year and then being told
> to stop. `PUBLISHED_OFFER_LIMITS` and `SEAT_LIMITS` are the only two dictionaries that
> exist; everything below them is a decision written down early so it does not have to be
> invented under pressure later.
>
> `SEAT_LIMITS` is `None` everywhere on purpose: the *shape* of the limit is in the file so
> that when a number is finally chosen it lands here with the others, rather than as a magic
> number inside a handler.

`business` is **200**, not unlimited. An unlimited tier means the largest customer can, by
accident, make every search query slow for everybody. A number you can raise is friendlier
than an outage.

The chatbot row is a flag for a feature that is not built — deliberately, so that when it
lands, which plan gets it is a one-word product decision rather than a schema change.

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

There is deliberately **no `LEAD_LIMITS` dictionary** in `quotas.py`. Not one set to `None`
everywhere — none at all. A dictionary of nulls is an invitation; its absence is a decision
somebody has to reopen on purpose.

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

`assert_can_publish(agency, exclude_pk=None)` is called before **any** transition into
`published` — creating an already-published offer, or publishing a draft. It:

1. **Counts** currently published offers for this agency — a fresh `COUNT` from the database.
2. **Resolves** the limit: `published_offer_limit_override` if set, otherwise the plan's.
3. **Compares**: `count >= limit` → `QuotaExceeded`.

Four things worth noticing:

**The count is never taken from the client.** "I have 3 offers, let me publish another" is
not evidence. See [[Validation at the Boundary]].

**Drafts don't count.** Only `published` offers occupy a slot. An agency can prepare next
season's twenty packages and publish five. Limiting drafts would be limiting work, not
limiting attention — and attention is the scarce thing.

**`exclude_pk` is why editing a title never trips the quota.** Re-saving an already-published
offer excludes itself from its own count. Without it, an agency at exactly its limit could
never fix a typo — a bug that only appears at the boundary, which is exactly where nobody
tests by hand.

**`QuotaExceeded` maps to `409`, not `403`.** The caller *is* allowed to publish offers;
there is just no room. A 403 tells them to go find a permission they already have, whereas a
409 says the state is wrong and points at the fix — archive something, or upgrade. Both the
API and the offer editor page raise the same exception from the same function.

---

## The override, and why only admins may set it

`Agency.published_offer_limit_override` raises one agency's cap above its plan.

You will need this immediately. Recruiting your first 40 agencies means saying "post as
many as you like, it's free while we grow" — and you want that per-agency, not a change to
the free plan for everyone.

> [!danger] Platform admins only
> If an agency could set its own override, the quota system would be decoration. This field
> must not appear in any agency-facing request schema.

It is also not in `AgencyProfileIn`, so it cannot arrive in a request body at all — the
field simply does not exist as far as the boundary is concerned. That is a stronger
guarantee than a handler remembering to ignore it.

One subtlety with a test on it: an override of `0` must mean **zero**, not "unset, use the
default".

```python
if agency.published_offer_limit_override is not None:   # not `or`
    return agency.published_offer_limit_override
```

Written the obvious way — `override or plan_limit` — `0` is falsy in Python exactly as it is
in JavaScript, and a suspended agency silently gets its full free quota back. The explicit
`is not None` is the whole fix, and it is the reason this paragraph exists: the bug is
invisible in review and only fires on the one agency you most wanted to stop.

---

## Feature gates are not built

There is no `has_feature()` in this codebase yet. When it lands it belongs next to the limits
in `quotas.py`, and it needs two functions rather than one:

- `has_feature(plan, name)` — the gate itself
- `cheapest_plan_with(name)` — so an upgrade prompt can say *"Disponible sur Pro"* by reading
  the table, instead of hardcoding "Pro" in a template. Change the table, every prompt
  follows.

Whenever it is built: **the API enforces the gate, the template merely hides the button.** A
`free` agency calling the export endpoint directly must get a refusal, not a CSV. See
[[Authentication vs Authorization]] and rule #2 of [[The Seven Rules]].

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

`apps/common/quotas.py` is safe for you to change. Edit the numbers, then:

```bash
./scripts/check.sh
```

The tests check that the table stays coherent — plans get more permissive as they get more
expensive, every plan is defined, and the off-by-one at exactly the limit still refuses. If
you break one, it tells you which.

Nothing else needs touching. `quota_state()` feeds both the API's `GET …/quota` and the bar
on the offers page, so a new number shows up in both places at once.

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
