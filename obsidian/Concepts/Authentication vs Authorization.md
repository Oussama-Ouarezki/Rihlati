# Authentication vs Authorization

Two different questions that get confused constantly, including by experienced developers.
Rule #2 in [[The Seven Rules]] is what happens when you conflate them.

| | Question | Asked | Fails with |
|---|---|---|---|
| **Authentication** (authn) | *Who are you?* | Once, at login | `401` |
| **Authorization** (authz) | *Are you allowed to do this?* | **Every single request** | `403` |

Authentication happens once. Authorization happens constantly. A logged-in user is not an
allowed user.

> [!important] Django makes this distinction easy to miss
> Django hands you authentication complete and working on day one — user model, password
> hashing, login view, session cookie, `@login_required`. You never build it, so you never
> think about it.
>
> That's a real gift and a real trap. `@login_required` is *authentication*. It says "some
> user is here". It says nothing about whether **this** user may touch **this** row, and a
> project where every view is decorated `@login_required` and nothing else is a project with
> no authorization at all. Every logged-in agency can read every other agency's leads, and
> the app looks completely fine.
>
> In `apps/pages/views.py` the two are always adjacent, on consecutive lines:
>
> ```python
> @login_required                                              # authn
> def agency_leads(request, agency_id):
>     agency = require_membership_or_404(request.user, agency_id)   # authz
> ```
>
> Point at both. They are not the same line and they never do the same job. The file's own
> docstring says it: "UX choice; `require_membership_or_404` is the actual security."

---

## Why "the UI is the only security" happens

You build an admin page. You hide the "Delete agency" button from non-admins. It looks
correct — non-admins can't see the button, so they can't delete anything.

But the button was never what deleted the agency. `DELETE /api/agencies/abc` deleted it. The
button just called it. And anyone can send that request with `curl`, from a phone, from a
script, without ever loading your page.

**Hiding a button is a UX decision. It is not a permission.** The permission has to live on
the server, in front of the handler, where the attacker can't reach it.

AI coding tools produce this bug constantly because they build the *happy path* — the journey
a cooperative user takes through the interface. Attackers don't use the interface.

The same logic applies to `GET /api/me`. It lists the agencies you belong to so the UI can
draw an agency switcher. Removing an agency from that response grants nothing and protects
nothing — every agency-scoped endpoint calls `require_membership` on its own. It is a
convenience, not a permission.

---

## How authentication works here

### Passwords

A password is **never stored**. Django stores a PBKDF2 hash — a one-way scramble. Checking a
login means hashing the attempt and comparing. Even with a full database dump, an attacker
doesn't have the passwords.

The hash is deliberately *slow*, which is a feature: it makes guessing billions of passwords
expensive. Never hash a password with SHA-256 or MD5 — they're fast, which is exactly wrong
here.

Note the contrast with `hash_token()` in `apps/common/auth.py`, which *does* use SHA-256, and
says why in a comment: a refresh token is 256 random bits, so it isn't guessable, so slowness
buys nothing. Same verb, opposite reasoning, because the inputs have different entropy.

> [!tip] Worth doing before launch
> Django supports Argon2id (`pip install django[argon2]`, then put `Argon2PasswordHasher`
> first in `PASSWORD_HASHERS`). It is memory-hard, which PBKDF2 is not, and that is what makes
> GPU cracking expensive. Django re-hashes each user on their next successful login, so
> switching is one setting and no migration. `PASSWORD_HASHERS` is unset in
> `config/settings.py` today, meaning PBKDF2.

### Two ways in, on purpose

| Caller | Mechanism | Class |
|---|---|---|
| A person in a browser | **session cookie**, HttpOnly | `SessionAuth` |
| A program (mobile app, script, an LLM tool-call) | **bearer token** in an `Authorization` header | `BearerAuth` |

Both are in `API_AUTH`, and either satisfies a request. Sessions are right for browsers
because the cookie can be `HttpOnly` — JavaScript cannot read it, so an XSS bug cannot steal
it. Tokens are right for programs because there is no cookie jar to put a cookie in.

**CSRF belongs to exactly one of these two.** A browser attaches the session cookie to *any*
request to our domain, including one triggered by a form on someone else's site — so the
cookie half needs a CSRF token. A browser never attaches a bearer header on its own, so the
token half needs nothing. That is why `SessionAuth` subclasses Ninja's version instead of
being hand-written: **the base class carries the CSRF check and a reimplementation would
silently not.**

> [!info] Where the CSRF switch actually lives
> In Ninja 1.x, `NinjaAPI(csrf=True)` raises `TypeError`. CSRF moved onto the auth class,
> which is the right place for it — it is a property of *how you authenticated*, not of the
> API. If you find a tutorial passing `csrf=True` to `NinjaAPI`, it predates 1.0.

### Tokens: short-lived, rotated, and revocable

- **Access token** — 15 minutes, sent on every request. Made with `django.core.signing`, not
  a JWT library: an HMAC-signed timestamped payload verified against `SECRET_KEY` is what a
  JWT's HS256 mode *is*, minus a dependency and minus the `"alg": "none"` family of bugs.
- **Refresh token** — 30 days, used only to get a new access token, stored **hashed**, and
  **single-use**.

The rotation rule in `rotate_refresh_token()` is the part worth understanding. If a refresh
token arrives that has already been spent, two parties hold it — the legitimate client and a
thief — and there is no way to tell which one is calling. So the entire **family** (every
token descended from one login) is revoked and everyone re-authenticates.

That sounds harsh until you notice what it buys: **the theft is detected by the victim's own
normal activity.** No monitoring, no heuristics, nobody had to notice anything was wrong.

And what is deliberately *not* in the token: roles, memberships, `is_staff`. Those are read
from the database on every request, so revoking someone's access bites immediately rather
than whenever their token happens to expire. A token that carries permissions is a permission
you cannot take back for 15 minutes.

See [[Auth Flow]] for the full sequence.

---

## How authorization works here

### Deny by default

One line, in `config/api.py`:

```python
api = NinjaAPI(auth=API_AUTH, ...)
```

Every operation on the API requires an authenticated caller **unless it explicitly says
otherwise**, one route at a time:

```python
@public_router.post("/inquiries", response={201: Message}, auth=None)  # ← deliberate
```

The direction of this default is the whole point. If the default were "open" and you had to
remember to add a check, forgetting would expose data — and you would never notice, because
the app would keep working. With deny-by-default, forgetting means legitimate users get a
`401`, someone reports it within the hour, and nothing leaked.

**Design so that mistakes fail closed.** You will make mistakes; choose which direction they
break in.

Because "explicitly public" is a decision worth counting, `AuthorizationTests` in
`apps/common/tests_house_rules.py` pins the exact list — currently ten operations, each with a
comment saying why. It reads the **generated OpenAPI document**, not the source, which catches
two things grepping for `auth=None` would miss: a route made public by inheriting from a
router mounted `auth=None`, and a route whose auth silently failed to resolve at all. Adding
an eleventh is an edit to that test, with a reviewer attached.

> [!danger] The default does not cover the HTML pages
> `auth=API_AUTH` is a Ninja setting. A plain Django view in `apps/pages/` is wide open unless
> *you* decorate it. That asymmetry is the sharpest edge in this codebase, and it is why
> `apps/pages/tests.py` re-runs every tenant-isolation test against the rendered pages. See
> [[One Rule, Two Entry Points]].

### The four layers

A request to change a lead's status passes four checks:

1. **Authenticated?** Valid session or bearer token. → else `401`
2. **Member of that agency?** `require_membership` looks for a `Membership` row. → else `403`
3. **Role high enough?** A rank comparison against `minimum_role`. → else `403`
4. **Does this row belong to that agency?** Enforced *inside the queryset*, not as an `if`.
   → else `404`

Layer 4 is the one that must never be skipped, and it is the one that isn't a check at all —
it's a property of how the query is written. `scoped(queryset, agency_id)` narrows the query
before it runs, so another tenant's row was never a candidate. A check you write after the
fetch can be refactored away by someone in a hurry; a filter inside the queryset has nothing
to skip. See [[Multi-Tenancy]].

Note the two failure codes. Layers 2–3 are `403` because agency ids are not secret — they are
in every agency's own URLs — and "you are not a member of this agency" is exactly what a real
user sees when their access is revoked while a tab is open. Layer 4 is `404` because a `403`
there would confirm that a specific lead id exists, and looping through ids would let you
count a competitor's clients without reading one.

### Roles are ranks, not lists

```python
RANK = {AGENT: 1, MANAGER: 2, OWNER: 3}
```

`require_membership(request.user, agency_id, Membership.MANAGER)` asks *is your rank at least
this?* — not *is your role in this allowlist?*

The difference matters the day you add a fourth role. With ranks, it is one line in `RANK` and
it slots into the hierarchy everywhere at once. With allowlists, the new role is silently
absent from every list in the codebase and every endpoint has to be edited by someone who
remembers all of them.

| Role | Can |
|---|---|
| `agency_agent` | read offers and leads, work the pipeline, run checkpoints |
| `agency_manager` | + create and publish offers, edit the programme, reply to reviews |
| `agency_owner` | + edit the agency profile, submit for verification, manage members |
| `is_staff` | Rihlati staff. Verify agencies, moderate reports. **Not an agency role.** |

The reasoning behind the owner-only line is a good example of authorization as a *business*
decision rather than a technical one: submitting for verification is a legal declaration about
the company, and an agent hired last week should not be able to make it.

Rihlati staff is Django's own `User.is_staff`, checked by `require_staff(request)` in
`apps/accounts/api.py`, which reads it from the database every request. There is no such thing
as an agency membership that grants it.

> [!danger] `is_staff` and `is_superuser` must never be settable through an endpoint
> Not on signup, not on profile update, not "only for admins" — the fields simply must not
> appear in any schema or form. Set them with `manage.py createsuperuser`, or a deliberate
> shell session. A single mass-assignment slip on either hands over the whole platform.
>
> This is why every input schema here lists its fields by hand. `AgencyProfileIn` carries the
> same idea for the tenant: `status`, `plan` and `credit_balance_centimes` are absent, because
> an agency that could `PUT` its own `status` would verify itself. See
> [[Validation at the Boundary]].

---

## The rule to remember

> Every endpoint authorizes itself, server-side, every time — regardless of what the
> interface shows.

The UI decides what's *comfortable*. The server decides what's *possible*.

---

## Open questions

- Should an `agency_agent` see leads assigned to *other* agents in the same agency? Today they
  see all of them. "Can't see other agents' leads" is a different product from "can't delete
  an offer", and only you can say which one an Algerian agency expects.
- Is three roles enough, or does a large agency need a read-only accountant? Every role you
  add is a permission-matrix row you maintain forever, so the answer should stay "no" until an
  agency asks.
- Should logging out of one device log out all of them? `POST /api/auth/logout` currently
  revokes *every* refresh token, on the argument that a partial logout leaves someone feeling
  safe when they aren't. That is a real trade-off against convenience.

Related: [[Multi-Tenancy]] · [[The Seven Rules]] · [[What the API Is]] · [[User]] ·
[[Auth Flow]] · [[Agency Verification]] · [[One Rule, Two Entry Points]]
