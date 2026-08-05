# Agency Verification

> [!success] The mechanism is built — 2026-08-05. The *policy* is still yours.
> There is now a review queue, a verify/reject decision that is attributable to a named
> person, and a way to become an admin. What is **not** decided is what a review actually
> *checks*, because we still have no authoritative source to check against. The machine is
> built; what you feed it is the open question below.
>
> Still deferred, deliberately: **collecting identity documents** (see the section further
> down). It needs a legal answer and its own storage driver, and bolting it onto this slice is
> how a passport ends up in the public bucket.

---

## What exists today, precisely

**The agency's side.** `POST /v1/agencies/{id}/submit-for-review` (owner only) sets
`status = 'pending_review'`, clears any old `rejectionReason`, stamps `submittedForReviewAt`
and writes an audit row.

**Rihlati's side** — new, `apps/api/src/modules/admin/`:

| | |
|---|---|
| `GET /v1/admin/agencies` | the queue, oldest request first, with the RC / NIF / licence / owner contact on one screen |
| `POST /v1/admin/agencies/{id}/verify` | grants the badge, sets `verifiedByUserId`, requires a written note of what was checked |
| `POST /v1/admin/agencies/{id}/reject` | refuses, with an owner-visible reason and a private internal note |
| `/admin` in the web app | the queue, the two buttons, and the panels that demand a sentence first |
| `npm run admin:grant -- email` | the only way to create a platform admin |

Permissions, transitions and the reasoning behind each are in [[API Endpoints]]; the
cross-tenant design is the interesting part.

**What this fixed.** Verification used to be a hand-written `UPDATE`, which meant it bypassed
the audit log entirely: `verifiedByUserId` stayed null and there was no record of who granted
a badge. That is precisely the record you want if a verified agency later turns out to be
fraudulent — and precisely the one that cannot be reconstructed after the fact. It is now
written in the same transaction as the status change, with the reviewer's note attached.

**What is still missing:**

- **Nobody is notified.** A pending agency sits in the queue until an admin opens `/admin`.
  There is no email, no digest, no badge count.
- **No suspension endpoint.** `suspended` is a valid status with no route that sets it, so
  pulling a fraudulent agency down is still a database edit. The audit action
  `agency.suspended` already exists, waiting.
- **No reviewer-facing history.** You can see an agency's current state, not "this is their
  third attempt". The audit rows hold it; nothing reads them back.

> [!tip] A note that was wrong, and why it is worth recording
> This page previously said the decorator was `@RequirePlatformAdmin()`. It is
> `@PlatformAdminOnly()`, in `common/auth/auth.decorators.ts`. The note had drifted from the
> code, and CLAUDE.md's rule applies: when a note and the code disagree, the code is right and
> the note is the bug.

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

## Holding identity documents — planned 2026-08-04, not built

The accountability model above only works if "we have a real identity to hand to the
authorities" is true. Today it is not: an agency types a number into a box and we store the
number. Anyone can type a number.

So the plan is to collect **documents**, not strings:

| Document | Why it is asked for |
|---|---|
| Registre de commerce (scan) | the company exists and is trading legally |
| Attestation NIF | ties the company to a tax identity |
| Agrément d'agence de tourisme et de voyage | the licence specific to selling travel |
| **National ID card or passport of the owner** | ties a *person* to the company |

The last row is the one that changes the model. A company can be dissolved and its name
abandoned; a person cannot. Holding the owner's identity document is what makes "if you take
Omra money and vanish, we know who you are" a statement rather than a bluff — and, just as
importantly, agencies with nothing to hide will hand it over without complaint. The ones who
refuse have told you something.

> [!danger] This is the most sensitive data in the entire product
> A passport scan is worth more to a criminal than every offer in the database. It is enough
> to open accounts in someone's name. If Rihlati leaks one, the damage is not a bad week —
> it is personal and permanent for the person whose document it was.
>
> Which means: **do not build this the day you feel like it.** It is the one feature where
> shipping a rough version first is not acceptable, because the rough version is a breach
> waiting to happen.

### The trap: this must NOT reuse the avatar pipeline

[[Image Uploads]] is well designed *for avatars and logos*. Every one of its decisions is
wrong here, and reaching for it because it already works is the mistake this section exists
to prevent:

| Avatar pipeline does | Why that is right for a logo | Why it is a breach for a passport |
|---|---|---|
| Public URL, no auth to fetch | a logo is meant to be seen | anyone with the link has the passport, forever |
| `Cache-Control: immutable, max-age=1 year` | the URL is a content hash, so it can never be stale | copies land in every CDN and browser cache; deletion becomes impossible |
| Content-addressed filename | unguessable and collision-free | still a permanent bearer token — knowing the URL *is* the permission |
| Re-encode to WebP, strip metadata | kills EXIF GPS and polyglot files | fine, and still wanted — but it is not the part that matters here |

What it needs instead:

- **A private bucket.** No public read. Every fetch goes through an endpoint that checks the
  session on that request — platform admin, or a member of that agency looking at their own.
  See [[Multi-Tenancy]]; this is one of the few reads where being an admin is the *only*
  reason it is allowed.
- **Short-lived signed URLs**, minutes not years, generated per view. The URL stops working.
- **`Cache-Control: private, no-store`**, and served as a download, never inline.
- **Encryption at rest**, with the key not sitting next to the data.
- **Every read audited, not just every write.** For ordinary data, "who changed this" is the
  question. For a passport, "who *looked* at this" is the question — and an admin who browses
  documents for no reason should leave a trail.
- **Never in any API response an agency or a traveler can reach.** `GET /agencies/{slug}` must
  not carry so much as a filename. A test should assert this, the same way there is a test
  that `avatarUrl` cannot be set by the client.
- **Never in a log line.** Rule #4 already forbids logging phone numbers; a document key
  belongs on the same list, in `AppLogger`'s redaction.

> [!warning] PDFs break the re-encode trick
> Scans arrive as PDFs, and the whole security model in [[Image Uploads]] is "decode it and
> throw the original away" — which has no equivalent for a PDF. A PDF can carry JavaScript and
> can be a polyglot. Either accept photographs only (JPEG/PNG/WebP, re-encoded, which is
> probably right since everyone photographs documents with a phone anyway), or serve PDFs with
> `Content-Disposition: attachment` and never inline. Decide before writing the endpoint.

### Shape of the data

A separate table, not columns on [[Agency]]. `Agency` is read on nearly every page; the
documents must live somewhere that is *never* joined in by accident.

```
AgencyDocument
  id                UUID
  agencyId          FK  -- tenant-scoped like everything else
  type              registre_commerce | nif_attestation | tourism_licence
                    | owner_id_card | owner_passport
  storageKey        String   -- private bucket, never a public URL
  uploadedByUserId  FK
  uploadedAt        DateTime
  reviewedByUserId  FK?      -- who looked at it
  reviewedAt        DateTime?
  outcome           accepted | rejected | unreadable
  expiresAt         DateTime? -- a licence expires; so should our copy
  deletedAt         DateTime?
```

`outcome` is deliberately per-document. "The RC was fine but the licence was expired" is a
real review result, and a single `status` on the agency cannot express it — which means the
rejection message to the owner would be vague, and they would resubmit the same thing.

### Retention: decide the deletion rule before the upload rule

The instinct is to keep everything forever, in case it is needed. That instinct is what turns
a small breach into a large one. Data you deleted cannot leak.

A defensible default, to be confirmed: keep documents while the agency is active, delete them
a fixed period after an agency is **rejected** (they were never a customer) and after an
agency **leaves** (the reason to hold them is gone). Keep the *record* that a document was
seen and by whom — a row saying "RC reviewed 2026-09-01 by X, accepted" is almost as useful
for accountability and carries none of the risk.

> [!danger] Verify this — do not assume
> Algeria's Law 18-07 on personal data protection governs collecting and storing this, and
> nothing in this note asserts what it requires: whether consent must be explicit and in
> writing, whether a declaration or authorisation is needed to hold identity documents,
> what retention limits apply, or what must happen on a request for deletion.
> **This needs an Algerian lawyer before the first upload**, not after. Nothing here is
> legal advice, and the whole feature is legally shaped, not just technically shaped.

---

## The slice as built — and the three choices inside it

All four pieces landed together on 2026-08-05. Documents were held back on purpose: the order
was always "get the queue and the audit trail working against fields that already exist, then
add `AgencyDocument` as its own vertical with its own storage driver and the legal answer in
hand." Building both at once is how the passport ends up in the public bucket.

Three decisions inside the slice are worth understanding, because each one traded convenience
for something:

**1. Verifying costs you a sentence.** `checkedNote` is required, minimum ten characters,
private to the audit log. It would have been faster to make approval one click. But the fear
this whole note is built around is the gap between what the badge claims and what was done,
and a required sentence closes it at the only moment it can be closed honestly — while you are
looking at the documents. A year later, during a complaint, it cannot be reconstructed.

**2. An admin cannot decide on their own agency.** `403`, with `details.reason =
"self_review"`. The membership guard cannot catch this — it happily grants an admin `owner`
rank anywhere — so the service checks it itself. The reasoning is not that staff will cheat;
it is that a badge granted by its own owner proves nothing, and proving something is the
badge's only function.

**3. The route says `{id}`, not `{agencyId}`.** That one character keeps
`AgencyMembershipGuard` from firing, which is intentional: the guard would frame the request
as *staff acting as the agency*, and a reviewer acts on Rihlati's behalf, not the agency's.
The cost is that this route family opts out of the app's automatic tenant protection, so it
carries its own checks. See [[API Endpoints]].

This is the first genuinely **cross-tenant** surface in the app. Every other query is scoped by
`agencyId` ([[Multi-Tenancy]]); this one deliberately is not, which makes it the most dangerous
code in the repository. A bug in `@PlatformAdminOnly()` exposes every agency at once, which is
why `apps/api/test/admin-agencies.e2e.test.ts` spends most of its length on who is shut out —
anonymous, traveler, agency owner, another agency's manager, and an admin whose rights were
revoked while holding a valid token.

---

## Open questions — for the owner

- **Does any RC or tourism-licence lookup exist in Algeria, at any price?** Everything else
  depends on this. Needs a real answer, not a guess.
- **Gatekeeping, accountability, or both?** See above. This decides whether verification blocks
  launch or follows it.
- **What does the badge say, in one sentence?** And does that sentence match what the review
  actually does?
- **Is the owner's ID card or passport required, or optional?** Required makes the
  accountability model real and will lose you some agencies at signup — probably the ones you
  least want, but not only those. Optional makes it a badge tier instead of a gate. This is
  the single decision that shapes the whole feature.
- **Photographs only, or PDFs too?** See the warning above. Photos-only is meaningfully safer
  and probably loses nothing.
- **How long do we keep them, and what triggers deletion?** Answer this *before* building the
  upload, not after — see the retention section.
- **Who is allowed to look at a stored document?** Platform admins only, or also the agency's
  own owner (to check what they submitted)? Every answer here is an audited read.
- **What happens on a credible fraud report?** Suspend immediately and investigate, or
  investigate first? An innocent agency suspended for a week loses a season's bookings; a guilty
  one left up for a week takes more money.
- **Who does this work when there are 200 agencies?** Manual review is the moat, and it is also
  a job. It does not scale to one person forever.
- **How does a reviewer find out there is work?** Nothing notifies anyone today — the queue is
  a page you have to remember to open. An agency that applies on a Friday may wait until you
  next think of it, and "we never replied" is a worse first impression than "we said no".
- **How long may an agency wait before that is a failure?** The queue shows a waiting counter
  and turns it red past seven days, which was a guess, not a policy. Pick the number you would
  be comfortable publishing on the signup page.
- **May an agency see why it was verified?** `checkedNote` is private today. Showing it would
  make the badge more credible to the agency; keeping it private lets a reviewer write frankly.
  Both are defensible; only one is currently true.

## Related

[[Agency]] · [[Decisions You Must Make]] · [[Agency Ratings]] · [[Duplicate and Spam Control]] ·
[[The Seven Rules]]
