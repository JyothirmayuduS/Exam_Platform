#!/usr/bin/env bash
# Full backup of the exam platform:
#   1. Postgres: roles, schema, data (including auth users and Storage
#      metadata), migration history and platform objects (Storage policies,
#      realtime tables), plus a manifest with row counts and checksums;
#   2. stored evidence: every Storage bucket and the R2 evidence bucket,
#      copied into one mirror at the backup location;
# then reports the run with public.record_backup_run so the admin console
# shows it. Environment and schedule: docs/backup-restore.md.
#
#   backend/backup/backup.sh [--skip-evidence]
set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

SKIP_EVIDENCE=0
for arg in "$@"; do
  case "$arg" in
    --skip-evidence) SKIP_EVIDENCE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

require_cmd node gzip
require_env SOURCE_DB_URL SOURCE_SUPABASE_URL SOURCE_SERVICE_ROLE_KEY SOURCE_ANON_KEY
[ "$SKIP_EVIDENCE" = 1 ] || require_env R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_S3_ENDPOINT R2_BUCKET
backup_remote

PLATFORM_ROLES='anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin'
PLATFORM_SCHEMAS='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'
DATA_EXCLUDED_SCHEMAS='information_schema|pg_*|graphql|graphql_public|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault|etl|extensions|pgbouncer|realtime|supabase_migrations|_analytics|_realtime|_supavisor|net|cron'

make_work
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0=$(date +%s)
LOCATION="$BACKUP_LABEL/db/$STAMP"
SOURCE_REF="$(manifest ref SOURCE_SUPABASE_URL)"
RUN_ID=""
CURRENT_STEP="start"

pg_connect SOURCE

record() { # record STATUS [MESSAGE] [SIZE_BYTES]
  printf '%s\n' "select public.record_backup_run(:'status', p_started_at => :'started'::timestamptz, p_kind => 'full', p_location => :'loc', p_size_bytes => nullif(:'size', '')::bigint, p_message => nullif(:'msg', ''), p_id => nullif(:'id', '')::bigint);" |
    sql -v status="$1" -v started="$STARTED" -v loc="$LOCATION" -v size="${3:-}" -v msg="${2:-}" -v id="$RUN_ID" -f -
}

DONE=0
finish() {
  local rc=$?
  if [ "$DONE" != 1 ]; then
    log "backup failed during: $CURRENT_STEP"
    [ -z "$RUN_ID" ] || record failed "failed during $CURRENT_STEP (exit $rc)" >/dev/null 2>&1 || log "could not record the failure"
  fi
  [ "${KEEP_WORK:-}" = 1 ] || rm -rf "$WORK"
  exit "$rc"
}
trap finish EXIT

RUN_ID="$(record running)"
log "backup run $RUN_ID → $LOCATION"

# --- database ----------------------------------------------------------------

step roles
pg pg_dumpall --roles-only ${PG_ROLE:+--role "$PG_ROLE"} --quote-all-identifier --no-role-passwords --no-comments |
  sed -E 's/^\\(un)?restrict .*$/-- &/' |
  sed -E "s/^CREATE ROLE \"($PLATFORM_ROLES)\"/-- &/" |
  sed -E "s/^ALTER ROLE \"($PLATFORM_ROLES)\"/-- &/" |
  sed -E 's/ (NOSUPERUSER|NOREPLICATION)//g' |
  sed -E 's/^-- (.* SET "(pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing)" .*)/\1/' |
  sed -E "s/GRANT \".*\" TO \"($PLATFORM_ROLES)\"/-- &/" |
  sed -E "s/^GRANT .+ ON PARAMETER .+ TO \"($PLATFORM_ROLES)\"/-- &/" |
  sed -E '/^--/d' | uniq > "$WORK/db/roles.sql"
echo 'RESET ALL;' >> "$WORK/db/roles.sql"
step_done

step schema
pg pg_dump --schema-only --quote-all-identifier ${PG_ROLE:+--role "$PG_ROLE"} --exclude-schema "$PLATFORM_SCHEMAS" |
  sed -E 's/^\\(un)?restrict .*$/-- &/' |
  sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' |
  sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' |
  sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' |
  sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' |
  sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' |
  sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' |
  sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' |
  sed -E 's/^CREATE EVENT TRIGGER /-- &/' |
  sed -E 's/^         WHEN TAG IN /-- &/' |
  sed -E 's/^   EXECUTE FUNCTION /-- &/' |
  sed -E 's/^ALTER EVENT TRIGGER /-- &/' |
  sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' |
  sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' |
  sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' |
  sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' |
  sed -E "s/^GRANT (.+) ON (.+) \"($PLATFORM_SCHEMAS)\"/-- &/" |
  sed -E "s/^REVOKE (.+) ON (.+) \"($PLATFORM_SCHEMAS)\"/-- &/" |
  sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/' |
  sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/' |
  sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/' |
  sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' |
  sed -E 's/^CREATE POLICY "cron_job_/-- &/' |
  sed -E 's/^ALTER TABLE "cron"/-- &/' |
  sed -E 's/^SET transaction_timeout = 0;/-- &/' |
  sed -E '/^--/d' > "$WORK/db/schema.sql"
step_done

step migrations
pg pg_dump --quote-all-identifier ${PG_ROLE:+--role "$PG_ROLE"} --schema supabase_migrations --no-owner |
  sed -E 's/^\\(un)?restrict .*$/-- &/' |
  sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' |
  sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' |
  sed -E 's/^SET transaction_timeout = 0;/-- &/' > "$WORK/db/migrations.sql"
step_done

step facts
sql -f "$WORK/sql/facts.sql" > "$WORK/facts.json"
ATTEMPT_ID="$(manifest get "$WORK/facts.json" sample_attempt_id)"
if [ -n "$ATTEMPT_ID" ]; then
  sql -v attempt_id="$ATTEMPT_ID" -f "$WORK/sql/attempt.sql" > "$WORK/attempt.json"
  manifest set "$WORK/facts.json" sample_attempt "$(cat "$WORK/attempt.json")"
fi
step_done

step data
NOT_RESTORED=""
for t in $(manifest lines "$WORK/facts.json" not_restored_tables table); do NOT_RESTORED="$NOT_RESTORED --exclude-table $t"; done
{
  echo 'SET session_replication_role = replica;'
  # shellcheck disable=SC2086
  pg pg_dump --data-only --quote-all-identifier ${PG_ROLE:+--role "$PG_ROLE"} \
    --exclude-schema "$DATA_EXCLUDED_SCHEMAS" $NOT_RESTORED \
    --exclude-table auth.schema_migrations --exclude-table storage.migrations \
    --exclude-table supabase_functions.migrations \
    --exclude-table 'storage.s3_multipart_uploads*' |
    sed -E 's/^\\(un)?restrict .*$/-- &/' |
    sed -E 's/^SET transaction_timeout = 0;/-- &/'
  echo 'RESET ALL;'
} > "$WORK/db/data.sql"
step_done

step platform
sql -f "$WORK/sql/platform.sql" > "$WORK/db/platform.sql"
step_done

gzip -n "$WORK"/db/*.sql

# --- evidence ----------------------------------------------------------------

copy_store() { # copy_store STORE SOURCE_REMOTE_PATH
  local store=$1 src=$2 dest="$BACKUP_ROOT/evidence/$3"
  listing "$src" "$WORK/listings/$store.tsv"
  if [ -s "$WORK/listings/$store.tsv" ]; then
    rc copy "$src" "$dest" --fast-list --transfers "${BACKUP_TRANSFERS:-8}" --checkers 16 --stats-log-level NOTICE --stats 0
    listing "$dest" "$WORK/backup-$store.tsv"
  else
    : > "$WORK/backup-$store.tsv"
  fi
  manifest compare-listing "$WORK/listings/$store.tsv" "$WORK/backup-$store.tsv" > "$WORK/check-$store.json" ||
    die "evidence copy for $store is incomplete: $(cat "$WORK/check-$store.json")"
  cp "$WORK/listings/$store.tsv" "$WORK/db/listings/$store.tsv"
  log "   $store: $(manifest summary "$WORK/listings/$store.tsv")"
}

if [ "$SKIP_EVIDENCE" = 0 ]; then
  step evidence
  remote_supabase SRCSB SOURCE
  remote_s3 SRCR2 Cloudflare "$R2_S3_ENDPOINT" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" auto
  for bucket in $(manifest lines "$WORK/facts.json" buckets id); do
    copy_store "storage-$bucket" "SRCSB:$bucket" "storage/$bucket"
  done
  copy_store r2 "SRCR2:$R2_BUCKET" r2

  REC_STORE="$(manifest get "$WORK/facts.json" sample_recording.store)"
  if [ -z "$REC_STORE" ]; then
    REC_PATH="$(manifest pick-recording "$WORK/listings/r2.tsv")"
    [ -z "$REC_PATH" ] || manifest set "$WORK/facts.json" sample_recording "$(node -e 'console.log(JSON.stringify({store:"r2",path:process.argv[1]}))' "$REC_PATH")"
    REC_STORE="${REC_PATH:+r2}"
  fi
  if [ -n "$REC_STORE" ]; then
    REC_PATH="$(manifest get "$WORK/facts.json" sample_recording.path)"
    case "$REC_STORE" in r2) REC_DIR=r2 ;; *) REC_DIR="storage/${REC_STORE#storage-}" ;; esac
    rc copyto "$BACKUP_ROOT/evidence/$REC_DIR/$REC_PATH" "$WORK/sample-recording"
    manifest set "$WORK/facts.json" sample_recording.sha256 "\"$(manifest sha256 "$WORK/sample-recording")\""
    rm -f "$WORK/sample-recording"
  fi
  step_done
fi

# --- manifest and upload -------------------------------------------------------

step upload
GIT_COMMIT="$(git -C "$BACKUP_LIB" rev-parse HEAD 2>/dev/null || true)"
META="$(node -e 'const [stamp, started, ref, commit, loc, timings, skip] = process.argv.slice(1);
  console.log(JSON.stringify({ stamp, started_at: started, source_ref: ref, git_commit: commit || null,
    location: loc, evidence_included: skip !== "1", timings_seconds: JSON.parse(`{${timings}}`) }))' \
  "$STAMP" "$STARTED" "$SOURCE_REF" "$GIT_COMMIT" "$LOCATION" "$TIMINGS" "$SKIP_EVIDENCE")"
log "   $(manifest build "$WORK" "$META")"
rc copy "$WORK/db" "$BACKUP_ROOT/db/$STAMP" --stats 0
rc check "$WORK/db" "$BACKUP_ROOT/db/$STAMP" --one-way --size-only
step_done

DB_BYTES=$(node -e 'const m=require(process.argv[1]); console.log(Object.values(m.files).reduce((n,f)=>n+f.bytes,0))' "$WORK/db/manifest.json")
EVIDENCE_BYTES=$(node -e 'const m=require(process.argv[1]); console.log(Object.values(m.evidence).reduce((n,e)=>n+e.bytes,0))' "$WORK/db/manifest.json")
SUMMARY=$(node -e 'const m=require(process.argv[1]); const rows=Object.values(m.rows).reduce((a,b)=>a+b,0);
  const ev=Object.entries(m.evidence).map(([k,e])=>`${k} ${e.objects}`).join(", ");
  console.log(`${Object.keys(m.rows).length} tables, ${rows} rows` + (ev ? `; evidence: ${ev}` : "; evidence skipped") + `; ${process.argv[2]}s`)' \
  "$WORK/db/manifest.json" "$(( $(date +%s) - T0 ))")
record succeeded "$SUMMARY" "$(( DB_BYTES + EVIDENCE_BYTES ))" >/dev/null
DONE=1
log "backup $STAMP succeeded: $SUMMARY"
echo "$STAMP"
