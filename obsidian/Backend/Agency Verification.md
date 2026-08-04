# Agency Verification

> [!warning] Deferred — planned, not built
> Decided 2026-08-04: not in this slice. The blocker is not code, it is that **we have no
> authoritative source to check an agency against**. Building a review screen before deciding
> what a review actually *checks* would produce a button that grants a badge on a hunch.
> Everything below is the plan and the open questions. Nothing here is implemented.

---

## What exists today, precisely

An agency can already ask to be reviewed. `POST /v1/agencies/{id}/submit-for-review` (owner
only) sets `status = 'pending_review'`, clears `rejectionReason`, and writes an audit row.

Then it stops. There is:

- **no admin page** — no `/admin` route in the web app;
- **no approve or reject endpoint** — nothing anywhere writes `status = 'verified'`;
- **no notification** — a pending agency sits in the table until someone runs a query;
- **no way to become an admin** — `isPlatformAdmin` has no path to `true` except SQL.

The rails are laid and unused: `isPlatformAdmin` is on [[User]], it is a claim in the access
token, `JwtAuthGuard` enforces it, and `@RequirePlatformAdmin()` exists in
`common/auth/auth.decorators.ts`. **Zero controllers use it.**

So today, verification is a hand-written `UPDATE`. Two consequences worth stating out loud:

- It **bypasses the audit log**, so `verifiedByUserId` stays null and there is no record of who
  granted the badge. That is exactly the record you would want if a verified agency later turns
  out to be fraudulent.
- `rejectionReason` is **shown verbatim to the agency owner** in the red banner on
  `/console/agence`. It is not a place for private notes.

---

## The real problem: we cannot verify against anything

The vault has said since day one that verification *is* the product. That is still true. What
was never confronted is the mechanics:

**We have no access to the registers that would make "verified" a fact.** No connection to the
Ministry of Tourism's list of licensed agencies, and no lookup against the trade register.

> [!warning] Verify this — do not assume
> Whether Algeria offers **any** public or paid lookup for the RC (via the CNRC) or for tourism
> licences is **unknown and must be checked with a real source**, not guessed. If a paid or
> in-person lookup exists, it changes this entire note. Do not build on an assumption here.

Without a source, a "review" can only be one of:

1. **Plausibility check.** Does the RC have the right shape, does the wilaya code match the
   address, does the agency answer its phone, does it have a real web presence. Catches the
   lazy fraud, catches nothing careful.
2. **Documentary.** Ask for a scan of the RC and the licence, and look at it. Better — but a
   scan is trivially forged, and we would then be storing sensitive documents, which is its own
   obligation.
3. **Accountability instead of verification** — the model raised on 2026-08-04, below.

---

## The alternative worth taking seriously: accountability, not gatekeeping

The idea: stop pretending to certify, and instead make sure that **whoever takes the money is
identifiable afterwards**. We collect the RC, NIF, licence number, address and a phone we have
confirmed answers. We do not claim to have validated them. If an agency defrauds a traveler, we
have a real identity to hand to the authorities, and we suspend them platform-wide.

Trust then comes from **behaviour over time** rather than a badge on day one: completed trips,
[[Agency Ratings]], complaint rate, how long they have been listed.

**Why this is attractive:** it is honest about what we actually know, it does not block launch
on a data source we may never get, and it is *enforceable* — suspension and a police report are
things we can genuinely do.

**Why it is dangerous:** it is much weaker at the exact moment that matters. A first-time
fraudster passes it. And the cold-start problem bites — a brand new agency has no behavioural
record, so early travelers get no signal at all, which is when they are most afraid.

**Likely answer: both.** Documentary checks at the gate, behaviour after, and the badge wording
tells the truth about which one it is.

---

## The word "vérifiée" is a promise, and it is a legal one

This is the part to get right before launch, and it is not a UI detail.

If the badge says **"Vérifiée"** and a traveler loses 400 000 DZD to an agency wearing it, the
question asked will be "what exactly did you verify?" The honest answer today would be "we
looked at a number they typed in themselves." That is a gap between what was claimed and what
was done, and it is the kind of gap that ends a marketplace.

The fix is not to weaken the checks — it is to **make the badge say what actually happened**:

| What we did | Honest label |
|---|---|
| Received documents, not validated | « Documents reçus » |
| Read the documents, confirmed the address, spoke to them | « Identité confirmée » |
| Checked against an official register | « Vérifiée » |

A weaker badge that is true beats a strong one that is not. The tooltip should say, in one
sentence, exactly what was checked — and the same sentence should be what the review process
actually does.

> [!danger] Never invent an Algerian legal or regulatory fact
> Nothing in this note asserts what Algerian law requires of a travel intermediary, what
> liability the platform carries, or what obligations attach to storing someone's RC and NIF.
> **These need a real answer from a competent source before launch.** See [[The Seven Rules]].

---

## When it gets built: the slice

Four pieces, one vertical, same shape as everything else:

1. `GET /v1/admin/agencies?status=pending_review` — `@RequirePlatformAdmin()`, finally using
   the decorator that already exists.
2. `POST /v1/admin/agencies/{id}/verify` and `.../reject` (reason required). **Both audited**,
   and `verify` sets `verifiedByUserId` — the column is already in the schema waiting for it.
   That is the whole point: the badge must be attributable to a person.
3. `/admin` in the web app: the queue, the submitted documents, approve and reject.
4. A path to the **first** admin — a seed script or a CLI command, since nothing today can set
   `isPlatformAdmin`.

Note this is the first genuinely **cross-tenant** surface in the app. Every other query is
scoped by `agencyId` ([[Multi-Tenancy]]); this one deliberately is not, which makes it the most
dangerous endpoint in the codebase and the one most worth testing hard. A bug in
`@RequirePlatformAdmin()` exposes every agency at once.

---

## Open questions — for the owner

- **Does any RC or tourism-licence lookup exist in Algeria, at any price?** Everything else
  depends on this. Needs a real answer, not a guess.
- **Gatekeeping, accountability, or both?** See above. This decides whether verification blocks
  launch or follows it.
- **What does the badge say, in one sentence?** And does that sentence match what the review
  actually does?
- **Do we store document scans?** If yes, that is sensitive-document handling — retention,
  access control, and deletion rules — and it is a real obligation, not a checkbox.
- **What happens on a credible fraud report?** Suspend immediately and investigate, or
  investigate first? An innocent agency suspended for a week loses a season's bookings; a guilty
  one left up for a week takes more money.
- **Who does this work when there are 200 agencies?** Manual review is the moat, and it is also
  a job. It does not scale to one person forever.

## Related

[[Agency]] · [[Decisions You Must Make]] · [[Agency Ratings]] · [[Duplicate and Spam Control]] ·
[[The Seven Rules]]
