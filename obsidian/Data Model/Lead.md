# Lead

A traveler's inquiry about a trip: who they are, what they want, and where the agency has
got to with them.

**This is the most commercially important table in the app.** It's what agencies pay for,
and it's the object your whole monetization plan sits on. It's also the most sensitive —
it holds real people's phone numbers.

---

## Why contact details are copied, not linked

A lead stores `contactName`, `contactPhone`, `contactEmail` directly, even when the traveler
has an account (`travelerUserId`).

That looks like duplication. It's deliberate, for three reasons:

1. **An inquiry must work with no account.** Forcing signup before the one action that
   makes you money is the single most expensive mistake a marketplace can make. A traveler
   types name + phone and they're done.
2. **A lead is a historical record.** If someone later deletes their account or changes
   their number, the agency's record of *who inquired in March* must stay intact. That's a
   business document.
3. **The agency owns its copy.** A traveler exercising a data-deletion request removes
   their *account*; the agency's legitimate commercial record is a separate question with a
   separate answer.

So `travelerUserId` is a nice-to-have link. `contactPhone` is the truth.

---

## The consent trail

```
consentGivenAt      DateTime   -- when
consentTextVersion  String     -- exactly which wording they agreed to
consentIpHash       String?    -- from where (hashed)
consentUserAgent    String?    -- on what
```

These four fields are the **legal basis for an agency phoning this person**, and later the
basis for charging for the introduction. Written once at submission, never updated.

`consentTextVersion` is the important one. When you reword the consent notice, the old
version stays on old leads — so you can always answer "what exactly did this person agree
to?" Storing just `consentGiven: true` would make that unanswerable, and unanswerable is
the same as no consent.

> [!important] This is what makes your business model legal
> You wrote that you want to sell information about high-value clients. Selling a data list
> is a different thing from selling a *consented introduction*, and only the second one is
> a business. The consent record is what separates them. See
> [[Decisions You Must Make]] section 3, and get an Algerian lawyer to review the wording
> before you charge anyone — I won't guess at Law 18-07's requirements.

---

## The CRM fields

### `stage` — where the deal is

```
new → contacted → quoted → negotiating → booked → paid → travelled
                                                            │
                        (from anywhere) ───────────────────► lost
```

`travelled` and `lost` are terminal. `lost` also takes a `lostReason`, which after a few
hundred leads becomes the most valuable data you own — it tells you *why* Algerian
travelers don't buy, which is a report nobody else in the market has.

### `quality` — how serious the person is

Your troll-to-vip labels: `unrated`, `spam`, `troll`, `cold`, `warm`, `serious`, `vip`.
Full explanation in [[Client Quality Labels]].

### `firstRespondedAt`

Set the first time the agency acts. Feeds "you answer in 12 minutes on average" — the
single most persuasive number you can show a prospective agency, and a fair ranking signal
for search. An agency that answers fast should outrank one that doesn't.

### `nextActionAt`

Powers the "à rappeler aujourd'hui" list. In practice this is the screen an agency opens
every morning, and the reason they keep using the CRM instead of a notebook.

### `assignedToUserId`

Which staff member owns it. `agent` role sees only their own; `manager` sees all. See
[[Authentication vs Authorization]].

---

## Notes vs Activities — two different things

| | `LeadNote` | `LeadActivity` |
|---|---|---|
| Written by | a person | the system |
| Content | "client wants a window seat, calling back Thursday" | `stage_changed: quoted → booked` |
| Editable | yes | **never** |
| Purpose | working memory | audit trail |

Keeping them separate matters: if staff could edit the activity timeline, it would be
worthless as evidence in a dispute. And if the system wrote into notes, real notes would
drown in noise.

---

## Tenant isolation

`agencyId` is non-null on `Lead`, and **also** on `LeadNote`, `LeadActivity` and `LeadTag` —
even though you could reach those through the lead.

That duplication is on purpose: it means the safe query needs no join. The safe path is the
easy path, so people take it. See [[Multi-Tenancy]].

Required test for every one of these tables: Agency B requests Agency A's lead by exact id
and gets `404`. Not `403` — `403` would confirm the row exists.

---

## Indexes

Every index starts with `agencyId`, because every query is tenant-scoped:

```
[agencyId, stage, createdAt]                    -- the inbox, by column
[agencyId, quality]                             -- "show me the serious ones"
[agencyId, assignedToUserId, nextActionAt]      -- "my callbacks today"
[agencyId, contactPhone]                        -- "has this person called before?"
```

That last one is why phone normalization matters so much. See
[[Indexes and Why Queries Get Slow]].

---

## Where money will attach

Nothing here is built yet, but nothing blocks it:

- `estimatedValueCentimes` / `actualValueCentimes` — what the lead is worth, which is what
  lets you price leads at all
- `source` — `marketplace_inquiry` leads are the ones you generated and could charge for;
  `walk_in` and `direct_call` are the agency's own and must be free, or agencies will stop
  logging them and your data goes blind
- charging happens against a credit ledger beside this table, never by editing the lead

That distinction in `source` is a real design decision: **never charge an agency for a lead
they brought themselves.** If you do, they'll hide their own clients from the CRM, and then
your pipeline data — the thing your future AI features depend on — becomes fiction.

---

## Open questions for you

- **Are contact details revealed immediately, or after the agency responds in-platform?**
  This decides whether you can ever charge. See [[Decisions You Must Make]] section 6.
- **How many agencies does one inquiry go to?** One (exclusive, higher value per lead) or
  several (better for the traveler, more competition)? Emploitic-style is several.
- **Can a traveler see their own inquiry history?** Cheap to build, and it's a reason to
  have an account.

---

Related: [[Data Model Overview]] · [[Client Quality Labels]] · [[Multi-Tenancy]] ·
[[Agency]] · [[Decisions You Must Make]]
