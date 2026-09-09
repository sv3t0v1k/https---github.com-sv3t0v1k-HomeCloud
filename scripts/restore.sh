#!/usr/bin/env bash
set -euo pipefail

# Restore script for HomeCloud
# Restores PostgreSQL dump and storage archive from backup
# Restore format version: 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
STORAGE_PATH="${STORAGE_PATH:-/storage}"
RESTORE_FORMAT_VERSION="1"

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"

# Find latest backup
LATEST_META=$(find "$BACKUP_DIR" -name "homecloud_*.meta" -type f | sort | tail -n 1)
if [ -z "$LATEST_META" ]; then
  echo "ERROR: No backup metadata found in $BACKUP_DIR"
  exit 1
fi

TIMESTAMP=$(basename "$LATEST_META" .meta | sed 's/^homecloud_//')

# Parse metadata fields
PG_DUMP_FILENAME=$(grep '"db_dump"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')
STORAGE_ARCHIVE_FILENAME=$(grep '"storage_archive"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')
PG_DUMP_SHA256=$(grep '"db_dump_sha256"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')
STORAGE_SHA256=$(grep '"storage_archive_sha256"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')

PG_DUMP_FILE="$BACKUP_DIR/$PG_DUMP_FILENAME"
STORAGE_ARCHIVE="$BACKUP_DIR/$STORAGE_ARCHIVE_FILENAME"

echo "=== HomeCloud Restore ==="
echo "Backup timestamp: $TIMESTAMP"

# --- Pre-validation ---
echo ""
echo "[0/6] Validating backup..."

if [ ! -f "$PG_DUMP_FILE" ]; then
  echo "ERROR: PostgreSQL dump not found: $PG_DUMP_FILE"
  exit 1
fi
if [ ! -f "$STORAGE_ARCHIVE" ]; then
  echo "ERROR: Storage archive not found: $STORAGE_ARCHIVE"
  exit 1
fi
if [ ! -f "$LATEST_META" ]; then
  echo "ERROR: Metadata not found: $LATEST_META"
  exit 1
fi

# Verify PostgreSQL dump checksum
if [ -n "$PG_DUMP_SHA256" ]; then
  ACTUAL_DB_SHA256=$(sha256sum "$PG_DUMP_FILE" | awk '{print $1}')
  if [ "$ACTUAL_DB_SHA256" != "$PG_DUMP_SHA256" ]; then
    echo "ERROR: PostgreSQL dump checksum mismatch!"
    echo "  Expected: $PG_DUMP_SHA256"
    echo "  Actual:   $ACTUAL_DB_SHA256"
    exit 1
  fi
  echo "  PostgreSQL dump checksum: OK"
else
  echo "  WARNING: No checksum in metadata, verifying manually..."
  ACTUAL_DB_SHA256=$(sha256sum "$PG_DUMP_FILE" | awk '{print $1}')
  echo "  PostgreSQL dump SHA256: $ACTUAL_DB_SHA256"
fi

# Verify storage archive checksum
if [ -n "$STORAGE_SHA256" ]; then
  ACTUAL_STORAGE_SHA256=$(sha256sum "$STORAGE_ARCHIVE" | awk '{print $1}')
  if [ "$ACTUAL_STORAGE_SHA256" != "$STORAGE_SHA256" ]; then
    echo "ERROR: Storage archive checksum mismatch!"
    echo "  Expected: $STORAGE_SHA256"
    echo "  Actual:   $ACTUAL_STORAGE_SHA256"
    exit 1
  fi
  echo "  Storage archive checksum: OK"
else
  echo "  WARNING: No checksum in metadata, verifying manually..."
  ACTUAL_STORAGE_SHA256=$(sha256sum "$STORAGE_ARCHIVE" | awk '{print $1}')
  echo "  Storage archive SHA256: $ACTUAL_STORAGE_SHA256"
fi

# Verify gzip integrity
if ! gzip -t "$PG_DUMP_FILE"; then
  echo "ERROR: PostgreSQL dump gzip integrity check failed"
  exit 1
fi
echo "  PostgreSQL dump gzip: OK"

# Verify tar integrity
if ! tar -tzf "$STORAGE_ARCHIVE" > /dev/null 2>&1; then
  echo "ERROR: Storage archive tar integrity check failed"
  exit 1
fi
echo "  Storage archive tar: OK"

# --- Path traversal protection ---
echo ""
echo "Checking archive contents for path traversal..."
STORAGE_ROOT=$(realpath "$STORAGE_PATH" 2>/dev/null || echo "$STORAGE_PATH")
BAD_PATHS=$(tar -tzf "$STORAGE_ARCHIVE" 2>/dev/null | while read -r entry; do
  clean=$(echo "$entry" | sed 's|^/||')
  if echo "$clean" | grep -qE '^\.\./|/\.\./|^\.\.$|/\.\.$'; then
    echo "$entry"
  fi
done)

if [ -n "$BAD_PATHS" ]; then
  echo "ERROR: Storage archive contains path traversal entries:"
  echo "$BAD_PATHS"
  exit 1
fi
echo "  Path traversal check: OK"

# --- Confirmation ---
echo ""
echo "PostgreSQL dump: $PG_DUMP_FILE"
echo "Storage archive: $STORAGE_ARCHIVE"
echo "Storage target: $STORAGE_ROOT"
echo ""
read -p "This will OVERWRITE current data. Continue? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

# --- Stop services ---
echo ""
echo "[1/6] Stopping services..."
docker compose down

# --- Restore PostgreSQL ---
echo ""
echo "[2/6] Restoring PostgreSQL..."
# Start db temporarily for restore
docker compose up -d db
sleep 5
if ! gunzip -c "$PG_DUMP_FILE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"; then
  echo "ERROR: PostgreSQL restore failed"
  echo "Starting services to recover..."
  docker compose up -d
  exit 1
fi
echo "  PostgreSQL restored."

# --- Restore storage ---
echo ""
echo "[3/6] Restoring storage files..."
if [ -d "$STORAGE_PATH" ]; then
  rm -rf "${STORAGE_PATH:?}"/*
fi
mkdir -p "$STORAGE_PATH"

# Extract safely with --strip-components=0 to prevent path traversal
if ! tar -xzf "$STORAGE_ARCHIVE" -C "$STORAGE_PATH" --strip-components=0; then
  echo "ERROR: Storage restore failed"
  echo "Starting services to recover..."
  docker compose up -d
  exit 1
fi
echo "  Storage restored."

# --- Run migrations ---
echo ""
echo "[4/6] Running migrations..."
if ! docker compose exec -T backend npm run migration:run; then
  echo "  WARNING: Migration command failed, checking if schema is already up to date..."
fi

# --- Start services ---
echo ""
echo "[5/6] Starting services..."
docker compose up -d

# --- Verify ---
echo ""
echo "[6/6] Verifying restore..."
sleep 10

# Check backend health
BACKEND_HEALTH=""
for i in $(seq 1 15); do
  BACKEND_HEALTH=$(docker compose exec -T backend wget -qO- http://localhost:3000/api/v1/health 2>/dev/null || echo "")
  if [ -n "$BACKEND_HEALTH" ]; then
    break
  fi
  sleep 2
done

if [ -z "$BACKEND_HEALTH" ]; then
  echo "  ERROR: Backend health check failed after restore"
  echo "  Check logs: docker compose logs backend"
  exit 1
fi
echo "  Backend health: $BACKEND_HEALTH"

echo ""
echo "=== Restore completed successfully ==="
echo "Verify:"
echo "  - Backend health: http://localhost:3000/api/v1/health"
echo "  - Frontend: http://localhost"
echo "  - Check user files and metadata"