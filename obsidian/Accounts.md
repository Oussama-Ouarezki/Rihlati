# Rihlati Test Accounts

| Role                                             | Email                   | Password               |
| ------------------------------------------------ | ----------------------- | ---------------------- |
| **Platform Admin**                               | `admin@rihlati.test`    | `rihlati-dev-password` |
| **Agency Owner (Voyages El Baraka – Free Plan)** | `baraka@rihlati.test`   | `rihlati-dev-password` |
| **Agency Owner (Nour Travel – Pro Plan)**        | `nour@rihlati.test`     | `rihlati-dev-password` |
| **Agency Agent**                                 | `agent@rihlati.test`    | `rihlati-dev-password` |
| **Traveler**                                     | `voyageur@rihlati.test` | `rihlati-dev-password` |

All of the above are created by `npm run db:seed`, and all of them are fictional. Never seed a
real agency or a real phone number — a dev database gets copied around, and a copy is a leak.

---

## Making someone a platform admin

Not an endpoint. A command:

```bash
npm run admin:list                          # who has it today
npm run admin:grant  -- someone@rihlati.dz  # they must already have an account
npm run admin:revoke -- someone@rihlati.dz
```

**Why a CLI and not a page.** Chicken and egg: an endpoint that promotes someone to platform
admin would itself have to be protected by platform admin, so the *first* one could never be
created through it. Something outside the API has to bootstrap it.

The obvious alternative — an endpoint that works only while zero admins exist — is worse. It is
a public "make me god" route that is armed on every fresh deployment, and a race between
deploying and registering hands the platform to whoever wins it. A CLI moves the boundary to
something an attacker on the internet does not have: shell access and the database credentials.
If they already have those, this script is not what you lost.

Two things worth knowing:

- **It takes effect immediately.** `JwtAuthGuard` reads `isPlatformAdmin` from the database on
  every request, not from the token's `adm` claim — so revoking it does not wait 15 minutes for
  an access token to expire. There is a test for exactly that.
- **It writes an audit row** (`user.platform_admin_granted`), with `actorUserId: null`, because
  the script genuinely does not know who was at the keyboard — only that they had shell access.
  Admitting that is better than attributing it to the promoted account.

A platform admin can read **every agency** on the platform: their RC, NIF, licence and the
owner's phone number. Grant it the way you would hand over a key, not the way you would tick a
checkbox. See [[Agency Verification]] and [[API Endpoints]].
