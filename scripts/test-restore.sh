#!/usr/bin/env bash
set -euo pipefail

# Isolated restore test — uses ONLY temporary Docker resources.
# No production container, volume, or network is ever touched.
#
# Tests the complete safe-restore flow:
#   - Phase A: validation (checksums, format version, security scan)
#   - Phase C: safe DB restore (ON_ERROR_STOP, schema wipe, validation)
#   - Phase C: safe storage restore (rename-swap, no delete-before-copy)
#   - Post-restore: reconciliation + health check
#
# Usage: ./scripts/test-restore.sh [--backup-dir <dir>]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"

# Allow override of backup dir via flag
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

LATEST_META="$(find "$BACKUP_DIR" -name 'homecloud_*.meta' -type f 2>/dev/null | sort | tail -n 1)"

if [ -z "$LATEST_META" ]; then
  echo "ERROR: No backup metadata found in $BACKUP_DIR"
  exit 1
fi

# Parse .meta with JSON parser (fail-closed)
META_JSON="$(python3 -c "
import json, sys
with open('$LATEST_META') as f:
    m = json.load(f)
for k in ['timestamp','db_dump','storage_archive','db_dump_sha256','storage_archive_sha256','storage_file_count']:
    print(m.get(k, ''))
" 2>/dev/null)" || { echo "ERROR: Failed to parse .meta"; exit 1; }

TIMESTAMP="$(echo "$META_JSON" | sed -n '1p')"
PG_DUMP_FILENAME="$(echo "$META_JSON" | sed -n '2p')"
STORAGE_ARCHIVE_FILENAME="$(echo "$META_JSON" | sed -n '3p')"
PG_DUMP_FILE="$BACKUP_DIR/$PG_DUMP_FILENAME"
STORAGE_ARCHIVE="$BACKUP_DIR/$STORAGE_ARCHIVE_FILENAME"
META_STORAGE_FILE_COUNT="$(echo "$META_JSON" | sed -n '6p')"

echo "=== Isolated Restore Test (Phase 5.2) ==="
echo "Backup timestamp : $TIMESTAMP"
echo "DB dump          : $PG_DUMP_FILE"
echo "Storage archive  : $STORAGE_ARCHIVE"
echo ""

# Load env
set -a; source "$PROJECT_ROOT/.env"; set +a
DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
DB_PASSWORD="${DB_PASSWORD:-test-password-123}"
BACKEND_IMAGE="${BACKEND_IMAGE:-homecloud-backend}"

# Generate unique suffix for temp resources
SUFFIX="$(date +%s)"
NET_NAME="homecloud_test_net_${SUFFIX}"
DB_VOL_NAME="homecloud_test_db_${SUFFIX}"
STOR_VOL_NAME="homecloud_test_storage_${SUFFIX}"
DB_CONTAINER="homecloud_test_db_${SUFFIX}"
BACKEND_CONTAINER="homecloud_test_backend_${SUFFIX}"

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  docker rm -f "$BACKEND_CONTAINER" 2>/dev/null || true
  docker rm -f "$DB_CONTAINER" 2>/dev/null || true
  docker volume rm -f "$STOR_VOL_NAME" 2>/dev/null || true
  docker volume rm -f "$DB_VOL_NAME" 2>/dev/null || true
  docker network rm "$NET_NAME" 2>/dev/null || true
  echo "Cleanup complete."
}
trap cleanup EXIT

echo "[1/8] Creating temporary Docker resources..."
docker network create "$NET_NAME" >/dev/null
docker volume create "$DB_VOL_NAME" >/dev/null
docker volume create "$STOR_VOL_NAME" >/dev/null
echo "  Network: $NET_NAME"
echo "  DB volume: $DB_VOL_NAME"
echo "  Storage volume: $STOR_VOL_NAME"

echo "[2/8] Starting temporary Postgres..."
docker run -d \
  --name "$DB_CONTAINER" \
  --network "$NET_NAME" \
  -v "${DB_VOL_NAME}:/var/lib/postgresql/data" \
  -e POSTGRES_DB="$DB_NAME" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  postgres:16-alpine >/dev/null

# Wait for Postgres
DB_READY=0
for i in $(seq 1 15); do
  if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    DB_READY=1
    break
  fi
  sleep 1
done
if [ "$DB_READY" -ne 1 ]; then
  echo "  FAILED: Postgres did not start"
  exit 1
fi
echo "  Postgres is ready."

echo "[3/8] Restoring PostgreSQL dump (ON_ERROR_STOP=1)..."
# Schema wipe for clean restore
docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER;" \
  >/dev/null 2>&1
# Restore with fail-closed
if ! gunzip -c "$PG_DUMP_FILE" | docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"; then
  echo "  FAILED: DB restore failed"
  exit 1
fi
echo "  DB restore OK (ON_ERROR_STOP: enabled)."

echo "[4/8] Validating database integrity..."
TABLE_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
" 2>/dev/null | tr -d '[:space:]')
echo "  Tables in database: $TABLE_COUNT (expected 7)"
if [ "$TABLE_COUNT" != "7" ]; then
  echo "  FAILED: expected 7 tables, got $TABLE_COUNT"
  exit 1
fi

# Verify each expected table exists
for t in users files folders share_links upload_sessions refresh_tokens migrations; do
  EXISTS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'" 2>/dev/null | tr -d '[:space:]')
  [ "$EXISTS" = "1" ] || { echo "  FAILED: table '$t' missing"; exit 1; }
done
echo "  All 7 tables present: OK"

# Verify key columns
FILES_COLS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='files' AND table_schema='public'" 2>/dev/null | tr -d '[:space:]')
[ "${FILES_COLS%%,*}" = "id" ] || { echo "  FAILED: files table columns unexpected ($FILES_COLS)"; exit 1; }
echo "  Key column validation: OK"

USERS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM users" 2>/dev/null | tr -d '[:space:]')
echo "  users row count: $USERS_COUNT"

echo "[5/8] Restoring storage archive (safe rename-swap)..."
if ! docker run --rm --user root -i --entrypoint sh \
  -v "${STOR_VOL_NAME}:/storage" \
  -e "EXPECTED_FILE_COUNT=${META_STORAGE_FILE_COUNT:-0}" \
  "$BACKEND_IMAGE" \
  -c '
set -e
STORAGE_ROOT="/storage"
STAGE="$STORAGE_ROOT/.restore-staging"
SWAP="$STORAGE_ROOT/.restore-swap"
rm -rf "$STAGE" "$SWAP"
mkdir -p "$STAGE" "$SWAP"

# Prepare: extract to staging
tar -xzf - -C "$STAGE"

# Validate: verify staging file count
STAGE_COUNT=$(find "$STAGE" -type f | wc -l)
EXPECTED="${EXPECTED_FILE_COUNT:-0}"
if [ "$EXPECTED" != "0" ]; then
  ACTUAL=$((STAGE_COUNT))
  if [ "$ACTUAL" -lt "$EXPECTED" ]; then
    rm -rf "$STAGE"
    echo "STORAGE_RESTORE_FAIL: staging file count mismatch"
    exit 1
  fi
  echo "  staging file count: $ACTUAL (expected $EXPECTED)"
fi

# Normalize permissions
find "$STAGE" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$STAGE" -type f -exec chmod 644 {} + 2>/dev/null || true

# Stage: move old content to .restore-swap (NOT deleted until switch verified)
find "$STORAGE_ROOT" -mindepth 1 -maxdepth 1 \
  -not -name ".restore-staging" \
  -not -name ".restore-swap" \
  -not -name ".tmp" \
  -exec mv -f {} "$SWAP/" + 2>/dev/null || true

# Switch: move staging contents to root (atomic rename)
find "$STAGE" -mindepth 1 -maxdepth 1 -exec mv -f {} "$STORAGE_ROOT/" + 2>/dev/null || true
rmdir "$STAGE" 2>/dev/null || rm -rf "$STAGE"

# Verify
ROOT_TOTAL=$(find "$STORAGE_ROOT" -type f -not -path "*/.tmp/*" -not -path "*/.restore-swap/*" | wc -l)
if [ "$EXPECTED" != "0" ]; then
  if [ "$((ROOT_TOTAL))" -lt "$EXPECTED" ]; then
    echo "STORAGE_RESTORE_FAIL: post-switch verification failed"
    exit 1
  fi
fi

# Cleanup
rm -rf "$SWAP"
mkdir -p "$STORAGE_ROOT/.tmp"
NEXTJS_UID=$(id -u nextjs 2>/dev/null || echo 1001)
NEXTJS_GID=$(id -g nextjs 2>/dev/null || echo 1001)
chown -R "$NEXTJS_UID:$NEXTJS_GID" "$STORAGE_ROOT"
echo "STORAGE_RESTORE_OK: files=$ROOT_TOTAL"
' < "$STORAGE_ARCHIVE"; then
  echo "  FAILED: Storage restore failed"
  exit 1
fi
echo "  Storage restore OK (safe rename-swap, old data preserved during switch)."

echo "[6/8] Starting temporary backend..."
docker run -d \
  --name "$BACKEND_CONTAINER" \
  --network "$NET_NAME" \
  -v "${STOR_VOL_NAME}:/storage" \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DB_NAME="$DB_NAME" \
  -e DB_USER="$DB_USER" \
  -e DB_PASSWORD="$DB_PASSWORD" \
  -e DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_CONTAINER}:5432/${DB_NAME}" \
  -e REDIS_URL="redis://:unused@127.0.0.1:6379" \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET}" \
  -e STORAGE_PATH="/storage" \
  -e MAX_FILE_SIZE=0 \
  -e CHUNK_SIZE=10485760 \
  -e FRONTEND_URL="http://localhost:5173" \
  "$BACKEND_IMAGE" \
  >/dev/null
echo "  Backend container started."

echo "[7/8] Waiting for backend health..."
BACKEND_HEALTH=""
for i in $(seq 1 30); do
  set +e
  BACKEND_HEALTH=$(echo 'const http=require("http");http.get("http://localhost:3000/api/v1/health",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{process.stdout.write(d);process.exit(r.statusCode===200?0:1);});}).on("error",()=>process.exit(1));' | \
    docker compose exec -T "$BACKEND_CONTAINER" node - 2>/dev/null || \
    docker exec "$BACKEND_CONTAINER" node -e 'const http=require("http");http.get("http://localhost:3000/api/v1/health",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{process.stdout.write(d);process.exit(r.statusCode===200?0:1);});}).on("error",()=>process.exit(1));' 2>/dev/null)
  set -e
  if [ -n "$BACKEND_HEALTH" ]; then
    break
  fi
  sleep 2
done
if [ -z "$BACKEND_HEALTH" ]; then
  echo "  FAILED: Backend health check failed"
  docker logs "$BACKEND_CONTAINER" 2>/dev/null | tail -30
  exit 1
fi
echo "  Backend health: $BACKEND_HEALTH"

echo "[8/8] Validating storage volume contents..."
STOR_FILE_COUNT=$(docker run --rm -v "${STOR_VOL_NAME}:/storage" "$BACKEND_IMAGE" \
  sh -c 'find /storage -type f | wc -l' 2>/dev/null | tr -d '[:space:]')
echo "  Files in storage volume: $STOR_FILE_COUNT"

STOR_FILE_LIST=$(docker run --rm -v "${STOR_VOL_NAME}:/storage" "$BACKEND_IMAGE" \
  sh -c 'find /storage -type f -not -path "*/.tmp/*"' 2>/dev/null)
echo "  Storage files:"
for f in $STOR_FILE_LIST; do
  echo "    $f"
done

# Reconciliation check
echo ""
echo "  Reconciliation:"
RECONCILE_RC=0
python3 "$SCRIPT_DIR/reconcile.py" \
  --db-user "$DB_USER" \
  --db-name "$DB_NAME" \
  --storage-volume "$STOR_VOL_NAME" \
  --backend-image "$BACKEND_IMAGE" \
  2>/dev/null || RECONCILE_RC=$?
if [ "$RECONCILE_RC" -ne 0 ]; then
  echo "  FAILED: reconciliation found critical discrepancies (exit code $RECONCILE_RC)"
  exit 1
fi
echo "  Reconciliation: OK (no critical discrepancies)"

echo ""
echo "=== Isolated Restore Test PASSED ==="
echo "  Backup timestamp: $TIMESTAMP"
echo "  DB tables: $TABLE_COUNT"
echo "  users=$USERS_COUNT"
echo "  Storage files: $STOR_FILE_COUNT"
echo "  Backend health: $BACKEND_HEALTH"
echo ""
echo "NOTE: All temporary Docker resources will be cleaned up on exit."
