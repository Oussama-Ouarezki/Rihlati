---
name: pre-launch-audit
description: Audit the Rihlati codebase against the seven rules in CLAUDE.md before exposing it to real users. Use when asked to check if the app is ready to launch, do a security or pre-launch review, or verify the seven rules are actually being followed.
---

# Pre-launch audit

Check the real state of the code, not what the docs claim. Report honestly — a failed check
found now is cheap; found by a user it is not.

For each rule: run the check, then report **PASS / FAIL / NOT APPLICABLE YET** with evidence.
Never report PASS without having actually looked.

---

## 1. Secrets

```bash
git log --all -p | grep -inE "(sk-[a-zA-Z0-9]{16,}|secret[\"']?\s*[:=]\s*[\"'][^\"']{8,}|password[\"']?\s*[:=]\s*[\"'][^\"']{8,}|BEGIN [A-Z ]*PRIVATE KEY)" | head -40
git check-ignore -v .env
grep -rn "NEXT_PUBLIC_\|EXPO_PUBLIC_" --include="*.ts" --include="*.tsx" apps/ | grep -iE "secret|key|token|password"
```

Any real value in git history means that key is burned — it must be rotated, not deleted.
Confirm `.env` is ignored and `.env.example` holds only empty values.

## 2. Server-side authorization

```bash
grep -rn "@Public()" apps/api/src --include="*.ts"
```

For **every** `@Public()`: is it genuinely meant to be public, is it rate limited, and does it
avoid reading tenant data? Then list every controller method and confirm each has an explicit
permission level. Any endpoint reachable without an intended check is a FAIL.

Verify the global auth guard is actually registered — a deny-by-default policy that was never
wired up is the worst outcome, because everything looks protected.

## 3. Tenant isolation

```bash
grep -rn "findUnique\|findUniqueOrThrow" apps/api/src --include="*.ts"
grep -rn "prisma\.\(lead\|offer\|leadNote\|tag\|review\|leadActivity\)\.\(update\|delete\)(" apps/api/src --include="*.ts"
```

Every hit on a tenant-owned table is a finding unless the where clause includes `agencyId`.

Then, for each tenant-owned resource, confirm a test exists where Agency B requests Agency A's
row and gets **404**. Count them against the list of resources. A resource without that test
is a FAIL — do not accept "the code looks right".

Confirm forbidden and missing return identical responses.

## 4. Errors and logging

- Sentry (or GlitchTip) initialized in `apps/api` and `apps/web`, DSN from env
- A global exception filter that returns a `requestId` and never a stack trace
- Structured logs with a request id
- Grep for logging of sensitive values:

```bash
grep -rn "console.log\|logger\.\(log\|info\|debug\)" apps/api/src --include="*.ts" | grep -iE "phone|password|token|otp|secret"
```

## 5. Backups

Read `obsidian/Runbooks/Restore From Backup.md`. Is there a **date** on the last-verified
line?

If not: FAIL. Not "partially". An unrehearsed backup is not a backup, and this is the rule
people most want to wave through. Do not soften it.

Also confirm: PITR enabled, nightly dump to *separate* storage, dumps encrypted.

## 6. Payments

If no payment code exists: NOT APPLICABLE YET — say so plainly.

If it does:
- prices and plan tiers read from the database server-side; the client sends only an item id
- webhook signature verified before the body is trusted
- webhook handling idempotent, deduped on the provider's event id
- payment state changes only on a verified webhook, never a client redirect
- amounts are integer centimes end to end, never floats

```bash
grep -rn "amount\|price\|total" apps/api/src --include="*.ts" | grep -iE "req\.|body\.|dto\.|input\." | head -30
```

## 7. Silent changes

```bash
npm run check
ls .github/workflows/ 2>/dev/null
```

- Does CI exist and does it block merges on failure?
- Do Playwright tests cover search, offer detail, inquiry, lead inbox and login?
- Any migration in `prisma/migrations/` that drops or renames a column — was it reviewed?

```bash
grep -rln "DROP COLUMN\|ALTER COLUMN.*TYPE\|DROP TABLE" apps/api/prisma/migrations/
```

---

## Report

A table of the seven rules with status and evidence, then the findings ordered by how bad
they are, worst first. For each: what is wrong, how it would fail in practice, and the fix.

Finish with one sentence: **is this safe to put in front of real users?** Give a straight
answer. If the answer is no, say no.
