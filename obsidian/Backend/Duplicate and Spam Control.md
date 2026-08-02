# Duplicate and Spam Control

> [!quote] Your words
> "my goal of remove duplicate is maybe some agencies start like spamming their offers in
> the marketplace, so don't remove duplicate — make them flaggable, and limited number of
> offers per agency"

That reframing changed the design, and for the better. This note is what got built.

---

## The problem, stated precisely

An agency wants more of the search results page. The cheapest way to get it is to post the
same Omra package eight times with slightly different titles. Now they occupy eight slots,
the results page is useless to travelers, and honest agencies are pushed down.

This is **not** a data-cleanliness problem. It's a competitive-abuse problem. The two have
different solutions:

| | Deduplication | Spam control |
|---|---|---|
| Goal | one row per real thing | fair share of attention |
| Action | merge or delete | flag, demote, cap |
| Who decides | an algorithm can | a human must |
| Cost of error | a merged row | you deleted a paying customer's listing |

---

## Two defences, and the second is the strong one

### 1. Flagging — detection after the fact

Three signals, none of which deletes anything:

**Fingerprint (exact).** A hash of `agency + kind + destination + departure date +
normalized title`. Identical hash from the same agency means "you already posted this".

`normalizeTitle` strips case, accents, punctuation, word order, and marketing filler in
French and Arabic — so "Offre spéciale OMRA RAMADAN 2026 — Départ Alger !!" and "Omra
Ramadan 2026 Alger" collapse to the same key.

**Price is deliberately not in the fingerprint.** Changing a price is the most common edit
an agency makes, and it must not turn one offer into two. An earlier version bucketed
prices into 5 000 DZD bands; it split offers that straddled a band boundary — 149 000 and
150 000 DZD landed in different buckets. Every fixed bucketing has boundaries, so no band
width fixes it. The idea was unsound and got deleted. There's a comment in `money.ts`
explaining why the function isn't there, so nobody re-adds it.

**Title similarity (fuzzy).** Jaccard overlap of normalized title tokens. Above `0.72`, the
pair goes to a review queue. Cheap and imperfect — fine, because a human decides.

**User reports.** Travelers *and* rival agencies can flag an offer:
`duplicate_spam`, `misleading_price`, `scam_suspicion`, `wrong_information`, `expired`,
`inappropriate`, `other`. One report per person per offer (a database `@@unique`), so a
single rival can't flood the queue.

### 2. Quotas — prevention up front

The real fix. An agency on the free plan can publish **5 offers**. Posting the same trip
eight times is impossible, because the sixth one is refused.

Quotas don't need detection, don't need a reviewer, and can't produce a false positive.
And the cap is exactly where your paid tier lives: [[Plan Limits and Quotas]].

> Flagging cleans up after abuse. Quotas make most of it impossible. Build both, but the
> quota is what actually works.

---

## What a flag does — and doesn't do

`Offer.duplicateStatus`:

| Status | Effect | Set by |
|---|---|---|
| `none` | normal | default |
| `suspected` | **demoted** in ranking (−40 points). Still listed. Badge shown to the agency. | automatic |
| `confirmed` | out of the **default** listing. Still reachable by direct link. | a human |
| `dismissed` | legitimately distinct. Never flagged again. | a human |

**Nothing is ever deleted or merged.** Not on any signal, at any confidence.

Two reasons. First, it's unrecoverable — you cannot un-delete a paying customer's listing
and you cannot un-say "your offer disappeared". Second, false positives are guaranteed: two
genuinely different tiers of the same trip (4★ and 5★ hotel, same dates, same city) can
match on every field the algorithm sees.

`suspected` is deliberately soft. Demotion is reversible, invisible to the traveler, and
costs the agency little if wrong. Punishment escalates only when a human has looked.

---

## Different agencies selling the same package are NOT duplicates

The fingerprint includes `agencyId`, so two agencies reselling the same wholesaler package
never collide.

This is the most important line in the design. Those are **different sellers at different
prices** — that comparison is the entire reason a traveler uses a marketplace instead of
going to one agency. Collapsing them would destroy the product to tidy the data.

Cross-agency similarity is still computed, but only ever as a *suggestion for a human*, and
usually the right answer is "leave both". There's a test asserting two agencies with
identical offers get different fingerprints.

---

## Reports never auto-hide anything

At any count. Not at three, not at ten.

Rival agencies can report each other, and organizing ten reports is easier than it sounds —
in a market where agencies in the same wilaya know each other, it's a phone call. If reports
auto-hid offers, the report button would become the cheapest attack in the app.

`REPORTS_BEFORE_PRIORITY_REVIEW = 3` moves an offer **up the admin queue**. It changes what
a human looks at first. It doesn't change what travelers see.

---

## Where the code is

| Piece | File |
|---|---|
| Normalization, fingerprint, similarity | `packages/shared/src/offers/dedup.ts` |
| Statuses, thresholds, penalties | `packages/shared/src/enums.ts` |
| Quotas | `packages/shared/src/plans.ts` |
| Tables | `Offer.duplicateStatus`, `OfferDuplicateCandidate`, `OfferReport` |
| Tests | `packages/shared/src/offers/dedup.test.ts` |

---

## Open questions for you

- **What happens at the quota when an agency wants to post a new trip?** Force them to
  archive an old one, or offer the upgrade? The second is the business — but the first is
  the honest default when they haven't paid.
- **Should repeat spamming affect the agency, not just the offer?** Three confirmed
  duplicates could lower `qualityScore` for *all* their offers. Effective, and harsh —
  needs an appeal path.
- **Who reviews the queue?** Right now: you. That's fine at 40 agencies and impossible at
  400. Worth knowing the number where it breaks.
- **Do you tell an agency when their offer is flagged?** Transparency builds trust with
  honest agencies who tripped the rule by accident; it also teaches deliberate spammers
  exactly where the line is.

---

Related: [[Offer]] · [[Plan Limits and Quotas]] · [[Search and Filters]] · [[Agency]]
