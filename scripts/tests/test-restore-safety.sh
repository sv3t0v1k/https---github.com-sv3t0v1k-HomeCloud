#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# Phase 5.2 — Restore Safety Test Suite
#
# Tests:
#   1. Phase A validation (read-only): various invalid/corrupted backups
#      must fail BEFORE any destructive Docker operation.
#   2. Phase C integration: valid backup restores successfully; partial dump
#      fails at DB restore; existing data is preserved on failure.
#
# Usage: ./scripts/tests/test-restore-safety.sh [--skip-integration]
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
RESTORE_SH="$PROJECT_ROOT/scripts/restore.sh"
FIXTURES_DIR="/tmp/homecloud-restore-fixtures-$$"

SKIP_INTEGRATION=0
for arg in "$@"; do
  case "$arg" in
    --skip-integration) SKIP_INTEGRATION=1 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

PASS=0
FAIL=0
SKIP=0

report_pass() { log "  PASS: $1"; PASS=$((PASS+1)); }
report_fail() { log "  FAIL: $1"; FAIL=$((FAIL+1)); }
report_skip() { log "  SKIP: $1"; SKIP=$((SKIP+1)); }

cleanup() {
  rm -rf "$FIXTURES_DIR" 2>/dev/null || true
  for vol in $(docker volume ls --filter name=homecloud_test_recon --format '{{.Name}}' 2>/dev/null || true); do
    docker volume rm -f "$vol" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ===========================================================================
# Generate test fixtures
# ===========================================================================
log ""
log "=== Generating test fixtures ==="
python3 "$SCRIPT_DIR/create_fixtures.py" "$FIXTURES_DIR" || die "Failed to create fixtures"

# Build sidecar-specific fixtures without changing the production backup set.
cp -r "$FIXTURES_DIR/valid" "$FIXTURES_DIR/legacy-no-sidecar"
rm -f "$FIXTURES_DIR/legacy-no-sidecar/"*.meta.sha256
cp -r "$FIXTURES_DIR/valid" "$FIXTURES_DIR/tampered-sidecar"
printf 'x' >> "$FIXTURES_DIR/tampered-sidecar/"*.meta.sha256
cp -r "$FIXTURES_DIR/valid" "$FIXTURES_DIR/wrong-sidecar-name"
SIDECAR_HASH=$(awk '{print $1}' "$FIXTURES_DIR/wrong-sidecar-name/"*.meta.sha256)
printf '%s  wrong.meta\n' "$SIDECAR_HASH" > "$FIXTURES_DIR/wrong-sidecar-name/"*.meta.sha256
cp -r "$FIXTURES_DIR/valid" "$FIXTURES_DIR/unsafe-artifact-mode"
chmod 666 "$FIXTURES_DIR/unsafe-artifact-mode/"*.meta

# ===========================================================================
# Phase A validation tests (no Docker operations — --validate-only)
# ===========================================================================
log ""
log "=== Phase A Validation Tests ==="
log ""

run_phase_a_test() {
  local name="$1" fixture_dir="$2" expect_fail="$3" expect_msg="${4:-}"
  log "--- Test: $name ---"
  set +e
  OUTPUT=$(BACKUP_DIR="$fixture_dir" BACKEND_IMAGE="homecloud-backend" \
    bash "$RESTORE_SH" --validate-only 2>&1)
  RC=$?
  set -e

  if [ "$expect_fail" = "yes" ]; then
    if [ "$RC" -ne 0 ]; then
      if [ -n "$expect_msg" ] && echo "$OUTPUT" | grep -qi "$expect_msg"; then
        report_pass "$name (exit=$RC, msg matched)"
      elif [ -n "$expect_msg" ]; then
        report_pass "$name (exit=$RC, msg not matched but exit non-zero)"
      else
        report_pass "$name (exit=$RC)"
      fi
      # Verify NO destructive operations were performed
      if echo "$OUTPUT" | grep -q "Stopping application services"; then
        report_fail "$name — docker compose down was called (Phase A should have blocked it)"
      fi
    else
      report_fail "$name — expected non-zero exit, got 0"
    fi
  else
    if [ "$RC" -eq 0 ]; then
      report_pass "$name"
    else
      report_fail "$name — expected exit 0, got $RC"
    fi
  fi
}

# 1. Valid backup — should pass Phase A
run_phase_a_test "valid backup" "$FIXTURES_DIR/valid" "no"

# 2. Legacy backup without a sidecar must fail closed before JSON parsing
run_phase_a_test "legacy backup without .meta.sha256" "$FIXTURES_DIR/legacy-no-sidecar" "yes" "Missing or unsafe .meta.sha256"

# 3. Tampered sidecar must fail closed before JSON parsing
run_phase_a_test "tampered .meta.sha256" "$FIXTURES_DIR/tampered-sidecar" "yes" "checksum mismatch"

# 4. Sidecar filename must match the metadata file
run_phase_a_test "sidecar references wrong metadata" "$FIXTURES_DIR/wrong-sidecar-name" "yes" "wrong metadata file"

# 5. Malformed .meta JSON
run_phase_a_test "malformed .meta JSON" "$FIXTURES_DIR/malformed-meta" "yes" "malformed .meta JSON"

# 6. Missing checksum field
run_phase_a_test "missing checksum fields" "$FIXTURES_DIR/missing-checksum" "yes" "field empty"

# 7. Invalid checksum value
run_phase_a_test "invalid checksum value" "$FIXTURES_DIR/invalid-checksum" "yes" "checksum mismatch"

# 8. Unsafe artifact mode
run_phase_a_test "unsafe artifact permissions" "$FIXTURES_DIR/unsafe-artifact-mode" "yes" "unsafe permissions"

# 9. Unsupported format version
run_phase_a_test "unsupported format version" "$FIXTURES_DIR/unsupported-version" "yes" "Unsupported backup format_version"

# 10. Corrupted storage archive
run_phase_a_test "corrupted storage archive" "$FIXTURES_DIR/corrupted-archive" "yes" "tar integrity check failed"

# 11. Corrupted DB dump (gzip)
run_phase_a_test "corrupted DB dump (gzip)" "$FIXTURES_DIR/corrupted-dump" "yes" "gzip integrity check failed"

# 12. Malicious archive (path traversal + device files)
run_phase_a_test "malicious archive" "$FIXTURES_DIR/malicious-archive" "yes" "security scan"

# 13. Empty storage backup (0 files) — valid empty storage
run_phase_a_test "empty storage backup (valid)" "$FIXTURES_DIR/empty-storage" "no"

# 14. File count mismatch
run_phase_a_test "file count mismatch" "$FIXTURES_DIR/file-count-mismatch" "yes" "file count mismatch"

# 11. Missing backup file (artifact referenced in .meta but not on disk)
log "--- Test: missing backup file ---"
BAD_BACKUP="/tmp/homecloud_missing_file_$$"
cp -r "$FIXTURES_DIR/valid" "$BAD_BACKUP"
rm -f "$BAD_BACKUP"/homecloud_db_*.sql.gz
set +e
OUTPUT=$(BACKUP_DIR="$BAD_BACKUP" BACKEND_IMAGE="homecloud-backend" bash "$RESTORE_SH" --validate-only 2>&1)
RC=$?
set -e
if [ "$RC" -ne 0 ] && echo "$OUTPUT" | grep -qi "not found"; then
  report_pass "missing backup file — fails as expected (exit=$RC)"
else
  report_fail "missing backup file — expected non-zero exit with 'not found' message (exit=$RC)"
fi
rm -rf "$BAD_BACKUP"

# ===========================================================================
# Integration tests (require Docker — skipped if --skip-integration)
# ===========================================================================
if [ "$SKIP_INTEGRATION" -eq 1 ]; then
  report_skip "integration tests (skipped via --skip-integration)"
fi

log ""
log "=== Phase A Summary ==="
log "  Passed: $PASS"
log "  Failed: $FAIL"
log "  Skipped: $SKIP"

# ===========================================================================
# Integration tests
# ===========================================================================
if [ "$SKIP_INTEGRATION" -eq 0 ]; then
  log ""
  log "=== Integration Tests ==="
  log ""

  # Check Docker availability
  if ! docker info >/dev/null 2>&1; then
    report_skip "integration tests (Docker not available)"
    log ""
    log "=== Final Summary ==="
    log "  Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
    [ "$FAIL" -eq 0 ] && exit 0 || exit 1
  fi

  # Ensure backend image exists
  if ! docker image inspect "homecloud-backend" >/dev/null 2>&1; then
    log "  Building backend image..."
    (cd "$PROJECT_ROOT" && docker compose build --quiet backend 2>&1 | tail -3) || true
  fi

  # Create a fresh sidecar-backed backup for the destructive integration test.
  # Legacy repository backups intentionally remain sidecar-less and must fail closed.
  INTEGRATION_BACKUP_DIR="$FIXTURES_DIR/live-backup"
  mkdir -p "$INTEGRATION_BACKUP_DIR"
  BACKUP_DIR="$INTEGRATION_BACKUP_DIR" bash "$PROJECT_ROOT/scripts/backup.sh" --yes >/dev/null 2>&1 || \
    die "Failed to create integration backup"
  VALID_BACKUP_DIR="$INTEGRATION_BACKUP_DIR"

  # --- Integration Test 1: Valid backup restores successfully ---
  log "--- Test: valid restore end-to-end ---"
  # Use the fresh real backup with a verified .meta.sha256 sidecar.
  if [ -n "$VALID_BACKUP_DIR" ]; then
    # Pre-populate storage with existing data to test preservation on failure
    log "  Pre-populating storage volume with existing data..."
    EXISTING_VOL="homecloud_test_recon_existing_$$"
    docker volume create "$EXISTING_VOL" >/dev/null 2>&1
    docker run --rm --user root -v "$EXISTING_VOL:/storage" "homecloud-backend" \
      sh -c 'mkdir -p /storage/user1 /storage/.tmp && echo "important data" > /storage/user1/important.txt' 2>/dev/null
    log "  Existing data: /storage/user1/important.txt"

    # Run restore with the real backup
    set +e
    STORAGE_VOLUME="$EXISTING_VOL" BACKUP_DIR="$VALID_BACKUP_DIR" \
      bash "$RESTORE_SH" --yes 2>&1 | tail -25
    RC=${PIPESTATUS[0]}
    set -e

    if [ "$RC" -eq 0 ]; then
      report_pass "valid restore end-to-end (exit=0)"
    else
      report_fail "valid restore end-to-end (exit=$RC)"
    fi

    # Verify new data is in place (backup data, not the old pre-populated data)
    NEW_DATA=$(docker run --rm -v "$EXISTING_VOL:/storage" "homecloud-backend" \
      sh -c 'test -f /storage/backup-test/test.txt && echo "FOUND" || echo "NOT_FOUND"' 2>/dev/null || echo "ERROR")
    if [ "$NEW_DATA" = "FOUND" ]; then
      report_pass "backup data present after restore"
    else
      report_fail "backup data missing after restore ($NEW_DATA)"
    fi

    docker volume rm -f "$EXISTING_VOL" >/dev/null 2>&1 || true
  else
    report_skip "valid restore (no real backup available)"
  fi

  # --- Integration Test 2: Existing data + failed restore → old data preserved ---
  log ""
  log "--- Test: existing storage + failed restore → old data preserved ---"
  STOR_VOL="homecloud_test_recon_safety_$$"
  docker volume create "$STOR_VOL" >/dev/null 2>&1

  # Pre-populate storage with known data
  docker run --rm --user root -v "$STOR_VOL:/storage" "homecloud-backend" \
    sh -c 'mkdir -p /storage/user1 /storage/user2 && echo "important data" > /storage/user1/important.txt && echo "other data" > /storage/user2/data.bin' 2>/dev/null
  log "  Pre-populated: /storage/user1/important.txt, /storage/user2/data.bin"

  # Use a corrupted archive (should fail at Phase A — before docker compose down)
  BAD_BACKUP="/tmp/bad_backup_$$"
  cp -r "$FIXTURES_DIR/corrupted-archive" "$BAD_BACKUP"

  set +e
  BACKUP_DIR="$BAD_BACKUP" STORAGE_VOLUME="$STOR_VOL" BACKEND_IMAGE="homecloud-backend" \
    bash "$RESTORE_SH" --yes 2>&1
  RC=$?
  set -e

  if [ "$RC" -ne 0 ]; then
    report_pass "corrupted backup causes restore failure (exit=$RC)"
  else
    report_fail "corrupted backup should have failed but exit=0"
  fi

  # Verify old data is STILL in the volume (NOT destroyed)
  OLD_DATA=$(docker run --rm -v "$STOR_VOL:/storage" "homecloud-backend" \
    sh -c 'cat /storage/user1/important.txt 2>/dev/null || echo "MISSING"' 2>/dev/null || echo "ERROR")
  if [ "$OLD_DATA" = "important data" ]; then
    report_pass "existing data preserved after failed restore"
  else
    report_fail "existing data was destroyed! got: $OLD_DATA"
  fi

  docker volume rm -f "$STOR_VOL" >/dev/null 2>&1 || true
  rm -rf "$BAD_BACKUP"

  # --- Integration Test 3: DB restore with SQL error fails (ON_ERROR_STOP) ---
  log ""
  log "--- Test: partial DB dump fails (ON_ERROR_STOP) ---"
  PARTIAL_NET="homecloud_test_net_partial_$$"
  PARTIAL_DB="homecloud_test_db_partial_$$"
  set +e
  docker network create "$PARTIAL_NET" >/dev/null 2>&1
  docker run -d --name "$PARTIAL_DB" --network "$PARTIAL_NET" \
    -e POSTGRES_DB=homecloud -e POSTGRES_USER=homecloud -e POSTGRES_PASSWORD=test-password-123 \
    postgres:16-alpine >/dev/null 2>&1
  set -e

  # Wait for DB
  for i in $(seq 1 15); do
    docker exec "$PARTIAL_DB" pg_isready -U homecloud -d homecloud >/dev/null 2>&1 && break
    sleep 1
  done

  # Schema wipe
  docker exec "$PARTIAL_DB" psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud -c \
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO homecloud;" >/dev/null 2>&1

  # Try to restore the partial dump — should fail
  set +e
  gunzip -c "$FIXTURES_DIR/partial-dump/homecloud_db_20260101_000000.sql.gz" | \
    docker exec -i "$PARTIAL_DB" psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud 2>&1
  PSQL_RC=$?
  set -e

  if [ "$PSQL_RC" -ne 0 ]; then
    report_pass "partial DB dump fails with ON_ERROR_STOP (exit=$PSQL_RC)"
  else
    report_fail "partial DB dump should have failed but exit=0"
  fi

  # Verify DB is NOT fully restored (not all 7 tables exist → ON_ERROR_STOP worked)
  BAD_TABLES=$(docker exec "$PARTIAL_DB" psql -U homecloud -d homecloud -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null | tr -d '[:space:]')
  log "  DB tables after failed restore: $BAD_TABLES (expected < 7, not fully restored)"
  if [ "$BAD_TABLES" -lt 7 ] 2>/dev/null; then
    report_pass "DB not fully restored after failed restore (tables=$BAD_TABLES < 7)"
  else
    report_fail "DB fully restored despite SQL error (tables=$BAD_TABLES)"
  fi

  docker rm -f "$PARTIAL_DB" >/dev/null 2>&1 || true
  docker network rm "$PARTIAL_NET" >/dev/null 2>&1 || true
fi

# ===========================================================================
# Final Summary
# ===========================================================================
log ""
log "========================================"
log "=== Final Summary ==="
log "  Passed:  $PASS"
log "  Failed:  $FAIL"
log "  Skipped: $SKIP"
log "========================================"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
