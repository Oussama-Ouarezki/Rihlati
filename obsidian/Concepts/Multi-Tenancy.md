# Multi-Tenancy

The most important note in this vault. If one thing in Rihlati must never break, it's this.

---

## The problem

Every agency's leads sit in the same `leads_lead` table. Agency A's client list and Agency B's
client list are rows next to each other in one place.

A **tenant** is one agency's isolated space. **Tenant isolation** is the guarantee that
Agency A cannot see, edit, or even detect Agency B's rows.

Get this wrong and you don't have a bug, you have a business-ending event: you'd be handing
travel agencies their competitors' client lists. In Algeria, where agencies in the same
wilaya know each other by name, that news travels in a day.

This is rule #3, and it's the one that most often "just works" in AI-built apps — meaning the
attack works.

---

## Why remembering to check is not a strategy

The naive approach is to check ownership in each handler:

```python
# DON'T
def get_lead(request, lead_id):
    lead = Lead.objects.get(pk=lead_id)
    if lead.agency_id != request.user.agency_id:
        raise PermissionDenied
    return lead
```

This is correct. It's also a trap, because it relies on a human writing those two lines in
**every single handler, forever**. There are 56 operations. You need 56 out of 56. Miss one
— on a Thursday, in a hurry, in the notes endpoint nobody thought about — and that one is
the breach.

Worse, it leaks by design: `403` tells the attacker the lead exists.

Security that depends on remembering is not security. It's a coin flip repeated 56 times.

---

## What we do instead: make it structural

Four layers, so that forgetting is *impossible* rather than *discouraged*.

### 1. Every tenant-owned model has a non-null `agency`

Look at [[Lead]]: `agency = models.ForeignKey(Agency, on_delete=models.CASCADE, ...)` with no
`null=True`, so the database itself rejects a lead with no owner. Same for [[Offer]],
`OfferMilestone`, `Reservation`, `Tag`, `TrackedLink` and the rest.

`Lead.agency` is **denormalised** from `lead.offer.agency` on purpose. You could always reach
the agency through the offer, so storing it twice looks like a mistake. Two reasons it isn't:

- The tenant filter never has to join. The safe query is also the *simple* query — and
  **when the safe path is the lazy path, people take it.** That is the entire trick.
- An offer changing hands later cannot silently move a historical lead into a different
  agency's inbox. The lead records who received it, which is a fact about the past, not a
  pointer that should follow the offer around.

`OfferMilestone.agency` is the same idea one level deeper: a milestone belongs to an offer,
which belongs to an agency, but the column is there anyway so the filter never joins.

The house-rules test asserts this column stays non-null, because "make it nullable to unblock
a migration" is a five-second edit with permanent consequences.

### 2. Two gates, and they answer different questions

This is where Django Ninja differs most from the DRF version this repo used to have, and the
shape is worth learning because it's more explicit — you can *see* both gates in the handler:

```python
@agency_router.get("/agencies/{uuid:agency_id}/leads", response=list[LeadOut])
def list_leads(request, agency_id: UUID, filters: Query[LeadFilters]):
    require_membership(request.user, agency_id)          # gate 1: are you in this agency?
    qs = scoped(Lead.objects, agency_id).select_related("offer")   # gate 2: which rows exist for you
```

**`require_membership(user, agency_id)`** asks the database whether this user has a
`Membership` row for the agency named in the URL. No membership → `Forbidden` → 403. It also
takes a `minimum_role`, which is a *different* question — see
[[Authentication vs Authorization]].

**`scoped(queryset, agency_id)`** is four words long and is the whole point:

```python
def scoped(queryset, agency_id):
    return queryset.filter(agency_id=agency_id)
```

Filtering *inside the queryset* rather than checking the row afterwards is the entire idea.
A check after the fetch can be refactored away, skipped by an early return, or missed when
the query gets reused. A condition inside the queryset cannot be accidentally skipped,
because there is nothing to skip: `get_object_or_404` looks inside the queryset it was
handed, and another agency's row was never in there to be found.

Read that once more, because it's the transferable idea: **the row isn't rejected, it never
existed.** Every SaaS backend you build after this one wants the same shape.

The rule in `CLAUDE.md`:

> No `Model.objects.get(pk=...)` on tenant data — always `.filter(agency_id=...)` first.

`Model.objects.get(pk=...)` reads whichever agency's row happens to have that primary key.
`.filter(agency_id=...)` can carry the second condition. Using the filter isn't a style
preference; it's what makes the extra condition possible at all. `get_scoped_object()` bundles
the two so the safe version is also the shortest one to type.

### 3. A machine enforces the rule, not a reviewer

`apps/common/tests_house_rules.py` parses every source file with Python's `ast` module and
fails the build on `Offer.objects.get(...)` or `Lead.objects.get(...)`.

It also **pins the exact list of public operations**, by reading the generated OpenAPI
document and collecting every operation with no security requirement:

```python
schema = api.get_openapi_schema()
found = {f"{method.upper()} {path}"
         for path, operations in schema["paths"].items()
         for method, operation in operations.items()
         if not operation.get("security")}
self.assertEqual(found, PUBLIC_OPERATIONS)
```

Ten operations, each with a comment saying why it's public. Adding a new one is a deliberate
edit to a test with a reviewer attached, rather than one `auth=None` nobody notices in a
400-line diff.

> [!info] Django vs NestJS
> The NestJS repo does this with a custom ESLint rule banning `findUnique` on tenant tables.
> Ruff has no user-defined rules, so here it's an `ast.NodeVisitor` in the test suite.
>
> The mechanism differs; the principle is identical and it is the one worth keeping:
> **when a mistake gets made twice, add a check rather than a comment.** A comment is a
> request. A failing build is an answer.

> [!tip] A trap worth knowing about, from writing that pin
> The first version of that test walked `api._routers` — Ninja's internal route registry —
> and reported a dozen routes as having no auth. It looked like a serious finding. It was
> wrong: that registry holds the operations *before* they're cloned onto the API with the
> root `auth=`. Issuing real anonymous HTTP requests to those routes returned 401 every time.
>
> The lesson generalises past this codebase: **when introspection says something alarming,
> reproduce it with a real request before you believe it.** A false security finding costs
> the same as a missed one, in the opposite direction — it burns the trust you need when the
> next one is real.

### 4. Every resource has a test that tries the attack

For each tenant-owned resource:

1. Create Agency A and Agency B, each with a user.
2. As A, create an offer.
3. As B, request that offer by its exact id.
4. Assert `404`.

`apps/offers/tests.py` runs both variants of the attack, and the difference between them
matters:

| B does this | Result | Which layer caught it |
|---|---|---|
| Puts A's offer id under **B's own** agency path | `404` | `scoped()` — the row was never in the queryset |
| Puts **A's** agency id in the path | `403` | `require_membership` — B has no Membership row |

Two different defences, and both are tested **separately**, because either one alone would be
enough right up until the day it wasn't. That's why the tests assert the exact status code
and not `assertIn(status, (403, 404))` — a test that accepts either would pass while the bug
is present.

`apps/pages/tests.py` repeats the whole exercise against the HTML pages. **Two doors into
the same models means two places to get authorization wrong**, and the second door is
always the one that gets forgotten — it feels like "our own site" rather than an API. See
[[One Rule, Two Entry Points]].

**A feature without these tests is not finished.** It's in the definition of done in
`CLAUDE.md`. It's about eight lines and it's the difference between believing you're safe
and knowing it.

> [!warning] A real gap found while writing those tests
> There is no `GET /api/agencies/{id}/offers/{offer_id}` — the API has a list and a `PUT`
> but no single-offer read. So the read-isolation test goes through the `/milestones`
> sub-resource, which uses the same `scoped(Offer.objects, agency_id)` lookup and therefore
> fails the same way if scoping breaks.
>
> That's a legitimate substitute, not a fix. The missing route is written up in
> [[Known Gaps]].

---

## The `404` rule

A forbidden row and a nonexistent row return **exactly the same response**.

Not just the same status code — the same body, and ideally similar timing. If forbidden took
50 ms and missing took 5 ms, the timing itself is the answer.

Why it matters concretely: ids are unguessable (see below), but if `403` meant "exists", then
any id an attacker learned by *any* means — a screenshot, a shared link, a former employee —
becomes a confirmed target.

The honest caveat: the borrowed-agency-id case above returns `403`, not `404`, and that does
leak one bit — "you are not a member of that agency". This is deliberate, and
`apps/common/tenancy.py` says so in its module docstring. Agency ids are not secret (they're
in every agency's own URLs, and agencies are a public directory), and a membership failure is
genuinely useful to report: it's what a real user sees when their access was revoked while
they had a tab open. The rule protects **rows**, not the existence of agencies.

The **pages** make the opposite trade. `require_membership_or_404()` exists for exactly that:
a browser URL gets pasted around far more casually than an API call, so the HTML side turns
the 403 into a 404 and tells a stranger nothing at all.

---

## Why ids are UUIDs, not 1, 2, 3

If leads were numbered sequentially, `/leads/1`, `/leads/2`, `/leads/3` walks the whole
table. Even with isolation working perfectly, sequential ids leak business intelligence: a
competitor signs up, creates one lead, sees id `4912`, and now knows your total volume. They
repeat it next month and know your growth rate.

`UUIDModel` in `apps/accounts/models.py` gives every model a random UUID primary key. Django
sets `DEFAULT_AUTO_FIELD = BigAutoField`, so **inheriting `UUIDModel` is not optional
decoration** — a new model that forgets it silently gets sequential integers back and nothing
complains.

> [!info] Django vs NestJS — a real cost, worth knowing
> The NestJS repo uses UUIDv7, which is random *and* time-ordered, so rows written together
> land together on disk and the index stays compact.
>
> Python's `uuid.uuid4` is purely random, so inserts scatter across the index and it
> fragments as the table grows. At Rihlati's size this is invisible. At millions of leads it
> is a real write cost, and the fix — `uuid7` from a library, or a `ULID` field — is a
> migration you'd rather do early. Filed as a known trade, not a problem yet. See
> [[Indexes and Why Queries Get Slow]].

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
- The role lives on the *relationship*, so someone can be `agency_owner` of one agency and
  `agency_agent` at another.

The alternative — an `agency_id` column on `User` — caps everyone at one agency forever and
turns "transfer ownership" into a data migration. It looks simpler for exactly as long as it
takes to meet the first accountant who works for three agencies.

A user with no membership is a **traveler**. That's not a lesser account — it's the other
side of the marketplace. See [[User]].

Roles here are `agency_owner`, `agency_manager` and `agency_agent`, compared by *rank* rather
than by an allowlist. See [[Authentication vs Authorization]].

---

## What this does NOT protect against

Worth being honest about the limits:

- **A compromised agency account.** If an agency's own password leaks, tenant isolation
  works perfectly and the attacker still sees that agency's data. Defence there is
  passwords, rate limiting, and the [[Audit Log]].
- **Rihlati staff.** `require_staff()` gates four endpoints that are deliberately *not*
  scoped, because reviewing an agency means reading an agency you're not a member of. That's
  the entire cross-tenant surface of the API, and it is protected by one boolean. See
  [[Accounts]] and [[Agency Verification]].
- **Bugs in `tenancy.py` itself.** One shared helper is one place to get wrong. That's a good
  trade (one carefully-tested place beats 56 hopeful ones), but it means that file earns the
  most thorough tests in the codebase.
- **Anything reached through the Django admin.** The admin does not go through `scoped()` at
  all. Today only staff reach it, which is fine. The day an agency user is given admin
  access, tenant isolation is off for them — see the open question below.

---

## Open questions

- Should agency staff ever get Django admin access? It's tempting (it's free), and it
  bypasses every protection in this note. My recommendation is no, permanently, and that the
  admin stays a platform-staff tool — but it's your call and it should be a written one.
- When an owner removes an agent, do the leads that agent worked stay visible to them for
  any period? Currently: no, instantly. That's the safe default and possibly the wrong
  business answer for a handover.
- `TENANT_MODELS` in the house-rules test lists only `Offer` and `Lead`, but `Reservation`,
  `OfferMilestone`, `Tag` and `TrackedLink` are equally tenant-owned. Widening it is one line
  and would probably find something. Worth doing.

Related: [[The Seven Rules]] · [[Authentication vs Authorization]] · [[Lead]] · [[Agency]] ·
[[What the API Is]] · [[The Seven Hops of a Request]] · [[Known Gaps]]
