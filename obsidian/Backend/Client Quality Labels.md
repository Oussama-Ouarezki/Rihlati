# Client Quality Labels

Your "label clients from serious to troll to good" feature. It's a field on [[Lead]], plus
one genuinely hard design question at the end that's yours to answer.

---

## The labels

`Lead.quality`, one of seven values:

| Label | Meaning | Weight |
|---|---|---|
| `spam` | not a real person — bot, junk | −2 |
| `troll` | real person, wasting the agency's time deliberately | −1 |
| `unrated` | nobody has judged yet (the default) | 0 |
| `cold` | real, but just looking | 1 |
| `warm` | genuinely interested, no budget confirmed | 2 |
| `serious` | ready to buy, budget confirmed | 3 |
| `vip` | high value, repeat, or a referral source | 4 |

Defined in `packages/shared/src/enums.ts` as `LEAD_QUALITIES` and `LEAD_QUALITY_WEIGHT`.

---

## Why an enum and not free-text tags

Because you want to *compute* with these. The weights let the inbox sort by "worth calling
first", and later let you price leads — a `serious` Omra lead is worth more than a `cold`
one, and that's the foundation of charging for introductions at all.

Free text can't do that. If one agency writes "sérieux", another "serious", a third "SERIEUX
++", you have three strings and no signal.

But agencies will always want labels you didn't think of. That's what the separate `Tag`
table is for: agency-invented, free-form, no computation. "Waiting for passport", "friend of
Karim", "wants window seat".

> Fixed enum for what the system reasons about. Open table for what humans reason about.
> Both, not one.

---

## Quality is separate from stage

Two different axes, and conflating them is the common mistake:

- **`stage`** — where the *deal* is: `new → contacted → quoted → booked → paid → travelled`
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
- rate limit inquiries per IP and per phone number
- a hidden honeypot field bots fill in and humans don't
- SMS OTP, but *only* if abuse actually appears (every OTP step loses real inquiries — see
  [[User]])

Prevention beats labelling, same lesson as quotas in [[Duplicate and Spam Control]].

---

## What agencies get from this in v1

- Set a label on any lead they own
- Sort or filter the inbox by it
- `spam` and `troll` are recorded in [[Audit Log]] — because a negative judgement about a
  named person should be attributable to whoever made it
- Every change appends to the lead's `LeadActivity` timeline

Sorting by quality weight is a `free` plan feature. The pipeline board and analytics are
`pro` — see [[Plan Limits and Quotas]].

---

Related: [[Lead]] · [[Plan Limits and Quotas]] · [[Duplicate and Spam Control]] · [[User]] ·
[[Audit Log]]
