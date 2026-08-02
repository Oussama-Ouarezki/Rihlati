# Multi-Tenancy

The most important note in this vault. If one thing in Rihlati must never break, it's this.

---

## The problem

Every agency's leads sit in the same `leads` table. Agency A's client list and Agency B's
client list are rows next to each other in one place.

A **tenant** is one agency's isolated space. **Tenant isolation** is the guarantee that
Agency A cannot see, edit, or even detect Agency B's rows.

Get this wrong and you don't have a bug, you have a business-ending event: you'd be handing
travel agencies their competitors' client lists. In Algeria, where agencies in the same
wilaya know each other by name, that news travels in a day.

This is problem #3 on your list, and it's the one that most often "just works" in AI-built
apps — meaning the attack works.

---

## Why remembering to check is not a strategy

The naive approach is to check ownership in each endpoint:

```ts
// DON'T
async function getLead(leadId: string, session: Session) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead.agencyId !== session.agencyId) throw new ForbiddenException();
  return lead;
}
```

This is correct. It's also a trap, because it relies on a human writing those two lines in
**every single endpoint, forever**. You will have 60 endpoints. You need 60 out of 60.
Miss one — on a Thursday, in a hurry, in the notes endpoint nobody thought about — and
that one is the breach.

Worse, it leaks by design: `403` tells the attacker the lead exists.

Security that depends on remembering is not security. It's a coin flip repeated 60 times.

---

## What we do instead: make it structural

Three layers, so that forgetting is *impossible* rather than *discouraged*.

### 1. Every tenant-owned table has a non-null `agencyId`

Look at [[Lead]]: `agencyId String` — no `?`, so the database itself rejects a lead with
no owner. Same for `LeadNote`, `LeadActivity`, `Tag`, `Offer`, `Review`.

`LeadNote` carries `agencyId` even though you could reach it through `Lead`. That's a
deliberate duplication: it means a note can be scoped without a join, so the safe query is
also the easy query. **When the safe path is the lazy path, people take it.**

### 2. Queries go through a scoped helper, not through Prisma directly

Rather than every service calling `prisma.lead.findUnique`, they ask a helper that has
already been told which agency it's allowed to see. There is no code path that can express
"find lead 123" without also saying "belonging to my agency" — the function simply doesn't
take that shape.

The rule in `CLAUDE.md`:

> No raw `findUnique({ id })` on tenant data — always `findFirst({ where: { id, agencyId } })`.

`findUnique` can only search by unique key, so it *cannot* take a second condition.
`findFirst` can. Using `findFirst` isn't a style preference; it's what makes the extra
condition possible at all.

### 3. Every resource has a test that tries the attack

For each tenant-owned resource:

1. Create Agency A and Agency B, each with a user.
2. As A, create a lead.
3. As B, request that lead by its exact id.
4. Assert `404`.

**A feature without this test is not finished.** It's in the definition of done in
`CLAUDE.md`. It's about eight lines and it's the difference between believing you're safe
and knowing it.

---

## The `404` rule

A forbidden row and a nonexistent row return **exactly the same response**.

Not just the same status code — the same body, and ideally similar timing. If forbidden
took 50 ms and missing took 5 ms, the timing itself is the answer.

Why it matters concretely: ids are unguessable (see below), but if `403` meant "exists",
then any id an attacker learned by *any* means — a screenshot, a shared link, a former
employee — becomes a confirmed target.

---

## Why ids are UUIDs, not 1, 2, 3

If leads were numbered sequentially, `/leads/1`, `/leads/2`, `/leads/3` walks the whole
table. Even with isolation working perfectly, sequential ids leak business intelligence:
a competitor signs up, creates one lead, sees id `4,912`, and now knows your total volume.
They repeat it next month and know your growth rate.

We use UUIDv7: unguessable, but time-ordered, so the database can still index them
efficiently. Random-but-sortable is the best of both.

---

## Who is in which tenant

A user isn't *in* an agency. A **Membership** row links them, with a role:

```
User ──── Membership (role) ──── Agency
```

This shape matters:
- One person can work for two agencies (real: accountants, group owners) and switching
  between them doesn't need a second account.
- Removing someone is deleting one row, not editing a user.
- The role lives on the *relationship*, so someone can be `owner` of one agency and
  `agent` at another.

A user with no membership is a **traveler**. That's not a lesser account — it's the other
side of the marketplace. See [[User]].

Roles, weakest to strongest: `agent` → `manager` → `owner`. See
[[Authentication vs Authorization]].

---

## What this does NOT protect against

Worth being honest about the limits:

- **A compromised agency account.** If an agency's own password leaks, tenant isolation
  works perfectly and the attacker still sees that agency's data. Defence there is
  passwords, rate limiting, and the [[Audit Log]].
- **Platform admins.** `isPlatformAdmin` users can see everything — that's the point of
  them. Which is why every admin action is written to the audit log, and why that flag can
  never be set through a public endpoint.
- **Bugs in the helper itself.** One shared helper is one place to get wrong. That's a
  good trade (one carefully-tested place beats 60 hopeful ones), but it means the helper
  gets the most thorough tests in the codebase.

---

Related: [[The Seven Rules]] · [[Authentication vs Authorization]] · [[Lead]] · [[Agency]] ·
[[What the API Is]]
