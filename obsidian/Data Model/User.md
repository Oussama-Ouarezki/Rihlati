# User

One person. Rihlati has accounts for **both travelers and agencies** — this note explains how
one table serves both, and why that's better than two.

Defined in `apps/accounts/models.py`.

---

## What's actually in the table

```python
class User(AbstractUser):
    id                 UUIDField(primary_key=True, default=uuid.uuid4)
    phone              CharField(20, blank=True)   # E.164, never logged in full
    preferred_language CharField(2, choices=[("fr", "Français"), ("ar", "العربية")])
```

Plus everything `AbstractUser` brings: `username`, `email`, `password`, `first_name`,
`last_name`, `is_staff`, `is_superuser`, `is_active`, `date_joined`, `last_login`.

Two things about this class are worth stopping on.

### `AbstractUser`, and why swapping the user model is a one-way door

```python
AUTH_USER_MODEL = "accounts.User"
```

Django ships a `User` model that works out of the box, and **substituting your own is
effectively impossible after the first migration**. Not "hard" — the official documentation
says to do it at the start of a project or accept a painful manual migration, because
`AUTH_USER_MODEL` is baked into every migration that references a user, in every app,
including third-party ones.

So this is a decision you make on day one with incomplete information, and the correct answer
is always the same: **subclass it immediately, even if you add no fields.** An empty
`class User(AbstractUser): pass` costs nothing and buys the ability to add a column later.
Doing it on day 400 costs a weekend and a data migration.

That's a general lesson about frameworks, not a Django trivium: find the decisions that are
cheap now and expensive later, and pay for them now.

### The UUID `id` is declared by hand

`User` can't inherit `UUIDModel` — it already inherits `AbstractUser` — so the UUID primary
key is repeated on the class. If it weren't, `DEFAULT_AUTO_FIELD` would silently give users
sequential integer ids, and `/api/users/1/` would be the platform's first account. See
[[Data Model Overview]].

---

## One table, two kinds of account

There is no `account_type` column. Instead:

```
A user with NO Membership   →  a traveler (a client)
A user WITH a Membership    →  agency staff
```

`apps/pages/views.py` reads exactly this, and does the honest thing with the third case:

```python
memberships = request.user.memberships.select_related("agency")
if not memberships:
    return render(request, "pages/no_agency.html")
```

### Why not two separate tables?

Because the same person is often both. An agency owner in Oran also books a holiday for their
family. A traveler who inquires about Omra opens their own agency next year.

With two tables that person needs two accounts and two passwords, and you can never tell
they're the same human. With one table plus [[Agency]] memberships, they log in once and what
they can do depends on which context they're in.

It also means every security mechanism — login, password hashing, session handling, rate
limiting — is written once and covers both sides. **Two auth systems means one of them gets
less attention, and that's the one that gets breached.**

### What each kind can do, here

| | Traveler | Agency staff |
|---|---|---|
| Browse and search offers | ✅ | ✅ |
| Send an inquiry | ✅ — **no account needed at all** | ✅ |
| Publish and edit offers | — | ✅ |
| See the lead inbox / CRM | — | ✅ |
| Save offers to a shortlist | ✗ not built | — |
| See their own inquiry history | ✗ not built | — |
| Review an agency after travelling | ✗ not built — [[Agency Ratings]] | — |
| Manage staff, billing | — | ✗ not built; roles aren't enforced |

---

## Travelers don't need an account to inquire

Worth being explicit, because it's the most important product decision touching this table,
and it's why `Lead.traveler` is `null=True`.

A traveler sends a lead with just **name + phone + message**. No signup, no email
confirmation, no password. `InquiryCreateView` is one of exactly two `AllowAny` endpoints in
the project, and that is deliberate.

Why: signup is a wall placed directly in front of the one action that makes you money. Every
step between "I like this Omra package" and "the agency has my number" loses a share of
people. In a phone-first market where many users are on mobile data and not fluent in web
forms, that share is large.

So what is an account *for*, then? Three things worth returning for, none of them built:

- **A shortlist.** Omra is a comparison purchase; people look at ten offers over two weeks.
- **Inquiry history** — "which agencies did I contact?" `Lead.traveler` already stores the
  link and nothing reads it.
- **Reviewing** — a review needs an identity to be worth anything.

**An account is a reward for coming back, not a toll on arriving.**

---

## Identity: username, and the phone-first problem

`AbstractUser` makes `username` required and unique, and login goes through it. That is
Django's default and it is wrong for this market.

- **Travelers are phone-first.** Many Algerian users don't check email. Their phone number is
  their identity, and it's what the agency will actually call.
- **Agency staff are email-first.** It's a business account: shared context, password resets,
  invoices.

Neither of them thinks in usernames.

> [!warning] Honest state — `phone` is a plain, non-unique, optional field
> `phone = CharField(max_length=20, blank=True)` has no `unique=True` and no validator, and
> nothing anywhere sets it. Two accounts can hold the same number. It is not an identity, it's
> a note.
>
> The NestJS repo has nullable-but-unique `email` *and* `phone`, with a service-layer rule
> that at least one must be present, and login by either.
>
> The Django version of that is a custom `UserManager` plus an authentication backend, and
> `USERNAME_FIELD` pointing at something other than `username`. It's not hard, and — like
> `AUTH_USER_MODEL` itself — it is much easier before there are accounts than after.

When it is built, the phone must be **normalised during validation**, not at the point of
use. `0551 23 45 67`, `+213 551 234 567` and `00213551234567` are one person and must become
one string before any handler sees them, or `unique=True` protects nothing and you get several
accounts for one human. See the honest note in [[Validation at the Boundary]] — the current
validator rejects rather than normalises.

---

## Passwords

Never stored. Django stores a **PBKDF2 hash** by default — a one-way scramble, deliberately
slow, so that guessing billions of candidates is expensive.

`createsuperuser` and `LoginView` handle this for you and you should never touch it. Do not
hash a password with SHA-256 or MD5: they're fast, which is exactly the wrong property here.

Upgrading to Argon2id before launch is one setting and no migration — Django re-hashes each
user on their next successful login. Details and the exact setting are in
[[Authentication vs Authorization]].

---

## `is_staff` and `is_superuser`

Rihlati's own team: verifies agencies, moderates offers, resolves reports. These are **not**
agency roles — an agency owner is not staff, and staff are not members of any agency.

> [!danger] These fields must never appear in any serializer or form
> Not on signup, not on profile update, not on an "admins only" endpoint. It must be
> impossible to *send* them. Set them with `manage.py createsuperuser`, deliberately, for
> named people.
>
> One mass-assignment slip on `is_superuser` hands over the entire platform — every agency's
> client list at once. It is the highest-value target in the app, and the only real defence is
> that **no code path writes it from a request**. This is why every serializer here lists its
> fields by hand and none uses `"__all__"`. See [[Validation at the Boundary]].

There is a chicken-and-egg reason the first admin cannot come from an endpoint: an endpoint
that "only works while zero admins exist" is a race condition and a permanent liability in the
codebase. A shell command run by someone with server access is the honest version of the same
thing. See [[Accounts]].

Django reads these flags from the **database on every request**, which is a real advantage of
sessions over stateless tokens: revoking `is_superuser` bites on the next request rather than
whenever a token happens to expire.

> [!warning] Nothing an admin does is recorded
> Un-verifying an agency in `/admin` leaves a row in Django's own `LogEntry` table if it went
> through the admin — which is better than nothing and is not a real audit trail, because it
> only covers the admin site and it records the object, not the reason. See [[Audit Log]].

---

## `preferred_language`

```python
choices = [("fr", "Français"), ("ar", "العربية")]
```

Stored per user. It should determine the language of the interface *and* of any notification
SMS or email — the server can't infer a person's language from a request, which carries a
token and a body, not a person. Storing it is what makes an Arabic SMS possible at all.

Arabic is right-to-left, which affects **layout**, not just text: navigation, form alignment,
icons that point somewhere. That's why it's handled from the first template instead of
retrofitted — retrofitting RTL is a rewrite. See [[The Seven Rules]].

> [!warning] Honest state — nothing reads this field
> `LANGUAGE_CODE = "fr"` and every template string is a French literal. There is no
> `{% trans %}`, no `.po` files, no `LocaleMiddleware`, and no `dir="rtl"`. `Offer` has
> `title_fr` and `title_ar` columns, so the *data* is bilingual while the *interface* is not.
>
> This is the largest single gap between this repo and the NestJS one, and the one that gets
> most expensive to close later. See [[Templates and Pages]].

---

## Fields you might expect and won't find

- **No `role` column.** Roles live on `Membership`, because they're per-agency — the same
  person can be an owner at one and an agent at another.
- **`first_name` / `last_name` come from `AbstractUser` and shouldn't be used.** Algerian
  naming conventions don't map cleanly onto a Western first/last split, and nothing in the
  product needs them apart. `Lead.full_name` is one field for exactly this reason. They can't
  be removed from `AbstractUser` without abandoning it, so the rule is a convention, not a
  constraint.
- **No `phone_verified_at` / `email_verified_at`.** When these arrive they should be nullable
  **timestamps, not booleans** — you will want to know *when*, and a nullable timestamp
  carries both facts in one column. That's a small habit worth keeping everywhere: a boolean
  answers one question, a nullable timestamp answers two for the same storage.
- **No avatar.** When it comes, the client posts the **file**, never a URL. Letting a client
  write a URL into that column lets anyone point it at a server they control and learn the IP
  address of everyone who loads a page showing that avatar. Same reasoning as
  `Offer.cover_image_url`, which currently *does* accept a URL — see [[Image Uploads]].

---

## Open questions

- **Should login be by phone, email, or username?** Today it's username, which no real user
  will have. This is the single biggest usability gap on the accounts side, and it is much
  cheaper to change before there are accounts.
- **Do travelers need SMS OTP verification?** Right now, no — a guest inquiry is name +
  phone. It should stay that way until spam appears. Every SMS costs money and every OTP step
  loses real inquiries, so decide this *when* you see abuse, with data, not now.
- **Account deletion.** A traveler asks to be deleted. Their account goes — `Lead.traveler` is
  `SET_NULL`, so their inquiries survive with the name and number they typed. Is that right?
  It's what makes the agency's commercial record intact and what a deletion request arguably
  forbids. Worth a lawyer's view, not a guess.

---

Related: [[Data Model Overview]] · [[Agency]] · [[Lead]] · [[Multi-Tenancy]] ·
[[Authentication vs Authorization]] · [[Validation at the Boundary]] · [[Accounts]] ·
[[Audit Log]] · [[Templates and Pages]]
