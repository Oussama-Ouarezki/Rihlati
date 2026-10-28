# Credits and Promotion

> [!info] Status: **planned, not built.** This note is the design, written before the code.
> The room was left for it on purpose: `Agency.credit_balance_centimes`, `Offer.is_featured`
> and `Offer.featured_until` are columns that exist and that nothing reads. There is no
> ledger table, no plan flag, and no admin screen.
>
> **And search does not sort featured offers first** — `SORTS["quality"]` in
> `apps/offers/api.py` orders by `-quality_score, departure_date`, with a comment saying why:
> a paid slot that outranks a better listing is how a marketplace loses the travelers it
> needs in order to have anything to sell. Whatever gets built here has to answer that
> comment, not overwrite it. See "where promotion is allowed to appear" below.

**The idea (yours):** an agency buys credits, then spends them on — a cheaper subscription,
bidding for placement, its agency appearing first, its listings appearing first. Plus two
public pages: promoted offers, and top agencies.

---

## 1. Why credits fit Algeria specifically

This is not a generic "add a wallet" feature — it is the shape the local payment rails
force, and that makes it the right call rather than a compromise.

Stripe does not operate in Algeria ([[Decision Log]] 017). The realistic rails are CIB /
Edahabia through a local PSP, plus **CCP / BaridiMob transfers confirmed by hand**. A
per-transaction model would mean an admin confirming a bank transfer every time an agency
wants to promote one offer — unworkable.

Credits invert it: **one manual confirmation, then many automatic deductions.**

> The agency transfers 10 000 DZD once. An admin confirms it once. The balance loads, and
> every promotion afterwards is instant.

That is also why `credit_balance_centimes` was put on `Agency` in the very first schema.

> [!danger] Verify every payment fact yourself
> Which PSP, what they charge, what a *compte* requires legally, what invoicing and VAT
> rules apply to selling advertising in Algeria. **I am not a source of Algerian legal,
> tax or payment fact and will not invent one.** Ask an accountant before writing the
> first line of billing code.

---

## 2. The single most important technical decision: a ledger, not a balance

`credit_balance_centimes` is one mutable integer. **Never let that be the source of truth.**

The moment an agency says *"I bought 10 000 and it says 3 000, where did it go?"* — and they
will, because it is their money — a single number cannot answer. You need every movement,
append-only:

```
CreditTransaction
  agency, amount_centimes (+ credit / − debit), kind, reference,
  balance_after_centimes, actor, note, created_at
```

- `kind`: `topup` · `promotion` · `subscription` · `refund` · `adjustment` · `expiry`
- **Append-only.** Corrections are a new compensating row, never an edit. Same principle as
  the [[Audit Log]] — a ledger you can rewrite is a ledger nobody can trust, including you.
- `credit_balance_centimes` on `Agency` stays as a **denormalized cache** for fast reads,
  recomputed inside the same transaction. A reconciliation job asserts
  `SUM(amount_centimes) == credit_balance_centimes` and screams if it ever drifts.
- **Money is integer centimes.** Never a float. Already the rule everywhere — every money
  column in the schema is a `BigIntegerField` named `…_centimes`, and the house-rule test
  `MoneyTests` in `apps/common/tests_house_rules.py` fails the suite if a `FloatField` or
  `DecimalField` shows up on one.

### Idempotency is not optional

An admin confirming a bank transfer will double-click. A PSP webhook will retry. Every
top-up carries a unique `reference` (transfer id / provider event id) with a **unique
index**, so the second attempt is a no-op rather than free money. Rule #6:

> Payment state changes only on a verified webhook or a verified admin action — never on
> a client saying "success".

---

## 3. What credits buy

One currency, four uses. Prices live in **one dict in `apps/common/quotas.py`**, next to
`PUBLISHED_OFFER_LIMITS`, read server-side — never sent by the client (rule #6). Same file as
the plan limits on purpose: a quota and a price are the same kind of fact, "a number the
client may not choose", and keeping them together is what makes the rule visible.

| Use | Shape | Notes |
|---|---|---|
| **Promote one offer** | fixed price per slot per day | the simplest and first to build |
| **Promote the agency** | appears high on the *Top agencies* page and in its wilaya | separate from offer promotion |
| **Pay for the subscription** | credits debit the monthly plan fee | makes credits the single payment surface |
| **Bidding** | highest bid wins a slot for a period | **see §4 — do this last** |

**"Cheaper subscription" is worth a decision, not an assumption.** Two readings:
1. *Prepay and save* — buy 12 months of credits, get a discount. Simple, standard, honest.
2. *Credits substitute for plan features* — a free-plan agency buys the analytics dashboard
   with credits.

Reading 2 quietly destroys the plan ladder: why upgrade if you can buy the parts? I would
build reading 1 and keep feature gates strictly on the plan. ← **your call**, recorded here.

---

## 4. Bidding: build it last, and probably simpler than you think

An auction is the natural end state and the wrong beginning.

- With ~50 agencies, a real auction (second-price, budget pacing, quality scoring) is weeks
  of work to allocate perhaps six slots.
- Worse, agencies cannot *predict* what visibility costs, which is exactly what a small
  business needs before it will spend.

**Start with fixed-price slots:** "Première place, Omra, wilaya d'Alger — 7 jours — N
crédits." Predictable for them, trivial for you, and it produces the price data you would
need to run an auction sensibly later.

Move to bidding only when a slot is genuinely contested — that is a real signal, and you
will see it in the data.

---

## 5. ⚠ The product risk, stated plainly

**What you are selling (visibility) directly competes with what travelers come for (an
honest comparison).** Every marketplace faces this, and the ones that die over-sell it.

If a traveler learns that "first result" means "paid most", the verified badge stops
meaning anything and Rihlati becomes a directory of adverts — which they can already get
on Facebook, for free.

Non-negotiables, and they should be in `CLAUDE.md` before this ships:

1. **Every promoted listing is visibly labelled** — "Sponsorisé" / "إعلان". Not a faint
   grey asterisk. This is also a legal requirement in many jurisdictions; **verify the
   Algerian rule**.
2. **Cap promoted slots.** At most 2 in the first 12 results. An entire paid first screen
   is the point of no return.
3. **Promotion never overrides trust signals.** It cannot hide a bad rating, cannot promote
   an unverified agency, and cannot lift a `suspected`/`confirmed` duplicate
   ([[Duplicate and Spam Control]]).
4. **Promotion never changes filter results.** If a traveler filters "under 300 000 DZD",
   a promoted 500 000 offer does not appear. Paid placement reorders; it never *inserts*.
5. **Organic ranking stays honest.** `Offer.quality_score` measures listing completeness, not
   spend. Never blend credits into it.

> The test: a traveler who reads the "Sponsorisé" label should still believe the ranking
> underneath it is real. The day that stops being true, the marketplace is over.

### Where promotion is allowed to appear

Rules 4 and 5 together decide the implementation, and it is worth stating it as code rather
than as principle, because the shortcut is very tempting:

- **Not** `order_by("-is_featured", "-quality_score")`. That is the one-line version, and it
  quietly breaks rule 4 — a promoted offer would jump the queue inside a filtered result set,
  including filters it does not satisfy in spirit.
- Instead: the organic queryset is built exactly as it is today, and promoted listings are a
  **separate, capped query** merged into fixed positions in the template. Two lists, one page.
  A traveler scrolling past the labelled slots is reading an untouched ranking.

That also keeps the honest thing cheap to verify: a test can assert that removing every
promotion row leaves the organic ordering byte-for-byte identical.

---

## 6. The two public pages

### 6.1 Top agencies — `/agences` ☐

A ranked directory. **The ranking rule is the whole design decision:**

- Rank by **rating and verified status**, with a small labelled promoted band at the top.
- Do **not** rank by credits spent and call it "top". That is a lie the market will detect,
  and it wastes the one asset a marketplace has — the appearance of neutrality.
- Show what it ranks on: ★ rating, number of reviews, verified date, offer count, wilaya.
- Needs [[Agency Ratings]] (task #20) to exist first — today `ratingSum`/`ratingCount` are
  counters nothing writes.

Also fills a real gap: there is currently **no public agency page at all**, so agency-wide
[[Tracked Links]] fall back to a filtered search.

### 6.2 Promoted offers ☐

Two different things people conflate:

- **The agency-facing page** (`/console/promotion`) — balance, buy credits, choose a slot,
  see what promotion returned (impressions, clicks, inquiries — [[Offer Analytics]] already
  collects exactly this).
- **The public surface** — promoted offers appear *inside* the normal grid, labelled and
  capped. A separate "sponsored offers" page nobody visits is a waste; the value of a slot
  is being in the results a traveler is already reading.

**Show agencies what they bought.** A promotion that reports "40 impressions, 6 clicks,
1 client" gets renewed. One that reports nothing gets cancelled and resented.

---

## 7. Build order

| Step | Why this order |
|---|---|
| 1. `CreditTransaction` ledger + balance reconciliation | everything else moves money; get the record right first |
| 2. Admin top-up (manual CCP/BaridiMob confirmation), idempotent | the only rail that exists today |
| 3. Agency wallet page: balance + history | an agency must see its own money before spending it |
| 4. Fixed-price offer promotion + the "Sponsorisé" label + slot cap | the first thing that earns revenue |
| 5. Promotion analytics ("what did it get me") | what makes it renew |
| 6. Subscription paid from credits | after the ladder decision in §3 |
| 7. `/agences` top-agencies page | needs reviews (#20) to be meaningful |
| 8. Bidding | only when a slot is genuinely contested |
| 9. Automated PSP top-up (CIB/Edahabia) | when manual confirmation becomes the bottleneck |

---

## 8. Open questions — yours

1. **Do credits buy features, or only promotion and prepaid subscription?** (§3 — I
   recommend the latter; the former hollows out the plan ladder.)
2. **Credit value.** 1 credit = 1 DZD, or a round number like 100 DZD? Round units are
   easier to price slots in; 1:1 is easier to trust.
3. **Do credits expire?** Expiry improves cash flow and is normal — it is also the thing
   that generates the angriest support messages. If yes: 12 months minimum, with warning
   emails, and an `expiry` ledger row so it is visible rather than silent.
4. **Refundable?** Once bought, credits are usually non-refundable — say so *before*
   purchase, in writing, or you will argue about it later.
5. **What exactly is a "slot"?** Per wilaya? Per offer kind? Per search page? Narrower
   slots are worth more to the agency and less disruptive to travelers.
6. **VAT and invoicing.** Selling advertising has different obligations from selling
   software in most tax systems. **Accountant, before any code.**

---

Related: [[Plan Limits and Quotas]] · [[Offer Analytics]] · [[Agency Ratings]] ·
[[Duplicate and Spam Control]] · [[Tracked Links]] · [[The Seven Rules]] ·
[[Vision and Roadmap]] · [[Decisions You Must Make]]
