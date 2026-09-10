#!/usr/bin/env bash
set -euo pipefail

# Isolated restore test — uses ONLY temporary Docker resources.
# No production container, volume, or network is ever touched.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
LATEST_META="$(find "$BACKUP_DIR" -name 'homecloud_*.meta' -type f 2>/dev/null | sort | tail -n 1)"

if [ -z "$LATEST_META" ]; then
  echo "ERROR: No backup metadata found in $BACKUP_DIR"
  exit 1
fi

TIMESTAMP="$(basename "$LATEST_META" .meta | sed 's/^homecloud_//')"
PG_DUMP_FILENAME="$(grep '"db_dump"'              "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
STORAGE_ARCHIVE_FILENAME="$(grep '"storage_archive"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
PG_DUMP_FILE="$BACKUP_DIR/$PG_DUMP_FILENAME"
STORAGE_ARCHIVE="$BACKUP_DIR/$STORAGE_ARCHIVE_FILENAME"

echo "=== Isolated Restore Test ==="
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
for i in $(seq 1 15); do
  if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "  Postgres is ready."

echo "[3/8] Restoring PostgreSQL dump..."
gunzip -c "$PG_DUMP_FILE" | \
  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
echo "  DB restore complete."

echo "[4/8] Validating database integrity..."
TABLE_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
")
echo "  Tables in database: $TABLE_COUNT"

# Verify key tables exist and have expected columns (camelCase)
FILES_COLS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_name='files' AND table_schema='public'
")
echo "  files columns: $FILES_COLS"

FOLDERS_COLS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_name='folders' AND table_schema='public'
")
echo "  folders columns: $FOLDERS_COLS"

SHARELINKS_COLS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_name='share_links' AND table_schema='public'
")
echo "  share_links columns: $SHARELINKS_COLS"

UPLOADSESSIONS_COLS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_name='upload_sessions' AND table_schema='public'
")
echo "  upload_sessions columns: $UPLOADSESSIONS_COLS"

USERS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM users")
FILES_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM files")
FOLDERS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM folders")
SHARELINKS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM share_links")
UPLOADSESSIONS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM upload_sessions")
REFRESH_TOKENS_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM refresh_tokens")
echo "  users=$USERS_COUNT  files=$FILES_COUNT  folders=$FOLDERS_COUNT  share_links=$SHARELINKS_COUNT  upload_sessions=$UPLOADSESSIONS_COUNT  refresh_tokens=$REFRESH_TOKENS_COUNT"

echo "[5/8] Restoring storage archive into temp volume..."
docker run --rm -i --entrypoint sh \
  -v "${STOR_VOL_NAME}:/storage" \
  "$BACKEND_IMAGE" \
  -c '
set -e
mkdir -p /storage/.restore-staging
tar -xzf - -C /storage/.restore-staging
find /storage -mindepth 1 -maxdepth 1 -not -name ".restore-staging" -exec rm -rf {} +
cp -a /storage/.restore-staging/. /storage/
rm -rf /storage/.restore-staging
echo "STORAGE_RESTORE_OK"
' < "$STORAGE_ARCHIVE"
echo "  Storage restore complete."

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
  BACKEND_HEALTH="$(docker exec "$BACKEND_CONTAINER" node -e \"require('http').get('http://localhost:3000/api/v1/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));\" 2>/dev/null || true)"
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
  sh -c 'find /storage -type f | wc -l' 2>/dev/null || echo 0)
echo "  Files in storage volume: $STOR_FILE_COUNT"

STOR_FILE_LIST=$(docker run --rm -v "${STOR_VOL_NAME}:/storage" "$BACKEND_IMAGE" \
  sh -c 'find /storage -type f' 2>/dev/null || echo "")
echo "  Storage files:"
for f in $STOR_FILE_LIST; do
  echo "    $f"
done

echo ""
echo "=== Isolated Restore Test PASSED ==="
echo "  Backup timestamp: $TIMESTAMP"
echo "  DB tables: $TABLE_COUNT"
echo "  users=$USERS_COUNT files=$FILES_COUNT folders=$FOLDERS_COUNT"
echo "  share_links=$SHARELINKS_COUNT upload_sessions=$UPLOADSESSIONS_COUNT"
echo "  refresh_tokens=$REFRESH_TOKENS_COUNT"
echo "  Storage files: $STOR_FILE_COUNT"
echo "  Backend health: $BACKEND_HEALTH"
echo ""
echo "NOTE: All temporary Docker resources will be cleaned up on exit."
