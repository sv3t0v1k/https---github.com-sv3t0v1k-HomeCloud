#!/usr/bin/env bash
set -euo pipefail

# Restore script for HomeCloud (volume-aware, format version 1)
#
# Restores PostgreSQL dump + Docker named-volume storage from a backup in
# $BACKUP_DIR. Storage is restored DIRECTLY into the Docker named volume that
# backs the backend's /storage mount (NOT into a host /storage path).
#
# Environment overrides:
#   BACKUP_DIR       - directory holding backups (default: ./backups)
#   STORAGE_VOLUME   - explicit Docker named volume to restore storage into.
#                      When unset, the volume backing the backend's /storage
#                      mount is auto-detected. Always validated.
#   BACKEND_IMAGE    - Docker image used for the throwaway extraction container
#                      (default: homecloud-backend)
#   DB_NAME / DB_USER - loaded from .env
#   DB_PASSWORD / REDIS_PASSWORD / JWT_*  - loaded from .env
#
# Operation phases:
#   Phase A: pre-validation (READ-ONLY) — backup integrity + volume validation.
#            No docker compose down, no volume/DB modification happens here.
#   Phase B: confirmation prompt.
#   Phase C: destructive restore (stop -> db -> storage -> start -> migrate -> health).
#
# Format version: 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
STORAGE_PATH="${STORAGE_PATH:-/storage}"   # in-container mount path (validation/display only)
RESTORE_FORMAT_VERSION="1"

# Load environment (do not override already-set vars)
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
BACKEND_IMAGE="${BACKEND_IMAGE:-homecloud-backend}"

# --- helpers ---
log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# stat size helper (bsd/gnu)
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

# ===========================================================================
# Security: scan a storage tar.gz archive BEFORE any destructive operation.
# Rejects: absolute paths, path traversal (".." components), and
# symlink/hardlink targets that escape the extraction root.
# ===========================================================================
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
    # getmembers() reads metadata only; it does NOT extract file contents.
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            name = m.name
            link = getattr(m, "linkname", "") or ""
            # absolute path
            if name.startswith("/"):
                errors.append("absolute path: %s" % name)
            # path traversal component in name
            if has_traversal(name):
                errors.append("path traversal in name: %s" % name)
            # symlink/hardlink escape
            if m.issym() or m.islnk():
                if link.startswith("/"):
                    errors.append("absolute link target: %s -> %s" % (name, link))
                if has_traversal(link):
                    errors.append("traversal link target: %s -> %s" % (name, link))
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

  # Bash fallback (names only) when python3 is unavailable — never worse than
  # the original check, but cannot inspect link targets.
  log "  NOTE: python3 not found; using reduced name-only tar security scan"
  local bad=0 entry
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    case "$entry" in
      /*) err "  SECURITY FAIL: absolute path: $entry"; bad=1 ;;
    esac
    if printf '%s' "$entry" | grep -qE '(^|/)\.\.(/|$)'; then
      err "  SECURITY FAIL: path traversal: $entry"; bad=1
    fi
  done < <(tar -tzf "$archive" 2>/dev/null)
  [ "$bad" -eq 0 ] || die "Storage archive failed security scan"
  log "  storage archive security scan: OK (bash fallback, names only)"
}

# ===========================================================================
# Resolve + validate the Docker named volume that backs backend /storage.
# Sets STORAGE_VOLUME. Fails closed (no destructive validation side-effects).
# ===========================================================================
validate_docker_volume() {
  local vol="$1"
  [ -n "$vol" ] || return 1
  # docker volume inspect succeeds ONLY for real named volumes; a host
  # directory or arbitrary path will fail here (fail-closed).
  docker volume inspect "$vol" >/dev/null 2>&1 || return 1
  log "  Docker volume '$vol' is a valid named volume (inspect: OK)"
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
    # storage_data is the declared volume key; its resolved name is project_prefixed.
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

# ===========================================================================
# Phase A: pre-validation (READ-ONLY)
# ===========================================================================

echo "=== HomeCloud Restore (volume-aware) ==="
echo "Restore format version: $RESTORE_FORMAT_VERSION"

# 1. Find latest backup metadata
LATEST_META="$(find "$BACKUP_DIR" -name 'homecloud_*.meta' -type f 2>/dev/null | sort | tail -n 1)"
[ -n "$LATEST_META" ] || die "No backup metadata found in $BACKUP_DIR"

TIMESTAMP="$(basename "$LATEST_META" .meta | sed 's/^homecloud_//')"
PG_DUMP_FILENAME="$(grep '"db_dump"'              "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
STORAGE_ARCHIVE_FILENAME="$(grep '"storage_archive"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
PG_DUMP_SHA256="$(grep '"db_dump_sha256"'           "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
STORAGE_SHA256="$(grep '"storage_archive_sha256"'   "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
META_DB_DUMP_SIZE="$(grep '"db_dump_size"'        "$LATEST_META" | sed 's/.*: \([0-9]*\).*/\1/')"
META_STORAGE_SIZE="$(grep '"storage_archive_size"' "$LATEST_META" | sed 's/.*: \([0-9]*\).*/\1/')"

PG_DUMP_FILE="$BACKUP_DIR/$PG_DUMP_FILENAME"
STORAGE_ARCHIVE="$BACKUP_DIR/$STORAGE_ARCHIVE_FILENAME"

echo "Backup timestamp : $TIMESTAMP"
echo "Backup directory : $BACKUP_DIR"
echo ""
echo "[0/6] Validating backup artifacts and environment (read-only)..."

# 2. Artifact existence
[ -f "$PG_DUMP_FILE" ]     || die "PostgreSQL dump not found: $PG_DUMP_FILE"
[ -f "$STORAGE_ARCHIVE" ]  || die "Storage archive not found: $STORAGE_ARCHIVE"
[ -f "$LATEST_META" ]      || die "Metadata not found: $LATEST_META"

# 3. SHA256 verification (DB)
if [ -n "$PG_DUMP_SHA256" ]; then
  ACTUAL_DB_SHA256="$(sha256sum "$PG_DUMP_FILE" | awk '{print $1}')"
  [ "$ACTUAL_DB_SHA256" = "$PG_DUMP_SHA256" ] \
    || die "PostgreSQL dump checksum mismatch (expected $PG_DUMP_SHA256, got $ACTUAL_DB_SHA256)"
  log "  PostgreSQL dump checksum: OK"
else
  log "  WARNING: no db_dump_sha256 in metadata; skipping DB checksum"
fi

# 4. SHA256 verification (storage)
if [ -n "$STORAGE_SHA256" ]; then
  ACTUAL_STOR_SHA256="$(sha256sum "$STORAGE_ARCHIVE" | awk '{print $1}')"
  [ "$ACTUAL_STOR_SHA256" = "$STORAGE_SHA256" ] \
    || die "Storage archive checksum mismatch (expected $STORAGE_SHA256, got $ACTUAL_STOR_SHA256)"
  log "  Storage archive checksum: OK"
else
  log "  WARNING: no storage_archive_sha256 in metadata; skipping storage checksum"
fi

# 5. Size verification against metadata
DB_SIZE="$(file_size "$PG_DUMP_FILE")"
STOR_SIZE="$(file_size "$STORAGE_ARCHIVE")"
if [ "${META_DB_DUMP_SIZE:-0}" -gt 0 ] && [ "${DB_SIZE:-0}" != "$META_DB_DUMP_SIZE" ]; then
  die "PostgreSQL dump size mismatch (meta=$META_DB_DUMP_SIZE, actual=$DB_SIZE)"
fi
if [ "${META_STORAGE_SIZE:-0}" -gt 0 ] && [ "${STOR_SIZE:-0}" != "$META_STORAGE_SIZE" ]; then
  die "Storage archive size mismatch (meta=$META_STORAGE_SIZE, actual=$STOR_SIZE)"
fi
log "  Size verification: OK (db=$DB_SIZE, storage=$STOR_SIZE)"

# 6. gzip integrity (DB dump)
gzip -t "$PG_DUMP_FILE" || die "PostgreSQL dump gzip integrity check failed"
log "  PostgreSQL dump gzip: OK"

# 7. SQL structure
gunzip -c "$PG_DUMP_FILE" | grep -qE 'CREATE TABLE|CREATE TABLE IF NOT EXISTS|CREATE EXTENSION' \
  || die "PostgreSQL dump does not contain expected SQL structure (CREATE TABLE)"
log "  PostgreSQL dump structure: OK"

# 8. tar integrity + security scan (storage)
tar -tzf "$STORAGE_ARCHIVE" >/dev/null 2>&1 || die "Storage archive tar integrity check failed"
log "  Storage archive tar: OK"
scan_storage_archive_security "$STORAGE_ARCHIVE"

# 9. Resolve + validate the Docker storage volume (read-only inspect only)
resolve_storage_volume

log "  All pre-validation checks passed."
echo ""

# ===========================================================================
# Phase B: confirmation (only after ALL pre-validation succeeded)
# ===========================================================================
echo "PostgreSQL dump : $PG_DUMP_FILE"
echo "Storage archive : $STORAGE_ARCHIVE"
echo "Storage volume  : $STORAGE_VOLUME  (mounted at $STORAGE_PATH in backend)"
echo ""
log "This will OVERWRITE current DB and storage data."
read -rp "Continue with destructive restore? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  log "Restore cancelled."
  exit 0
fi

# ===========================================================================
# Phase C: destructive restore
# ===========================================================================
echo ""
echo "[1/6] Stopping application services..."
docker compose down

echo "[2/6] Restoring PostgreSQL..."
docker compose up -d db
# wait for db to accept connections
for i in $(seq 1 15); do
  if docker compose exec -T db pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! gunzip -c "$PG_DUMP_FILE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"; then
  err "PostgreSQL restore failed; starting services to recover..."
  docker compose up -d
  exit 1
fi
log "  PostgreSQL restored."

echo "[3/6] Restoring storage into Docker volume $STORAGE_VOLUME..."
# Extract into a staging subdir first; only remove old content after a
# successful extraction (failure-before-modification of live data).
if ! docker run --rm -i --entrypoint sh \
  -v "${STORAGE_VOLUME}:/storage" \
  "$BACKEND_IMAGE" \
  -c '
  set -e
  STAGE="/storage/.restore-staging"
  mkdir -p "$STAGE"
  tar -xzf - -C "$STAGE"
  find /storage -mindepth 1 -maxdepth 1 -not -name ".restore-staging" -exec rm -rf {} +
  cp -a "$STAGE/." /storage/
  rm -rf "$STAGE"
' < "$STORAGE_ARCHIVE"; then
  err "Storage restore failed; starting services to recover..."
  docker compose up -d
  exit 1
fi
log "  Storage restored into volume $STORAGE_VOLUME."

echo "[4/6] Starting services..."
docker compose up -d

echo "[5/6] Running migrations..."
if ! docker compose exec -T backend npm run migration:run; then
  log "  WARNING: migration:run reported failure (continuing)"
fi

echo "[6/6] Verifying restore..."
BACKEND_HEALTH=""
for i in $(seq 1 20); do
  BACKEND_HEALTH="$(docker compose exec -T backend wget -qO- http://localhost:3000/api/v1/health 2>/dev/null || true)"
  if [ -n "$BACKEND_HEALTH" ]; then
    break
  fi
  sleep 2
done
if [ -z "$BACKEND_HEALTH" ]; then
  err "Backend health check failed after restore"
  err "Check logs: docker compose logs backend"
  exit 1
fi
log "  Backend health: $BACKEND_HEALTH"

echo ""
log "=== Restore completed successfully ==="
log "Verify:"
log "  - Backend health : http://localhost:3000/api/v1/health"
log "  - Frontend       : http://localhost"
log "  - Restored files : docker run --rm -v $STORAGE_VOLUME:/storage $BACKEND_IMAGE ls -R /storage"
exit 0
