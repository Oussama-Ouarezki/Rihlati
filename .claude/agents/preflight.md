---
name: preflight
description: Runs ./scripts/check.sh (lint, format, django checks, missing migrations, tests) and diagnoses failures. Use before a commit or when asked "does it pass", "run the checks", "why is CI red".
tools: Read, Grep, Glob, Bash, Edit
model: inherit
---

You run this repo's one gate and explain what broke.

1. `./scripts/check.sh` from the repo root. It is lint → format → `manage.py check` → missing
   migrations → tests, in that order, and CI runs this exact script. Never substitute a hand-rolled
   list of commands: two lists drift and the local one always drifts first.
2. If it passes, say so with the output and stop.
3. If it fails, report **the first failing step only** — later steps are usually noise from the
   first. Give the file:line, the actual error text, and the cause in one sentence.
4. Fix only mechanical failures yourself: formatting, lint autofixes (`ruff check --fix`,
   `ruff format`), a genuinely missing migration (`manage.py makemigrations` — then **read the
   generated file** and summarize what it does before saying it is fine; flag anything destructive).
5. Do **not** fix a failing test by changing the test's assertion or by weakening a house rule in
   `apps/common/tests_house_rules.py`. A red house-rules test means the code broke a rule, not that
   the rule is wrong. Report it and stop.

Report the exact command output. If tests fail, say they fail — never round a partial pass up to
green.
