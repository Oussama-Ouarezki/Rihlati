# Audit Log

An append-only record of who changed what. Cheap to add now, impossible to reconstruct later.

```
actorUserId   who did it
agencyId      in whose context
action        "offer.published", "agency.verified", "lead.quality_changed"
entityType    "Offer"
entityId      which row
before / after   the changed values (JSON)
ipHash        from where (hashed)
requestId     ties it to the application logs
createdAt     when
```

---

## Why it's worth the trouble

**Disputes.** An agency says "we never set that price." The log says who set it, when, and
what it was before. Without it you're guessing, and guessing wrong with a paying customer is
expensive.

**Admin accountability.** Platform admins can see and change everything — that's the point of
them. So every admin action is recorded. Not because you distrust your staff, but because
"who un-verified this agency?" needs an answer, including when the answer is you at 2am.

**Incident response.** If an account is compromised, the log is the only way to know what the
attacker touched. Without it, the honest answer to "what did they access?" is "we don't know",
and that's what you'd have to tell every affected agency.

**Recovery.** `before`/`after` means an accidental bulk change can be reversed by reading the
log, rather than restoring the whole database.

---

## What gets logged

Anything that changes trust, money, or someone's data:

- agency verified / rejected / suspended
- offer published, rejected, flagged as duplicate
- plan or quota override changed
- lead quality set to `spam` or `troll` — a negative judgement about a named person should be
  attributable to whoever made it
- membership added or removed, role changed
- every platform-admin action, always
- later: every payment state change

**Not** logged: ordinary reads, and routine edits like a staff member typing a note. Logging
everything produces a log nobody reads, which is the same as no log.

---

## Rules

**Append-only.** No updates, no deletes. A log that can be edited is not evidence. Ideally the
database user the app runs as has `INSERT` but not `UPDATE`/`DELETE` on this table.

**Never contains secrets.** No passwords, tokens, or full phone numbers in `before`/`after`.
IPs are hashed. The log is a security *control*, so it must not become the biggest leak.

**Writing it must not break the request.** If the audit write fails, the user's action should
still succeed — but the failure must be loud in error tracking. A silently failing audit log
is worse than none, because you'd trust it.

**It grows forever.** Fine for years, then it's the biggest table you own. `createdAt` indexes
exist so old rows can be archived out later.

---

## Not built yet

The table exists. Writing to it comes with the API — every service that changes something
records it in the same transaction as the change, so they can't disagree.

---

Related: [[Multi-Tenancy]] · [[Authentication vs Authorization]] · [[The Seven Rules]] ·
[[Data Model Overview]]
