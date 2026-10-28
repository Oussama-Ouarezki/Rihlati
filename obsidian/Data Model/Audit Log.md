# Audit Log

An append-only record of who changed what. Cheap to add now, impossible to reconstruct later.

> [!warning] Designed, not built here
> There is **no `AuditLog` model in this repo.** Nothing records who verified an agency, who
> published an offer, or who changed a lead's status.
>
> Django's admin writes `django.contrib.admin.models.LogEntry` rows for changes made *through
> the admin site*, which is better than zero and is not an audit trail: it covers one
> interface, records the object but not the reason, and says nothing about the API or the CRM
> pages where all the real work happens.
>
> This note is the design. The shape is stack-independent; what's Django-specific is at the
> bottom.

```
actor          who did it            FK(User, null=True, SET_NULL)
agency         in whose context      FK(Agency, null=True)
action         "offer.published", "agency.verified", "lead.status_changed"
entity_type    "Offer"
entity_id      which row             UUIDField
before/after   the changed values    JSONField
ip_hash        from where, hashed
request_id     ties it to the application logs
created_at     when
```

---

## Why it's worth the trouble

**Disputes.** An agency says "we never set that price." The log says who set it, when, and
what it was before. Without it you're guessing, and guessing wrong with a paying customer is
expensive.

**Admin accountability.** Superusers can see and change everything — that's the point of them.
So every admin action is recorded. Not because you distrust your staff, but because *"who
un-verified this agency?"* needs an answer, including when the answer is you at 2am.

This is the gap that matters most today. [[Agency Verification]] is the product, and
`Agency.is_verified` is currently a boolean a superuser flips in `/admin` with no record of
who, when, or on what evidence. See [[Agency]].

**Incident response.** If an account is compromised, the log is the only way to know what the
attacker touched. Without it, the honest answer to "what did they access?" is *"we don't
know"* — and that is what you would have to say to every affected agency.

**Recovery.** `before`/`after` means an accidental bulk change can be reversed by reading the
log rather than restoring the whole database. See [[Restore From Backup]].

---

## What gets logged

Anything that changes trust, money, or someone's data:

- agency verified / rejected / suspended
- offer published, rejected, flagged as duplicate
- plan or quota override changed
- a lead labelled `spam` or `troll` — a negative judgement about a named person should be
  attributable to whoever made it ([[Client Quality Labels]])
- membership added or removed, role changed
- every superuser action, always
- later: every payment state change

**Not** logged: ordinary reads, and routine edits like a staff member typing a note. Logging
everything produces a log nobody reads, which is the same as no log.

That last point is the one people get wrong. An audit log is not a debug log — the
application logs in `apps/common/logging.py` already record every request. The audit log
answers a different question: *who is accountable for this state?*

---

## Rules

**Append-only.** No updates, no deletes. A log that can be edited is not evidence. Ideally the
database role the app runs as has `INSERT` but not `UPDATE`/`DELETE` on this table — a
guarantee the database enforces beats a rule the code promises.

**Never contains secrets.** No passwords, tokens, or full phone numbers in `before`/`after`.
IPs are hashed. The log is a security *control*, so it must not become the largest leak in the
system. Note that `before`/`after` on a `Lead` would contain a phone number by default —
`apps/common/logging.py` has the redaction helpers, and they must be applied on the way *in*
to this table, not on the way out.

**Writing it must not break the request.** If the audit write fails, the user's action should
still succeed — but the failure must be loud in error tracking. A silently failing audit log
is worse than none, because you would trust it.

**It grows forever.** Fine for years, then it is the biggest table you own. Index `created_at`
so old rows can be archived out later.

---

## How to build it in Django

Three real options, and the choice matters more than it looks.

### 1. Signals — `post_save` / `pre_save`

Tempting, because it's automatic and catches every write including the admin and the shell.

Don't. Signals fire without knowing **who** — there is no `request` in a signal handler, so
the actor has to be smuggled in through thread-local storage, which is exactly as fragile as
it sounds and breaks under async. Signals also fire for migrations and fixtures. And they
make the audit write invisible at the call site, so the next person reading the view has no
idea it happens.

### 2. `django-auditlog` or `django-simple-history`

Mature, do the thread-local trick properly, give you a full version history per model.
`django-simple-history` in particular gives you `offer.history.all()` and time-travel queries
for one line per model.

The cost is a dependency that owns a core security control, a shadow table per model, and the
same actor-attribution problem solved in a way you didn't write and would have to debug. Worth
seriously considering when the schema is larger than five models.

### 3. An explicit call in the service path ← recommended

```python
with transaction.atomic():
    offer.status = Offer.PUBLISHED
    offer.save(update_fields=["status"])
    AuditLog.objects.create(
        actor=request.user,
        agency=offer.agency,
        action="offer.published",
        entity_type="Offer",
        entity_id=offer.id,
        before={"status": previous},
        after={"status": offer.status},
        request_id=getattr(request, "request_id", None),
    )
```

Two things make this the right answer here.

**`transaction.atomic()` is the whole point.** The change and its record commit together or
neither does. An audit log written *after* a successful save is a log that is missing exactly
the entries from the requests that crashed in between — which are the ones you most want.

**`request_id` is the join key.** The same id is in the `X-Request-Id` header the user saw and
in every application log line for that request. An agency quotes an id from a screenshot; you
get the audit row *and* the full request log. That link is free because
`RequestIdMiddleware` already exists — see [[The Seven Hops of a Request]].

The downside of option 3 is real: it only records what someone remembered to record, and it
does not cover the Django admin or a `manage.py shell`. Which is an argument for keeping the
admin restricted to a handful of named people and doing consequential work through the
application. See the open question in [[Multi-Tenancy]].

---

## Open questions

- **Is an agency allowed to read its own audit rows?** "Who on my team changed this price?"
  is a legitimate and quite compelling CRM feature. It also means an owner can see everything
  an agent did, which is a workplace-surveillance decision, not just a technical one.
- **How long are audit rows kept?** Forever is a decision you make by not making one. Disputes
  and legal retention pull in different directions here; verify the Algerian requirement
  rather than guessing.
- **Does a superuser's own row get written when they read data, not just change it?** Reading
  every agency's leads is the most sensitive thing a superuser can do and it changes nothing,
  so a change-only log misses it entirely.

---

Related: [[Data Model Overview]] · [[Agency]] · [[Multi-Tenancy]] ·
[[Authentication vs Authorization]] · [[Agency Verification]] · [[The Seven Rules]] ·
[[Restore From Backup]]
