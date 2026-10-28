# How to Study This Codebase

[[Start Here]] tells you **what to read**. This note tells you **how to study it** so it
actually sticks — and how to know when you genuinely understand something rather than just
recognising it.

## What you're up against

| | |
|---|---|
| Python, `apps/` + `config/` | ~6,900 lines |
| Django apps | 7 (`common`, `accounts`, `offers`, `leads`, `trips`, `reviews`, `pages`) |
| API operations | 56 |
| Database models | 18 |
| Tests | 59 |
| Templates | ~470 lines of HTML |
| Notes in this vault | 43 |

That is small enough to read all of, and you still shouldn't. Roughly 2,000 lines carry
every idea; the rest is those ideas repeated. This plan finds the 2,000.

> [!note] The numbers go stale, and that's fine
> They exist to size up the job, not to be precise. Recount whenever you want:
> `ls apps` (apps), `find apps config -name '*.py' | xargs wc -l` (lines),
> `.venv/bin/python manage.py test` (tests). For endpoints, open `/api/docs` and count —
> there is no grep for it, because the route table is generated.

---

## The one technique that matters: predict, then verify

The reason reading code feels productive but teaches little is that recognition feels like
understanding. You see `scoped(Offer.objects, agency_id)`, it makes sense, you move on — and
a week later you can't reconstruct why it isn't `Offer.objects.get(pk=...)`.

So: **before you open a file, write down what you expect to find in it.** One or two lines,
on paper or in a scratch note. Then open it. The gap between what you wrote and what's there
is the only part you're actually learning. Everything you predicted correctly, you already
knew.

Every session below has a **gate** — something you must be able to do from memory before
moving on. If you can't, don't push forward. Come back and ask me about the specific thing.
The gates are the point; the reading is just how you get there.

> [!tip] Keep a questions file
> Open a scratch note and put every "wait, why?" in it as it occurs, without stopping to
> resolve it. Bring me the list. Much better questions get asked mid-read — mid-read, you
> don't yet know which ones matter.

---

## Session 1 — Make it run, make it real (~60 min)

Studying a system you can't poke is reading, not learning. Everything after this session
depends on being able to check a claim against a running machine in thirty seconds.

Follow [[Local Setup]]. In short:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_preview
.venv/bin/python manage.py runserver
```

Then do four things, in order:

1. **Look at the actual data.** Open `/admin/` (make a superuser first with
   `manage.py createsuperuser`). Click through `Users`, `Agencies`, `Memberships`, `Offers`,
   `Leads`. Don't study — just see that rows are rows. Most database confusion is people
   reasoning about tables they have never looked at.
2. **Call a public endpoint.** `curl -s localhost:8000/api/offers` — works, no login.
3. **Call a protected one.** `curl -i localhost:8000/api/agencies/<some-id>/leads` and get a
   **401**. Good. That 401 is [[The Seven Rules]] rule 2 working, and nothing in
   `apps/leads/api.py` asked for it — see Session 3.
4. **Log in and retry.** `POST /api/auth/login` with a seeded account
   (`{"username":"karim","password":"preview-password"}`), take the `access` token, and retry
   step 3 with `-H "Authorization: Bearer <token>"`.

Then open **`/api/docs`** and leave the tab open for the rest of these sessions. It is the
generated OpenAPI browser and it is the single most useful URL in the project.

> **Gate:** you can list one seeded agency's leads over `curl`, and find those exact rows in
> `/admin/`. Two views, one truth.

---

## Session 2 — One request, all seven hops (~90 min)

This is the spine. Every other endpoint is this shape again. Learning one properly costs
sixty minutes instead of hours of drift.

Read [[The Seven Hops of a Request]] first, then trace
**`GET /api/agencies/{agency_id}/leads`** through the real files, in the order the request
actually visits them:

| # | File | What it decides |
|---|---|---|
| 1 | `config/settings.py` → `MIDDLEWARE` | what wraps every request; where the request id is born |
| 2 | `config/urls.py` | `/api/` goes to Ninja, everything else to `apps.pages` |
| 3 | `config/api.py` | `auth=API_AUTH` — the deny-by-default switch, set once |
| 4 | `apps/common/auth.py` | *are you anyone?* (bearer token or session cookie) |
| 5 | `apps/leads/api.py` → `require_membership(...)` | *are you anyone **in this agency**?* |
| 6 | `apps/leads/api.py` → `scoped(Lead.objects, agency_id)` | which rows can even exist for you |
| 7 | `apps/common/errors.py` | what the outside world is told when any of that fails |

Then trace a second one that is deliberately different: **`POST /api/inquiries`** in
`apps/leads/api.py`. It is `auth=None`, so hops 4 and 5 step aside and the `Strict` schema
becomes the *only* thing between the open internet and the database. Watch exactly where
validation happens. See [[Validation at the Boundary]].

> **Gate:** on paper, from memory, draw the seven hops and name the file that does each.
> Then answer this: *`POST /api/inquiries` has no membership check — so what stops someone
> filing a lead against an agency that never published that offer?* The answer is one
> queryset, and it is in the handler.

---

## Session 3 — The security spine, by breaking it (~90 min)

The most valuable session here. Do not skip it, and do not do it by reading.

First read the three files [[Start Here]] names, plus [[Multi-Tenancy]] and
[[Authentication vs Authorization]].

Then break things on purpose. Make a scratch branch first so you can't lose anything:

```bash
git checkout -b study/break-things
```

Run each break, watch what goes red, then `git checkout .` and do the next one.

```bash
# just the isolation suite
.venv/bin/python manage.py test apps.offers.tests.TenantIsolationTests
```

| Break this | Predict first, then run | What it teaches |
|---|---|---|
| Change `scoped(qs, agency_id)` to return `qs` unchanged in `apps/common/tenancy.py` | which tests go red, and how many? | that scoping is load-bearing, not decoration |
| Delete the `require_membership(...)` call in one handler in `apps/leads/api.py` | does *anything* still stop Agency B? | membership check and query scoping are two layers, not one |
| Make `get_scoped_object` raise `Forbidden` instead of `Http404` | one test fails — which, and why does it care? | why a 403 leaks the existence of a record |
| Add `auth=None` to a protected route | which test notices? | the public list is pinned, not trusted to memory |
| Remove `extra="forbid"` from `Strict` in `apps/common/schemas.py` | what now silently succeeds? | why a typo'd field name is a security problem |

That fourth one is worth sitting with. Nothing in `apps/leads/api.py` says "make this route
private". Routes are private *because nobody said otherwise* — `auth=API_AUTH` on the
`NinjaAPI` object in `config/api.py`. That inversion is the single design decision that keeps
this app from leaking, and it lives in a file with no business logic in it at all.

Then confirm the pin catches you:

```bash
.venv/bin/python manage.py test apps.common.tests_house_rules
```

> **Gate:** explain out loud, without looking, why a *missing* lead and *another agency's*
> lead both return 404 — and what an attacker learns if one of them returns 403. Then
> explain why putting another agency's id in the **path** is a 403 instead, which is the
> deliberate exception.

Then delete the branch: `git checkout main && git branch -D study/break-things`.

---

## Session 4 — The database (~90 min)

The hardest part to change later, so it's worth real time. But 21 models read top to bottom
is a waste — you'd remember none of it.

1. Read [[Data Model Overview]] for the map.
2. Read **only six models**, in `apps/accounts/models.py`, `apps/offers/models.py` and
   `apps/leads/models.py`: `User`, `Agency`, `Membership`, `Offer`, `Lead`, `Client`. Their
   notes are [[User]] · [[Agency]] · [[Offer]] · [[Lead]] · [[Client]].
3. Close the files and **draw the relations from memory.** Then check.

Ask yourself the questions the code answers, before reading the answer. Why is `Membership` a
table instead of a `user.agency_id` column? Why does `Lead` copy the traveler's name instead
of linking to a `User`? Why is `Agency.is_verified` a `@property` and not a column? Most take
ten seconds. The ones you can't answer are the question list for me.

Then the design question that generalises past this app: open `Offer` and find the
`attributes` JSON column sitting next to real columns like `price_centimes`. Ask yourself why
the split falls where it does. The rule of thumb — *if you filter or sort by it, it's a
column; if you only ever display it, it can be JSON* — is one you'll reuse in every schema
you ever design. See [[Indexes and Why Queries Get Slow]] for why filtering on JSON hurts.

Also read [[Migrations]] and run `ls apps/*/migrations/`. That list *is* the history of this
schema.

> **Gate:** I say "agencies want to offer early-bird discounts." You tell me: new column, new
> table, or JSON? And why. There's a defensible answer either way — I'm testing whether you
> can argue it, not whether you match me.

---

## Session 5 — The apps, differences only (~60 min)

You now know the shape every app repeats. So skim for what's *unusual* about each one and
ignore everything that's the pattern from Session 2.

| App | The thing that's different |
|---|---|
| `common` | The only app with no models and no URLs. Everything else imports *it*. |
| `accounts` | The only app holding server-side auth state — refresh token rotation is how a stolen session gets caught. [[Auth Flow]] |
| `offers` | The biggest file, ~930 lines. Search, the status machine, and the programme. [[Search and Filters]] · [[Trip Programme]] |
| `leads` | The CRM. Also the only place with a **consent trail**, which is a legal record, not a feature. [[Lead]] |
| `trips` | Travellers have **no account**. Access is a secret code in the URL. [[Trip Manifest]] |
| `reviews` | The interesting question isn't storage, it's *who is allowed to leave one*. [[Agency Ratings]] |
| `pages` | The second door onto the same models. Everything here must re-derive the same permissions. [[One Rule, Two Entry Points]] |

Two rows are worth more than the rest.

**The `leads` row** is the one people get wrong. Tenant isolation stops Agency B; **role
checks inside Agency A are a second, separate problem** with a separate answer
(`Membership.RANK`). Session 3 covered the first. This is the second.

**The `trips` row** is worth reading properly rather than skimming, because it is the one
place where the "everything is authenticated" rule is deliberately relaxed:
`GET /api/my-trip/{code}` is public, and the 128-bit code in the URL *is* the credential. Ask
yourself what is left protecting the data once the session is gone — and then check what that
endpoint actually returns, and what it very deliberately does not (the passenger list, the
CRM notes).

> **Gate:** one sentence per app on what's unusual about it, from memory. For `trips`, two:
> what a code-holder can see, and what stops them seeing anything else.

---

## Session 6 — The tests are the real specification (~45 min)

59 tests, most of them named as English sentences. Read *only the names*, all of them, in one
sitting:

```bash
grep -rhE "^\s*def test_" apps/ | sed 's/def //;s/(self)://;s/_/ /g'
```

This is the fastest description of what the app promises that exists anywhere — faster than
the code, and unlike a document it cannot drift, because a false line turns CI red.

Read them looking for rules you didn't know were there. There are several. When one surprises
you, open the test and read the body: it shows you the exact request that proves the rule.

Pay particular attention to `apps/common/tests_house_rules.py`. Those tests don't test
behaviour — they test *the source code itself*, with Python's `ast` module. Each one encodes
a bug that actually happened. That file is the Django answer to the custom ESLint rules in
the NestJS repo, and the reasoning for why it's a test instead of a linter plugin is in its
docstring.

> **Gate:** find three business rules you didn't know the app enforced. Bring them to me and
> we'll check whether each was deliberate or accidental. Some will be accidental — that's a
> useful finding, not a failure.

---

## Session 7 — Prove it: build one yourself (~2–3 h)

Reading has a ceiling. Pick something genuinely small — *"an agency owner can archive a
lead"*, or *"list the tags used by an agency"* — and write it yourself, end to end.

The checklist to grade yourself against, **after** you've written it:

- [ ] a `Strict` schema for the input, with no server-owned field in it
- [ ] `require_membership(...)` with the right minimum role
- [ ] every query through `scoped(...)`
- [ ] a tenant-isolation test: create as Agency A, act as Agency B, assert 404
- [ ] an `audit(...)` call inside the same `transaction.atomic()` as the change
- [ ] an entry in [[API Endpoints]]
- [ ] `./scripts/check.sh` green

> **Gate:** `./scripts/check.sh` passes — lint, format, system checks, migrations, tests —
> including a tenant-isolation test *you* wrote, which fails if you remove the scoping.

That's the finish line. The point at which you can read any endpoint here and predict what
it does before reading it is what "understanding a codebase" actually means.

---

## What to deliberately skip

Skipping most of this is what makes the plan fit in ten hours.

- **`apps/*/migrations/`** — read the *newest* one when the schema changes, never the back
  catalogue.
- **`templates/`** — 470 lines of HTML with Tailwind classes. Zero backend lessons.
- **`static/app.css`** — generated. Not source.
- **`.venv/`, `node_modules/`, `__pycache__/`** — not source.
- **Django's own internals.** When you want to know what `get_object_or_404` does, read its
  four lines in the Django source *once*, then stop. Reading a framework's implementation is
  a fine way to spend a day learning nothing about your own app.

If you catch yourself reading a template, you've drifted off the plan.

---

## Pacing

Seven sessions, roughly eight to ten hours. One session every day or two is far better than
three in a weekend — the gaps are where predictions get stronger, and a gate you can pass
*after a night's sleep* is a gate you actually passed.

Nothing here has to be done in order except sessions 1 and 2. Those two are load-bearing:
everything later assumes you can run the thing, and that you know the seven hops.

## Once you're through it

The code will keep moving, so understanding is a thing you maintain, not a thing you finish:

- **Read every migration as it's added.** Each new one is a schema change you should be able
  to explain. This is the cheapest habit here and the highest value.
- **Read the name of any test I add.** If a new test's name doesn't obviously match a rule
  you'd agree with, that's a business decision I made that should have been yours.
- **When I say a task is done, pick one claim and check it.** Not all of them. One. It keeps
  both of us honest, and it's how you'll learn to review work rather than accept it.

---

## Open questions — yours to decide

- **Do you want Session 7's endpoint real or throwaway?** A real one goes on `main` and
  you'll maintain it. A throwaway is lower stakes and gets deleted. I'd suggest real, small,
  boring — but it's your codebase to keep clean.
- **Do you want me to stop explaining as I build**, now that this study track exists? These
  double up. My default stays what `CLAUDE.md` describes — narrate each layer as I write it —
  unless you'd rather I build quietly and you catch up here on your own schedule.
- **Should the gates be checked out loud with me?** I can quiz you on one rather than you
  self-marking. Self-marking is faster; being quizzed catches things you think you know.

---

Related: [[Start Here]] · [[Local Setup]] · [[The Seven Hops of a Request]] ·
[[Multi-Tenancy]] · [[Data Model Overview]] · [[Milestone Plan]]
