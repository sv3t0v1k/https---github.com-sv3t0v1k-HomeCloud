#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# HomeCloud Backup — Phase 5.3: Reliable Backup Pipeline
#
# Creates PostgreSQL dump + Docker named-volume storage archive with
# atomicity, integrity verification, and metadata.
#
# Safety guarantees:
#   - Artifacts are staged in a private directory and only published to
#     $BACKUP_DIR AFTER all verification passes (CREATE → VERIFY → FINALIZE).
#   - A file-based lock with token prevents concurrent backup runs.
#   - Disk-space pre-check prevents partial archives from filling the disk.
#   - On ANY failure: staging is cleaned up, .meta is NOT published,
#     existing backups are untouched, non-zero exit code.
#   - Metadata (.meta) is generated with a real JSON serializer (no heredoc
#     injection risk) and includes app version, migration count, PG version.
#   - Timestamp includes random token suffix to prevent collisions.
#   - Retention keeps at least MIN_BACKUPS (default 2) and only deletes
#     old backups on successful completion using filename timestamps.
#   - Random tokens use Python secrets (fail-closed if no CSPRNG available).
#
# Environment overrides:
#   BACKUP_DIR       - directory holding backups (default: ./backups)
#   RETENTION_DAYS   - retention window in days (default: 7)
#   BACKEND_IMAGE    - Docker image for storage access (default: homecloud-backend)
#
# Exit codes:
#   0 — backup completed successfully
#   1 — backup failed (artifact creation or validation error)
#   2 — another backup is already running / invalid arguments
#   3 — insufficient disk space
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
DEFAULT_RETENTION_DAYS=7
BACKUP_FORMAT_VERSION="1"
MIN_BACKUPS=2

# ---------------------------------------------------------------------------
# Helpers (defined early for argparse)
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }
file_size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    python3 -c "
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], 'rb') as f:
    for chunk in iter(lambda: f.read(8192), b''):
        h.update(chunk)
print(h.hexdigest())
" "$1"
  fi
}
safe_remove_dir() {
  local path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ]; then
    err "Refusing to remove symlink path: $path"
    return 1
  fi
  if [ ! -d "$path" ]; then
    err "Refusing to remove non-directory path: $path"
    return 1
  fi
  # Use -P to not follow symlinks when finding files
  find -P "$path" -depth -type f -exec rm -f -- {} + 2>/dev/null || {
    err "Could not remove files from directory safely: $path"
    return 1
  }
  find -P "$path" -depth -type l -exec rm -f -- {} + 2>/dev/null || {
    err "Could not remove symlinks from directory safely: $path"
    return 1
  }
  find -P "$path" -depth -type d -exec rmdir {} + 2>/dev/null || {
    err "Could not remove empty directories safely: $path"
    return 1
  }
  [ ! -e "$path" ] && [ ! -L "$path" ] || {
    err "Directory removal did not complete: $path"
    return 1
  }
}
safe_remove_file() {
  local path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ] || [ -f "$path" ]; then
    rm -f -- "$path" 2>/dev/null || return 1
    [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
    return 0
  fi
  err "Refusing to remove non-regular lock file: $path"
  return 1
}
safe_remove_lock_dir() {
  local lock_dir="$1"
  [ -e "$lock_dir" ] || [ -L "$lock_dir" ] || return 0
  if [ -L "$lock_dir" ] || [ ! -d "$lock_dir" ]; then
    err "Unsafe lock path: $lock_dir"
    return 1
  fi
  safe_remove_file "$lock_dir/LOCK_PID" || return 1
  safe_remove_file "$lock_dir/LOCK_TOKEN" || return 1
  rmdir "$lock_dir" 2>/dev/null || {
    err "Could not remove empty lock directory: $lock_dir"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Argparse: --yes (non-interactive), --help, unknown -> exit 2
# ---------------------------------------------------------------------------
FORCE_YES=false
usage() {
  cat <<'EOF'
Usage: backup.sh [OPTIONS]

Options:
  --yes      Run non-interactively (assume yes to all prompts)
  --help     Show this help and exit

Exit codes:
  0  backup completed successfully
  1  backup failed (artifact creation or validation error)
  2  another backup is already running / invalid arguments
  3  insufficient disk space
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes) FORCE_YES=true ;;
    --help) usage; exit 0 ;;
    -*) err "Unknown option: $arg"; usage >&2; exit 2 ;;
    *) err "Unexpected positional argument: $arg"; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Load .env WITHOUT set -a (do NOT export secrets into process environment)
# ---------------------------------------------------------------------------
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
JWT_SECRET="${JWT_SECRET:-}"
JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-}"
if [ -f "$PROJECT_ROOT/.env" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key="${key%%#*}"
    [ -z "$key" ] && continue
    key="$(echo "$key" | tr -d '[:space:]')"
    value="${value//\"/}"
    value="${value//\'/}"
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$key" in
      DB_NAME) DB_NAME="$value" ;;
      DB_USER) DB_USER="$value" ;;
      DB_PASSWORD) DB_PASSWORD="$value" ;;
      REDIS_PASSWORD) REDIS_PASSWORD="$value" ;;
      JWT_SECRET) JWT_SECRET="$value" ;;
      JWT_REFRESH_SECRET) JWT_REFRESH_SECRET="$value" ;;
    esac
  done < "$PROJECT_ROOT/.env"
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
STORAGE_PATH="${STORAGE_PATH:-/storage}"
BACKEND_IMAGE="${BACKEND_IMAGE:-homecloud-backend}"
RETENTION_DAYS="${RETENTION_DAYS:-$DEFAULT_RETENTION_DAYS}"

# Resolve and validate the backup root before creating lock/staging paths.
if [ -z "$BACKUP_DIR" ]; then
  err "BACKUP_DIR must not be empty"
  exit 1
fi
if [ -L "$BACKUP_DIR" ]; then
  err "BACKUP_DIR is a symlink, refusing to proceed: $BACKUP_DIR"
  exit 1
fi
mkdir -p "$BACKUP_DIR" 2>/dev/null || {
  err "Could not create BACKUP_DIR: $BACKUP_DIR"
  exit 1
}
BACKUP_DIR="$(cd -P "$BACKUP_DIR" 2>/dev/null && pwd)" || {
  err "Could not resolve BACKUP_DIR: $BACKUP_DIR"
  exit 1
}

# ---------------------------------------------------------------------------
# --yes / FORCE_YES: meaningful confirmation for interactive use.
# When --yes is not set AND stdin is a TTY, ask for confirmation before
# proceeding.  Non-interactive (piped/cron) runs always proceed.
# ---------------------------------------------------------------------------
if [ "$FORCE_YES" = "false" ] && [ -t 0 ]; then
  log "About to create HomeCloud backup in: $BACKUP_DIR"
  printf 'Proceed? (yes/no): ' >&2
  read -r response || { err "No input received — aborting"; exit 1; }
  case "$response" in
    y|yes|Y|YES|Yes) ;;
    *) err "Aborted by user"; exit 1 ;;
  esac
fi

# ---------------------------------------------------------------------------
# Cryptographically secure random hex (fail closed if no entropy source)
# ---------------------------------------------------------------------------
random_hex() {
  # $1 = number of bytes → returns hex string of 2*$1 characters
  local nbytes="$1"
  python3 -c "import secrets; print(secrets.token_hex($nbytes))" 2>/dev/null
}

# Random suffix for backup ID (8 hex chars = 4 bytes)
RANDOM_SUFFIX=$(random_hex 4)
if [ -z "$RANDOM_SUFFIX" ]; then
  err "Cannot generate cryptographically random backup suffix (python3/secrets unavailable)"
  exit 1
fi
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_ID="${TIMESTAMP}_${RANDOM_SUFFIX}"

# Staging paths (private, never visible to restore.sh)
STAGING_ROOT="$BACKUP_DIR/.staging"
SESSION_DIR="$STAGING_ROOT/$BACKUP_ID"
LOCK_DIR="$BACKUP_DIR/.backup.lock"

# Final artifact paths (resolved after staging)
FINAL_DB="$BACKUP_DIR/homecloud_db_${BACKUP_ID}.sql.gz"
FINAL_STOR="$BACKUP_DIR/homecloud_storage_${BACKUP_ID}.tar.gz"
FINAL_META="$BACKUP_DIR/homecloud_${BACKUP_ID}.meta"
FINAL_META_SHA256="$BACKUP_DIR/homecloud_${BACKUP_ID}.meta.sha256"

# Marker files
LAST_SUCCESS_FILE="$BACKUP_DIR/.last-success"
LAST_FAILURE_FILE="$BACKUP_DIR/.last-failure"

STAGING_DB="$SESSION_DIR/homecloud_db_${BACKUP_ID}.sql.gz"
STAGING_STOR="$SESSION_DIR/homecloud_storage_${BACKUP_ID}.tar.gz"
STAGING_META="$SESSION_DIR/homecloud_${BACKUP_ID}.meta"
STAGING_META_SHA256="$SESSION_DIR/homecloud_${BACKUP_ID}.meta.sha256"

BACKUP_START=$(date +%s)

# Lock ownership token — MUST be initialised BEFORE the cleanup trap so that
# cleanup() can safely reference $LOCK_TOKEN even on early exit / signal before
# lock acquisition completes.  No PID fallback — fail closed.
LOCK_TOKEN=$(random_hex 16)
if [ -z "$LOCK_TOKEN" ]; then
  err "Cannot generate cryptographically random lock token (python3/secrets unavailable)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Structured one-line JSON summary
# ---------------------------------------------------------------------------
log_json() {
  local event="$1"; shift
  printf '{"event":"%s","backup_id":"%s","timestamp":"%s"%s}\n' \
    "$event" "$BACKUP_ID" "$TIMESTAMP" "$*"
}

# ---------------------------------------------------------------------------
# Cleanup trap — removes staging directory on ANY exit
# ---------------------------------------------------------------------------
cleanup() {
  local rc=$?
  safe_remove_dir "$SESSION_DIR" 2>/dev/null || err "Could not clean session staging: $SESSION_DIR"
  rmdir "$STAGING_ROOT" 2>/dev/null || true
  if [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
    local lock_token
    lock_token=$(cat "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null || echo "")
    # Only release lock if we own the token. No PID fallback — fail closed.
    if [ -n "$LOCK_TOKEN" ] && [ "$lock_token" = "$LOCK_TOKEN" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || err "Could not release backup lock: $LOCK_DIR"
    fi
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Stale staging cleanup (after lock acquired, before starting new backup)
# ---------------------------------------------------------------------------
cleanup_stale_staging() {
  if [ -L "$STAGING_ROOT" ]; then
    err "Staging root is a symlink, refusing to proceed: $STAGING_ROOT"
    return 1
  fi
  [ -d "$STAGING_ROOT" ] || return 0
  # Use find with -maxdepth 1 to avoid symlink races; glob expansion
  # ("$STAGING_ROOT"/*/) is vulnerable to TOCTOU via symlinks.
  local stale_dir
  while IFS= read -r -d '' stale_dir; do
    [ -e "$stale_dir" ] || continue
    if [ -L "$stale_dir" ] || [ ! -d "$stale_dir" ]; then
      err "Unsafe stale staging entry: $stale_dir"
      return 1
    fi
    [ "$stale_dir" = "$SESSION_DIR" ] && continue
    log "  Cleaning up stale staging directory: $(basename "$stale_dir")"
    safe_remove_dir "$stale_dir" || return 1
  done < <(find "$STAGING_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  rmdir "$STAGING_ROOT" 2>/dev/null || {
    err "Could not remove empty staging root: $STAGING_ROOT"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Concurrency lock (mkdir-based with random ownership token)
# ---------------------------------------------------------------------------
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    # Verify the path is NOT a symlink after mkdir (race defense)
    if [ -L "$LOCK_DIR" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      err "Lock path is a symlink after mkdir, refusing: $LOCK_DIR"
      return 2
    fi
    printf '%s\n' "$$" > "$LOCK_DIR/LOCK_PID" || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    printf '%s\n' "$LOCK_TOKEN" > "$LOCK_DIR/LOCK_TOKEN" || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    chmod 700 "$LOCK_DIR" 2>/dev/null || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    chmod 600 "$LOCK_DIR/LOCK_PID" "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    # Read back both values before entering the critical section. A contender
    # seeing an incomplete lock treats it as active/racy, never as stale.
    if [ "$(cat "$LOCK_DIR/LOCK_PID" 2>/dev/null)" != "$$" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      return 1
    fi
    if [ "$(cat "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null)" != "$LOCK_TOKEN" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      return 1
    fi
    return 0
  fi

  if [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
    local existing_token existing_pid
    existing_token="$(cat "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null || echo "")"
    existing_pid="$(cat "$LOCK_DIR/LOCK_PID" 2>/dev/null || echo "")"
    # Check if the lock holder is still alive.  This works even for partially
    # initialised locks (missing token file) — a dead PID means the lock is stale.
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      err "Another backup is already running (PID $existing_pid). Lock: $LOCK_DIR"
      log_json "backup_failed" ',"error":"concurrent backup blocked","exit_code":2'
      printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "concurrent_backup_blocked pid=$existing_pid" > "$LAST_FAILURE_FILE"
      return 2
    fi
    # PID is dead or missing → stale or partially initialised lock.
    # Clean up and retry.  Stale lock means the owning process is dead,
    # so cleanup is safe regardless of token state.
    safe_remove_lock_dir "$LOCK_DIR" || return 2
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      err "Could not acquire backup lock after stale-lock cleanup (race condition)"
      return 2
    fi
    # Verify the path is NOT a symlink after re-acquisition (race defense)
    if [ -L "$LOCK_DIR" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      err "Lock path is a symlink after re-acquisition, refusing: $LOCK_DIR"
      return 2
    fi
    printf '%s\n' "$$" > "$LOCK_DIR/LOCK_PID" || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    printf '%s\n' "$LOCK_TOKEN" > "$LOCK_DIR/LOCK_TOKEN" || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    chmod 700 "$LOCK_DIR" 2>/dev/null || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    chmod 600 "$LOCK_DIR/LOCK_PID" "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null || { safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null; return 1; }
    if [ "$(cat "$LOCK_DIR/LOCK_PID" 2>/dev/null)" != "$$" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      return 1
    fi
    if [ "$(cat "$LOCK_DIR/LOCK_TOKEN" 2>/dev/null)" != "$LOCK_TOKEN" ]; then
      safe_remove_lock_dir "$LOCK_DIR" 2>/dev/null || true
      return 1
    fi
    return 0
  fi

  err "Unsafe lock path: $LOCK_DIR"
  return 2
}
acquire_lock
acquire_rc=$?
if [ "$acquire_rc" -ne 0 ]; then
  exit "$acquire_rc"
fi

# ---------------------------------------------------------------------------
# Initialize
# ---------------------------------------------------------------------------
cleanup_stale_staging || exit 1
mkdir -p "$SESSION_DIR" 2>/dev/null || {
  err "Could not create session staging: $SESSION_DIR"
  exit 1
}
chmod 700 "$STAGING_ROOT" "$SESSION_DIR" 2>/dev/null || {
  err "Could not restrict staging permissions"
  exit 1
}

log "=== HomeCloud Backup ==="
log "Backup ID: $BACKUP_ID"
log "Backup directory: $BACKUP_DIR"
log "Format version: $BACKUP_FORMAT_VERSION"


# ---------------------------------------------------------------------------
# Phase 0: Disk-space pre-check (df -Pk, 1K-block units)
# ---------------------------------------------------------------------------
echo "[0/6] Pre-checking disk space..."

# Estimate DB size
DB_SIZE_BYTES=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COALESCE(pg_database_size('$DB_NAME'), 0)" 2>/dev/null | tr -d '[:space:]' || echo 0)
[ "$DB_SIZE_BYTES" -gt 0 ] 2>/dev/null || DB_SIZE_BYTES=0
log "  Database size estimate: ${DB_SIZE_BYTES} bytes"

# Resolve storage volume name from compose config (project_name + volume source)
STORAGE_VOLUME=$(docker compose config --format json 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    project_name = d.get("name", "")
    backend = d.get("services", {}).get("backend", {})
    for v in backend.get("volumes", []):
        if isinstance(v, dict):
            target = v.get("target", "")
            source = v.get("source", "")
        else:
            parts = v.split(":")
            target = parts[1] if len(parts) >= 2 else ""
            source = parts[0]
        if target == "/storage" and source:
            if project_name:
                print(project_name + "_" + source)
            else:
                print(source)
            break
except Exception:
    pass
' 2>/dev/null || true)

STORAGE_SIZE_BYTES=0
if [ -n "$STORAGE_VOLUME" ]; then
  STORAGE_SIZE_BYTES=$(docker run --rm -v "${STORAGE_VOLUME}:/storage" "$BACKEND_IMAGE" \
    du -sb /storage 2>/dev/null | awk '{print $1}' || echo 0)
  [ "$STORAGE_SIZE_BYTES" -gt 0 ] 2>/dev/null || STORAGE_SIZE_BYTES=0
  log "  Storage size estimate: ${STORAGE_SIZE_BYTES} bytes (volume: $STORAGE_VOLUME)"
fi

# Require at least 1.5x the uncompressed estimate, expressed in KiB.
# df -Pk reports 1K-blocks, so both sides of the comparison use the same unit.
DB_SIZE_KB=$(( (DB_SIZE_BYTES + 1023) / 1024 ))
STORAGE_SIZE_KB=$(( (STORAGE_SIZE_BYTES + 1023) / 1024 ))
RAW_TOTAL_KB=$(( DB_SIZE_KB + STORAGE_SIZE_KB ))
if [ "$RAW_TOTAL_KB" -gt 0 ]; then
  REQUIRED_SPACE_KB=$(( RAW_TOTAL_KB + RAW_TOTAL_KB / 2 ))
else
  # Fallback: require at least 1 GiB when estimates are unavailable.
  REQUIRED_SPACE_KB=1048576
fi

FREE_KB=$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -gt 0 ] 2>/dev/null; then
  if [ "$REQUIRED_SPACE_KB" -gt "$FREE_KB" ]; then
    err "Insufficient disk space: need at least ${REQUIRED_SPACE_KB} KiB, available ${FREE_KB} KiB"
    log_json 'backup_failed' ',"error":"insufficient_disk_space","required_kib":'"$REQUIRED_SPACE_KB"',"available_kib":'"$FREE_KB"',"exit_code":3'
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "insufficient_disk_space required_kib=$REQUIRED_SPACE_KB available_kib=$FREE_KB" > "$LAST_FAILURE_FILE"
    exit 3
  fi
  log "  Disk space: OK (need ${REQUIRED_SPACE_KB} KiB, have ${FREE_KB} KiB)"
else
  err "Could not determine free space for BACKUP_DIR; refusing to continue"
  log_json 'backup_failed' ',"error":"disk_space_unknown","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "disk_space_unknown" > "$LAST_FAILURE_FILE"
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 1: PostgreSQL dump → STAGING (not yet published)
# ---------------------------------------------------------------------------
echo "[1/6] Dumping PostgreSQL database to staging..."
if docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$STAGING_DB"; then
  log "  PostgreSQL dump staged: $STAGING_DB"
else
  RC=$?
  err "PostgreSQL dump failed (exit code $RC)"
  log_json "backup_failed" ',"error":"pg_dump_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "pg_dump_failed exit_code=$RC" > "$LAST_FAILURE_FILE"
  exit 1
fi

# Verify DB dump
if [ ! -f "$STAGING_DB" ] || [ ! -s "$STAGING_DB" ]; then
  err "PostgreSQL dump file missing or empty"
  log_json "backup_failed" ',"error":"dump_empty","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "dump_empty" > "$LAST_FAILURE_FILE"
  exit 1
fi

if ! gzip -t "$STAGING_DB"; then
  err "PostgreSQL dump gzip integrity check failed"
  log_json "backup_failed" ',"error":"dump_gzip_invalid","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "dump_gzip_invalid" > "$LAST_FAILURE_FILE"
  exit 1
fi

if ! gunzip -c "$STAGING_DB" | grep -qE 'CREATE TABLE|CREATE TABLE IF NOT EXISTS|CREATE EXTENSION'; then
  err "PostgreSQL dump does not contain expected SQL structure"
  log_json "backup_failed" ',"error":"dump_no_ddl","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "dump_no_ddl" > "$LAST_FAILURE_FILE"
  exit 1
fi

PG_DUMP_SIZE=$(file_size "$STAGING_DB")
PG_DUMP_SHA256=$(sha256_hex "$STAGING_DB") || {
  err "Failed to compute SHA256 of PostgreSQL dump"
  log_json "backup_failed" ',"error":"sha256_db_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "sha256_db_failed" > "$LAST_FAILURE_FILE"
  exit 1
}
log "  PostgreSQL dump: ${PG_DUMP_SIZE} bytes, SHA256: $PG_DUMP_SHA256"

# Collect PostgreSQL version
PG_VERSION=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SHOW server_version" 2>/dev/null | tr -d '[:space:]' || echo "unknown")

# Collect migration count
MIGRATION_COUNT=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COALESCE((SELECT count(*) FROM migrations), 0)" 2>/dev/null | tr -d '[:space:]' || echo 0)

# Collect app version from package.json
APP_VERSION="unknown"
BACKEND_PKG="$PROJECT_ROOT/backend/package.json"
if [ -f "$BACKEND_PKG" ]; then
  APP_VERSION=$(python3 -c "import json; print(json.load(open('$BACKEND_PKG')).get('version','unknown'))" 2>/dev/null || echo "unknown")
fi

# ---------------------------------------------------------------------------
# Phase 2: Storage archive → STAGING
# ---------------------------------------------------------------------------
echo "[2/6] Archiving storage files to staging..."

if [ -n "$STORAGE_VOLUME" ]; then
  # Docker named volume path (preferred — what Phase 5.1 §2.1 says actually executes)
  if ! docker run --rm -v "${STORAGE_VOLUME}:/storage" "$BACKEND_IMAGE" \
    tar -czf - --exclude='.tmp' --exclude='*.tmp' -C /storage . > "$STAGING_STOR"; then
    RC=$?
    err "Storage archive creation failed (exit code $RC)"
    log_json "backup_failed" ',"error":"storage_tar_failed","exit_code":1'
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_tar_failed exit_code=$RC" > "$LAST_FAILURE_FILE"
    exit 1
  fi
  log "  Storage archive staged (via Docker named volume $STORAGE_VOLUME)"
elif [ -d "$STORAGE_PATH" ]; then
  # Local path fallback
  if ! tar -czf "$STAGING_STOR" --exclude='.tmp' --exclude='*.tmp' -C "$STORAGE_PATH" . ; then
    RC=$?
    err "Storage archive creation failed (exit code $RC)"
    log_json "backup_failed" ',"error":"storage_tar_failed","exit_code":1'
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_tar_failed exit_code=$RC" > "$LAST_FAILURE_FILE"
    exit 1
  fi
  log "  Storage archive staged (via local path $STORAGE_PATH)"
else
  err "Storage not accessible: no Docker volume resolved and local path '$STORAGE_PATH' not found"
  log_json "backup_failed" ',"error":"storage_not_accessible","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_not_accessible" > "$LAST_FAILURE_FILE"
  exit 1
fi

# Verify storage archive
if [ ! -f "$STAGING_STOR" ] || [ ! -s "$STAGING_STOR" ]; then
  err "Storage archive file missing or empty"
  log_json "backup_failed" ',"error":"storage_empty","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_empty" > "$LAST_FAILURE_FILE"
  exit 1
fi

if ! tar -tzf "$STAGING_STOR" >/dev/null 2>&1; then
  err "Storage archive tar integrity check failed"
  log_json "backup_failed" ',"error":"storage_tar_integrity_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_tar_integrity_failed" > "$LAST_FAILURE_FILE"
  exit 1
fi

STORAGE_SIZE=$(file_size "$STAGING_STOR")
STORAGE_SHA256=$(sha256_hex "$STAGING_STOR") || {
  err "Failed to compute SHA256 of storage archive"
  log_json "backup_failed" ',"error":"sha256_storage_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "sha256_storage_failed" > "$LAST_FAILURE_FILE"
  exit 1
}

# Count files in storage archive
STORAGE_FILE_COUNT=$(python3 -c '
import tarfile, sys
try:
    with tarfile.open(sys.argv[1], "r:gz") as tf:
        print(sum(1 for m in tf.getmembers() if m.isfile()))
except Exception:
    print(0)
' "$STAGING_STOR" 2>/dev/null || echo 0)

log "  Storage archive: ${STORAGE_SIZE} bytes, SHA256: $STORAGE_SHA256, files: $STORAGE_FILE_COUNT"

# ---------------------------------------------------------------------------
# Phase 3: Validate ALL staging artifacts
# ---------------------------------------------------------------------------
echo "[3/6] Validating staging artifacts..."

# Re-verify checksums (guard against TOCTOU)
DB_SHA_RECHECK=$(sha256_hex "$STAGING_DB") || {
  err "Failed to recompute SHA256 of PostgreSQL dump"
  log_json "backup_failed" ',"error":"sha256_db_recheck_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "sha256_db_recheck_failed" > "$LAST_FAILURE_FILE"
  exit 1
}
STOR_SHA_RECHECK=$(sha256_hex "$STAGING_STOR") || {
  err "Failed to recompute SHA256 of storage archive"
  log_json "backup_failed" ',"error":"sha256_storage_recheck_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "sha256_storage_recheck_failed" > "$LAST_FAILURE_FILE"
  exit 1
}
if [ "$DB_SHA_RECHECK" != "$PG_DUMP_SHA256" ]; then
  err "DB dump checksum changed during staging (possible corruption)"
  log_json "backup_failed" ',"error":"db_checksum_mismatch","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "db_checksum_mismatch" > "$LAST_FAILURE_FILE"
  exit 1
fi
if [ "$STOR_SHA_RECHECK" != "$STORAGE_SHA256" ]; then
  err "Storage archive checksum changed during staging (possible corruption)"
  log_json "backup_failed" ',"error":"storage_checksum_mismatch","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_checksum_mismatch" > "$LAST_FAILURE_FILE"
  exit 1
fi

# Re-verify file count
ARCHIVE_FC=$(python3 -c '
import tarfile, sys
try:
    with tarfile.open(sys.argv[1], "r:gz") as tf:
        print(sum(1 for m in tf.getmembers() if m.isfile()))
except Exception:
    print("ERROR", file=sys.stderr)
    sys.exit(1)
' "$STAGING_STOR" 2>/dev/null || echo "ERROR")
if [ "$ARCHIVE_FC" = "ERROR" ]; then
  err "Cannot re-read storage archive for file count verification"
  log_json "backup_failed" ',"error":"storage_archive_unreadable","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "storage_archive_unreadable" > "$LAST_FAILURE_FILE"
  exit 1
fi
if [ "$ARCHIVE_FC" != "$STORAGE_FILE_COUNT" ]; then
  err "Storage file count mismatch (first=$STORAGE_FILE_COUNT, recheck=$ARCHIVE_FC)"
  log_json "backup_failed" ',"error":"file_count_mismatch","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "file_count_mismatch first=$STORAGE_FILE_COUNT recheck=$ARCHIVE_FC" > "$LAST_FAILURE_FILE"
  exit 1
fi

log "  All staging artifacts verified: OK"

# ---------------------------------------------------------------------------
# Phase 4: Generate .meta (Python JSON serializer — no heredoc injection)
# ---------------------------------------------------------------------------
echo "[4/6] Generating metadata..."

python3 - "$STAGING_META" "$BACKUP_ID" "$TIMESTAMP" "$STAGING_DB" "$STAGING_STOR" \
  "$DB_NAME" "$STORAGE_PATH" "$PG_DUMP_SIZE" "$STORAGE_SIZE" \
  "$PG_DUMP_SHA256" "$STORAGE_SHA256" "$STORAGE_FILE_COUNT" \
  "$RETENTION_DAYS" "$APP_VERSION" "$MIGRATION_COUNT" "$PG_VERSION" <<'PY'
import json, sys, os
from datetime import datetime, timezone

try:
    (meta_path, backup_id, timestamp, db_dump_path, storage_archive_path,
     db_name, storage_path, db_dump_size, storage_archive_size,
     db_dump_sha256, storage_archive_sha256, storage_file_count,
     retention_days, app_version, migration_count, pg_version) = sys.argv[1:]
except ValueError:
    print("ERROR: Expected 17 arguments", file=sys.stderr)
    sys.exit(1)

meta = {
    "format_version": "1",
    "backup_id": backup_id,
    "timestamp": timestamp,
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "db_dump": os.path.basename(db_dump_path),
    "storage_archive": os.path.basename(storage_archive_path),
    "db_name": db_name,
    "storage_path": storage_path,
    "db_dump_size": int(db_dump_size),
    "storage_archive_size": int(storage_archive_size),
    "db_dump_sha256": db_dump_sha256,
    "storage_archive_sha256": storage_archive_sha256,
    "storage_file_count": int(storage_file_count),
    "retention_days": int(retention_days),
    "app_version": app_version,
    "migration_count": int(migration_count) if migration_count.isdigit() else 0,
    "postgresql_version": pg_version,
}

try:
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
except Exception as e:
    print(f"ERROR: Failed to write metadata: {e}", file=sys.stderr)
    sys.exit(1)
PY
META_PY_RC=$?
if [ $META_PY_RC -ne 0 ]; then
  err "Metadata generation failed (exit $META_PY_RC)"
  log_json "backup_failed" ',"error":"meta_generation_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "meta_generation_failed exit_code=$META_PY_RC" > "$LAST_FAILURE_FILE"
  exit 1
fi

# Sidecar .meta.sha256 — exact-byte hash of the .meta file
META_SHA256="$(sha256_hex "$STAGING_META")" || {
  err "Failed to compute SHA256 of metadata file"
  log_json "backup_failed" ',"error":"sha256_meta_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "sha256_meta_failed" > "$LAST_FAILURE_FILE"
  exit 1
}
printf '%s  %s\n' "$META_SHA256" "$(basename "$STAGING_META")" > "$STAGING_META_SHA256"
chmod 600 "$STAGING_META" "$STAGING_META_SHA256" 2>/dev/null || {
  err "Could not restrict metadata permissions in staging"
  exit 1
}
log "  Metadata generated: $STAGING_META"
log "  Metadata hash sidecar: $STAGING_META_SHA256"

# Verify the exact-byte .meta.sha256 sidecar BEFORE publication.
# Re-read the meta file hash and confirm it matches what the sidecar says,
# and that the sidecar references the correct filename.
META_SIDECAR_VERIFY=$(sha256_hex "$STAGING_META") || {
  err "Failed to recompute SHA256 of metadata for sidecar verification"
  log_json "backup_failed" ',"error":"meta_sidecar_verify_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "meta_sidecar_verify_failed" > "$LAST_FAILURE_FILE"
  exit 1
}
# Parse sidecar: exactly one line, format "<hash>  <filename>\n" (two-space sep).
# Use awk with two-space field separator to avoid whitespace ambiguity, then
# verify byte-for-byte that the sidecar contains only this canonical line.
META_SIDECAR_FILE_HASH=$(awk -F'  ' '{print $1}' "$STAGING_META_SHA256" 2>/dev/null || true)
META_SIDECAR_FILE_NAME=$(awk -F'  ' '{print $2}' "$STAGING_META_SHA256" 2>/dev/null || true)
SIDECAR_LINES=$(wc -l < "$STAGING_META_SHA256" 2>/dev/null | tr -d '[:space:]' || echo 0)
SIDECAR_BYTES=$(wc -c < "$STAGING_META_SHA256" 2>/dev/null | tr -d '[:space:]' || echo 0)
# Reconstruct canonical line + newline; byte count must match exactly
SIDECAR_EXPECTED_BYTES=$(printf '%s  %s\n' "$META_SIDECAR_FILE_HASH" "$META_SIDECAR_FILE_NAME" | wc -c | tr -d '[:space:]')
if [ "$SIDECAR_LINES" -ne 1 ] || [ "$SIDECAR_BYTES" -ne "$SIDECAR_EXPECTED_BYTES" ]; then
  err "Metadata sidecar must contain exactly one canonical line"
  log_json "backup_failed" ',"error":"meta_sidecar_malformed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "meta_sidecar_malformed" > "$LAST_FAILURE_FILE"
  exit 1
fi
if [ "$META_SIDECAR_VERIFY" != "$META_SIDECAR_FILE_HASH" ]; then
  err "Metadata sidecar SHA256 mismatch (recomputed=$META_SIDECAR_VERIFY, sidecar=$META_SIDECAR_FILE_HASH)"
  log_json "backup_failed" ',"error":"meta_sidecar_hash_mismatch","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "meta_sidecar_hash_mismatch" > "$LAST_FAILURE_FILE"
  exit 1
fi
if [ "$META_SIDECAR_FILE_NAME" != "$(basename "$STAGING_META")" ]; then
  err "Metadata sidecar filename mismatch (sidecar=$META_SIDECAR_FILE_NAME, actual=$(basename "$STAGING_META"))"
  log_json "backup_failed" ',"error":"meta_sidecar_name_mismatch","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "meta_sidecar_name_mismatch" > "$LAST_FAILURE_FILE"
  exit 1
fi
log "  Metadata sidecar verified: OK"

# ---------------------------------------------------------------------------
# Phase 5: Finalize — atomic move from staging to backup directory
# ---------------------------------------------------------------------------
echo "[5/6] Finalizing backup (atomic publish from staging)..."

# All four artifacts must exist in staging before finalizing
if [ ! -f "$STAGING_DB" ] || [ ! -f "$STAGING_STOR" ] || [ ! -f "$STAGING_META" ] || [ ! -s "$STAGING_META_SHA256" ]; then
  err "Not all staging artifacts present — cannot finalize"
  log_json "backup_failed" ',"error":"missing_staging_artifacts","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "missing_staging_artifacts" > "$LAST_FAILURE_FILE"
  exit 1
fi

# Restrict permissions before publish; the backup directory itself is private.
chmod 600 "$STAGING_DB" "$STAGING_STOR" "$STAGING_META" "$STAGING_META_SHA256" 2>/dev/null || {
  err "Could not restrict staging artifact permissions"
  exit 1
}

# Atomic rename on same filesystem (staging is inside BACKUP_DIR)
mv "$STAGING_DB" "$FINAL_DB"
mv "$STAGING_STOR" "$FINAL_STOR"
mv "$STAGING_META" "$FINAL_META"
mv "$STAGING_META_SHA256" "$FINAL_META_SHA256"

# Restrict permissions on all artifacts
chmod 600 "$FINAL_DB" "$FINAL_STOR" "$FINAL_META" "$FINAL_META_SHA256"

BACKUP_END=$(date +%s)
DURATION=$((BACKUP_END - BACKUP_START))

log "  Published: $(basename "$FINAL_DB"), $(basename "$FINAL_STOR"), $(basename "$FINAL_META"), $(basename "$FINAL_META_SHA256")"
log "  Duration: ${DURATION}s"

# Success marker
printf '%s\n' "$TIMESTAMP" > "$LAST_SUCCESS_FILE"

# Structured one-line JSON summary
log_json "backup_completed" ',"exit_code":0,"db_dump":"'"$(basename "$FINAL_DB")"'","storage_archive":"'"$(basename "$FINAL_STOR")"'","meta":"'"$(basename "$FINAL_META")"'","meta_sha256":"'"$(basename "$FINAL_META_SHA256")"'","duration_seconds":'"$DURATION"

log ""
log "=== Backup completed successfully ==="
log "Backup ID: $BACKUP_ID"
log "Files:"
log "  - $FINAL_DB"
log "  - $FINAL_STOR"
log "  - $FINAL_META"
log "  - $FINAL_META_SHA256"

# ---------------------------------------------------------------------------
# Phase 6: Retention (only on success, keep at least MIN_BACKUPS)
# Uses filename timestamps (not mtime) with malformed/staging/symlink safeguards
# ---------------------------------------------------------------------------
echo "[6/6] Applying retention policy (min $MIN_BACKUPS backups, max ${RETENTION_DAYS} days)..."

python3 - "$BACKUP_DIR" "$MIN_BACKUPS" "$RETENTION_DAYS" "$BACKUP_END" <<'PY'
import os, sys, re, glob
from datetime import datetime, timezone

backup_dir, min_backups, retention_days, now = sys.argv[1:5]
min_backups = int(min_backups)
retention_days = int(retention_days)
now = int(now)

# Timestamp pattern: YYYYMMDD_HHMMSS_<8hex> (8 hex chars from secrets.token_hex(4))
TS_PATTERN = re.compile(r"^homecloud_(\d{8})_(\d{6})_([0-9a-f]{8})\.meta$")

def parse_ts_from_filename(path):
    """Extract timestamp from backup filename.

    Matches YYYYMMDD_HHMMSS_<8hex>.meta where <8hex> is 8 lowercase hex
    characters from secrets.token_hex(4).  The hex suffix is NOT a time
    value and must not be parsed with %f (microseconds).
    Returns datetime or None if malformed.
    """
    basename = os.path.basename(path)
    m = TS_PATTERN.match(basename)
    if not m:
        return None
    date_str, time_str, hex_suffix = m.group(1), m.group(2), m.group(3)
    try:
        dt = datetime.strptime(date_str + time_str, "%Y%m%d%H%M%S")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None

# Find all .meta files (exclude .staging and symlinks/filesystem edge cases)
candidates = []
for m in glob.glob(os.path.join(backup_dir, "homecloud_*.meta")):
    # Safeguard: skip staging directory
    if ".staging" in m:
        continue
    # Safeguard: skip symlinks and non-regular files
    try:
        if os.path.islink(m) or not os.path.isfile(m):
            continue
    except OSError:
        continue
    # Safeguard: reject files with unexpected names that don't match the pattern
    if not TS_PATTERN.match(os.path.basename(m)):
        continue
    dt = parse_ts_from_filename(m)
    if dt is None:
        print(f"  WARNING: Skipping malformed backup filename: {os.path.basename(m)}")
        continue
    candidates.append((dt, m))

# Sort by filename timestamp (newest first)
candidates.sort(key=lambda x: x[0], reverse=True)

total = len(candidates)
if total <= min_backups:
    print(f"  Only {total} backup(s) exist (minimum {min_backups}) — retention skipped")
    sys.exit(0)

# Keep newest min_backups; delete older ones past retention window
retention_errors = []
deleted = 0
for dt, meta_path in candidates[min_backups:]:
    age_days = int((now - int(dt.timestamp())) / 86400)
    if age_days >= retention_days:
        meta_basename = os.path.basename(meta_path).replace(".meta", "")
        backup_ts = meta_basename.replace("homecloud_", "", 1) if meta_basename.startswith("homecloud_") else meta_basename
        db_file = os.path.join(backup_dir, f"homecloud_db_{backup_ts}.sql.gz")
        stor_file = os.path.join(backup_dir, f"homecloud_storage_{backup_ts}.tar.gz")
        meta_sha256_file = os.path.join(backup_dir, f"homecloud_{backup_ts}.meta.sha256")
        for f in [meta_path, db_file, stor_file, meta_sha256_file]:
            # Safeguard: never remove symlinks during retention
            try:
                if os.path.islink(f):
                    retention_errors.append(f"Refusing to remove symlink during retention: {f}")
                    continue
            except OSError:
                continue
            if os.path.exists(f):
                try:
                    os.remove(f)
                except OSError as e:
                    retention_errors.append(f"Failed to remove {f}: {e}")
            # Missing files are not errors (orphan cleanup), only removal failures
        deleted += 1
        print(f"  Removed old backup: {backup_ts} (age: {age_days}d)")

# Re-enumerate to count remaining (fresh glob to avoid stale counts)
remaining = 0
for m in glob.glob(os.path.join(backup_dir, "homecloud_*.meta")):
    if ".staging" in m:
        continue
    try:
        if os.path.islink(m) or not os.path.isfile(m):
            continue
    except OSError:
        continue
    remaining += 1
print(f"  Retention complete. Removed {deleted} backup set(s). Remaining: {remaining}")

if retention_errors:
    print("  Retention ERRORS (fail-closed):", file=sys.stderr)
    for e in retention_errors:
        print(f"    - {e}", file=sys.stderr)
    sys.exit(1)
PY
RETENTION_RC=$?
if [ "$RETENTION_RC" -ne 0 ]; then
  err "Retention encountered errors (exit code $RETENTION_RC)"
  log_json "backup_failed" ',"error":"retention_failed","exit_code":1'
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "retention_failed exit_code=$RETENTION_RC" > "$LAST_FAILURE_FILE"
  exit 1
fi

exit 0
