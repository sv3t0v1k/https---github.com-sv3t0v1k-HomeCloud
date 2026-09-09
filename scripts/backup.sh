#!/usr/bin/env bash
set -euo pipefail

# Backup script for HomeCloud
# Creates PostgreSQL dump and storage archive with integrity verification

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
RETENTION_DAYS=${RETENTION_DAYS:-7}

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

DB_NAME="${DB_NAME:-homecloud}"
DB_USER="${DB_USER:-homecloud}"
STORAGE_PATH="${STORAGE_PATH:-/storage}"

mkdir -p "$BACKUP_DIR"

echo "=== HomeCloud Backup ==="
echo "Timestamp: $TIMESTAMP"
echo "Backup directory: $BACKUP_DIR"

# 1. PostgreSQL backup
echo "[1/4] Dumping PostgreSQL database..."
PG_DUMP_FILE="$BACKUP_DIR/homecloud_db_${TIMESTAMP}.sql.gz"
if docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$PG_DUMP_FILE"; then
  echo "  PostgreSQL dump created: $PG_DUMP_FILE"
else
  echo "  ERROR: PostgreSQL dump failed"
  rm -f "$PG_DUMP_FILE"
  exit 1
fi

# 2. Storage backup (exclude temporary upload chunks)
echo "[2/4] Archiving storage files..."
STORAGE_ARCHIVE="$BACKUP_DIR/homecloud_storage_${TIMESTAMP}.tar.gz"
if [ -d "$STORAGE_PATH" ]; then
  tar -czf "$STORAGE_ARCHIVE" \
    --exclude='.tmp' \
    --exclude='*.tmp' \
    -C "$STORAGE_PATH" . 2>/dev/null || true
  echo "  Storage archive created: $STORAGE_ARCHIVE"
else
  echo "  WARNING: Storage path $STORAGE_PATH not found, creating empty archive"
  tar -czf "$STORAGE_ARCHIVE" --files-from /dev/null 2>/dev/null || true
fi

# 3. Integrity verification
echo "[3/4] Verifying backup integrity..."

# Verify PostgreSQL dump
if [ -f "$PG_DUMP_FILE" ]; then
  PG_DUMP_SIZE=$(stat -f%z "$PG_DUMP_FILE" 2>/dev/null || stat -c%s "$PG_DUMP_FILE" 2>/dev/null || echo 0)
  if [ "$PG_DUMP_SIZE" -eq 0 ]; then
    echo "  ERROR: PostgreSQL dump is empty"
    rm -f "$PG_DUMP_FILE"
    exit 1
  fi
  echo "  PostgreSQL dump size: $PG_DUMP_SIZE bytes"
fi

# Verify storage archive
if [ -f "$STORAGE_ARCHIVE" ]; then
  STORAGE_SIZE=$(stat -f%z "$STORAGE_ARCHIVE" 2>/dev/null || stat -c%s "$STORAGE_ARCHIVE" 2>/dev/null || echo 0)
  if [ "$STORAGE_SIZE" -eq 0 ]; then
    echo "  WARNING: Storage archive is empty"
  else
    echo "  Storage archive size: $STORAGE_SIZE bytes"
  fi
fi

# Create metadata
METADATA_FILE="$BACKUP_DIR/homecloud_${TIMESTAMP}.meta"
cat > "$METADATA_FILE" << EOF
{
  "timestamp": "$TIMESTAMP",
  "db_dump": "$(basename "$PG_DUMP_FILE")",
  "storage_archive": "$(basename "$STORAGE_ARCHIVE")",
  "db_name": "$DB_NAME",
  "storage_path": "$STORAGE_PATH",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "  Metadata created: $METADATA_FILE"

# 4. Retention cleanup
echo "[4/4] Applying retention policy (${RETENTION_DAYS} days)..."
find "$BACKUP_DIR" -name "homecloud_db_*.sql.gz" -type f -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "homecloud_storage_*.tar.gz" -type f -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "homecloud_*.meta" -type f -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true

REMAINING_BACKUPS=$(find "$BACKUP_DIR" -name "homecloud_db_*.sql.gz" -type f | wc -l)
echo "  Remaining backups: $REMAINING_BACKUPS"

echo "=== Backup completed successfully ==="
echo "Files:"
echo "  - $PG_DUMP_FILE"
echo "  - $STORAGE_ARCHIVE"
echo "  - $METADATA_FILE"
