# Auth Flow

> [!success] Built
> Code: `apps/api/src/modules/auth/` and `apps/api/src/common/auth/`.
> Tests: `apps/api/test/auth.e2e.test.ts` (17 cases).
> Concepts first: [[Authentication vs Authorization]].

---

## One account type for everybody

There is no "traveler account" and "agency account". There is a `User`, and a user who has a
[[Agency|Membership]] is agency staff. No membership means traveler.

Why: the owner of an agency is usually also a traveler, and two account types would force them
to keep two passwords. It would also double every piece of auth code — and duplicated auth code
is where auth bugs live. See [[User]].

---

## Register

```
POST /v1/auth/register
{ displayName, email?, phone?, password, locale? }
```

1. Rate limited: **5 per hour per IP**.
2. Validated by `registerSchema` in `packages/shared`. At least one of `email` or `phone`.
3. The phone is normalized to E.164 **inside validation**, so the handler can only ever see
   `+213…`. The email is lowercased the same way.
4. Password hashed with **Argon2id** (~19 MiB, ~50 ms). Deliberately slow — see below.
5. `isPlatformAdmin`, `emailVerifiedAt` and every other server-owned field are absent from the
   schema, so Zod strips them. Posting `isPlatformAdmin: true` does nothing. There is a test.
6. Tokens issued.

> [!note] Why the minimum password length is 10 and there is no symbol rule
> "Must contain an uppercase, a number and a symbol" produces `Password1!` — memorable to a
> cracking dictionary, annoying to a human. Length is the only rule that reliably buys
> entropy. Checking against a list of breached passwords would beat both, and is a later job.

**Registration does tell you an email is taken.** That is a deliberate trade — the alternative
needs working email delivery, which does not exist yet, and leaves a user staring at a form
that silently did nothing. Rate limiting is what makes bulk enumeration impractical here.
Login, where the stakes are higher, does *not* leak (below).

**The web page is `/inscription`.** Until 2026-08-04 this endpoint existed but nothing called
it, so an agency could only be created by hand in SQL. It now runs through the same server
action pattern as login: the password is posted to a server action, the Next server calls the
API, and the tokens land in httpOnly cookies the browser cannot read (see Decision 019 below).

After signing up with no agency, the console shows a dead-end screen with a link to
`/nouvelle-agence`. That page is deliberately **outside** `/console`, because the console layout
short-circuits to that same dead-end screen for anyone with no membership — putting the
create-agency form inside it would make it unreachable by exactly the people who need it.

---

## Profile edits

```
PATCH /v1/auth/me
{ displayName?, locale? }
```

The interesting part is the list of fields it **refuses**:

- `avatarUrl` — a picture is uploaded as bytes to `POST /auth/me/avatar`. See [[Image Uploads]].
- `email` / `phone` — these are what you log in with. Changing one is account recovery: it needs
  the current password and a verification round trip, and neither exists yet. The account page
  shows them read-only with a note to contact support.
- `isPlatformAdmin`, `emailVerifiedAt`, … — server-owned, always.

None of them are in `updateProfileSchema`, so Zod strips them rather than the handler having to
remember to ignore them. Two tests post `avatarUrl` and `isPlatformAdmin` and assert nothing
happened. This is [[Validation at the Boundary]] doing its job: the safe thing is the default,
not something a future handler has to opt into.

---

## Login

```
POST /v1/auth/login
{ identifier, password }        // identifier = email OR phone, one field
```

One field, not a "log in with email / with phone" toggle — the server works out which it is by
trying to normalize it as a phone first. Users should not have to make that choice.

Three things are the same whether the account exists or not, whether it has a password or not,
and whether the password is wrong: **the status, the error code, and the time taken.**

The timing is the part people forget. Checking a real password costs ~50 ms and returning
"no such user" costs ~2 ms, and that gap alone lets anyone test which phone numbers have
accounts on Rihlati. So when there is no account, the code hashes against a decoy anyway
(`fakeVerifyPassword`) and pays the same cost.

In a country where the phone number *is* the identity, a verified list of "these numbers are
registered travel customers" has real resale value. That is what this defends.

> [!warning] Rate limiting is per IP, NOT per account
> The vault used to say "per identifier and per IP". That was wrong, and the code is right.
>
> Locking an account after N failed attempts hands everyone a weapon: type wrong passwords at
> a competitor's owner account and lock them out of their own CRM during Ramadan booking
> season. Limiting the **source** slows down guessing without creating that weapon.
> **10 attempts per 15 minutes per IP.**

A disabled account is rejected **after** the password check, so "this account is suspended"
is never returned to someone who merely guessed the address.

---

## Tokens: why there are two

| | Access token | Refresh token |
|---|---|---|
| What it is | signed JWT | 256 random bits |
| Lives | ~15 minutes | 30 days |
| Sent | every request | only to `/auth/refresh` |
| Stored server-side | no | yes, **hashed** |
| Can be cancelled | no | yes, instantly |

The access token is checked with maths alone — no database lookup — which is what makes it
fast. The price of that speed is that it cannot be revoked, which is exactly why it expires
quickly. The refresh token is the opposite trade.

### What is inside the access token

**Three claims: `sub` (user id), `fam` (session family), `adm` (admin flag).** That is all.

A JWT is *signed, not encrypted* — anyone holding it can read every claim. And every claim is
a snapshot that goes stale the moment the database changes.

> [!warning] The token does NOT contain memberships or roles
> The vault used to say it did. That was wrong, and the code is right.
>
> Fire an employee at 09:00, and with roles baked into a 15-minute token they can still read
> your client list until 09:15. The membership is instead read from the database on every
> tenant-scoped request — one indexed lookup, `memberships(userId, agencyId)`.
>
> The `adm` claim exists but is **not trusted**: `JwtAuthGuard` re-reads `isPlatformAdmin`
> from the database too. Revocation that takes effect now is worth one query.

Refresh tokens are stored as plain **SHA-256**, not Argon2. A password is low-entropy and
guessable, so its hash must be slow; a 256-bit random token is not guessable at any speed, so
slowness would only make every refresh cost 50 ms for nothing. What is needed here is just
that a stolen database dump contains no usable tokens.

---

## Refresh, with theft detection

```
POST /v1/auth/refresh
{ refreshToken }
```

Every refresh **consumes** the old token and issues a new one. Refresh tokens are single-use.
All tokens descending from one login share a `familyId`.

Now suppose a refresh token is stolen:

- **The thief uses it first.** The real user's next refresh presents a token already revoked.
- **The user uses it first.** The thief presents a token already revoked.

Either way **a revoked token gets presented** — and that never happens in normal use, because
a client that has rotated threw the old one away. So it is treated as proof of theft: the
entire family is revoked, both parties are logged out, and the one who knows the password
comes back. The thief does not.

The theft is caught by the victim simply carrying on using the app, with nobody noticing
anything was wrong. Without rotation, a stolen refresh token is 30 days of silent access.

The detection is written to the [[Audit Log]] as `user.token_reuse_detected`.

---

## Acting as an agency

```
GET /v1/agencies/{agencyId}/leads
```

The agency is named **in the URL path**. That sounds like trusting client input, and it is
worth being precise about why it is not:

> The client **says** which agency it wants to act as.
> The server **proves** the claim, and derives the role from its own data.

`AgencyMembershipGuard` takes `:agencyId`, looks for a membership row for the logged-in user,
and 404s if there is none. `TenantContext` — including `role` — is built from **that row**, not
from the URL. So `:agencyId` is a lookup key that must match something the caller owns, and
guessing ids reveals nothing.

> [!tip] The mechanism worth understanding
> The guard is global, and it activates on one condition: **the route has an `:agencyId`
> parameter.** The thing that makes a route tenant-scoped is the same thing that switches the
> guard on. There is no decorator to forget.

See [[Multi-Tenancy]] and [[API Endpoints]].

---

## Logout

```
POST /v1/auth/logout
{ refreshToken?, allDevices? }
```

With no `refreshToken`, this session's whole family is revoked — otherwise "log out" would
leave the session alive until it expired. `allDevices: true` revokes every family the user has.

---

## How the WEB APP holds the session (Decision 019)

The browser never sees a token. Not in localStorage, not in JavaScript memory — nowhere
a script on the page could read.

- **Login is a server action**: the password goes browser → Next server → API, and the
  returned tokens land in **httpOnly cookies** the browser stores but cannot read.
- **Console reads are server components, writes are server actions** — both attach the
  `Authorization: Bearer` header on the server. The API itself never sees a cookie, which
  is exactly what keeps the API's CSRF surface at zero.
- **Refresh happens in `middleware.ts`** — the one stage of a request where Next can still
  set cookies before pages render. The middleware also has to mutate the *request's*
  cookies, not just the response's: cookies set only on the response reach the browser but
  not the server components of the same request, and with rotation, "the new refresh token
  got lost" reads as theft to the API (family revoked, on purpose).

**Rejected:** tokens in localStorage (any XSS exfiltrates a 30-day session);
access-token-in-JS-memory (the standard compromise, workable — but "no tokens in JS at
all" is strictly simpler to reason about, and this app can afford it because every
mutation already runs through a server action).

**Cost:** an XSS on the site can still *ride* the session while the tab is open (make
requests as the user); it just can't *steal* it. And the web server is now stateful about
auth in middleware — a page cannot be exported statically. Both accepted.

---

## Sign in with Google

> [!success] Built — code only. **Not switched on until you add credentials.**
> `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Both or neither: the config
> refuses to boot half-configured, because a client id without a secret fails later with a
> confusing error from Google instead of a clear one from us.

### The flow, and why it is split across both apps

```
web   /auth/google/start      makes state + PKCE, redirects to Google
Google                        the user consents
web   /auth/google/callback   checks state, POSTs the code to the API
API   POST /v1/auth/oauth/google   exchanges it, decides whose account this is
web                           sets the same session cookies as a password login
```

The web app owns cookies (Decision 019); the API stays stateless and cookie-free. **The
browser never holds a Google token** — only the web server does.

Two secrets make the round trip safe, both in httpOnly cookies for ten minutes:

- **`state`** — without it, an attacker can hand a victim a crafted callback URL and log
  them into the *attacker's* Google account. Everything the victim then types happens
  inside a stranger's session. This is login CSRF, and it is easy to forget because the
  flow "works" without it.
- **PKCE `code_verifier`** — an intercepted authorization code is useless without it, and
  the verifier never leaves our server.

### Account linking — where OAuth vulnerabilities actually live

Three cases, and **the order is the security**:

1. **Known provider subject** → log that user in.
2. **No link, but the email matches an existing account** → link only if the provider says
   it **verified** that address.
3. **Otherwise** → create a new account.

> [!danger] Case 2 is the takeover path
> Linking on an *unverified* email means anyone who can persuade a provider to assert
> `victim@gmail.com` inherits the victim's Rihlati account — no password required. It is
> the most common OAuth flaw, and the `emailVerified` check is the whole defence. There is
> a test named for it.

Everything keys on the provider's stable **`sub`**, never the email: people change email
addresses, and an address can be reassigned to someone else. A test signs in, changes the
email, signs in again, and asserts it is still the same user.

The refusal message talks about *the provider*, never about whether a Rihlati account
exists — otherwise Google sign-in becomes an account-enumeration oracle.

### A design gap the database caught

Case 3 originally created an account with a null email when the provider would not verify
one. The `users_has_identifier` CHECK constraint rejected it — correctly. Such a user would
have had **no email and no phone**: uncontactable, unrecoverable, a ghost.

So new accounts now require a verified email, which collapses both branches into one rule:

> **An unverified email is never enough to establish an identity.**

The alternative — relaxing the constraint — would have weakened a real invariant for
everyone to serve a rare case (a Workspace account whose domain admin has not verified it).
Those users get a clear message pointing at password signup.

### Why the ID token's signature is not verified

Deliberate, and spec-backed rather than a shortcut. OIDC Core §3.1.3.7: a token received by
**direct TLS communication with the provider's token endpoint** may rely on TLS server
validation instead of the signature. We asked Google directly over HTTPS a millisecond
earlier; nobody else was in the conversation. Issuer, audience and expiry *are* checked —
the audience check is what stops a token Google issued for a different application.

> [!warning] If you ever accept an ID token from the BROWSER
> Google One Tap, or a mobile SDK, hands you a token from an untrusted party. Signature
> verification against Google's JWKS becomes **mandatory** there. Do not copy
> `readIdToken()` into that path.

### Apple, later

`OAuthAccount` is a table with a `provider` enum, not a `googleId` column on `User` — so
adding Apple is a row, not a migration. You will need it: **the App Store requires Sign in
with Apple** if an iOS app offers Google. `signInWithIdentity()` is already
provider-agnostic; only a new client class is needed.

---

## Deliberately not in v1

- **SMS OTP.** Every message costs money and every extra step loses real inquiries. Add it
  when abuse actually appears, with data. See [[User]].
- **Password reset.** Needed before real users, not before the first endpoint. It needs
  working email/SMS delivery first.
- ~~**Social login.**~~ Built — see above.
- **2FA for `isPlatformAdmin`.** Those accounts can read every agency's data. This is the
  first one to add.

---

## Open questions — yours to decide

- **Session length.** 30 days is convenient and long. Agency staff handle other people's
  personal data on possibly shared computers — do you want a shorter refresh window for
  accounts with a membership than for travelers?
- **Should registering with an existing email be allowed to say so?** It is the friendly
  option and the one implemented. The private alternative needs email delivery.
- **Do you want to force logout everywhere when a password changes?** Standard, and not built
  yet because there is no password-change endpoint.

---

Related: [[Authentication vs Authorization]] · [[User]] · [[Multi-Tenancy]] ·
[[API Endpoints]] · [[Audit Log]] · [[The Seven Rules]]
