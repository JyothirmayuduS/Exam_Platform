# shellcheck shell=bash
# Shared by backup.sh and restore.sh (bash 3.2+). Secrets come from the
# environment and reach the tools through the environment, never on a
# command line, and nothing here prints them.

BACKUP_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SQL="$(cd "$BACKUP_LIB/../sql" && pwd)"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
PG_MAJOR="${PG_MAJOR:-17}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.2}"
TIMINGS=""

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_env() {
  local missing="" v
  for v in "$@"; do [ -n "${!v:-}" ] || missing="$missing $v"; done
  [ -z "$missing" ] || die "missing environment variables:$missing"
}

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "$c is required"; done
}

manifest() { node "$BACKUP_LIB/manifest.mjs" "$@"; }

# Tool error output passes through here so a credential echoed back in an
# error message never reaches the console or a cron log.
redact() { node "$BACKUP_LIB/manifest.mjs" redact; }

step() { CURRENT_STEP=$1; STEP_START=$(date +%s); log "== $1"; }
step_done() {
  local d=$(( $(date +%s) - STEP_START ))
  TIMINGS="${TIMINGS}${TIMINGS:+,}\"$CURRENT_STEP\":$d"
  log "   $CURRENT_STEP done in ${d}s"
}

# A scratch directory that docker can mount at the same path.
make_work() {
  WORK="$(mktemp -d "${BACKUP_WORK_ROOT:-${TMPDIR:-/tmp}}/exam-backup.XXXXXX")"
  WORK="$(cd "$WORK" && pwd -P)"
  mkdir -p "$WORK/db/listings" "$WORK/listings" "$WORK/sql"
  cp "$BACKUP_SQL"/*.sql "$WORK/sql/"
  : > "$WORK/rclone.conf"
  export RCLONE_CONFIG="$WORK/rclone.conf"
}

# --- Postgres --------------------------------------------------------------

# pg_connect SOURCE|TARGET: libpq settings from <PREFIX>_DB_URL, optional
# <PREFIX>_DB_ROLE to SET ROLE to (needed when logging in as a helper role).
pg_connect() {
  local role_var="${1}_DB_ROLE" exports
  exports="$(manifest pg-env "${1}_DB_URL")" || die "${1}_DB_URL is not a usable postgres URL"
  eval "$exports"
  PG_ROLE="${!role_var:-}"
}

local_pg_ok() {
  [ "${BACKUP_USE_DOCKER:-}" != 1 ] && command -v "$1" >/dev/null 2>&1 &&
    [ "$("$1" --version | grep -oE '[0-9]+' | head -1)" -ge "$PG_MAJOR" ]
}

# pg <tool> [args]: a Postgres client tool, local if new enough, else docker.
# File arguments must be under $WORK.
pg() {
  local tool=$1; shift
  if local_pg_ok "$tool"; then "$tool" "$@" 2> >(redact >&2); return; fi
  docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE \
    -v "$WORK:$WORK" -w "$WORK" --entrypoint "$tool" "$PG_IMAGE" "$@" 2> >(redact >&2)
}

sql() {
  if [ -n "${PG_ROLE:-}" ]; then
    pg psql -X -v ON_ERROR_STOP=1 -Atq -c "set role \"$PG_ROLE\"" "$@"
  else
    pg psql -X -v ON_ERROR_STOP=1 -Atq "$@"
  fi
}

# --- rclone ----------------------------------------------------------------

rc() {
  if [ "${BACKUP_USE_DOCKER:-}" != 1 ] && command -v rclone >/dev/null 2>&1; then rclone "$@" 2> >(redact >&2); return; fi
  local args="" n
  for n in $(compgen -e | grep '^RCLONE_'); do args="$args -e $n"; done
  # shellcheck disable=SC2086
  docker run --rm -i $args -v "$WORK:$WORK" ${BACKUP_LOCAL_DIR:+-v "$BACKUP_LOCAL_DIR:$BACKUP_LOCAL_DIR"} \
    -w "$WORK" "$RCLONE_IMAGE" "$@" 2> >(redact >&2)
}

# remote_s3 NAME PROVIDER ENDPOINT ACCESS_KEY SECRET_KEY REGION [SESSION_TOKEN]
remote_s3() {
  local p="RCLONE_CONFIG_${1}_"
  export "${p}TYPE=s3" "${p}PROVIDER=$2" "${p}ENDPOINT=$3" "${p}ACCESS_KEY_ID=$4" \
    "${p}SECRET_ACCESS_KEY=$5" "${p}REGION=$6" "${p}NO_CHECK_BUCKET=true"
  if [ -n "${7:-}" ]; then export "${p}SESSION_TOKEN=$7" "${p}FORCE_PATH_STYLE=true"; fi
}

# remote_supabase NAME SOURCE|TARGET: the project's Storage over its S3
# endpoint, signed in with the service role key (sees every bucket).
remote_supabase() {
  local url="${2}_SUPABASE_URL" anon="${2}_ANON_KEY" key="${2}_SERVICE_ROLE_KEY" region="${2}_STORAGE_REGION" ref
  ref="$(manifest ref "$url")" || die "$url must look like https://<ref>.supabase.co"
  remote_s3 "$1" Other "https://$ref.storage.supabase.co/storage/v1/s3" "$ref" "${!anon}" \
    "${!region:-ap-southeast-1}" "${!key}"
}

# The backup location: an S3-compatible bucket, or BACKUP_LOCAL_DIR for tests.
backup_remote() {
  if [ -n "${BACKUP_LOCAL_DIR:-}" ]; then
    mkdir -p "$BACKUP_LOCAL_DIR"
    BACKUP_LOCAL_DIR="$(cd "$BACKUP_LOCAL_DIR" && pwd -P)"
    BACKUP_ROOT="$BACKUP_LOCAL_DIR"
    BACKUP_LABEL="$BACKUP_LOCAL_DIR"
    return
  fi
  require_env BACKUP_S3_ENDPOINT BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_BUCKET
  remote_s3 BACKUP "${BACKUP_S3_PROVIDER:-Cloudflare}" "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
    "$BACKUP_S3_SECRET_ACCESS_KEY" "${BACKUP_S3_REGION:-auto}"
  BACKUP_ROOT="BACKUP:$BACKUP_S3_BUCKET${BACKUP_S3_PREFIX:+/$BACKUP_S3_PREFIX}"
  BACKUP_LABEL="s3://$BACKUP_S3_BUCKET${BACKUP_S3_PREFIX:+/$BACKUP_S3_PREFIX}"
}

# listing REMOTE:PATH FILE: "size<TAB>path" for every object, sorted.
listing() {
  rc lsf -R --files-only --format sp --separator "$(printf '\t')" "$1" | LC_ALL=C sort -t "$(printf '\t')" -k2 > "$2"
}
