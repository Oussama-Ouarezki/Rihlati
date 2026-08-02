# Authentication vs Authorization

Two different questions that get confused constantly, including by experienced developers.
Problem #2 on your list is what happens when you conflate them.

| | Question | Asked | Fails with |
|---|---|---|---|
| **Authentication** (authn) | *Who are you?* | Once, at login | `401` |
| **Authorization** (authz) | *Are you allowed to do this?* | **Every single request** | `403` |

Authentication happens once. Authorization happens constantly. A logged-in user is not an
allowed user.

---

## Why "the UI is the only security" happens

You build an admin page. You hide the "Delete agency" button from non-admins. It looks
correct — non-admins can't see the button, so they can't delete anything.

But the button was never what deleted the agency. `DELETE /agencies/abc` deleted it. The
button just called it. And anyone can send that request with `curl`, from a phone, from a
script, without ever loading your page.

**Hiding a button is a UX decision. It is not a permission.** The permission has to live on
the server, in front of the endpoint, where the attacker can't reach it.

AI coding tools produce this bug constantly because they build the *happy path* — the
journey a cooperative user takes through the interface. Attackers don't use the interface.

---

## How authentication works here

### Signing up and logging in

A password is **never stored**. We store an Argon2id hash of it — a one-way scramble.
Checking a login means hashing the attempt and comparing hashes. Even with a full database
dump, an attacker doesn't have the passwords.

Argon2id is deliberately *slow* and memory-hungry, which is a feature: it makes guessing
billions of passwords expensive. Never hash a password with SHA-256 or MD5 — they're fast,
which is exactly wrong here.

### Staying logged in: two tokens

Sending a password with every request would be terrible. Instead, logging in returns two
tokens:

**Access token** — a JWT, lives **15 minutes**, sent with every request. It contains the
user id, and which agency+role they're acting as. It's *signed*, so the server can verify
we issued it and nobody edited it.

> [!warning] A JWT is signed, not secret
> Anyone holding it can read what's inside — it's just base64, not encryption. Never put
> anything sensitive in a token. It proves identity; it doesn't hide anything.

**Refresh token** — lives **30 days**, used for exactly one thing: getting a new access
token. Stored **hashed** in the `refresh_tokens` table.

Why two? A trade-off between safety and annoyance. A stolen access token is only useful for
15 minutes. But making users log in every 15 minutes would make the product unusable — so
the refresh token quietly renews it in the background.

### Rotation, and how theft gets detected

Every time a refresh token is used, it's invalidated and a new one issued. Both belong to a
**family** (`familyId`).

Now suppose someone steals a refresh token. Both they and the real user hold the same one.
Whoever uses it first gets a new token; the other then presents a token that's already been
spent.

**A token being reused after rotation can only mean one thing: two parties hold it.** So the
whole family is revoked immediately and everyone is logged out. The theft is detected by the
victim's own normal activity, without anyone noticing anything was wrong.

---

## How authorization works here

### Deny by default

Every endpoint requires a logged-in user *unless explicitly marked otherwise*:

```ts
@Public()               // ← must be written deliberately
@Get('offers')
searchOffers() { ... }
```

The direction of this default is the whole point. If the default were "open" and you had to
remember `@RequireAuth()`, then forgetting it would expose data — and you'd never notice,
because the app would keep working. With deny-by-default, forgetting it means the endpoint
returns `401` to legitimate users, someone reports it in an hour, and nothing leaked.

**Design so that mistakes fail closed.** You will make mistakes; choose which direction
they break in.

### Layers of authorization

A request to change a lead's stage passes four checks:

1. **Authenticated?** Valid, unexpired access token. → else `401`
2. **Member of an agency?** Is there a membership? → else `403`
3. **Role high enough?** `agent` can edit assigned leads; only `manager`+ can reassign.
   → else `403`
4. **Does this row belong to your agency?** Enforced in the query itself, not as an
   `if`. → else `404`. See [[Multi-Tenancy]].

Layer 4 is the one that must never be skipped, and it's the one that isn't a check at all —
it's a property of how the query is written.

### Roles

| Role | Can |
|---|---|
| `agent` | see and work the leads assigned to them |
| `manager` | everything `agent` can + all leads, offers, staff |
| `owner` | everything `manager` can + billing, delete the agency |
| `isPlatformAdmin` | Rihlati staff. Verify agencies, moderate. Not an agency role. |

Ranked numerically in `packages/shared/src/enums.ts` (`AGENCY_ROLE_RANK`), so a guard asks
"is your rank ≥ the required rank?" rather than listing allowed roles at every endpoint.
Adding a role later means one line in one table.

> [!danger] `isPlatformAdmin` must never be settable through an API endpoint
> Not on signup, not on profile update, not "only for admins" — the field simply must not
> appear in any request schema. Set it directly in the database, deliberately. A single
> mass-assignment slip on that field hands over the whole platform.

---

## The rule to remember

> Every endpoint authorizes itself, server-side, every time — regardless of what the
> interface shows.

The UI decides what's *comfortable*. The API decides what's *possible*.

---

Related: [[Multi-Tenancy]] · [[The Seven Rules]] · [[What the API Is]] · [[User]] · [[Auth Flow]]
