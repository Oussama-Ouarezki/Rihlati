#!/usr/bin/env bash
#
# RESTORE REHEARSAL — CLAUDE.md rule #5
#
# "Backups are only real once restored." This script proves the dump → restore
# → verify procedure end to end, into a SCRATCH database, and times it.
#
# The step most people skip is step 4: it doesn't just check that rows came
# back, it points the real API at the restored database and confirms an agency
# can log in, sees its own leads, and CANNOT see another agency's. A dump that
# restores cleanly but breaks tenant isolation is a restore that failed.
#
# Usage:  ./scripts/restore-rehearsal.sh
# Safe:   only ever writes to a database named *_restore_test, and drops it.

set -euo pipefail

CONTAINER="${CONTAINER:-rihlati_db}"
DB_USER="${DB_USER:-rihlati}"
SOURCE_DB="${SOURCE_DB:-rihlati}"
SCRATCH_DB="${SOURCE_DB}_restore_test"
API_PORT="${API_PORT_REHEARSAL:-4100}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP_PATH="/tmp/${SOURCE_DB}_rehearsal.dump"

# Refuse to run against anything that looks live.
case "$SCRATCH_DB" in
  *_restore_test) ;;
  *) echo "REFUSING: scratch database name must end in _restore_test" >&2; exit 1 ;;
esac

step()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail()  { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }
ok()    { printf '\033[32m  ok\033[0m %s\n' "$1"; }
psql_scratch() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH_DB" -tAc "$1"; }

cleanup() {
  docker exec "$CONTAINER" dropdb -U "$DB_USER" --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" rm -f "$DUMP_PATH" >/dev/null 2>&1 || true
  [ -n "${API_PID:-}" ] && kill "$API_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

TOTAL_START=$(date +%s)

# ---------------------------------------------------------------------------
step "1. Take a dump of ${SOURCE_DB}"
# ---------------------------------------------------------------------------
DUMP_START=$(date +%s)
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$SOURCE_DB" -Fc -f "$DUMP_PATH"
DUMP_SECONDS=$(( $(date +%s) - DUMP_START ))
DUMP_SIZE=$(docker exec "$CONTAINER" sh -c "du -h $DUMP_PATH | cut -f1")
ok "dump written in ${DUMP_SECONDS}s (${DUMP_SIZE})"

# ---------------------------------------------------------------------------
step "2. Restore into the scratch database ${SCRATCH_DB}"
# ---------------------------------------------------------------------------
RESTORE_START=$(date +%s)
docker exec "$CONTAINER" dropdb -U "$DB_USER" --if-exists "$SCRATCH_DB"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$SCRATCH_DB"
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH_DB" --no-owner "$DUMP_PATH"
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_START ))
ok "restored in ${RESTORE_SECONDS}s"

# ---------------------------------------------------------------------------
step "3. Is the data actually there?"
# ---------------------------------------------------------------------------
for table in users agencies offers leads reservations tracked_links; do
  src=$(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SOURCE_DB" -tAc "SELECT count(*) FROM $table")
  dst=$(psql_scratch "SELECT count(*) FROM $table")
  [ "$src" = "$dst" ] || fail "$table: source has $src rows, restore has $dst"
  ok "$table: $dst rows"
done

# The answer to "how much did we lose?" — the newest row that survived.
LATEST=$(psql_scratch 'SELECT COALESCE(max("createdAt")::text, (SELECT '"'"'no leads'"'"')) FROM leads')
ok "most recent lead: ${LATEST}"

# The CHECK constraints must survive the restore — they are half the data model.
CONSTRAINTS=$(psql_scratch "SELECT count(*) FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace")
[ "$CONSTRAINTS" -gt 15 ] || fail "only $CONSTRAINTS CHECK constraints survived — expected the hand-written ones"
ok "$CONSTRAINTS CHECK constraints present"

ORPHANS=$(psql_scratch 'SELECT count(*) FROM leads l LEFT JOIN agencies a ON a.id = l."agencyId" WHERE a.id IS NULL')
[ "$ORPHANS" = "0" ] || fail "$ORPHANS leads point at an agency that does not exist"
ok "no orphaned leads"

# ---------------------------------------------------------------------------
step "4. THE STEP PEOPLE SKIP — can the app actually use it?"
# ---------------------------------------------------------------------------
[ -f "$REPO_ROOT/apps/api/dist/main.js" ] || fail "API not built — run: npm run build --workspace @rihlati/api"

set -a; . "$REPO_ROOT/.env"; set +a
# Swap only the DATABASE PATH. Do not use bash substitution here: `?` is a
# glob wildcard, so `${URL/\/rihlati?/...}` matches the USERNAME first and
# silently produces a connection string pointing at a nonexistent host.
DATABASE_URL="$(DB_URL="$DATABASE_URL" SCRATCH="$SCRATCH_DB" python3 -c '
import os
from urllib.parse import urlparse, urlunparse
u = urlparse(os.environ["DB_URL"])
print(urlunparse(u._replace(path="/" + os.environ["SCRATCH"])))
')"
export DATABASE_URL
export API_PORT="$API_PORT"
node "$REPO_ROOT/apps/api/dist/main.js" > /tmp/rehearsal-api.log 2>&1 &
API_PID=$!

for _ in $(seq 1 30); do
  curl -sf "localhost:${API_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "localhost:${API_PORT}/health" >/dev/null || fail "API would not start against the restored database (see /tmp/rehearsal-api.log)"
ok "API started against the restored database"

TOKEN=$(curl -s -X POST "localhost:${API_PORT}/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"identifier":"baraka@rihlati.test","password":"rihlati-dev-password"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['tokens']['accessToken'])" 2>/dev/null) \
  || fail "a real agency owner cannot log in against the restored data"
ok "agency owner logged in"

MINE=$(curl -s "localhost:${API_PORT}/v1/auth/me" -H "Authorization: Bearer $TOKEN")
MY_AGENCY=$(echo "$MINE" | python3 -c "import sys,json;print(json.load(sys.stdin)['memberships'][0]['agencyId'])")
LEAD_COUNT=$(curl -s "localhost:${API_PORT}/v1/agencies/${MY_AGENCY}/leads?limit=100" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)['items']))")
[ "$LEAD_COUNT" -gt 0 ] || fail "the agency sees zero leads — the restore is empty where it matters"
ok "agency sees its own ${LEAD_COUNT} leads"

OTHER_AGENCY=$(psql_scratch "SELECT id FROM agencies WHERE id <> '${MY_AGENCY}' AND \"deletedAt\" IS NULL LIMIT 1")
if [ -n "$OTHER_AGENCY" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "localhost:${API_PORT}/v1/agencies/${OTHER_AGENCY}/leads" -H "Authorization: Bearer $TOKEN")
  [ "$CODE" = "404" ] || fail "TENANT ISOLATION BROKEN on the restored database (got HTTP $CODE, expected 404)"
  ok "another agency's leads return 404 — isolation intact after restore"
fi

TOTAL_SECONDS=$(( $(date +%s) - TOTAL_START ))

# ---------------------------------------------------------------------------
printf '\n\033[1m== RESULT ==\033[0m\n'
printf '  dump         %ss (%s)\n' "$DUMP_SECONDS" "$DUMP_SIZE"
printf '  restore      %ss\n' "$RESTORE_SECONDS"
printf '  total        %ss\n' "$TOTAL_SECONDS"
printf '\n\033[32mREHEARSAL PASSED\033[0m — record the date in obsidian/Runbooks/Restore From Backup.md\n'
