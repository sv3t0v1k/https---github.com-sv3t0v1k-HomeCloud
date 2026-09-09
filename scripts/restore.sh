#!/usr/bin/env bash
set -euo pipefail

# Restore script for HomeCloud
# Restores PostgreSQL dump and storage archive from backup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
STORAGE_PATH="${STORAGE_PATH:-/storage}"

# Find latest backup
LATEST_META=$(find "$BACKUP_DIR" -name "homecloud_*.meta" -type f | sort | tail -n 1)
if [ -z "$LATEST_META" ]; then
  echo "ERROR: No backup metadata found in $BACKUP_DIR"
  exit 1
fi

TIMESTAMP=$(basename "$LATEST_META" .meta | sed 's/^homecloud_//')
PG_DUMP_FILE="$BACKUP_DIR/$(grep '"db_dump"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"
STORAGE_ARCHIVE="$BACKUP_DIR/$(grep '"storage_archive"' "$LATEST_META" | sed 's/.*: "\(.*\)".*/\1/')"

if [ ! -f "$PG_DUMP_FILE" ]; then
  echo "ERROR: PostgreSQL dump not found: $PG_DUMP_FILE"
  exit 1
fi

if [ ! -f "$STORAGE_ARCHIVE" ]; then
  echo "ERROR: Storage archive not found: $STORAGE_ARCHIVE"
  exit 1
fi

echo "=== HomeCloud Restore ==="
echo "Backup timestamp: $TIMESTAMP"
echo "PostgreSQL dump: $PG_DUMP_FILE"
echo "Storage archive: $STORAGE_ARCHIVE"
echo ""

read -p "This will OVERWRITE current data. Continue? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

echo "[1/5] Stopping services..."
docker compose down

echo "[2/5] Restoring PostgreSQL..."
if [ -f "$PG_DUMP_FILE" ]; then
  gunzip -c "$PG_DUMP_FILE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" 2>/dev/null || {
    echo "  Starting db service temporarily..."
    docker compose up -d db
    sleep 5
    gunzip -c "$PG_DUMP_FILE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"
  }
  echo "  PostgreSQL restored."
else
  echo "  WARNING: PostgreSQL dump not found, skipping."
fi

echo "[3/5] Restoring storage files..."
if [ -f "$STORAGE_ARCHIVE" ]; then
  if [ -d "$STORAGE_PATH" ]; then
    rm -rf "${STORAGE_PATH:?}"/*
  fi
  mkdir -p "$STORAGE_PATH"
  tar -xzf "$STORAGE_ARCHIVE" -C "$STORAGE_PATH"
  echo "  Storage restored."
else
  echo "  WARNING: Storage archive not found, skipping."
fi

echo "[4/5] Running migrations..."
docker compose up -d db
sleep 5
docker compose exec -T backend npm run migration:run 2>/dev/null || echo "  No pending migrations or migration command not available."

echo "[5/5] Starting services..."
docker compose up -d

echo ""
echo "=== Restore completed ==="
echo "Verify:"
echo "  - Backend health: http://localhost:3000/api/v1/health"
echo "  - Frontend: http://localhost"
echo "  - Check user files and metadata"
