# How to Study This Codebase

[[Start Here]] tells you **what to read**. This note tells you **how to study it** so it
actually sticks — and how to know when you genuinely understand it rather than just
recognising it.

## What you're up against

| | |
|---|---|
| TypeScript, all apps | ~27,000 lines |
| The backend — the part that matters to you | ~9,000 lines, 11 modules |
| Endpoints | 67 |
| Database models | 22, in ~1,000 lines of schema |
| Integration tests | 151, against real Postgres |
| Notes in this vault | 43 |

You cannot read 27,000 lines. You don't need to. Roughly 6,000 lines carry all the ideas;
the rest is those same ideas repeated. This plan finds the 6,000.

> [!note] These numbers go stale, and that is fine
> They are here to size up the job, not to be precise. Recount them whenever you want:
> `ls apps/api/src/modules` (modules), `grep -rc '@Get(\|@Post(\|@Patch(\|@Delete('
> apps/api/src` (endpoints), `grep -c '^model' apps/api/prisma/schema.prisma` (models).

---

## The one technique that matters: predict, then verify

The reason reading code feels productive but teaches little is that recognition feels like
understanding. You read `findFirst({ where: { id, agencyId } })`, it makes sense, you move
on — and a week later you can't reconstruct why it isn't `findUnique`.

So: **before you open a file, write down what you expect to find in it.** One or two lines
on paper or in a scratch note. Then open it. The gap between what you wrote and what's
there is the only part you're actually learning. Everything you predicted correctly, you
already knew.

Every session below has a **gate** — something you must be able to do from memory before
moving on. If you can't, don't push forward. Come back and ask me about that specific thing.
The gates are the point; the reading is just how you get there.

> [!tip] Keep a questions file
> Open a scratch note and put every "wait, why?" in it as it occurs, without stopping to
> resolve it. Bring me the list at the end of a session. Questions asked in a batch after
> reading are much better than questions asked mid-read — mid-read, you don't yet know
> which ones matter.

---

## Session 1 — Make it run, make it real (~90 min)

Studying a system you can't poke is reading, not learning. Everything after this session
depends on being able to check a claim against a running machine in thirty seconds.

Follow [[Local Setup]]. In short:

```bash
npm run db:up        # Postgres in Docker
npm run db:migrate   # build the tables
npm run db:seed      # fake agencies, offers, leads
npm run dev:api      # backend on :4000, routes prefixed /v1
npm run dev:web      # site on :3000
```

Then do these four things, in this order:

1. **Look at the actual data.** `npm run db:studio` opens a table browser. Click through
   `User`, `Agency`, `Membership`, `Offer`, `Lead`. Don't study it — just see that rows are
   rows. Most database confusion is people reasoning about tables they've never looked at.
2. **Call a public endpoint.** `curl localhost:4000/v1/offers` — works, no login.
3. **Call a protected one.** `curl -i localhost:4000/v1/agencies/<some-id>/leads` — you get
   a 401. Good. That 401 is [[The Seven Rules]] rule 2 working.
4. **Log in and retry.** Log in through the site, or `POST /v1/auth/login` with a seeded
   account (body: `{"identifier": "...", "password": "..."}` — `identifier` because login
   accepts email or phone), take the `accessToken`, and retry step 3 with
   `-H "Authorization: Bearer <token>"`.

> **Gate:** you can list one seeded agency's leads over `curl`, and then find those exact
> same rows in Studio. Two views of one truth.

---

## Session 2 — One request, all seven hops (~90 min)

This is the spine. Every other endpoint is this shape again. Learn one properly and the
other 60 cost you minutes each instead of hours.

Read [[The Seven Hops of a Request]] first, then trace **`GET /agencies/:agencyId/leads`**
through the real files, in the order the request actually visits them:

| # | File | What it decides |
|---|---|---|
| 1 | `src/main.ts` | the app exists, and what wraps every request |
| 2 | `src/app.module.ts` | which guards are global — the deny-by-default switch |
| 3 | `src/common/auth/jwt-auth.guard.ts` | *are you anyone?* |
| 4 | `src/common/auth/agency-membership.guard.ts` | *are you anyone **in this agency**?* |
| 5 | `src/modules/leads/leads.controller.ts` | the door: shape in, shape out |
| 6 | `src/modules/leads/leads.service.ts` | the brain: the actual rule |
| 7 | `src/common/prisma/prisma.service.ts` | the hands: SQL |

Then the return path: the mapper that decides what leaves, and
`src/common/filters/all-exceptions.filter.ts` that turns a thrown error into a typed
response.

Now do it a second time with a **write** that comes from a stranger: **`POST /inquiries`**
(`leads.controller.ts:46`). It's deliberately different — it's `@Public()`, so the guards
step aside and the Zod schema becomes the *only* thing between the internet and your
database. Watch where the validation happens. See [[Validation at the Boundary]].

> **Gate:** on paper, from memory, draw the seven hops and name the file that does each.
> Then answer: *on `POST /inquiries` there is no membership guard — so what stops someone
> filing a lead against an agency that doesn't exist?* Find the answer in the service.

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
# run just the isolation suite
cd apps/api && npx vitest run test/tenant-isolation.e2e.test.ts
```

| Break this | Predict first, then run | What it teaches |
|---|---|---|
| Delete `agencyId` from one `where` clause in `leads.service.ts` | which tests go red? how many? | that the scoping is load-bearing, not decoration |
| Remove the guard from `leads.controller.ts` | does *anything* still stop Agency B? | guards and query scoping are two layers, not one |
| Change a `404` to a `403` for a forbidden lead | one test fails — which, and why does it care? | why a 403 leaks the existence of a record |
| Delete a `@Public()` from `auth.controller.ts` | which flow breaks? | that "public" is an exception you grant, never a default |
| Delete `@PlatformAdminOnly()` from `admin-agencies.controller.ts` | who can now read every agency's RC, NIF and owner's phone? | that one line is the *entire* protection on the only cross-tenant surface — run `npx vitest run test/admin-agencies.e2e.test.ts` |

The last one is worth sitting with. Nothing here says "make this route private." Routes are
private *because nobody said otherwise*. That inversion is the single design decision that
keeps this app from leaking, and it lives in `app.module.ts`, not in any controller.

> **Gate:** explain out loud, without looking, why a missing lead and another agency's lead
> both return 404 — and what an attacker learns if one of them returns 403. Then delete the
> branch: `git checkout main && git branch -D study/break-things`.

---

## Session 4 — The database (~90 min)

The hardest part to change later, so it's worth real time. But 25 models read top to bottom
is a waste — you'd remember none of it.

1. Read [[Data Model Overview]] for the map.
2. In `schema.prisma`, read **only five models**: `User`, `Agency`, `Membership`, `Offer`,
   `Lead`. Their notes are [[User]] · [[Agency]] · [[Offer]] · [[Lead]].
3. Close the file and **draw the relations from memory.** Boxes and arrows. Where does
   `Membership` sit, and why does it exist instead of a `user.agencyId` column?
4. Then skim the other 20 models and write **one sentence each** on why it exists. Most take
   ten seconds. The ones you can't answer are your question list for me.

Then the design question that generalises past this app: open `Offer` and find the
`attributes` JSON column sitting next to real columns like `priceCentimes`. Ask yourself why
the split falls where it does. The rule of thumb — *if you filter or sort by it, it's a
column; if you only ever display it, it can be JSON* — is one you'll reuse in every schema
you ever design. See [[Indexes and Why Queries Get Slow]] for why filtering on JSON hurts.

Also read [[Migrations]] and run `ls apps/api/prisma/migrations`. Ten directories, in order.
That list *is* the history of this schema.

> **Gate:** I say "agencies want to offer early-bird discounts." You tell me: new column, new
> table, or JSON? And why. There's a defensible answer either way — I'm testing whether you
> can argue it, not whether you match me.

---

## Session 5 — The modules, for their differences only (~60 min)

You now know the shape every module repeats. So skim for what's *unusual* about each one and
ignore everything that's the pattern from Session 2.

| Module | The thing that's different |
|---|---|
| `auth` | the only module holding server-side state (refresh tokens) — and rotation is how a stolen session gets caught. [[Auth Flow]] |
| `offers` | biggest service, 750 lines. Search, filters, and a status machine. [[Search and Filters]] |
| `leads` | the CRM. Roles *narrow what you see* inside one agency — an agent sees fewer leads than an owner |
| `reservations` · `milestones` · `trips` | travellers have **no account**. Access is a secret code in a URL. [[Trip Programme]] |
| `tracked-links` | attribution — which link produced which lead. [[Tracked Links]] |
| `uploads` | files never touch your server's disk unexamined. [[Image Uploads]] |
| `agencies` | onboarding — an agency creating itself, and asking to be reviewed |
| `admin` | the exception to everything: **not scoped to a tenant at all**. [[Agency Verification]] |

Two rows are worth more than the rest.

**The `leads` row** is the one people get wrong. Tenant isolation stops Agency B; **role checks
inside Agency A are a second, separate problem** with a separate answer. Session 3 covered
the first. This is the second.

**The `admin` row** is worth reading properly rather than skimming, because it is the only
place in the codebase where the rule from Session 3 is deliberately broken. Every other query
is scoped by `agencyId`; these are not, because Rihlati staff review agencies they are by
definition not members of. Ask yourself what is left protecting the data once that scoping is
gone — the answer is one boolean, and it is why that module's tests are mostly about who gets
refused rather than what happens when it works.

> **Gate:** one sentence per module on what's unusual about it, from memory. For `admin`,
> two: what it can see, and what stops everyone else seeing it.

---

## Session 6 — The tests are the real specification (~60 min)

129 tests, written as English sentences. Read *only the names*, all of them, in one sitting:

```bash
grep -hE "^\s*(it|test)\(" apps/api/test/*.test.ts
```

This is the fastest description of what this app promises that exists anywhere — faster than
the code, and unlike a document it cannot drift, because a false line turns CI red.

Read them looking for rules you didn't know were there. There will be several. When one
surprises you, open that test and read the body: it shows you the exact request that proves
the rule.

> **Gate:** find three business rules you didn't know the app enforced. Bring them to me and
> we'll check whether each is deliberate or accidental. Some will be accidental — that's a
> useful finding, not a failure.

---

## Session 7 — Prove it: build one yourself (~2–3 h)

Reading has a ceiling. Pick something genuinely small — *"an agency owner can archive a
lead"*, or *"list the tags used by this agency"* — and write it yourself, end to end.

Use the `/new-endpoint` skill as a **checklist to grade yourself against, after** you've
written it. Not as a generator. The gap between your version and its checklist is your real
score for the previous six sessions.

> **Gate:** `npm run check` is green — build, typecheck, lint, and tests — including a
> tenant-isolation test *you* wrote, that fails when you remove the scoping.

That's the finish line. At that point you can read any endpoint here and predict what it
does before reading it, which is what "understanding a codebase" actually means.

---

## What to deliberately skip

Skipping is most of what makes this fit in ten hours.

- **`apps/web/src/components/ui/`** — shadcn components, generated, not yours. Zero lessons.
- **`apps/web/src/components/roadmap/`** — SVG path maths for the trip map. Clever, irrelevant.
- **`node_modules/`, `.next/`, `dist/`, `package-lock.json`** — not source.
- **The web app in general** — you decided the frontend is vibe-coded and the backend is
  yours. Honour that. Learn one thing only: `apps/web/src/lib/*-actions.ts` is where the
  site calls the API. Read one of them, understand that the browser never talks to the
  backend directly, and move on. [[Web App]] covers the rest if you ever want it.

If you catch yourself reading a React component, you've drifted off the plan.

---

## Pacing

Seven sessions, roughly nine to eleven hours. One session every day or two is far better
than three in a weekend — the gaps are when the predictions get stronger, and a gate you
can pass *after a night's sleep* is a gate you actually passed.

Nothing here has to be done in order except sessions 1 and 2. Those two are load-bearing:
everything later assumes you can run the thing and that you know the seven hops.

## Once you're through it

The code will keep moving, so understanding is a thing you maintain, not a thing you finish:

- **Read every migration as it's added.** Ten now; each new one is a schema change you
  should be able to explain. This is the cheapest habit here and the highest value.
- **Read the `it(...)` name of any test I add.** If a new test's name doesn't obviously match
  a rule you'd agree with, that's a business decision I made that should have been yours.
- **When I say a task is done, pick one claim and check it.** Not all of them. One. It keeps
  both of us honest, and it's how you'll learn to review work rather than accept it.

---

## Open questions — yours to decide

- **Do you want Session 7's endpoint to be real or throwaway?** A real one goes on `main` and
  you'll maintain it. A throwaway is lower stakes and gets deleted. I'd suggest real, small,
  and boring — but it's your codebase to keep clean.
- **Do you want me to stop explaining as I build**, now that a study track exists? These can
  double up. My default stays as `CLAUDE.md` describes — narrate each layer as I write it —
  unless you'd rather I build quietly and you catch up here on your own schedule.
- **Should the gates be checked out loud with me?** I can quiz you on each one rather than
  you self-marking. Self-marking is faster; being quizzed catches the things you think you
  know. Say which you want.
