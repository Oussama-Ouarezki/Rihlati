# Restore From Backup

> [!success] Procedure rehearsed: **2026-08-01** — locally, and it passed
> `./scripts/restore-rehearsal.sh` dumps the database, restores it into a scratch copy,
> checks the data, then **starts the real API against the restored database** and confirms
> an agency can log in, sees its own leads, and gets a 404 for another agency's. 3 seconds
> end to end at current data size.
>
> That proves the **procedure**. Run it any time; it only ever writes to a database whose
> name ends in `_restore_test`, and it drops it afterwards.

> [!danger] Production backups: **still none. Last verified production restore: never.**
> There is no production database, so there is nothing to back up yet. A rehearsal against
> a local Docker Postgres proves the steps and the verification — it does **not** prove
> your hosting provider's PITR, your off-site copy, or that anyone can find the dump at
> 3am. **Do not launch before this line has a date too.**

This is rule #5 in [[The Seven Rules]] — the one most people skip, because nothing appears
to be wrong right up until everything is.

---

## What has to exist before launch

**1. Managed Postgres with point-in-time recovery.** Not a database you administer yourself.
Whichever provider you choose, PITR means you can rewind to any moment, not just to last
night — which is what you need when the problem is "a bad migration at 14:20", not "the
server died".

**2. A nightly logical dump to separate storage.** `pg_dump` to object storage on a
*different* provider from the database.

Why both: PITR protects against data loss. A separate dump protects against losing the
account, the provider, or the region. A backup living inside the thing it's backing up is not
a backup.

**3. Encrypted at rest, and the key is not in the same place.** A dump of this database
contains every agency's client list and thousands of real phone numbers. Treat it as the most
sensitive object you own.

**4. Retention:** 7 daily, 4 weekly, 12 monthly. Ransomware and slow corruption are both
found late.

---

## The rehearsal — the part that actually matters

```bash
./scripts/restore-rehearsal.sh
```

That is the whole thing. It is scripted rather than a checklist on purpose: a procedure
you have to remember at 3am is a procedure you will get wrong at 3am.

What it does, and why each step is there:

| Step | Checks | Why it is in there |
|---|---|---|
| 1 | `pg_dump -Fc` | times it — "we can restore" and "we can restore in 20 minutes" are different promises, and you will be making one of them to an agency on the phone |
| 2 | restore into `*_restore_test` | **never over the live one**: if the restore is wrong you have destroyed your only evidence |
| 3 | row counts match, no orphans, **CHECK constraints survived** | a dump that restores with no errors but an empty `leads` table, or without the hand-written constraints, is a failed backup that reports success |
| 4 | **starts the real API against the restored DB**, logs in, reads leads, confirms another agency gets 404 | the step everyone skips. Data that restores but breaks [[Multi-Tenancy|tenant isolation]] is worse than no restore |
| 5 | drops the scratch database | |

> [!note] You do not have `pg_dump` on your machine
> It lives inside the Postgres container, which is why every command in the script goes
> through `docker exec`. In production it will run wherever your dumps are taken.

> [!warning] One trap the script hit while being written
> Rewriting the database name in `DATABASE_URL` with bash substitution **silently broke**:
> `?` is a glob wildcard, so the pattern matched the *username* first and produced a
> connection string pointing at a host that does not exist. The script parses the URL
> properly now. Worth knowing if you ever hand-edit a connection string in a hurry.

---

## Record every rehearsal here

Run it before launch, then **quarterly**, and paste the result line here.

| Date | Environment | Time to restore | Rows recovered | Result |
|---|---|---|---|---|
| 2026-08-01 | local (Docker) | 1s (3s total) | 5 users · 3 agencies · 5 offers · 6 leads · 2 reservations | ✅ passed, isolation intact |
| — | **production** | — | — | **never run** |

---

## The real emergency checklist

When it happens, decisions are harder than commands. Decide the order now:

1. **Stop the bleeding.** Put the API in read-only or maintenance mode. Do not let a bad
   process keep writing.
2. **Work out what happened and when.** PITR needs a target timestamp. The
   [[Audit Log]] and error tracking are how you find it.
3. **Restore to a NEW database.** Never over the live one — if the restore is wrong you've
   destroyed your only evidence.
4. **Verify** as in the rehearsal above, especially tenant isolation.
5. **Switch over**, then confirm the last write that survived.
6. **Tell affected agencies what was lost.** Specifically. "Leads received between 14:20 and
   15:05 are gone; here is what we still have." Vagueness is what loses customers, not the
   outage.
7. **Write down what happened** and what would have caught it.

> [!warning] Locally, `docker compose down -v` deletes your development database
> No backup, no recovery. Harmless now — it's exactly why the real one needs this runbook.

---

Related: [[The Seven Rules]] · [[Local Setup]] · [[Audit Log]] · [[Data Model Overview]]
