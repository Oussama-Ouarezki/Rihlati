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

Two signals in this port, neither of which deletes anything:

**Fingerprint (exact).** `fingerprint_for()` in `apps/offers/api.py` hashes `agency + kind +
departure date + normalized title`. Identical hash from the same agency means "you already
posted this", and `apply_derived_fields` sets `duplicate_status = suspected` with
`duplicate_of` pointing at the original.

`normalize_title` strips case, accents, punctuation, word order, and marketing filler in
French and Arabic — so "Offre spéciale OMRA RAMADAN 2026 — Départ Alger !!" and "Omra
Ramadan 2026 Alger" collapse to the same key.

**Price is deliberately not in the fingerprint.** Changing a price is the most common edit
an agency makes, and it must not turn one offer into two. An earlier version bucketed
prices into 5 000 DZD bands; it split offers that straddled a band boundary — 149 000 and
150 000 DZD landed in different buckets. Every fixed bucketing has boundaries, so no band
width fixes it. The idea was unsound and got deleted. `fingerprint_for`'s docstring says why
the price is not in the hash, so nobody re-adds it.

> [!warning] No fuzzy similarity in this port
> The NestJS design also computed a Jaccard overlap of title tokens and sent anything above
> `0.72` to a review queue. Nothing like that exists here. The exact fingerprint is the whole
> detector.
>
> That is a smaller feature, on purpose: a threshold is a number nobody can defend without
> data, and the pairs it surfaces are exactly the ambiguous ones a reviewer is worst at
> judging. Exact matching catches the behaviour that actually happens — an agency retyping
> the same trip — and never accuses anyone. Add the fuzzy pass when the queue is empty and
> abuse is still getting through, which is evidence rather than a guess.

**User reports.** `OfferReport` in `apps/offers/models.py`, with four reasons — `spam`,
`misleading`, `duplicate`, `other`. One report per person per offer, enforced by a database
constraint, so a single rival cannot flood the queue. Anonymous reporters are deduplicated by
`reporter_fingerprint`, a hash: one person cannot file the same complaint fifty times without
an account, **and the raw IP is never stored** (rule #4).

### 2. Quotas — prevention up front

The real fix. An agency on the free plan can publish **5 offers**. Posting the same trip
eight times is impossible, because the sixth one is refused.

Quotas don't need detection, don't need a reviewer, and can't produce a false positive.
And the cap is exactly where your paid tier lives: [[Plan Limits and Quotas]].

> Flagging cleans up after abuse. Quotas make most of it impossible. Build both, but the
> quota is what actually works.

---

## What a flag does — and doesn't do

`Offer.duplicate_status`:

| Status | Effect | Set by |
|---|---|---|
| `clean` | normal | default |
| `suspected` | flagged for review. Still listed, still published. | automatic |
| `confirmed_duplicate` | out of the default listing — every public index filters on it. | a human |

Only `clean` is ever changed automatically: `apply_derived_fields` re-flags nothing that a
person has already ruled on. Otherwise every subsequent edit would re-open a settled pair, the
queue would hand back the same two offers forever, and the reviewer would learn to ignore it —
which costs more than the flag was worth.

> [!warning] There is no `dismissed`
> The NestJS design had a fourth state meaning "a human looked, these are genuinely distinct".
> This port does not, so the only verdict the schema can record is *guilty*. In practice a
> reviewer who decides two offers are legitimately different has nowhere to put that, and the
> pair stays `suspected` indefinitely. See the open questions — this is a small migration and
> a real gap, not a stylistic difference.

**Nothing is ever deleted or merged.** Not on any signal, at any confidence.

Two reasons. First, it's unrecoverable — you cannot un-delete a paying customer's listing
and you cannot un-say "your offer disappeared". Second, false positives are guaranteed: two
genuinely different tiers of the same trip (4★ and 5★ hotel, same dates, same city) can
match on every field the algorithm sees.

`suspected` is deliberately soft. Demotion is reversible, invisible to the traveler, and
costs the agency little if wrong. Punishment escalates only when a human has looked.

---

## Different agencies selling the same package are NOT duplicates

The fingerprint includes the `agency_id`, so two agencies reselling the same wholesaler
package never collide — not "are filtered out afterwards", *cannot collide*, because the
input to the hash differs.

This is the most important line in the design. Those are **different sellers at different
prices** — that comparison is the entire reason a traveler uses a marketplace instead of
going to one agency. Collapsing them would destroy the product to tidy the data.

> [!bug] This was inverted in the code, and no test caught it
> `apply_derived_fields` used to hash *without* the agency and then search for a clash with
> `.exclude(agency_id=offer.agency_id)` — the exact opposite of the rule above. Honest
> competitors were flagged as duplicates of each other, and an agency posting the same trip
> eight times was flagged as nothing at all.
>
> It was found by reading this note against the code, which is the whole reason the vault is
> kept true. The fix put the agency id inside the hash, so the mistake is now structurally
> unavailable rather than a filter someone has to remember. `DuplicateFingerprintTests` in
> `apps/offers/tests.py` pins it — nine cases, and the one that matters is
> `test_two_agencies_selling_the_same_package_never_collide`.

---

## Reports never auto-hide anything

At any count. Not at three, not at ten.

Rival agencies can report each other, and organizing ten reports is easier than it sounds —
in a market where agencies in the same wilaya know each other, it's a phone call. If reports
auto-hid offers, the report button would become the cheapest attack in the app.

What a report *does* do is increment two counters, both with `F()` so concurrent reports
cannot lose one: `Offer.report_count` and `Agency.open_report_count`. They are sort keys for a
review queue, nothing more — they change what a human looks at first, never what a traveler
sees.

> [!danger] The queue those counters feed does not exist yet
> Reports accumulate and nobody is shown them. `Agency.open_report_count` is written and never
> read. That is worse than it sounds: a traveler who reports a scam gets silence, and the one
> defence that depends on people bothering to report stops being used. The verification queue
> in [[Agency Verification]] is the obvious place to put it.

---

## Where the code is

| Piece | File |
|---|---|
| Normalization, fingerprint, clash detection | `normalize_title` / `fingerprint_for` / `apply_derived_fields` in `apps/offers/api.py` |
| Statuses | `Offer.DUPLICATE_STATUSES`, `OfferReport.REASONS` in `apps/offers/models.py` |
| Quotas | `apps/common/quotas.py` |
| Rate limiting | `InquiryThrottle` in `apps/common/throttling.py` |
| Tables | `Offer.duplicate_status` / `duplicate_of` / `fingerprint` / `report_count`, `OfferReport`, `Agency.open_report_count` |
| Tests | `DuplicateFingerprintTests` in `apps/offers/tests.py`; quota tests in `apps/common/tests_quotas.py` |

---

## Open questions for you

- **What happens at the quota when an agency wants to post a new trip?** Force them to
  archive an old one, or offer the upgrade? The second is the business — but the first is
  the honest default when they haven't paid.
- **Should repeat spamming affect the agency, not just the offer?** Three confirmed
  duplicates could lower `quality_score` for *all* their offers. Effective, and harsh —
  needs an appeal path.
- **Does a reviewer need a way to say "not a duplicate"?** Today they cannot: the only human
  verdict `duplicate_status` can hold is `confirmed_duplicate`, so a pair that is genuinely
  two hotel tiers of the same trip stays `suspected` forever. Adding `dismissed` is one
  migration; the question is whether the review queue is close enough to justify it now.
- **Who reads the reports?** `report_count` and `open_report_count` are incremented on every
  report and read by nothing. Until a screen exists, reporting a scam is a button that does
  nothing visible, which teaches people to stop pressing it.
- **Who reviews the queue?** Right now: you. That's fine at 40 agencies and impossible at
  400. Worth knowing the number where it breaks.
- **Do you tell an agency when their offer is flagged?** Transparency builds trust with
  honest agencies who tripped the rule by accident; it also teaches deliberate spammers
  exactly where the line is.

---

Related: [[Offer]] · [[Plan Limits and Quotas]] · [[Search and Filters]] · [[Agency]]
