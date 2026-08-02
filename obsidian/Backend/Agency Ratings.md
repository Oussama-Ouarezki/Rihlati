# Agency Ratings

Your "add rating to agencies" feature. Table: `Review`. Aggregate: `Agency.ratingSum` /
`ratingCount`.

The hard part isn't storing a number out of five. It's stopping the ratings from being
fiction — because a rating system everyone knows is fake is worse than none at all.

---

## The trick: link a review to a completed lead

```
Review.leadId  String?  @unique
Review.isVerifiedTraveller  Boolean
```

A review can be attached to a [[Lead]] that reached stage `travelled`. That link is what
makes it verifiable: the platform knows this person actually inquired through the site, and
the agency actually marked the trip as completed.

`@unique` on `leadId` means one review per lead. No review-bombing from one inquiry.

Reviews **without** a lead link are possible (someone who booked offline) but marked
unverified, and shown differently. Two tiers, honestly labelled.

> [!important] Without this link, ratings are worthless
> Nothing stops an agency creating ten accounts and writing its own reviews. Every review
> site has this problem, and the answer is always the same: only count reviews you can tie
> to a transaction you observed.
>
> Since agencies control when a lead becomes `travelled`, there's a partial gap here — an
> agency could mark a fake lead as travelled. It's much more work than typing a review, and
> it leaves an [[Audit Log]] trail, but it's not airtight. Worth knowing.

---

## Moderation

`Review.status`: `pending` → `published` / `rejected`.

Reviews are **not** published automatically. Reasons: defamation risk, real names and phone
numbers appearing in review text, and competitors posing as customers.

At 40 agencies you can read every review yourself. That doesn't scale, and knowing where it
breaks is more useful than pretending it won't.

`agencyReply` lets an agency respond publicly. This matters more than it sounds — an agency
that can answer a bad review feels treated fairly, and a well-handled complaint is often
more persuasive to a reader than a five-star review.

---

## The denormalized aggregate

```
Agency.ratingSum    Int
Agency.ratingCount  Int
```

Average = `ratingSum / ratingCount`. Stored rather than computed, because search result cards
show it for twenty agencies at once and aggregating on every page load would be slow.

The cost is real: these two numbers can drift from the truth. They must be updated whenever a
review is published, rejected, edited or soft-deleted — **and** there should be a periodic job
that recomputes from scratch and complains if it disagrees.

> Any denormalized counter without a reconciliation job eventually lies. The only question
> is when you find out.

Also: don't show an average from two reviews as "4.5 ★". Show the count too, and consider
withholding the average below a threshold (say 3 reviews). One angry customer shouldn't
define an agency forever, and one friendly one shouldn't either.

---

## Ranking with ratings

Rating feeds `relevance` sorting — see [[Search and Filters]]. Two commitments worth making
now, before there's money involved:

- **Paid placement must be visibly labelled.**
- **Paid placement must not outrank a badly-rated agency.** Selling the top slot to whoever
  pays, regardless of how they treat customers, is how a marketplace destroys the trust it
  spent years building. Your entire product is trust — see [[Agency]].

---

## Open questions for you

- **Can a traveler review without a lead through the platform?** Allowing it gets you more
  reviews and more fakes. Recommendation: allow, mark unverified, weight lower.
- **What's the minimum review count before showing an average?** 3 is a common answer.
- **Do reviews expire?** A 2-star from 2026 shouldn't haunt an agency in 2030. Time-weighting
  is fairer and harder to explain.
- **Can an agency dispute a review?** They will. Needs a process before the first one arrives,
  not after.
- **Rate more than one thing?** Separate scores for price accuracy, hotel accuracy and
  communication would be far more useful than one number — and much more work to collect.

---

## Not built yet

The `Review` table exists. No endpoints, no moderation queue, no aggregate recomputation.
Comes after leads, since a verified review depends on a completed lead existing.

---

Related: [[Agency]] · [[Lead]] · [[Search and Filters]] · [[Audit Log]]
