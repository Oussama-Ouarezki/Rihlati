# Client Quality Labels

> [!success] Built
> `Lead.Quality` in `apps/leads/models.py`; set through `PATCH
> /api/agencies/{id}/leads/{id}` in `apps/leads/api.py`; filtered in the inbox by the
> `quality` query parameter. Free-form tags: `Tag` and `LeadTag`, same file.

Your "label clients from serious to troll to good" feature. It's a field on [[Lead]], plus
one genuinely hard design question at the end that's yours to answer.

---

## The labels

`Lead.quality`, one of seven values, defined as a `TextChoices` class on the model —
`Lead.Quality`. The labels the agency sees are French, because the CRM is French:

| Value | Shown as | Meaning |
|---|---|---|
| `spam` | Spam | not a real person — bot, junk |
| `troll` | Troll | real person, wasting the agency's time deliberately |
| `unrated` | Non évalué | nobody has judged yet (**the default**) |
| `cold` | Froid | real, but just looking |
| `warm` | Tiède | genuinely interested, no budget confirmed |
| `serious` | Sérieux | ready to buy, budget confirmed |
| `vip` | VIP | high value, repeat, or a referral source |

> [!warning] There are no weights in this port
> The NestJS version carried a `LEAD_QUALITY_WEIGHT` map (`spam` = −2 … `vip` = +4) and
> sorted the inbox by it. Nothing like that exists here: `Lead.Quality` is a plain set of
> strings, and the inbox **filters** by quality but does not **sort** by it.
>
> Not an oversight worth rushing to fix. A weight is a claim that the gap between `cold`
> and `warm` is the same size as the gap between `serious` and `vip`, and nobody has
> checked that. Filtering — "show me the sérieux ones" — answers the same question an
> agency actually asks, without inventing arithmetic. Sorting is a `models.Case/When` in
> one queryset the day you want it, and it should be added with a reason, not by default.

---

## Why an enum and not free-text tags

Because you eventually want to *compute* with these. A fixed set lets the system reason:
filter the inbox, count conversions per label, and later price leads — a `serious` Omra
lead is worth more than a `cold` one, and that's the foundation of charging for
introductions at all.

Free text can't do that. If one agency writes "sérieux", another "serious", a third "SERIEUX
++", you have three strings and no signal.

The enum is enforced on the way in: `update_lead` rejects a value outside
`Lead.Quality.values` with a **422**, rather than letting a typo become a new category. An
`agency, quality` index on `Lead` makes the filter cheap.

But agencies will always want labels you didn't think of. That's what the separate `Tag`
table is for: agency-invented, free-form, no computation. "Waiting for passport", "friend of
Karim", "wants window seat".

> Fixed enum for what the system reasons about. Open table for what humans reason about.
> Both, not one.

---

## Quality is separate from stage

Two different axes, and conflating them is the common mistake:

- **`status`** — where the *deal* is: `new → contacted → quoted → negotiating → booked →
  travelled`, with `lost` as the other ending
- **`quality`** — how good the *person* is

A `vip` client can be `lost` (they bought elsewhere). A `troll` can reach `quoted` (the
agency wasted an afternoon before realising). One tells you about the transaction, the other
about the human.

Keeping them apart is what lets you ask the question that matters: *"how many of our
`serious` leads convert?"* — which is how you learn what a lead is actually worth.

---

## Labels are per-agency, not global

`Lead.quality` sits on a lead, and a lead belongs to one agency. So if Agency A marks
someone `troll`, Agency B sees `unrated`.

That's correct, and it's not an oversight:

- One agency's troll is another's customer. Someone who wasted A's time asking about a
  budget Omra might be exactly right for B's package.
- An agency could label a rival's client `spam` out of spite if labels were shared.
- The label reflects one interaction, not the person's character.

---

## The hard question: cross-agency reputation

Here's the tension. If **six different agencies** independently mark the same phone number
`troll`, that is real information. Acting on it would protect every agency on the platform
and is exactly the kind of thing only a marketplace can do.

But acting on it is dangerous:

**False positives are brutal.** Someone comparison-shopping ten Omra offers — completely
reasonable behaviour for a 350 000 DZD purchase — looks exactly like a time-waster to nine
of those ten agencies. Punishing them means punishing your most engaged travelers.

**Agencies have an incentive to mislabel.** If a `troll` flag reduces someone's visibility,
labelling becomes a weapon. Some will label anyone who didn't buy.

**Silent blacklisting is indefensible.** A person who can't get replies, doesn't know why,
and has no way to appeal. In a market built on trust, that story spreading is a real risk.

The data structure already supports it — `Lead.quality` rows across agencies are queryable,
no new table needed. What's missing is the *policy*, and that's yours:

- How many independent agencies before it counts? (3? 6?)
- Must they be over a time window, so one bad week doesn't stick forever?
- What does the signal *do*? Show a warning to agencies (soft) or limit how many inquiries
  the person can send (hard)?
- How does someone appeal, and who hears it?
- Is `spam` treated differently from `troll`? A bot needs no appeal; a human does.

My recommendation: build the **soft** version only. Show the receiving agency "this number
has been marked as a time-waster by 4 other agencies" and let a human decide. Never block
automatically. You get most of the protection and none of the unfixable failure mode.

Note this is genuinely personal data being used to make a judgement about someone — worth a
lawyer's view before it ships, same as the consent trail on [[Lead]].

---

## Rate limiting is the better answer to bots

For actual `spam` — bots, junk submissions — quality labels are the wrong tool. They work
after the fact, by hand.

Cheaper and automatic:
- **rate limit inquiries** — built: `InquiryThrottle` in `apps/common/throttling.py` caps
  the public inquiry endpoint at 20/hour per source. Per source, never per phone number —
  see [[Auth Flow]] for why limiting per account is a weapon pointed at your own users.
- a hidden honeypot field bots fill in and humans don't — **not built**
- SMS OTP, but *only* if abuse actually appears (every OTP step loses real inquiries — see
  [[User]])

Prevention beats labelling, same lesson as quotas in [[Duplicate and Spam Control]].

---

## What agencies get from this today

- Set a label on any lead they own — `PATCH .../leads/{id}` with `{"quality": "serious"}`
- **Filter** the inbox by it (`?quality=serious`). Not sort — see the warning above.
- Every change appends to the lead's `LeadActivity` timeline with the old and new value,
  and the actor, so a negative judgement about a named person is attributable to whoever
  made it.
- The change is also written to the [[Audit Log]] as `lead.updated`, with `before` and
  `after`. That covers every label, not just `spam` and `troll` — a narrower rule would
  mean deciding at write time which judgements deserve recording, which is exactly the
  decision an audit log exists to avoid.

None of this is plan-gated: [[Plan Limits and Quotas]] currently gates one thing only, the
number of *published offers*. There is no feature-gating helper in this port yet, so the
pipeline board and the inbox are open to every plan.

---

Related: [[Lead]] · [[Plan Limits and Quotas]] · [[Duplicate and Spam Control]] · [[User]] ·
[[Audit Log]]
