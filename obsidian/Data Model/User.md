# User

One person. You asked for accounts for **both travelers and agencies** — this note explains
how one table serves both, and why that's better than two.

---

## One table, two kinds of account

There is no `accountType` column. Instead:

```
A user with NO membership   →  a traveler (a client)
A user WITH a membership    →  agency staff
```

### Why not two separate tables?

Because the same person is often both. An agency owner in Oran also books a holiday for
their family. A traveler who inquires about Omra opens their own agency next year.

With two tables that person needs two accounts, two passwords, and you can never tell
they're the same human. With one table plus [[Agency]] memberships, they log in once and
their role depends on which context they're in.

It also means every security mechanism — login, password hashing, token rotation, rate
limiting — is written once and covers both sides. Two auth systems means one of them gets
less attention, and that's the one that gets breached.

### What each kind can do

| | Traveler | Agency staff |
|---|---|---|
| Browse and search offers | ✅ | ✅ |
| Send an inquiry | ✅ (no account needed at all) | — |
| Save offers to a shortlist | ✅ | — |
| See their own inquiry history | ✅ | — |
| Review an agency after travelling | ✅ | — |
| Publish offers | — | ✅ |
| See the lead inbox / CRM | — | ✅ |
| Manage staff, billing | — | `owner` only |

---

## Travelers don't need an account to inquire

Worth being explicit, because it's the most important product decision in this table.

A traveler can send a lead with just **name + phone + consent**. No signup, no email
confirmation, no password.

Why: signup is a wall placed in front of the one action that makes you money. Every step
between "I like this Omra package" and "the agency has my number" loses a share of people.
In a phone-first market where many users are on mobile data and not fluent in web forms,
that share is large.

So what is an account *for*, then? Three things that are worth returning for:
- **`SavedOffer`** — a shortlist. Omra is a comparison purchase; people look at ten offers
  over two weeks.
- **Inquiry history** — "which agencies did I contact?"
- **Reviewing** — a review needs an identity to be worth anything.

An account is a reward for coming back, not a toll on arriving.

---

## Identity: phone or email, not both required

```
email         String?  @unique
phone         String?  @unique   -- E.164, always "+213..."
passwordHash  String?
```

Both nullable, because the two sides of the market identify differently:

- **Travelers are phone-first.** Many Algerian users don't check email. Their phone number
  is their identity, and it's what the agency will actually call.
- **Agency staff are email-first.** It's a business account, shared context, password
  resets, invoices.

The service layer enforces "at least one of email or phone" — the database can't express
that constraint cleanly, so it's a rule in code with a test.

`passwordHash` is nullable because an account can exist without one: a traveler whose lead
was created as a guest, who later claims the account by SMS code. They have an identity
before they have a password.

> [!info] Phones are normalized during validation
> `0551 23 45 67`, `+213 551 234 567` and `00213551234567` all become `+213551234567`
> before any handler sees them. Without this, the same person creates several accounts and
> `@unique` protects nothing. Ten tests cover this in `phone.test.ts`.

---

## Passwords

Stored as an **Argon2id hash**, never as the password.

Argon2id is deliberately slow and memory-hungry. That's the feature: it makes guessing
billions of candidates expensive. Never use SHA-256 or MD5 for a password — they're fast,
which is precisely wrong. See [[Authentication vs Authorization]].

---

## `isPlatformAdmin`

Rihlati's own staff. Verifies agencies, moderates offers, resolves reports.

> [!danger] This field must never appear in any request schema
> Not on signup, not on profile update, not on an "admins only" endpoint. It must be
> impossible to send. Set it directly in the database, deliberately, for named people.
>
> One mass-assignment slip on this field hands over the entire platform — every agency's
> client list at once. It's the highest-value target in the app, and the defence is that
> there's simply no code path that writes it. See [[Validation at the Boundary]].

Every action an admin takes is written to the [[Audit Log]]. Not because you distrust your
staff, but because "who un-verified this agency?" must have an answer.

---

## Sessions: `RefreshToken`

```
tokenHash   String @unique   -- hashed, never the token itself
familyId    String           -- rotation family
expiresAt   DateTime
revokedAt   DateTime?
```

Tokens are stored **hashed**, so a database leak doesn't hand over live sessions.

Rotation with families is how token theft gets detected: a refresh token used twice can only
mean two parties hold it, so the whole family is revoked. Full explanation in
[[Authentication vs Authorization]].

---

## `locale`

`ar` / `fr` / `en`, stored per user. Determines the language of the interface *and* of
notification SMS and emails.

Arabic is right-to-left, which affects layout rather than just text — which is why it's
handled from the first component instead of retrofitted. See [[The Seven Rules]].

---

## `avatarUrl`

A profile picture, and the only field on `User` that a user cannot set directly.

`PATCH /auth/me` accepts `displayName` and `locale` and nothing else. To change the picture you
post the **file** to `POST /auth/me/avatar`; the server re-encodes it and writes the URL itself.
Letting a client put a URL in this column would let anyone point it at a server they control and
learn the IP address of everyone who loads a page showing that avatar. Full reasoning in
[[Image Uploads]].

It is a `String?` holding a URL rather than the bytes. Images do not belong in Postgres — they
would bloat every backup — so the bytes live in object storage and this column points at them.

---

## Fields you might expect and won't find

- **No `name` split into first/last.** One `displayName`. Algerian naming conventions
  don't map cleanly onto a Western first/last split, and nothing in the product needs them
  apart.
- **No `role` column.** Roles live on `Membership`, because they're per-agency.
- **No `isVerified` for travelers.** `phoneVerifiedAt` / `emailVerifiedAt` are timestamps,
  not booleans — you'll want to know *when*, and a nullable timestamp carries both facts.

---

## Open questions for you

- **Do travelers need SMS OTP verification?** Right now, no — a guest inquiry is name +
  phone. It stays that way until spam appears. Every SMS costs money and every OTP step
  loses real inquiries, so this is a decision to make *when* you see abuse, with data,
  not now.
- **Should a "troll" flagged by several different agencies become a platform-level
  signal?** The data supports it (`Lead.quality` rows across agencies). But one agency
  labelling someone a troll must not blacklist a real customer, so the threshold and the
  appeal path are a real design problem. See [[Client Quality Labels]].
- **Account deletion.** A traveler asks to be deleted. Their account goes — but what about
  the agency's commercial record of an inquiry from March? Worth a lawyer's view.

---

Related: [[Data Model Overview]] · [[Agency]] · [[Authentication vs Authorization]] ·
[[Lead]] · [[Client Quality Labels]]
