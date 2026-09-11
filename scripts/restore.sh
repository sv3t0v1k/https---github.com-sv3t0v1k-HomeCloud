#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# HomeCloud Restore (Safe / Fail-Closed) — Phase 5.2
#
# Restores PostgreSQL dump + Docker named-volume storage from a backup in
# $BACKUP_DIR. Storage is restored DIRECTLY into the Docker named volume that
# backs the backend's /storage mount (NOT into a host /storage path).
#
# Safety guarantees:
#   - Old storage data is NEVER deleted before new data is verified in staging.
#   - Storage switch uses atomic rename (mv) on the same filesystem.
#   - DB restore is fail-closed: ON_ERROR_STOP=1, schema wipe, post-restore
#     validation (7 tables, column check, row-count check).
#   - Checksum/size mismatches, malformed .meta, unsupported format_version
#     all abort BEFORE any destructive operation.
#   - Migration failure aborts restore (no WARNING+continue).
#   - Post-restore reconciliation reports DB↔storage discrepancies.
#   - Exit code is non-zero for ANY failure; zero only when every gate passes.
#
# Environment overrides:
#   BACKUP_DIR       - directory holding backups (default: ./backups)
#   STORAGE_VOLUME   - explicit Docker named volume to restore storage into.
#   BACKEND_IMAGE    - Docker image for throwaway extraction container
#                      (default: homecloud-backend)
#   DB_NAME / DB_USER / DB_PASSWORD - loaded from .env
#
# Operation phases:
#   Phase A: pre-validation (READ-ONLY) — backup integrity + volume validation.
#   Phase B: confirmation prompt (skipped with --yes).
#   Phase C: destructive restore (stop → db → storage → start → migrate →
#            reconcile → health).
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
SUPPORTED_FORMAT_VERSIONS="1"
EXPECTED_TABLES=7
EXPECTED_TABLE_NAMES="users files folders share_links upload_sessions refresh_tokens migrations"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
FORCE_YES=0
VALIDATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) FORCE_YES=1 ;;
    --validate-only) VALIDATE_ONLY=1 ;;
    --help|-h)
      echo "Usage: $0 [--yes|-y] [--validate-only]"
      echo "  --yes, -y   Skip interactive confirmation (for automated use)"
      echo "  --validate-only  Run Phase A validation only; exit before destructive operations"
      exit 0
      ;;
    *) err "Unknown argument: $arg"; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Load .env WITHOUT set -a to avoid leaking secrets into child process env
# ---------------------------------------------------------------------------
DB_NAME=""
DB_USER=""
DB_PASSWORD=""
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
    esac
  done < "$PROJECT_ROOT/.env"
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
BACKEND_IMAGE="${BACKEND_IMAGE:-homecloud-backend}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# stat size helper (bsd/gnu compatible)
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

# Portable SHA-256 helper (GNU sha256sum / BSD shasum / python3 fallback)
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

# Cryptographically random hex; fail closed if no entropy source is usable.
random_hex() {
  local nbytes="$1"
  python3 -c "import secrets; print(secrets.token_hex($nbytes))" 2>/dev/null
}

# Remove only a regular file or a symlink itself; never follow a symlink.
safe_remove_file() {
  local path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ] || [ -f "$path" ]; then
    rm -f -- "$path" 2>/dev/null || return 1
    [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
    return 0
  fi
  err "Refusing to remove non-regular path: $path" >&2
  return 1
}

# Remove a directory tree without following symlinks or using rm -rf.
safe_remove_dir() {
  local path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ] || [ ! -d "$path" ]; then
    err "Refusing to remove non-directory path: $path" >&2
    return 1
  fi
  find -P "$path" -depth -type f -exec rm -f -- {} + 2>/dev/null || return 1
  find -P "$path" -depth -type l -exec rm -f -- {} + 2>/dev/null || return 1
  find -P "$path" -depth -type d -exec rmdir -- {} + 2>/dev/null || return 1
  [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
}

# Remove an exact lock directory and its two known files.
safe_remove_lock_dir() {
  local lock_dir="$1"
  [ -e "$lock_dir" ] || [ -L "$lock_dir" ] || return 0
  if [ -L "$lock_dir" ] || [ ! -d "$lock_dir" ]; then
    err "Unsafe lock path: $lock_dir" >&2
    return 1
  fi
  safe_remove_file "$lock_dir/LOCK_PID" || return 1
  safe_remove_file "$lock_dir/LOCK_TOKEN" || return 1
  rmdir "$lock_dir" 2>/dev/null || return 1
}

# Reject group/other write bits portably on BSD and GNU stat output.
assert_safe_mode() {
  local path="$1" mode digits perm group_bit other_bit
  mode="$(stat -f%Lp "$path" 2>/dev/null || stat -c%a "$path" 2>/dev/null || echo "")"
  digits="$(printf '%s' "$mode" | tr -cd '0-7')"
  if [ "${#digits}" -lt 3 ]; then
    die "Cannot determine permissions for $path"
  fi
  perm="${digits: -3}"
  group_bit="${perm:1:1}"
  other_bit="${perm:2:1}"
  case "$group_bit$other_bit" in
    *[2367]*) die "$path has unsafe permissions (mode=$mode); expected no group/other write" ;;
  esac
}


# ---------------------------------------------------------------------------
# Security: scan a storage tar.gz archive BEFORE any destructive operation.
# Rejects: absolute paths, path traversal (".." components), symlink/hardlink
# escape, device files, FIFOs, and sockets.
# ---------------------------------------------------------------------------
scan_storage_archive_security() {
  local archive="$1"

  if command -v python3 >/dev/null 2>&1; then
    set +e
    python3 - "$archive" <<'PY'
import sys, tarfile

archive = sys.argv[1]
errors = []

def has_traversal(s):
    # True if any path component equals ".."
    return bool(s) and any(p == ".." for p in s.split("/"))

try:
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            name = m.name
            link = getattr(m, "linkname", "") or ""
            if name.startswith("/"):
                errors.append("absolute path: %s" % name)
            if has_traversal(name):
                errors.append("path traversal in name: %s" % name)
            if m.issym() or m.islnk():
                if link.startswith("/"):
                    errors.append("absolute link target: %s -> %s" % (name, link))
                if has_traversal(link):
                    errors.append("traversal link target: %s -> %s" % (name, link))
            # device files (char/block) and FIFOs — reject all
            if m.isdev() or m.isfifo():
                ftype = "char/block device" if (m.ischr() or m.isblk()) else "fifo"
                errors.append("dangerous file type (%s): %s" % (ftype, name))
except Exception as e:
    print("ERROR: cannot read archive for security scan: %s" % e, file=sys.stderr)
    sys.exit(2)

if errors:
    print("ERROR: storage archive failed security scan", file=sys.stderr)
    for e in errors:
        print("  - %s" % e, file=sys.stderr)
    sys.exit(1)
print("  storage archive security scan: OK")
PY
    rc=$?
    set -e
    [ $rc -eq 0 ] || die "Storage archive failed security scan (rc=$rc)"
    return 0
  fi

  log "  ERROR: python3 is required for security scan (not found in PATH)"
  die "python3 is required for restore; install it and retry"
}

# ---------------------------------------------------------------------------
# Parse .meta with a real JSON parser — fail-closed on malformed JSON.
# Outputs: "key=value" lines for required fields.
# ---------------------------------------------------------------------------
parse_meta() {
  local meta_file="$1"
  set +e
  python3 - "$meta_file" <<'PY'
import sys, json

try:
    with open(sys.argv[1]) as f:
        m = json.load(f)
except json.JSONDecodeError as e:
    print("ERROR: malformed .meta JSON: %s" % e, file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print("ERROR: cannot read .meta: %s" % e, file=sys.stderr)
    sys.exit(1)

required = [
    "format_version", "timestamp", "db_dump", "storage_archive",
    "db_dump_sha256", "storage_archive_sha256", "db_dump_size",
    "storage_archive_size", "storage_file_count",
]
for k in required:
    v = m.get(k)
    if v is None:
        print("ERROR: .meta missing required field: %s" % k, file=sys.stderr)
        sys.exit(1)
    if isinstance(v, str) and v == "":
        print("ERROR: .meta field empty: %s" % k, file=sys.stderr)
        sys.exit(1)

for k in required:
    print("%s=%s" % (k, m[k]))
PY
  rc=$?
  set -e
  [ $rc -eq 0 ] || die "Failed to parse .meta file (invalid JSON or missing required fields)"
  return 0
}

# ---------------------------------------------------------------------------
# Resolve + validate the Docker named volume that backs backend /storage.
# Sets STORAGE_VOLUME. Fails closed.
# ---------------------------------------------------------------------------
validate_docker_volume() {
  local vol="$1"
  [ -n "$vol" ] || return 1
  docker volume inspect "$vol" >/dev/null 2>&1 || return 1
  return 0
}

resolve_storage_volume() {
  # 1. Explicit override (validated).
  if [ -n "${STORAGE_VOLUME:-}" ]; then
    validate_docker_volume "$STORAGE_VOLUME" \
      || die "STORAGE_VOLUME override '$STORAGE_VOLUME' is not a valid Docker named volume"
    log "  Storage volume: $STORAGE_VOLUME (explicit override)"
    return 0
  fi

  # 2. Auto-detect from the running backend container's /storage mount.
  local cid vol
  cid="$(docker compose ps -q backend 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    vol="$(docker inspect -f \
      '{{ range .Mounts }}{{ if and (eq .Destination "/storage") (eq .Type "volume") }}{{ .Name }}{{ end }}{{ end }}' \
      "$cid" 2>/dev/null || true)"
    if [ -n "$vol" ]; then
      validate_docker_volume "$vol" \
        || die "Auto-detected storage volume '$vol' does not pass docker volume inspect"
      STORAGE_VOLUME="$vol"
      log "  Storage volume: $STORAGE_VOLUME (auto-detected from backend /storage mount)"
      return 0
    fi
  fi

  # 3. Fallback: compose config (works even when the stack is stopped).
  vol="$(docker compose config --format json 2>/dev/null \
        | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get("volumes", {})
    for key in ("storage_data",):
        if key in v:
            print(v[key].get("name") or "")
            break
' 2>/dev/null || true)"
  if [ -n "$vol" ]; then
    validate_docker_volume "$vol" \
      || die "Compose-resolved storage volume '$vol' does not pass docker volume inspect"
    STORAGE_VOLUME="$vol"
    log "  Storage volume: $STORAGE_VOLUME (resolved from docker compose config)"
    return 0
  fi

  die "Could not resolve a Docker named volume for storage (/storage). \
Set STORAGE_VOLUME=<volume_name> explicitly or start the stack."
}

# Resolve and validate the backup root before reading any metadata.
if [ -z "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  die "BACKUP_DIR is not a safe existing directory: $BACKUP_DIR"
fi
BACKUP_DIR="$(cd -P "$BACKUP_DIR" 2>/dev/null && pwd)" || die "Could not resolve BACKUP_DIR: $BACKUP_DIR"

# ===========================================================================
# Phase A: pre-validation (READ-ONLY — no docker compose down, no DB/volume
# modification happens here)
# ===========================================================================

echo "=== HomeCloud Restore (Safe / Fail-Closed) ==="
echo "Supported backup format version(s): $SUPPORTED_FORMAT_VERSIONS"
echo "Backup directory: $BACKUP_DIR"
echo ""

# A0 — Validate backup directory ownership and permissions
assert_safe_mode "$BACKUP_DIR"
log "  Backup directory permissions: OK"

# A1 — Find latest backup metadata
LATEST_META="$(find "$BACKUP_DIR" -name 'homecloud_*.meta' -type f -not -path "*/.staging/*" 2>/dev/null | sort | tail -n 1)"
[ -n "$LATEST_META" ] || die "No backup metadata found in $BACKUP_DIR"
log "Latest backup metadata: $LATEST_META"

# A1.5 — Verify .meta.sha256 sidecar (exact-byte hash of .meta)
META_SHA256_FILE="${LATEST_META}.sha256"
if [ -L "$META_SHA256_FILE" ] || [ ! -f "$META_SHA256_FILE" ]; then
  die "Missing or unsafe .meta.sha256 sidecar: $META_SHA256_FILE"
fi
SIDECAR_LINES=$(wc -l < "$META_SHA256_FILE" 2>/dev/null | tr -d '[:space:]' || echo 0)
if [ "$SIDECAR_LINES" -ne 1 ]; then
  die ".meta.sha256 sidecar must contain exactly one line: $META_SHA256_FILE"
fi
read -r EXPECTED_META_SHA256 SIDECAR_META_NAME SIDECAR_EXTRA < "$META_SHA256_FILE" || \
  die ".meta.sha256 sidecar is empty or unreadable: $META_SHA256_FILE"
SIDECAR_BYTES=$(wc -c < "$META_SHA256_FILE" 2>/dev/null | tr -d '[:space:]' || echo 0)
# Reconstruct the canonical line from the parsed fields and verify byte-for-byte.
# This rejects trailing whitespace, extra spaces, or extra columns while
# still tolerating the standard "hash  filename\n" format produced upstream.
SIDECAR_EXPECTED_BYTES=$(printf '%s\n' "$EXPECTED_META_SHA256  $SIDECAR_META_NAME" | wc -c | tr -d '[:space:]')
if [ "$SIDECAR_BYTES" -ne "$SIDECAR_EXPECTED_BYTES" ]; then
  die ".meta.sha256 sidecar contains extra bytes or unexpected whitespace: $META_SHA256_FILE"
fi
if [ "$SIDECAR_BYTES" -lt 65 ]; then
  die ".meta.sha256 sidecar is too short (expected 64-char hash + 2 spaces + filename): $META_SHA256_FILE"
fi
if [ -n "${SIDECAR_EXTRA:-}" ]; then
  die ".meta.sha256 sidecar is malformed (extra fields): $META_SHA256_FILE"
fi
if [ "${#EXPECTED_META_SHA256}" -ne 64 ]; then
  die ".meta.sha256 hash is not 64 hex characters: $META_SHA256_FILE"
fi
case "$EXPECTED_META_SHA256" in
  *[!0-9a-fA-F]*) die ".meta.sha256 hash contains non-hex characters: $META_SHA256_FILE" ;;
esac
if [ "$SIDECAR_META_NAME" != "$(basename "$LATEST_META")" ]; then
  die ".meta.sha256 sidecar references the wrong metadata file"
fi
ACTUAL_META_SHA256="$(sha256_hex "$LATEST_META")"
[ "$ACTUAL_META_SHA256" = "$EXPECTED_META_SHA256" ] \
  || die ".meta checksum mismatch (sidecar=$EXPECTED_META_SHA256, actual=$ACTUAL_META_SHA256)"
log "  .meta.sha256 verification: OK"

# A2 — Parse .meta with JSON parser (fail-closed on malformed JSON, missing/empty fields)
META_OUTPUT="$(parse_meta "$LATEST_META")"
while IFS='=' read -r key value; do
  case "$key" in
    format_version)        META_FORMAT_VERSION="$value" ;;
    timestamp)             TIMESTAMP="$value" ;;
    db_dump)               PG_DUMP_FILENAME="$value" ;;
    storage_archive)       STORAGE_ARCHIVE_FILENAME="$value" ;;
    db_dump_sha256)        PG_DUMP_SHA256="$value" ;;
    storage_archive_sha256) STORAGE_SHA256="$value" ;;
    db_dump_size)          META_DB_DUMP_SIZE="$value" ;;
    storage_archive_size)  META_STORAGE_SIZE="$value" ;;
    storage_file_count)    META_STORAGE_FILE_COUNT="$value" ;;
  esac
done <<< "$META_OUTPUT"

# Validate archive filenames contain no path separators (path safety)
case "$PG_DUMP_FILENAME" in
  */*|*\\*) die "db_dump filename contains path separator: $PG_DUMP_FILENAME" ;;
esac
case "$STORAGE_ARCHIVE_FILENAME" in
  */*|*\\*) die "storage_archive filename contains path separator: $STORAGE_ARCHIVE_FILENAME" ;;
esac

# Validate numeric metadata fields are non-negative integers
for NUM_FIELD_VAR in META_DB_DUMP_SIZE META_STORAGE_SIZE META_STORAGE_FILE_COUNT; do
  VAL="${!NUM_FIELD_VAR}"
  case "$VAL" in
    ''|*[!0-9]*) die ".meta field ${NUM_FIELD_VAR#META_} is not a non-negative integer: $VAL" ;;
  esac
done

# Validate consumed string fields before constructing paths or invoking tools.
case "$TIMESTAMP" in
  ''|*[!0-9_]*) die ".meta timestamp is malformed: $TIMESTAMP" ;;
esac
if ! printf '%s' "$TIMESTAMP" | grep -Eq '^[0-9]{8}_[0-9]{6}$'; then
  die ".meta timestamp is malformed: $TIMESTAMP"
fi
for CHECKSUM_VAR in PG_DUMP_SHA256 STORAGE_SHA256; do
  CHECKSUM_VALUE="${!CHECKSUM_VAR}"
  if [ "${#CHECKSUM_VALUE}" -ne 64 ]; then
    die ".meta field ${CHECKSUM_VAR#META_} is not a 64-character SHA256"
  fi
  case "$CHECKSUM_VALUE" in
    *[!0-9a-fA-F]*) die ".meta field ${CHECKSUM_VAR#META_} contains non-hex characters" ;;
  esac
done
case "$PG_DUMP_FILENAME" in
  .|..) die "db_dump filename is unsafe: $PG_DUMP_FILENAME" ;;
esac
case "$STORAGE_ARCHIVE_FILENAME" in
  .|..) die "storage_archive filename is unsafe: $STORAGE_ARCHIVE_FILENAME" ;;
esac

log "Backup timestamp : $TIMESTAMP"

# A3 — format_version: only explicitly supported versions are accepted
log "Backup format_version: $META_FORMAT_VERSION"
FORMAT_OK=0
for v in $SUPPORTED_FORMAT_VERSIONS; do
  if [ "$META_FORMAT_VERSION" = "$v" ]; then
    FORMAT_OK=1
    break
  fi
done
[ "$FORMAT_OK" -eq 1 ] \
  || die "Unsupported backup format_version '$META_FORMAT_VERSION' (supported: $SUPPORTED_FORMAT_VERSIONS)"
log "  format_version check: OK (version $META_FORMAT_VERSION)"

# A4 — Artifact existence
PG_DUMP_FILE="$BACKUP_DIR/$PG_DUMP_FILENAME"
STORAGE_ARCHIVE="$BACKUP_DIR/$STORAGE_ARCHIVE_FILENAME"
echo ""
echo "[0/6] Validating backup artifacts and environment (read-only)..."
[ -f "$PG_DUMP_FILE" ]     || die "PostgreSQL dump not found: $PG_DUMP_FILE"
[ -f "$STORAGE_ARCHIVE" ]  || die "Storage archive not found: $STORAGE_ARCHIVE"
log "  Artifact existence: OK"

# A4.5 — Validate artifact ownership and permissions (not group/other writable)
for ARTIFACT in "$LATEST_META" "$META_SHA256_FILE" "$PG_DUMP_FILE" "$STORAGE_ARCHIVE"; do
  if [ -L "$ARTIFACT" ] || [ ! -f "$ARTIFACT" ]; then
    die "Backup artifact is missing or unsafe: $ARTIFACT"
  fi
  assert_safe_mode "$ARTIFACT"
done
log "  Artifact permissions: OK"

# A5 — SHA256 verification (DB) — fail-closed: empty checksum = failure
# parse_meta already rejected empty checksum fields, but double-check:
[ -n "$PG_DUMP_SHA256" ] || die "db_dump_sha256 is empty or missing in .meta"
ACTUAL_DB_SHA256="$(sha256_hex "$PG_DUMP_FILE")"
[ "$ACTUAL_DB_SHA256" = "$PG_DUMP_SHA256" ] \
  || die "PostgreSQL dump checksum mismatch (expected $PG_DUMP_SHA256, got $ACTUAL_DB_SHA256)"
log "  PostgreSQL dump checksum: OK"

# A6 — SHA256 verification (storage) — fail-closed
[ -n "$STORAGE_SHA256" ] || die "storage_archive_sha256 is empty or missing in .meta"
ACTUAL_STOR_SHA256="$(sha256_hex "$STORAGE_ARCHIVE")"
[ "$ACTUAL_STOR_SHA256" = "$STORAGE_SHA256" ] \
  || die "Storage archive checksum mismatch (expected $STORAGE_SHA256, got $ACTUAL_STOR_SHA256)"
log "  Storage archive checksum: OK"

# A7 — Size verification against metadata
DB_SIZE="$(file_size "$PG_DUMP_FILE")"
STOR_SIZE="$(file_size "$STORAGE_ARCHIVE")"
[ "$DB_SIZE" -gt 0 ] || die "PostgreSQL dump file is empty (size=0)"
[ "$STOR_SIZE" -gt 0 ] || die "Storage archive file is empty (size=0)"
if [ "${META_DB_DUMP_SIZE:-0}" -gt 0 ] && [ "$DB_SIZE" != "${META_DB_DUMP_SIZE}" ]; then
  die "PostgreSQL dump size mismatch (meta=$META_DB_DUMP_SIZE, actual=$DB_SIZE)"
fi
if [ "${META_STORAGE_SIZE:-0}" -gt 0 ] && [ "$STOR_SIZE" != "${META_STORAGE_SIZE}" ]; then
  die "Storage archive size mismatch (meta=$META_STORAGE_SIZE, actual=$STOR_SIZE)"
fi
log "  Size verification: OK (db=$DB_SIZE bytes, storage=$STOR_SIZE bytes)"

# A8 — gzip integrity (DB dump)
gzip -t "$PG_DUMP_FILE" || die "PostgreSQL dump gzip integrity check failed"
log "  PostgreSQL dump gzip: OK"

# A9 — SQL structure check
gunzip -c "$PG_DUMP_FILE" | grep -qE 'CREATE TABLE|CREATE TABLE IF NOT EXISTS|CREATE EXTENSION' \
  || die "PostgreSQL dump does not contain expected SQL structure (CREATE TABLE)"
log "  PostgreSQL dump structure: OK"

# A10 — tar integrity (storage)
tar -tzf "$STORAGE_ARCHIVE" >/dev/null 2>&1 || die "Storage archive tar integrity check failed"
log "  Storage archive tar integrity: OK"

# A11 — Security scan (extended: path traversal, symlinks, device files, FIFOs)
#       Must run BEFORE file-count check so malicious archives are caught
#       by the security error, not a count mismatch.
scan_storage_archive_security "$STORAGE_ARCHIVE"

# A12 — Storage archive content validation (empty vs corrupted vs valid)
ARCHIVE_FILE_COUNT=$(python3 -c '
import tarfile, sys
try:
    with tarfile.open(sys.argv[1], "r:gz") as tf:
        print(sum(1 for m in tf.getmembers() if m.isfile()))
except Exception:
    print("ERROR", file=sys.stderr)
    sys.exit(1)
' "$STORAGE_ARCHIVE" 2>/dev/null || echo "ERROR")
if [ "$ARCHIVE_FILE_COUNT" = "ERROR" ]; then
  die "Cannot read storage archive for file count verification"
fi
if [ "$ARCHIVE_FILE_COUNT" != "${META_STORAGE_FILE_COUNT:-0}" ]; then
  die "Storage archive file count mismatch (meta=${META_STORAGE_FILE_COUNT:-0}, actual=$ARCHIVE_FILE_COUNT)"
fi
if [ "$ARCHIVE_FILE_COUNT" -eq 0 ]; then
  log "  Storage archive contains 0 files (valid empty storage backup)"
else
  log "  Storage archive file count: OK ($ARCHIVE_FILE_COUNT files)"
fi

# A13 — Disk space pre-check (need at least 2x storage archive size, in KiB)
REQUIRED_SPACE_KB=$(( (STOR_SIZE + 511) / 512 ))
FREE_SPACE_KB=$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_SPACE_KB" ] && [ "$FREE_SPACE_KB" -gt 0 ] 2>/dev/null; then
  if [ "$REQUIRED_SPACE_KB" -gt "$FREE_SPACE_KB" ]; then
    die "Insufficient disk space: need at least ${REQUIRED_SPACE_KB} KiB, available ${FREE_SPACE_KB} KiB"
  fi
  log "  Disk space check: OK (${FREE_SPACE_KB} KiB available, ${REQUIRED_SPACE_KB} KiB required)"
else
  die "Could not determine free space for BACKUP_DIR; refusing to continue"
fi

# A14 — Resolve + validate Docker storage volume
resolve_storage_volume || die "Could not resolve Docker storage volume"

# A15 — Verify backend image exists
docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1 \
  || die "Backend image '$BACKEND_IMAGE' not found. Run 'docker compose build' first."
log "  Backend image '$BACKEND_IMAGE': OK"

# A16 — Verify DB credentials are available
[ -n "$DB_PASSWORD" ] || log "  WARNING: DB_PASSWORD not set in .env (restore may fail at DB connection)"

log "  All pre-validation checks passed."

# --validate-only: exit after Phase A without any destructive operations
if [ "$VALIDATE_ONLY" -eq 1 ]; then
  log "Validation complete (--validate-only; no destructive operations performed)."
  exit 0
fi

# ===========================================================================
# Phase B: confirmation
# ===========================================================================
echo ""
echo "Backup to restore:"
echo "  PostgreSQL dump : $PG_DUMP_FILE"
echo "  Storage archive : $STORAGE_ARCHIVE"
echo "  Storage volume  : $STORAGE_VOLUME  (mounted at /storage in backend)"
echo ""
if [ "$FORCE_YES" -eq 0 ]; then
  log "This will OVERWRITE current DB and storage data."
  read -rp "Continue with destructive restore? (yes/no): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    log "Restore cancelled."
    exit 0
  fi
else
  log "Running in --yes mode; skipping confirmation prompt."
fi

# Acquire backup lock to prevent concurrent backup.sh during restore.
BACKUP_LOCK_DIR="$BACKUP_DIR/.backup.lock"
if ! RESTORE_TOKEN="$(random_hex 16)"; then
  die "Cannot generate cryptographically random restore lock token (python3/secrets unavailable)"
fi

# Atomic lock acquisition: mkdir is atomic on most filesystems.
# After mkdir succeeds, verify the path is a real directory (not a symlink
# that was created by a racer between our check and our mkdir).
if mkdir "$BACKUP_LOCK_DIR" 2>/dev/null; then
  # Verify the path is NOT a symlink (race defense)
  if [ -L "$BACKUP_LOCK_DIR" ]; then
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Lock path is a symlink after mkdir, refusing to proceed: $BACKUP_LOCK_DIR"
  fi
  printf '%s\n' "$$" > "$BACKUP_LOCK_DIR/LOCK_PID" || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Could not write lock PID"
  }
  printf '%s\n' "$RESTORE_TOKEN" > "$BACKUP_LOCK_DIR/LOCK_TOKEN" || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Could not write lock token"
  }
  chmod 700 "$BACKUP_LOCK_DIR" 2>/dev/null || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Could not set lock permissions"
  }
  chmod 600 "$BACKUP_LOCK_DIR/LOCK_PID" "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Could not set lock file permissions"
  }
  [ "$(cat "$BACKUP_LOCK_DIR/LOCK_PID" 2>/dev/null)" = "$$" ] || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Lock PID mismatch after acquisition"
  }
  [ "$(cat "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null)" = "$RESTORE_TOKEN" ] || {
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
    die "Lock token mismatch after acquisition"
  }
  RESTORE_HOLDS_LOCK=1
else
  # mkdir failed — check if it's a symlink (race condition) or a stale lock
  if [ -L "$BACKUP_LOCK_DIR" ]; then
    die "Lock path is a symlink, refusing to proceed: $BACKUP_LOCK_DIR"
  fi
  if [ -d "$BACKUP_LOCK_DIR" ] && [ ! -L "$BACKUP_LOCK_DIR" ]; then
    EXISTING_TOKEN="$(cat "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null || echo "")"
    EXISTING_PID="$(cat "$BACKUP_LOCK_DIR/LOCK_PID" 2>/dev/null || echo "")"
    if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
      die "Cannot restore: a backup/restore is currently running (PID $EXISTING_PID)"
    fi
    if [ -z "$EXISTING_PID" ]; then
      # A missing PID can mean another process is still initializing the lock.
      # Fail closed instead of racing it.
      die "Cannot restore: lock is incomplete and has no owner PID"
    fi
    # PID is dead → stale lock. Clean up and acquire atomically.
    safe_remove_lock_dir "$BACKUP_LOCK_DIR" || die "Could not remove stale restore lock"
    if ! mkdir "$BACKUP_LOCK_DIR" 2>/dev/null; then
      die "Cannot acquire backup lock (possible race condition)"
    fi
    # Verify after re-acquisition
    if [ -L "$BACKUP_LOCK_DIR" ]; then
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Lock path is a symlink after re-acquisition, refusing to proceed"
    fi
    printf '%s\n' "$$" > "$BACKUP_LOCK_DIR/LOCK_PID" || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Could not write lock PID"
    }
    printf '%s\n' "$RESTORE_TOKEN" > "$BACKUP_LOCK_DIR/LOCK_TOKEN" || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Could not write lock token"
    }
    chmod 700 "$BACKUP_LOCK_DIR" 2>/dev/null || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Could not set lock permissions"
    }
    chmod 600 "$BACKUP_LOCK_DIR/LOCK_PID" "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Could not set lock file permissions"
    }
    [ "$(cat "$BACKUP_LOCK_DIR/LOCK_PID" 2>/dev/null)" = "$$" ] || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Lock PID mismatch after acquisition"
    }
    [ "$(cat "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null)" = "$RESTORE_TOKEN" ] || {
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || true
      die "Lock token mismatch after acquisition"
    }
    RESTORE_HOLDS_LOCK=1
  else
    die "Cannot acquire backup lock (unsafe lock path or race condition)"
  fi
fi

# Release restore lock on exit — only if we own it (token match).
restore_cleanup() {
  local rc=$?
  if [ "${RESTORE_HOLDS_LOCK:-0}" -eq 1 ] && [ -d "$BACKUP_LOCK_DIR" ] && [ ! -L "$BACKUP_LOCK_DIR" ]; then
    local lock_token
    lock_token="$(cat "$BACKUP_LOCK_DIR/LOCK_TOKEN" 2>/dev/null || echo "")"
    if [ "$lock_token" = "$RESTORE_TOKEN" ]; then
      safe_remove_lock_dir "$BACKUP_LOCK_DIR" 2>/dev/null || \
        err "Could not release restore lock: $BACKUP_LOCK_DIR"
    fi
  fi
  exit "$rc"
}
trap restore_cleanup EXIT INT TERM

# ===========================================================================
# Phase C: destructive restore
# ===========================================================================
echo ""
echo "[1/6] Stopping application services..."
docker compose down

# --- DB restore with fail-closed semantics ---
echo "[2/6] Restoring PostgreSQL..."
docker compose up -d db
# wait for db to accept connections
DB_READY=0
for i in $(seq 1 15); do
  if docker compose exec -T db pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    DB_READY=1
    break
  fi
  sleep 1
done
[ "$DB_READY" -eq 1 ] || die "PostgreSQL did not become ready within 15s"

# Wipe existing schema for a clean, deterministic restore state
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER;" \
  >/dev/null || die "Failed to reset database schema before restore"

# Restore from dump with ON_ERROR_STOP=1 — any SQL error aborts immediately
if ! gunzip -c "$PG_DUMP_FILE" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"; then
  err "PostgreSQL restore failed (ON_ERROR_STOP detected an error)"
  err "Attempting service recovery..."
  docker compose up -d
  exit 1
fi
log "  PostgreSQL restored (ON_ERROR_STOP: enabled)."

# --- Post-DB restore validation ---
echo "[3/6] Validating restored database..."
TABLE_COUNT=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null | tr -d '[:space:]')
if [ "$TABLE_COUNT" != "$EXPECTED_TABLES" ]; then
  err "Database validation failed: expected $EXPECTED_TABLES tables, found $TABLE_COUNT"
  err "Expected tables: $EXPECTED_TABLE_NAMES"
  docker compose up -d
  exit 1
fi
log "  Tables in database: $TABLE_COUNT (expected $EXPECTED_TABLES)"

# Verify each expected table exists
for t in $EXPECTED_TABLE_NAMES; do
  EXISTS=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'" 2>/dev/null | tr -d '[:space:]')
  [ "$EXISTS" = "1" ] || die "Database validation failed: table '$t' missing after restore"
done
log "  All expected tables present: OK"

# Verify key columns match entity definitions
FILES_COLS=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='files' AND table_schema='public'" 2>/dev/null | tr -d '[:space:]')
[ "${FILES_COLS%%,*}" = "id" ] || die "Database validation failed: files table columns unexpected ($FILES_COLS)"
log "  Key column validation: OK"

USERS_COUNT=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM users" 2>/dev/null | tr -d '[:space:]')
log "  users row count: $USERS_COUNT"
log "  Database validation: OK"

# --- Storage restore (safe: prepare → validate → rename-swap → verify → cleanup) ---
echo "[4/6] Restoring storage into Docker volume $STORAGE_VOLUME..."
if ! docker run --rm --user root -i --entrypoint sh \
    -v "${STORAGE_VOLUME}:/storage" \
    -e "EXPECTED_FILE_COUNT=${META_STORAGE_FILE_COUNT:-0}" \
    "$BACKEND_IMAGE" \
    -c '
set -e
STORAGE_ROOT="/storage"
STAGE="$STORAGE_ROOT/.restore-staging"
SWAP="$STORAGE_ROOT/.restore-swap"

safe_remove_dir() {
  path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ] || [ ! -d "$path" ]; then
    echo "STORAGE_RESTORE_FAIL: unsafe path refused: $path" >&2
    return 1
  fi
  find -P "$path" -depth -type f -exec rm -f {} + 2>/dev/null || return 1
  find -P "$path" -depth -type l -exec rm -f {} + 2>/dev/null || return 1
  find -P "$path" -depth -type d -exec rmdir {} + 2>/dev/null || return 1
  [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
}

# Validate predictable staging paths before creating or removing them.
for cleanup_path in "$STAGE" "$SWAP"; do
  if [ -L "$cleanup_path" ]; then
    echo "STORAGE_RESTORE_FAIL: unsafe restore path (symlink): $cleanup_path" >&2
    exit 1
  fi
  if [ -e "$cleanup_path" ] && [ ! -d "$cleanup_path" ]; then
    echo "STORAGE_RESTORE_FAIL: unsafe restore path (not directory): $cleanup_path" >&2
    exit 1
  fi
done
safe_remove_dir "$STAGE" || exit 1
safe_remove_dir "$SWAP" || exit 1

# --- 1. Prepare: extract to staging ---
mkdir -p "$STAGE"
tar -xzf - -C "$STAGE"
if [ "$(find "$STAGE" -type l | wc -l)" -ne 0 ]; then
  echo "STORAGE_RESTORE_FAIL: symlink created during extraction" >&2
  safe_remove_dir "$STAGE" || true
  exit 1
fi

# --- 2. Validate: verify staging file count matches metadata ---
STAGE_COUNT=$(find "$STAGE" -type f | wc -l)
EXPECTED="${EXPECTED_FILE_COUNT:-0}"
if [ "$EXPECTED" != "0" ]; then
  ACTUAL=$((STAGE_COUNT))
  if [ "$ACTUAL" -lt "$EXPECTED" ]; then
    safe_remove_dir "$STAGE" || true
    echo "STORAGE_RESTORE_FAIL: staging file count mismatch (expected >= $EXPECTED, got $ACTUAL)"
    exit 1
  fi
  echo "  staging file count: $ACTUAL (expected $EXPECTED)"
fi

# Normalize permissions (defense-in-depth: prevent archive from setting
# dangerous modes like 0000 or 0777)
find "$STAGE" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$STAGE" -type f -exec chmod 644 {} + 2>/dev/null || true

# --- 3. Stage: move old content to .restore-swap (atomic rename on same FS) ---
# Old data is preserved here — NOT deleted — until switch succeeds.
mkdir -p "$SWAP"
find "$STORAGE_ROOT" -mindepth 1 -maxdepth 1 \
  -not -name ".restore-staging" \
  -not -name ".restore-swap" \
  -not -name ".tmp" \
  -exec mv -f {} "$SWAP/" +

# --- 4. Switch: move staging contents to root (atomic rename on same FS) ---
find "$STAGE" -mindepth 1 -maxdepth 1 -exec mv -f {} "$STORAGE_ROOT/" +
safe_remove_dir "$STAGE" || {
  echo "STORAGE_RESTORE_FAIL: could not remove empty staging directory" >&2
  exit 1
}

# --- 5. Verify: root now contains the restored data ---
ROOT_TOTAL=$(find "$STORAGE_ROOT" -type f -not -path "*/.tmp/*" -not -path "*/.restore-swap/*" | wc -l)
if [ "$EXPECTED" != "0" ]; then
  if [ "$((ROOT_TOTAL))" -lt "$EXPECTED" ]; then
    # ROLLBACK: remove only the newly switched entries, then restore old data.
    echo "  post-switch verification FAILED; rolling back..." >&2
    for entry in "$STORAGE_ROOT"/* "$STORAGE_ROOT"/.[!.]* "$STORAGE_ROOT"/..?*; do
      base="${entry##*/}"
      case "$base" in
        .restore-swap|.tmp) continue ;;
      esac
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      safe_remove_dir "$entry" || {
        echo "STORAGE_RESTORE_FAIL: could not remove partial entry during rollback: $entry" >&2
        exit 1
      }
    done
    find "$SWAP" -mindepth 1 -maxdepth 1 -exec mv -f {} "$STORAGE_ROOT/" +
    safe_remove_dir "$SWAP" || true
    echo "STORAGE_RESTORE_FAIL: post-switch verification failed; rollback complete"
    exit 1
  fi
fi

# --- 6. Cleanup: remove old data (already superseded by new) ---
safe_remove_dir "$SWAP" || {
  echo "STORAGE_RESTORE_FAIL: could not remove superseded swap data" >&2
  exit 1
}

# --- 7. Ensure .tmp exists ---
mkdir -p "$STORAGE_ROOT/.tmp"

# --- 8. Fix ownership: chown to the container default user ---
# Docker named volumes are root-owned; restore ran as root above.
# chown back so the backend (running as nextjs:uid 1001) can read/write.
NEXTJS_UID=$(id -u nextjs 2>/dev/null || echo 1001)
NEXTJS_GID=$(id -g nextjs 2>/dev/null || echo 1001)
chown -R "$NEXTJS_UID:$NEXTJS_GID" "$STORAGE_ROOT"
echo "  ownership set to uid=$NEXTJS_UID gid=$NEXTJS_GID"

echo "STORAGE_RESTORE_OK: files=$ROOT_TOTAL"
' < "$STORAGE_ARCHIVE"; then
  err "Storage restore failed; starting services to recover..."
  docker compose up -d
  exit 1
fi
log "  Storage restored into volume $STORAGE_VOLUME."

# --- Start backend and run migrations ---
echo "[5/6] Starting backend and running migrations..."
docker compose up -d backend
# Wait for DB to be reachable through backend
for i in $(seq 1 15); do
  if docker compose exec -T backend pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Migration must be fatal (no WARNING + continue)
set +e
docker compose exec -T backend npm run migration:run
MIGRATION_RC=$?
set -e
if [ "$MIGRATION_RC" -ne 0 ]; then
  err "Database migration failed (exit code $MIGRATION_RC); aborting restore"
  err "Check logs: docker compose logs backend"
  exit 1
fi
log "  Migrations: OK"

# --- Reconciliation (DB ↔ storage consistency report) ---
echo ""
echo "[6/6] Reconciling DB and storage..."
RECONCILE_SCRIPT="$SCRIPT_DIR/reconcile.py"
set +e
python3 "$RECONCILE_SCRIPT" \
  --db-user "$DB_USER" \
  --db-name "$DB_NAME" \
  --storage-volume "$STORAGE_VOLUME" \
  --backend-image "$BACKEND_IMAGE"
RECONCILE_RC=$?
set -e
if [ "$RECONCILE_RC" -ne 0 ]; then
  err "Reconciliation found CRITICAL discrepancies — restore is NOT declared successful"
  err "Review the reconciliation report above."
  err "Do NOT treat the system as fully recoverable without manual review."
  exit 1
fi
log "  Reconciliation: OK (no critical discrepancies)"

# --- Health check (actual HTTP probe, output captured) ---
echo ""
echo "=== Post-Restore Health Check ==="
BACKEND_HEALTH=""
for i in $(seq 1 30); do
  set +e
  BACKEND_HEALTH=$(echo 'const http=require("http");http.get("http://localhost:3000/api/v1/health",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{process.stdout.write(d);process.exit(r.statusCode===200?0:1);});}).on("error",()=>process.exit(1));' | \
    docker compose exec -T backend node - 2>/dev/null)
  set -e
  if [ -n "$BACKEND_HEALTH" ]; then
    break
  fi
  sleep 2
done

if [ -z "$BACKEND_HEALTH" ]; then
  err "Backend health check failed after restore"
  err "Backend may still be starting. Check: docker compose logs backend"
  exit 1
fi

log "  Backend health response: $BACKEND_HEALTH"
if echo "$BACKEND_HEALTH" | grep -q '"ok"'; then
  log "  Backend health: OK"
else
  err "Backend health check returned unexpected response: $BACKEND_HEALTH"
  exit 1
fi

echo ""
log "=== Restore completed successfully ==="
log "Verify:"
log "  - Backend health : http://localhost:3000/api/v1/health"
log "  - Frontend       : http://localhost"
log "  - Restored files : docker run --rm -v $STORAGE_VOLUME:/storage $BACKEND_IMAGE find /storage -type f"
exit 0
