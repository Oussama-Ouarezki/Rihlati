# Auth Flow

> [!success] Built
> Mechanism: `apps/common/auth.py`. Routes: `apps/accounts/api.py`.
> Rate limits: `apps/common/throttling.py`.
> Tests: `apps/accounts/tests.py` (28 cases).
> Concepts first: [[Authentication vs Authorization]].

---

## One account type for everybody

There is no "traveler account" and "agency account". There is a `User`, and a user who has a
[[Agency|Membership]] is agency staff. No membership means traveler.

Why: the owner of an agency is usually also a traveler, and two account types would force them
to keep two passwords. It would also double every piece of auth code — and duplicated auth code
is where auth bugs live. See [[User]].

---

## Two doors, one API

This is the part that differs most from the NestJS build, and it is worth understanding before
anything below makes sense.

| Caller | Proves identity with | Set up in |
|---|---|---|
| a person on a Django-rendered page | the **session cookie** Django already issues | `django.contrib.auth`, `LoginView` |
| a program — mobile app, script, a future LLM tool-call | a **bearer access token** | `BearerAuth` in `apps/common/auth.py` |

`API_AUTH = [BearerAuth(), SessionAuth()]` is handed to `NinjaAPI` once, so **either** satisfies
**any** route. That is why a console page can call the same endpoint the mobile app calls, with
no token anywhere in JavaScript — the page already has a session.

> [!note] Why the browser never holds a token here, and why that was hard work in NestJS
> The old stack served pages from a separate Next.js server, so the session had to be carried
> from the browser to that server to the API: httpOnly cookies, a token-refresh dance in
> `middleware.ts`, and a whole decision record explaining it (Decision 019).
>
> Django renders the pages *and* serves the API from the same process, so the session cookie
> is simply already there. The entire mechanism collapses into `request.user`. This is the
> single biggest simplification the port bought — and the cost is on the other side of the
> ledger: the pages are server-rendered, so anything that needs to feel instant needs real
> work rather than coming free from React. See [[One Rule, Two Entry Points]].

CSRF belongs to the cookie door only. A browser attaches the session cookie to *any* request to
our domain, including one triggered by a form on someone else's site; a bearer token is never
sent that way. So `SessionAuth` carries the CSRF check and `BearerAuth` needs no equivalent —
**CSRF is a cookie problem, not an authentication problem in general.**

> [!tip] One override in `SessionAuth`, and the reason for it
> Ninja runs the CSRF check unconditionally, so an anonymous POST to a protected route answers
> `403 CSRF check Failed` — a confusing thing to tell a mobile client whose token merely
> expired. With no session cookie there is nothing to forge, so the check is skipped and the
> honest answer is **401**. There is a test named for exactly this.

---

## Login

```
POST /api/auth/login
{ "username": "...", "password": "..." }
```

Three things are the same whether the account exists or not and whether the password is wrong:
**the status (401), the message ("Identifiants invalides."), and roughly the time taken.**

The timing is the part people forget. Verifying a real password costs tens of milliseconds and
returning "no such user" costs almost nothing, and that gap alone lets anyone test which
accounts exist here. Django's own `ModelBackend` closes it: when the user is not found it runs
the password hasher against a throwaway value anyway, purely to pay the same cost. That
behaviour is inherited, not written here — but it is load-bearing, so do not replace the
backend without reproducing it.

In a country where the phone number *is* the identity, a verified list of "these numbers are
registered travel customers" has real resale value. That is what this defends.

A deactivated user is refused with the same message, for the same reason.

> [!warning] Login is by `username`, not by email or phone
> The NestJS build accepted one `identifier` field and worked out whether it was an email or a
> phone. This port uses Django's stock `User.username`, because there is no self-registration
> yet (below) and inventing an identifier scheme before there are users to identify would be
> designing in the dark. **When registration is built, this changes** — the intended shape is
> still one field, normalized to E.164 if it parses as an Algerian number.

---

## Rate limits: per source, never per account

```
login     10 / 15 min
refresh   30 / 15 min
inquiry   20 / hour
```

Those are the only three routes a stranger may call, so they are the only three with limits.
Everything else is behind authentication, where the account itself is the limit.

> [!danger] Account lockout is a weapon, not a defence
> "Lock the account after five failed attempts" sounds safer and hands every user a button:
> type wrong passwords at a competitor's owner account and lock them out of their own CRM
> during Ramadan booking season. The server cannot tell that attack from a genuine forgotten
> password. Limiting the **source** slows guessing without creating the weapon.

The limit counts *attempts*, not failures — a stolen-password list wants to succeed, and every
request that gets a real answer is progress for the attacker. There is a test for that
distinction, because "only count failures" is the intuitive and wrong choice.

> [!warning] `NINJA_NUM_PROXIES = 0` is doing real work
> Left unset, Django Ninja keys the throttle bucket on `X-Forwarded-For` whenever that header
> is present — and that header is chosen by the caller. A different value on every request
> means a different bucket on every request, and the limit silently stops existing while still
> looking configured. Setting it to `0` means "ignore that header, trust `REMOTE_ADDR`", which
> is correct while nothing sits in front of us.
>
> **This must change at deploy time.** Behind nginx or Cloudflare, `REMOTE_ADDR` is the
> proxy, so every request in the country lands in one bucket and a single attacker locks
> everyone out. Set it to the real number of proxies. `test_a_forged_x_forwarded_for_header_
> does_not_buy_a_fresh_bucket` guards today's half of this; nothing can guard the deploy half
> except remembering.

Counters live in Django's cache, which defaults to per-process local memory. Two workers means
two counts and an effective limit twice as high. Production wants Redis — see [[The Seven Rules]].

---

## Tokens: why there are two

| | Access token | Refresh token |
|---|---|---|
| What it is | signed payload (`django.core.signing`) | 256 random bits |
| Lives | 15 minutes | 30 days |
| Sent | every request | only to `/api/auth/refresh` |
| Stored server-side | no | yes, **hashed** |
| Can be cancelled | no | yes, instantly |

The access token is checked with arithmetic alone — no database lookup for the *signature* —
which is what makes it fast. The price of that speed is that it cannot be recalled, which is
exactly why it expires quickly. The refresh token is the opposite trade.

### Why not a JWT library

`signing.dumps()` gives an HMAC-signed, timestamped payload verified against `SECRET_KEY` —
which is precisely what a JWT's HS256 mode gives, minus a dependency, minus the
algorithm-confusion family of bugs (`"alg": "none"` and friends), and minus the temptation to
put things in a token that ought to be read from the database.

The day a third party needs to *verify* our tokens without holding our secret is the day to
switch to real asymmetric JWTs. Nothing in Rihlati needs that.

`salt="rihlati.access"` is namespacing, and it matters: without it, any other signed value the
app produces — a future unsubscribe link, a password-reset code — would be accepted as a login
token, because they all share one `SECRET_KEY`. There is a test.

### What is inside the access token

**One field: the user id.** That is the whole payload.

Not roles. Not memberships. Not `is_staff`.

> [!important] Why the token is deliberately almost empty
> Fire an employee at 09:00, and with a role baked into a 15-minute token they can still read
> your client list until 09:15. Everything that answers "what may you do" is read from the
> database on every request, so revoking access bites **now**. The test
> `test_deactivating_a_user_kills_a_token_that_has_not_expired` is that guarantee, written
> down.
>
> A signed payload is also *readable* by anyone holding it — signing is not encryption. One
> more reason to put nothing in it.

Refresh tokens are stored as plain **SHA-256**, not a password hash. A password is low-entropy
and guessable, so its hash must be deliberately slow; 256 random bits are not guessable at any
speed, so slowness would only make every refresh burn CPU for nothing. The reason to hash at
all is the same either way: **a stolen database dump must contain no usable credentials.**

---

## Refresh, with theft detection

```
POST /api/auth/refresh
{ "refresh_token": "..." }
```

Every refresh **consumes** the old token and issues a new one. Refresh tokens are single-use,
and every token descending from one login shares a `family`.

Now suppose a refresh token is stolen:

- **The thief uses it first.** The real client's next refresh presents an already-spent token.
- **The client uses it first.** The thief presents an already-spent token.

Either way **a spent token gets presented** — and that never happens in normal use, because a
client that has rotated threw the old one away. So it is treated as proof that two parties hold
the credential, and since nothing in the request says which one is calling, the entire family
is revoked. Both are logged out; the one who knows the password comes back, and the thief does
not.

The theft is caught by the victim simply carrying on using the app, with no monitoring, no
heuristics, and nobody noticing anything was wrong. Without rotation, a stolen refresh token is
thirty days of silent access.

`test_a_replayed_refresh_token_burns_the_whole_family` is the single test in this file most
worth reading.

> [!warning] The reuse event is not written to the [[Audit Log]] yet
> The NestJS build logged `user.token_reuse_detected`. This one does not — the revocation
> happens, but nothing records that it happened, so the one signal that would tell you an
> account was actually attacked is currently invisible. Small fix; listed below.

---

## Logout

```
POST /api/auth/logout
```

Takes no body, and revokes **every** refresh token the user has, not just the one presented.

"Log out" on a device you are worried about has to mean it. A partial logout that leaves a
stolen token alive is worse than none, because the user now believes they are safe. The cost is
that logging out on a laptop also logs out the phone; that is the right default, and a
per-device logout can be added later by revoking one `family` instead of all of them.

The page-side logout (`/logout/`) is Django's own `LogoutView`, which flushes the session. The
two are independent: a browser session and an API token family are separate credentials.

---

## Acting as an agency

```
GET /api/agencies/{agency_id}/leads
```

The agency is named **in the URL path**. That sounds like trusting client input, and it is worth
being precise about why it is not:

> The client **says** which agency it wants to act as.
> The server **proves** the claim, and derives the role from its own data.

`require_membership(request.user, agency_id, minimum_role)` looks for a `Membership` row for the
session's user, and raises otherwise. The role comes from **that row**, never from the URL or
the body. So `agency_id` is a lookup key that must match something the caller already owns, and
guessing ids reveals nothing.

> [!warning] The one thing the port lost
> In NestJS this was a **global guard** that switched itself on whenever a route had an
> `:agencyId` parameter — the thing that made a route tenant-scoped was the same thing that
> armed the check, so there was no decorator to forget.
>
> Here it is a plain function call at the top of each handler, which means **it can be
> forgotten**. What replaces the guarantee is a test: `apps/common/tests_house_rules.py`
> asserts that every route with an `agency_id` parameter calls it. A convention plus a test
> that fails when the convention is broken — weaker than a mechanism, stronger than trust.

See [[Multi-Tenancy]] and [[API Endpoints]].

---

## Not built in this port

Say so plainly rather than describing a flow that does not exist:

- **Registration.** There is no `POST /api/auth/register` and no `/inscription` page. Accounts
  are created in the Django admin or `manage.py createsuperuser`, which is honest for a
  preview and is the first blocker for a real user. Whatever gets built must keep the
  server-owned fields (`is_staff`, `is_superuser`, `preferred_language`) out of the input
  schema, exactly as `AgencyProfileIn` keeps `status` and `plan` out of the profile update.
- **Profile edits.** No `PATCH /api/me`. An agency can edit its *agency* profile; a person
  cannot yet edit their own.
- **Sign in with Google.** The NestJS build had it, including the account-linking rules that
  are where OAuth vulnerabilities actually live. None of it is here. If it comes back, the
  rule that carried the weight was: **an unverified email is never enough to establish an
  identity** — linking on an unverified address means anyone who can persuade a provider to
  assert `victim@gmail.com` inherits that account, no password required.
- **Password reset**, **SMS OTP**, and **2FA for staff accounts**. Staff can read every
  agency's data, so that last one is the first to add.
- **Password strength rules.** `AUTH_PASSWORD_VALIDATORS` is not configured, so Django's
  defaults are off. Worth knowing: "must contain an uppercase, a number and a symbol" produces
  `Password1!` — memorable to a cracking dictionary, annoying to a human. Length is the only
  rule that reliably buys entropy, and checking against a list of breached passwords beats
  both.

---

## Open questions — yours to decide

- **What do people log in with?** Username is a placeholder. Email, phone, or either, is a
  product decision, and in Algeria the phone number is the stronger answer — which makes
  delivery (SMS cost per message) part of the same decision.
- **Session length.** Thirty days is convenient and long. Agency staff handle other people's
  personal data on possibly shared computers — do you want a shorter refresh window for
  accounts holding a membership than for travelers?
- **Should logout be per-device?** Today it is all-devices. Per-device is one line (revoke the
  presented token's family) and is what most people expect from a "log out" button.
- **Force logout everywhere when a password changes?** Standard, and not built, because there
  is no password-change endpoint yet.

---

Related: [[Authentication vs Authorization]] · [[User]] · [[Multi-Tenancy]] ·
[[API Endpoints]] · [[Audit Log]] · [[One Rule, Two Entry Points]] · [[The Seven Rules]]
