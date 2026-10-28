#!/usr/bin/env bash
#
# One command to run before every commit — CLAUDE.md rule #7.
#
# This is the Django counterpart of `npm run check` in the NestJS repo, and CI
# runs exactly this script rather than a parallel list of steps. Two lists of
# checks drift, and the one that drifts is always the local one, so "it passed
# on my machine" stops meaning anything.
#
#   ./scripts/check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

PY=".venv/bin/python"
RUFF=".venv/bin/ruff"
[ -x "$PY" ] || PY="python3"
[ -x "$RUFF" ] || RUFF="ruff"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "Lint"
"$RUFF" check .

step "Format"
"$RUFF" format --check .

step "Django system checks"
# Catches a misconfigured setting, a broken URLconf, or a model that will not
# make a table — the class of error that otherwise shows up as a 500 at runtime.
"$PY" manage.py check

step "Missing migrations"
# Rule #7: a model change with no migration works fine locally, because your
# database already has the column. It fails on a fresh deploy, which is the
# worst possible place to find out.
"$PY" manage.py makemigrations --check --dry-run

step "Tests"
# LOG_LEVEL=ERROR because the request logger is deliberately chatty and a
# thousand JSON lines between you and the one failure is how a red build gets
# ignored. The logging config itself is covered by tests_observability.py.
LOG_LEVEL=ERROR "$PY" manage.py test

printf '\n\033[32m✓ all checks passed\033[0m\n'
