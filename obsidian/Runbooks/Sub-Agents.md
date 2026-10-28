# Sub-Agents

Four named agents that do the repetitive, mechanical work of this repo — the security sweep, the
tenant-isolation test, the pre-commit check, and keeping this vault true.

They live in `.claude/agents/` as one Markdown file each. That folder *is* the agent: the `/agents`
command in Claude Code is a menu that writes those same files, so there is nothing else to create.

> [!tip] The one thing to take from this note
> A sub-agent is **a fresh context with a narrow job**, not a personality. It reads what it needs,
> reports a conclusion, and is thrown away — the hundreds of grep results it waded through never
> enter your conversation. That is the entire benefit, and it is also the entire limitation:
> **it cannot see anything you have said in the main thread.** Tell it what it needs to know.

---

## Why they exist at all

Two reasons, and the second matters more.

**Context.** A security sweep greps thousands of lines to produce a fifteen-line report. Done in the
main conversation, all of that noise sits in the window forever, pushing out the things you actually
want remembered. Done in a sub-agent, only the report comes back.

**Consistency.** The instructions in a `.md` agent file run identically every time. "Run a security
audit" typed fresh each launch produces a different audit each launch — you would eventually forget
the git-history scan, because you forgot it last time too. The file does not forget. This is the
same reasoning as `./scripts/check.sh` versus a remembered list of commands, and the same reasoning
as [[The Seven Rules]] being a file rather than a good intention.

> [!warning] What they are not
> They are not schedulers. **Nothing runs an agent automatically at ship time.** Either the main
> thread decides your request matches an agent's `description`, or you name it. If you want
> something that genuinely cannot be skipped, that is a **hook** — see the last section.

---

## The four agents

| Agent | Job | Edits files? |
|---|---|---|
| `security-audit` | The pre-ship security sweep, structured as the seven rules | **No** — reports only |
| `tenant-isolation-test` | The Agency-B-gets-404 test for a new resource | Yes, tests only |
| `preflight` | Runs `./scripts/check.sh` and explains the first failure | Yes, mechanical fixes only |
| `vault-sync` | Makes this vault true again after a code change | Yes, notes only |

### How to call one

Two ways, and you should mostly use the second.

**Automatic.** The main thread reads each agent's `description` field and delegates when your
request matches it. "Audit this before I deploy" will usually reach `security-audit` on its own.
Usually. It is a judgement, not a rule.

**Explicit**, which never misfires:

```
use the security-audit agent on the leads app
have tenant-isolation-test cover the new trips endpoint
run preflight
vault-sync the change I just made to Offer
```

> [!warning] Give it the context it cannot have
> "Audit it" means nothing to a fresh agent — *it* is a pronoun pointing at a conversation the agent
> never read. Name the app, the endpoint, or the files that changed. A vague brief produces a vague
> report, and a vague security report is worse than none because it feels like the box got ticked.

---

## `security-audit` — the one that matters before launch

Read-only by design. It never edits, so it can never "fix" a finding by weakening the check that
found it.

It runs the five passes below **in the order of [[The Seven Rules]]**, and for each one it reads the
rule's section in that note before deciding what counts as a violation. That is deliberate: the
rules note explains *why* a thing is a finding, including the cases where the obvious-looking fix is
the wrong one. An auditor that only knows "rate limit the login route" will happily recommend
account lockout.

| Pass | Rule | What a finding looks like |
|---|---|---|
| 1 — Rate limiting | 2 | a route with `auth=None` and no `throttle=[…]` |
| 2 — Hardcoded secrets | 1 | a literal key in source or anywhere in git history |
| 3 — Exposed config | 1 | a secret reaching a template context or a tracked file |
| 4 — Input validation | — | an input schema not inheriting `Strict`; an unbounded field |
| 5 — Isolation & authz | 3 | an unscoped read on a tenant model; a handler that never gates |

It finishes by running the house-rules tests, because those are the machine-checkable half of the
same list, and it reports what it **could not** check as loudly as what it found.

> [!danger] An audit that returns "no findings" is not the same as "secure"
> Three of the seven rules cannot be verified by reading this repository at all. Rule 5 has no
> backup to test, rule 6 has no payment code yet, and rule 7's browser layer does not exist — see
> the status table at the end of [[The Seven Rules]] and [[Known Gaps]]. The agent is told to say so
> rather than return a clean bill of health. **A green audit is evidence about the code, not about
> the system.**

---

## `tenant-isolation-test` — the test rule 3 demands

[[Multi-Tenancy]] says every tenant-scoped resource needs a test where Agency B asks for Agency A's
row and receives `404`. The shape is identical every time, which is exactly what makes it a good
delegation and a bad thing to write by hand at 11pm.

Give it the app and the endpoint. It reads the existing tests in `apps/offers/tests.py` first so the
new ones match the house style, covers read/update/delete/list plus the anonymous and wrong-role
cases, then runs the app's suite and reports the real output.

> [!tip] It is told to distrust a first-run pass
> A test that passes immediately might be a good test, or might be asserting nothing — the fixture
> could belong to the wrong agency, or the request could be authenticating as the wrong user. The
> agent's instructions require it to prove the test *fails* when the scoping is temporarily removed.
> A test that would pass against a broken implementation is worse than no test, because it buys
> confidence you have not earned.

---

## `preflight` — the gate before a commit

Runs `./scripts/check.sh` — lint, format, Django system checks, missing migrations, tests — and
reports **the first failing step only**, because the later failures are usually the first one's
echo.

It is allowed to fix mechanical things: formatting, `ruff --fix`, a genuinely missing migration
(reading the generated file and telling you what it does — see [[Migrations]]).

> [!danger] It is forbidden from doing the tempting thing
> It may not make a failing test pass by editing the assertion, and it may not weaken a rule in
> `apps/common/tests_house_rules.py`. **A red house-rules test means the code broke a rule, not that
> the rule is inconvenient.** This instruction exists because deleting the check is always the
> fastest way to a green build, and an AI optimising for a green build will find it.

---

## `vault-sync` — keeping this file honest

Vault notes rot the moment code changes without them, and a vault that is 90% true is worse than no
vault, because you stop being able to tell which 10% is lying to you.

Give it the files that changed; it maps them to the right note (`models.py` → [[Data Model Overview]],
a business rule → the `Backend/` note, an endpoint → [[API Endpoints]], a real decision →
[[Decision Log]]) and rewrites the affected sections in the house voice.

It carries the vault's own writing rules: explain *why* not *what*, open questions belong to you and
must never be invented, record the alternative that lost, never write a real phone number, and leave
**Designed, not built here** banners exactly where they are.

> [!info] Still your job, not its
> It cannot answer a business question, and it is instructed not to try. When a change raises one —
> what should the quota be, what happens to a lead after 90 days — it writes the question into the
> note's open-questions section and leaves it for you. See [[Decisions You Must Make]].

---

## When you want something that cannot be skipped

An agent runs when it is invoked. A **hook** runs because the harness runs it, with no model in the
loop deciding whether it is warranted. Hooks are configured in `.claude/settings.local.json`.

| You want | Use |
|---|---|
| The full check before every commit | a hook wrapping `./scripts/check.sh` |
| A security sweep before a launch | `security-audit`, invoked by you |
| The isolation test for a new endpoint | `tenant-isolation-test`, or write it inline |

The split is about cost and frequency. `preflight` is seconds and should be automatic. The security
sweep is minutes and reads half the repo — run it before a deploy and after any change to auth or
payments, not on every keystroke. An expensive check that fires constantly is a check that gets
turned off, which is the same failure as branch protection nobody enabled, described at the end of
[[The Seven Rules]].

---

## Open questions — yours

- **Do you want the `preflight` hook wired now?** It would run the full suite on every turn,
  including turns where you only asked a question. Scoping it to a pre-commit trigger is the usual
  answer, but this repo has no git history yet, so there is nothing to hook onto until it does.
- **Should `security-audit` gate a deploy, or only advise?** It has no deploy pipeline to block
  today. Once there is one, "the audit must be clean" is either a rule or a suggestion, and the
  difference shows up on the day it is inconvenient.
- **Does the vault get a note per agent, or stays this one page?** One page is currently honest
  because the agents are small. If any of them grows past a screen, it has earned its own note.

---

Related: [[The Seven Rules]] · [[Multi-Tenancy]] · [[End-to-End Testing]] · [[Known Gaps]] ·
[[Local Setup]] · [[Start Here]]
