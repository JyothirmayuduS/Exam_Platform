#!/usr/bin/env bash
# Rebuild a FRESH Supabase project from a backup made by backup.sh, then
# check it:
#   - every table has the row count recorded in the backup manifest;
#   - every evidence file listed in the manifest is in the restored Storage
#     buckets and restored R2 bucket, and a sample downloads byte-identical;
#   - the sample attempt shows the same score, answers and violations;
#   - the sample recording downloads from restored Storage and decodes.
# Cron jobs are restored switched off. Environment: docs/backup-restore.md.
#
#   backend/backup/restore.sh [--stamp <stamp>|latest] [--skip-evidence]
set -Eeuo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

STAMP=latest
SKIP_EVIDENCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stamp) STAMP="${2:?--stamp needs a value}"; shift ;;
    --skip-evidence) SKIP_EVIDENCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_cmd node curl
require_env TARGET_DB_URL TARGET_SUPABASE_URL TARGET_SERVICE_ROLE_KEY TARGET_ANON_KEY
[ "$SKIP_EVIDENCE" = 1 ] || { require_cmd ffmpeg ffprobe; require_env RESTORE_R2_BUCKET; }
TARGET_REF="$(manifest ref TARGET_SUPABASE_URL)"
case ",${PROTECTED_PROJECT_REFS:-}," in
  *",$TARGET_REF,"*) die "refusing to restore into protected project $TARGET_REF" ;;
esac
backup_remote

make_work
[ "${KEEP_WORK:-}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0=$(date +%s)
pg_connect TARGET

step preflight
TABLES="$(sql -c "select count(*) from pg_tables where schemaname = 'public'")"
[ "$TABLES" = 0 ] || die "target project $TARGET_REF already has $TABLES tables in public; restore only into a fresh project"
if [ "$STAMP" = latest ]; then
  STAMP="$(rc lsf --dirs-only "$BACKUP_ROOT/db/" | LC_ALL=C sort | tail -1 | tr -d /)"
  [ -n "$STAMP" ] || die "no backups under $BACKUP_LABEL/db/"
fi
log "   restoring backup $STAMP from $BACKUP_LABEL into $TARGET_REF"
step_done

step download
rc copy "$BACKUP_ROOT/db/$STAMP" "$WORK/db" --stats 0
manifest verify-sums "$WORK/db"
M="$WORK/db/manifest.json"
[ "$(manifest get "$M" source_ref)" != "$TARGET_REF" ] || die "target is the project this backup was taken from"
for f in roles schema migrations data platform; do gzip -dc "$WORK/db/$f.sql.gz" > "$WORK/db/$f.sql"; done
step_done

step database
sql --single-transaction \
  -f "$WORK/db/roles.sql" -f "$WORK/db/schema.sql" -f "$WORK/db/migrations.sql" -f "$WORK/db/data.sql" \
  -c "set client_min_messages = warning" -f "$WORK/db/platform.sql" > /dev/null
step_done

step cron-jobs
WANT_JOBS="$(manifest lines "$M" facts.cron_jobs jobname | LC_ALL=C sort | paste -sd , -)"
HAVE_JOBS="$(sql -c "select coalesce(string_agg(jobname, ',' order by jobname collate \"C\"), '') from cron.job")"
ACTIVE_JOBS="$(sql -c "select count(*) from cron.job where active")"
[ "$HAVE_JOBS" = "$WANT_JOBS" ] || die "cron jobs differ: expected [$WANT_JOBS], restored [$HAVE_JOBS]"
[ "$ACTIVE_JOBS" = 0 ] || die "$ACTIVE_JOBS restored cron jobs are active"
log "   restored inactive: ${HAVE_JOBS:-none}"
step_done

step row-counts
manifest count-sql "$M" > "$WORK/sql/counts.sql"
sql -f "$WORK/sql/counts.sql" > "$WORK/counts.tsv"
COUNTS="$(manifest compare-counts "$M" "$WORK/counts.tsv")" || die "row counts differ: $COUNTS"
log "   $COUNTS"
step_done

step sample-attempt
ATTEMPT_ID="$(manifest get "$M" facts.sample_attempt_id)"
ATTEMPT="{}"
if [ -n "$ATTEMPT_ID" ]; then
  sql -v attempt_id="$ATTEMPT_ID" -f "$WORK/sql/attempt.sql" > "$WORK/attempt.json"
  manifest same-json "$WORK/attempt.json" "$M" facts.sample_attempt || die "sample attempt $ATTEMPT_ID differs after restore"
  ATTEMPT="$(cat "$WORK/attempt.json")"
  log "   $ATTEMPT"
else
  log "   the backup has no attempts to sample"
fi
step_done

EVIDENCE="{}"
RECORDING="{}"
if [ "$SKIP_EVIDENCE" = 0 ]; then
  [ "$(manifest get "$M" evidence_included)" = true ] || die "backup $STAMP was taken with --skip-evidence"
  remote_supabase TGTSB TARGET
  remote_s3 RESTORE "${RESTORE_R2_PROVIDER:-Cloudflare}" "${RESTORE_R2_ENDPOINT:-${BACKUP_S3_ENDPOINT:-}}" \
    "${RESTORE_R2_ACCESS_KEY_ID:-${BACKUP_S3_ACCESS_KEY_ID:-}}" "${RESTORE_R2_SECRET_ACCESS_KEY:-${BACKUP_S3_SECRET_ACCESS_KEY:-}}" auto

  restore_store() { # restore_store STORE BACKUP_SUBDIR TARGET_REMOTE_PATH
    local store=$1 src="$BACKUP_ROOT/evidence/$2" dest=$3 list="$WORK/db/listings/$1.tsv"
    cut -f2- "$list" > "$WORK/$store.paths"
    : > "$WORK/$store.sample"
    if [ -s "$WORK/$store.paths" ]; then
      # Storage rows came back with the database, so never skip a file because
      # the destination already "has" it: upload every listed file.
      rc copy "$src" "$dest" --files-from-raw "$WORK/$store.paths" --no-check-dest \
        --transfers "${BACKUP_TRANSFERS:-8}" --stats-log-level NOTICE --stats 0
      listing "$dest" "$WORK/restored-$store.tsv"
      local r
      r="$(manifest compare-listing "$list" "$WORK/restored-$store.tsv")" || die "restored $store is incomplete: $r"
      manifest sample "$list" "${VERIFY_SAMPLE:-25}" ${REC_PATH:+"$REC_PATH"} > "$WORK/$store.sample"
      rc check "$src" "$dest" --download --one-way --files-from-raw "$WORK/$store.sample" ||
        die "restored $store files differ from the backup"
    else
      : > "$WORK/restored-$store.tsv"
    fi
    EVIDENCE="$(node -e 'const [e, k, s, n] = process.argv.slice(1); const o = JSON.parse(e);
      o[k] = { ...JSON.parse(s), downloaded_and_compared: Number(n) }; console.log(JSON.stringify(o))' \
      "$EVIDENCE" "$store" "$(manifest summary "$WORK/restored-$store.tsv")" "$(wc -l < "$WORK/$store.sample" | tr -d ' ')")"
    log "   $store restored: $(manifest summary "$list")"
  }

  step storage
  REC_STORE="$(manifest get "$M" facts.sample_recording.store)"
  for bucket in $(manifest lines "$M" facts.buckets id); do
    REC_PATH=""
    [ "$REC_STORE" != "storage-$bucket" ] || REC_PATH="$(manifest get "$M" facts.sample_recording.path)"
    restore_store "storage-$bucket" "storage/$bucket" "TGTSB:$bucket"
  done
  step_done

  step r2
  REC_PATH=""
  [ "$REC_STORE" != r2 ] || REC_PATH="$(manifest get "$M" facts.sample_recording.path)"
  restore_store r2 r2 "RESTORE:$RESTORE_R2_BUCKET"
  step_done

  step sample-recording
  if [ -n "$REC_STORE" ]; then
    REC_PATH="$(manifest get "$M" facts.sample_recording.path)"
    if [ "$REC_STORE" = r2 ]; then
      rc copyto "RESTORE:$RESTORE_R2_BUCKET/$REC_PATH" "$WORK/recording"
      SERVED_BY="restored R2 bucket $RESTORE_R2_BUCKET"
    else
      # Through the restored project's Storage API with a signed URL, the way
      # the app plays recordings.
      BUCKET="${REC_STORE#storage-}"
      SIGNED="$(printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$TARGET_SERVICE_ROLE_KEY" "$TARGET_SERVICE_ROLE_KEY" |
        curl -fsS -K - -X POST -H 'Content-Type: application/json' -d '{"expiresIn":600}' \
          "$TARGET_SUPABASE_URL/storage/v1/object/sign/$BUCKET/$(manifest encode-path "$REC_PATH")")"
      URL_PATH="$(node -e 'console.log(JSON.parse(process.argv[1]).signedURL)' "$SIGNED")"
      curl -fsS -o "$WORK/recording" "$TARGET_SUPABASE_URL/storage/v1$URL_PATH"
      SERVED_BY="restored project Storage, bucket $BUCKET (signed URL)"
    fi
    SHA="$(manifest sha256 "$WORK/recording")"
    [ "$SHA" = "$(manifest get "$M" facts.sample_recording.sha256)" ] || die "sample recording differs from the backup"
    ffmpeg -nostdin -v error -xerror -i "$WORK/recording" -map 0 -f null - 2> "$WORK/decode.err" ||
      die "sample recording does not decode: $(head -c 500 "$WORK/decode.err")"
    STREAMS="$(ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 "$WORK/recording" | paste -sd ' ' -)"
    SECONDS_PLAYED="$(ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$WORK/recording" | grep -v '^N/A' | tail -1)"
    [ -n "$SECONDS_PLAYED" ] || die "sample recording has no video frames"
    RECORDING="$(node -e 'const [p, b, s, st, sec, by] = process.argv.slice(1);
      console.log(JSON.stringify({ path: p, bytes: Number(b), sha256: s, streams: st, seconds: Number(sec), served_by: by }))' \
      "$REC_PATH" "$(wc -c < "$WORK/recording" | tr -d ' ')" "$SHA" "$STREAMS" "$SECONDS_PLAYED" "$SERVED_BY")"
    log "   $RECORDING"
  else
    log "   the backup has no recording to sample"
  fi
  step_done
fi

TOTAL=$(( $(date +%s) - T0 ))
node -e 'const [stamp, ref, started, total, timings, counts, attempt, evidence, recording, jobs] = process.argv.slice(1);
  console.log(JSON.stringify({ result: "passed", backup: stamp, target_ref: ref, started_at: started,
    finished_at: new Date().toISOString(), total_seconds: Number(total), timings_seconds: JSON.parse(`{${timings}}`),
    row_counts: JSON.parse(counts), cron_jobs_restored_inactive: jobs ? jobs.split(",") : [], sample_attempt: JSON.parse(attempt), evidence: JSON.parse(evidence),
    sample_recording: JSON.parse(recording),
    next: "cron jobs are restored inactive; see docs/backup-restore.md, After a restore" }, null, 2))' \
  "$STAMP" "$TARGET_REF" "$STARTED" "$TOTAL" "$TIMINGS" "$COUNTS" "$ATTEMPT" "$EVIDENCE" "$RECORDING" "$HAVE_JOBS"
log "restore of $STAMP into $TARGET_REF passed in ${TOTAL}s"
