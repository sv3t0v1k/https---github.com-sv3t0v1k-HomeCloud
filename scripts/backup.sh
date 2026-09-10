#!/usr/bin/env bash
set -euo pipefail

# Backup script for HomeCloud
# Creates PostgreSQL dump and storage archive with integrity verification
# Backup format version: 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
RETENTION_DAYS=${RETENTION_DAYS:-7}
BACKUP_FORMAT_VERSION="1"

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
echo "Backup format version: $BACKUP_FORMAT_VERSION"

# 1. PostgreSQL backup
echo "[1/5] Dumping PostgreSQL database..."
PG_DUMP_FILE="$BACKUP_DIR/homecloud_db_${TIMESTAMP}.sql.gz"
if docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$PG_DUMP_FILE"; then
  echo "  PostgreSQL dump created: $PG_DUMP_FILE"
else
  echo "  ERROR: PostgreSQL dump failed"
  rm -f "$PG_DUMP_FILE"
  exit 1
fi

# Verify PostgreSQL dump
if [ ! -f "$PG_DUMP_FILE" ]; then
  echo "  ERROR: PostgreSQL dump file not created"
  exit 1
fi

PG_DUMP_SIZE=$(stat -f%z "$PG_DUMP_FILE" 2>/dev/null || stat -c%s "$PG_DUMP_FILE" 2>/dev/null || echo 0)
if [ "$PG_DUMP_SIZE" -eq 0 ]; then
  echo "  ERROR: PostgreSQL dump is empty"
  rm -f "$PG_DUMP_FILE"
  exit 1
fi

# Verify gzip integrity
if ! gzip -t "$PG_DUMP_FILE"; then
  echo "  ERROR: PostgreSQL dump gzip integrity check failed"
  rm -f "$PG_DUMP_FILE"
  exit 1
fi

# Verify dump contains expected SQL structure
if ! gunzip -c "$PG_DUMP_FILE" | grep -q "CREATE TABLE\|CREATE TABLE IF NOT EXISTS\|CREATE EXTENSION"; then
  echo "  ERROR: PostgreSQL dump does not contain expected SQL structure"
  rm -f "$PG_DUMP_FILE"
  exit 1
fi

PG_DUMP_SHA256=$(sha256sum "$PG_DUMP_FILE" | awk '{print $1}')
echo "  PostgreSQL dump size: $PG_DUMP_SIZE bytes"
echo "  PostgreSQL dump SHA256: $PG_DUMP_SHA256"

# 2. Storage backup (exclude temporary upload chunks)
echo "[2/5] Archiving storage files..."
STORAGE_ARCHIVE="$BACKUP_DIR/homecloud_storage_${TIMESTAMP}.tar.gz"

# Determine if storage is accessible locally or via Docker
if [ -d "$STORAGE_PATH" ]; then
  if ! tar -czf "$STORAGE_ARCHIVE" \
    --exclude='.tmp' \
    --exclude='*.tmp' \
    -C "$STORAGE_PATH" . ; then
    echo "  ERROR: Storage archive creation failed"
    rm -f "$STORAGE_ARCHIVE"
    exit 1
  fi
  echo "  Storage archive created: $STORAGE_ARCHIVE"
elif docker compose exec -T backend test -d "$STORAGE_PATH" 2>/dev/null; then
  if ! docker compose exec -T backend tar -czf - \
    --exclude='.tmp' \
    --exclude='*.tmp' \
    -C "$STORAGE_PATH" . > "$STORAGE_ARCHIVE"; then
    echo "  ERROR: Storage archive creation failed"
    rm -f "$STORAGE_ARCHIVE"
    exit 1
  fi
  echo "  Storage archive created (via Docker): $STORAGE_ARCHIVE"
else
  echo "  WARNING: Storage path $STORAGE_PATH not found, creating empty archive"
  if ! tar -czf "$STORAGE_ARCHIVE" --files-from /dev/null; then
    echo "  ERROR: Empty storage archive creation failed"
    rm -f "$STORAGE_ARCHIVE"
    exit 1
  fi
fi

# Verify storage archive
if [ ! -f "$STORAGE_ARCHIVE" ]; then
  echo "  ERROR: Storage archive file not created"
  exit 1
fi

STORAGE_SIZE=$(stat -f%z "$STORAGE_ARCHIVE" 2>/dev/null || stat -c%s "$STORAGE_ARCHIVE" 2>/dev/null || echo 0)

# Verify tar archive integrity
if ! tar -tzf "$STORAGE_ARCHIVE" > /dev/null 2>&1; then
  echo "  ERROR: Storage archive tar integrity check failed"
  rm -f "$STORAGE_ARCHIVE"
  exit 1
fi

STORAGE_SHA256=$(sha256sum "$STORAGE_ARCHIVE" | awk '{print $1}')
echo "  Storage archive size: $STORAGE_SIZE bytes"
echo "  Storage archive SHA256: $STORAGE_SHA256"

# 3. Integrity verification
echo "[3/5] Verifying backup integrity..."

# Final existence check
if [ ! -f "$PG_DUMP_FILE" ]; then
  echo "  ERROR: PostgreSQL dump missing after verification"
  exit 1
fi
if [ ! -f "$STORAGE_ARCHIVE" ]; then
  echo "  ERROR: Storage archive missing after verification"
  exit 1
fi

echo "  PostgreSQL dump: OK"
echo "  Storage archive: OK"

# 4. Create metadata
echo "[4/5] Creating metadata..."
METADATA_FILE="$BACKUP_DIR/homecloud_${TIMESTAMP}.meta"

# Count files in storage archive (use python3 for accurate count; robust across platforms)
STORAGE_FILE_COUNT=$(python3 -c '
import tarfile, sys
try:
    with tarfile.open(sys.argv[1], "r:gz") as tf:
        print(sum(1 for m in tf.getmembers() if m.isfile()))
except Exception:
    print(0)
' "$STORAGE_ARCHIVE" 2>/dev/null || echo 0)

cat > "$METADATA_FILE" << EOF
{
  "format_version": "$BACKUP_FORMAT_VERSION",
  "timestamp": "$TIMESTAMP",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "db_dump": "$(basename "$PG_DUMP_FILE")",
  "storage_archive": "$(basename "$STORAGE_ARCHIVE")",
  "db_name": "$DB_NAME",
  "storage_path": "$STORAGE_PATH",
  "db_dump_size": $PG_DUMP_SIZE,
  "storage_archive_size": $STORAGE_SIZE,
  "db_dump_sha256": "$PG_DUMP_SHA256",
  "storage_archive_sha256": "$STORAGE_SHA256",
  "storage_file_count": $STORAGE_FILE_COUNT,
  "retention_days": $RETENTION_DAYS
}
EOF

echo "  Metadata created: $METADATA_FILE"

# Restrict permissions on backup artifacts
chmod 600 "$PG_DUMP_FILE" "$STORAGE_ARCHIVE" "$METADATA_FILE"

# 5. Retention cleanup
echo "[5/5] Applying retention policy (${RETENTION_DAYS} days)..."

# Find old backups and their metadata, delete together
find "$BACKUP_DIR" -name "homecloud_db_*.sql.gz" -type f -mtime +${RETENTION_DAYS} -print -delete | while read -r old_db; do
  base=$(basename "$old_db" .sql.gz)
  ts=$(echo "$base" | sed 's/^homecloud_db_//')
  old_meta="$BACKUP_DIR/homecloud_${ts}.meta"
  old_storage="$BACKUP_DIR/homecloud_storage_${ts}.tar.gz"
  rm -f "$old_meta" "$old_storage" 2>/dev/null || true
  echo "  Removed old backup: $base"
done

REMAINING_DUMPS=$(find "$BACKUP_DIR" -name "homecloud_db_*.sql.gz" -type f | wc -l)
echo "  Remaining backups: $REMAINING_DUMPS"

echo ""
echo "=== Backup completed successfully ==="
echo "Files:"
echo "  - $PG_DUMP_FILE"
echo "  - $STORAGE_ARCHIVE"
echo "  - $METADATA_FILE"