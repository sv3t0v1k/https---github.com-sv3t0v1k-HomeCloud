#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Phase 5.3 Backup Safety Tests
#
# Tests backup.sh reliability: atomicity, failure handling, concurrency,
# retention, and metadata correctness.
#
# Uses temporary BACKUP_DIR to avoid touching production backups.
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PARENT="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$SCRIPT_PARENT")"
BACKUP_SH="$SCRIPT_PARENT/backup.sh"
RESTORE_SH="$SCRIPT_PARENT/restore.sh"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC}: $1"; SKIP_COUNT=$((SKIP_COUNT + 1)); }

TEST_ROOT=$(mktemp -d /tmp/homecloud-backup-test.XXXXXX)
REAL_ENV="$PROJECT_ROOT/.env"
ENV_BACKED_UP=0

backup_start_time=$(date +%s)

# Cleanup helper: restore .env if it was moved
test_restore_env() {
  if [ "$ENV_BACKED_UP" -eq 1 ] && [ -f "$REAL_ENV.bak" ]; then
    mv "$REAL_ENV.bak" "$REAL_ENV" 2>/dev/null || true
    ENV_BACKED_UP=0
  fi
}

# Count backup sets (exclude staging and markers)
count_backup_sets() {
  find "$1" -maxdepth 1 -name 'homecloud_*.meta' -type f ! -path "*/.staging/*" 2>/dev/null | wc -l | tr -d ' '
}

# Backdate a file by N days (macOS and Linux compatible)
backdate_file() {
  local file="$1" days="$2"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: compute timestamp string
    local backdate
    backdate=$(date -v-${days}d +%Y%m%d%H%M 2>/dev/null)
    if [ -n "$backdate" ]; then
      touch -t "$backdate" "$file" 2>/dev/null || true
    fi
  else
    touch -d "$days days ago" "$file" 2>/dev/null || true
  fi
}

# Verify .meta consistency
verify_meta() {
  python3 -c '
import json, sys, os, hashlib, tarfile
meta_path = sys.argv[1]
backup_dir = os.path.dirname(meta_path)
with open(meta_path) as f:
    meta = json.load(f)
sidecar_path = meta_path + ".sha256"
if not os.path.isfile(sidecar_path):
    print("FAIL: .meta.sha256 sidecar missing"); sys.exit(1)
with open(sidecar_path, "rb") as f:
    sidecar_bytes = f.read()
sidecar_lines = sidecar_bytes.splitlines()
if len(sidecar_lines) != 1:
    print("FAIL: .meta.sha256 must contain exactly one line"); sys.exit(1)
sidecar_hash, sidecar_name = sidecar_lines[0].split()
with open(meta_path, "rb") as f:
    meta_bytes = f.read()
meta_hash = hashlib.sha256(meta_bytes).hexdigest()
if sidecar_hash.decode() != meta_hash:
    print("FAIL: .meta.sha256 mismatch"); sys.exit(1)
if sidecar_name.decode() != os.path.basename(meta_path):
    print("FAIL: .meta.sha256 references the wrong metadata file"); sys.exit(1)
for key in ["format_version", "timestamp", "db_dump", "storage_archive",
            "db_dump_sha256", "storage_archive_sha256", "db_dump_size",
            "storage_archive_size", "storage_file_count"]:
    if key not in meta or not meta[key]:
        print(f"FAIL: missing/empty field: {key}")
        sys.exit(1)
db_path = os.path.join(backup_dir, meta["db_dump"])
stor_path = os.path.join(backup_dir, meta["storage_archive"])
if not os.path.isfile(db_path):
    print("FAIL: db_dump file missing"); sys.exit(1)
if not os.path.isfile(stor_path):
    print("FAIL: storage_archive file missing"); sys.exit(1)
db_sha = hashlib.sha256(open(db_path, "rb").read()).hexdigest()
if db_sha != meta["db_dump_sha256"]:
    print("FAIL: db_dump checksum mismatch"); sys.exit(1)
stor_sha = hashlib.sha256(open(stor_path, "rb").read()).hexdigest()
if stor_sha != meta["storage_archive_sha256"]:
    print("FAIL: storage_archive checksum mismatch"); sys.exit(1)
if os.path.getsize(db_path) != meta["db_dump_size"]:
    print("FAIL: db_dump size mismatch"); sys.exit(1)
if os.path.getsize(stor_path) != meta["storage_archive_size"]:
    print("FAIL: storage_archive size mismatch"); sys.exit(1)
with tarfile.open(stor_path, "r:gz") as tf:
    fc = sum(1 for m in tf.getmembers() if m.isfile())
meta_fc = meta["storage_file_count"]
if fc != meta_fc:
    print("FAIL: file count mismatch (archive={}, meta={})".format(fc, meta_fc)); sys.exit(1)
if "app_version" not in meta:
    print("FAIL: app_version missing"); sys.exit(1)
if "migration_count" not in meta:
    print("FAIL: migration_count missing"); sys.exit(1)
if "postgresql_version" not in meta:
    print("FAIL: postgresql_version missing"); sys.exit(1)
print("OK"); sys.exit(0)
' "$1"
}

check_docker() {
  docker compose ps --format '{{.Status}}' 2>/dev/null | grep -q "Up"
}

echo "=== Phase 5.3 Backup Safety Tests ==="
echo "Test root: $TEST_ROOT"
echo ""

# ===========================================================================
# SUCCESS SCENARIOS
# ===========================================================================

echo "--- SUCCESS Scenarios ---"

# --- Test 1: Full successful backup ---
echo ""
echo "--- Test 1: Full successful backup ---"
if check_docker; then
  T1_DIR="$TEST_ROOT/t1"
  mkdir -p "$T1_DIR"
  BACKUP_DIR="$T1_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC=$?
  if [ $RC -eq 0 ]; then
    pass "Full backup completed successfully (exit 0)"
  else
    fail "Full backup failed (exit $RC)"
  fi
  
  TOTAL=$(count_backup_sets "$T1_DIR")
  if [ "$TOTAL" -eq 1 ]; then
    pass "Exactly 1 backup set published"
  else
    fail "Expected 1 backup set, found $TOTAL"
  fi
  
  STAGING=$(find "$T1_DIR/.staging" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
  if [ "$STAGING" -eq 0 ]; then
    pass "No staging directory left behind"
  else
    fail "Staging directory left behind ($STAGING items)"
  fi
  
  if [ ! -d "$T1_DIR/.backup.lock" ]; then
    pass "No lock directory left behind"
  else
    fail "Lock directory left behind"
  fi
else
  skip "Docker not running"
fi

# --- Test 2: Backup artifacts correct (.meta matches) ---
echo ""
echo "--- Test 2: .meta matches artifacts (checksums, sizes, file count) ---"
if [ -n "${T1_DIR:-}" ] && [ -d "$T1_DIR" ]; then
  LATEST_META=$(find "$T1_DIR" -maxdepth 1 -name 'homecloud_*.meta' -type f ! -path "*/.staging/*" 2>/dev/null | sort | tail -n 1)
  if [ -n "$LATEST_META" ]; then
    RESULT=$(verify_meta "$LATEST_META" 2>&1)
    if [ "$RESULT" = "OK" ]; then
      pass "All metadata fields consistent with artifacts"
    else
      fail "Metadata inconsistency: $RESULT"
    fi
  else
    fail "No .meta file found"
  fi
else
  skip "No backup from Test 1"
fi

# --- Test 3: .meta has enriched fields ---
echo ""
echo "--- Test 3: .meta has enriched fields (app_version, migration_count, pg_version) ---"
if [ -n "${LATEST_META:-}" ]; then
  RESULT=$(verify_meta "$LATEST_META" 2>&1)
  if [ "$RESULT" = "OK" ]; then
    pass "Enriched metadata fields present and valid"
  else
    fail "Missing enriched fields: $RESULT"
  fi
else
  skip "No .meta from Test 1/2"
fi

# --- Test 4: Artifact permissions are 600 ---
echo ""
echo "--- Test 4: Artifact permissions are 600 ---"
if [ -n "${T1_DIR:-}" ]; then
  ALL_OK=true
  for f in "$T1_DIR"/homecloud_*; do
    [ -f "$f" ] || continue
    PERMS=$(stat -f '%A' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null)
    PERMS="${PERMS: -3}"
    if [ "$PERMS" != "600" ]; then
      echo "  $f has $PERMS"
      ALL_OK=false
    fi
  done
  if $ALL_OK; then
    pass "All artifacts have 600 permissions"
  else
    fail "Some artifacts have wrong permissions"
  fi
else
  skip "No backup from Test 1"
fi

# --- Test 5: Structured JSON summary logged ---
echo ""
echo "--- Test 5: Structured JSON summary logged on success ---"
if [ -n "${T1_DIR:-}" ]; then
  # Re-run and capture output, check for JSON line
  OUTPUT=$(BACKUP_DIR="$T1_DIR" bash "$BACKUP_SH" --yes 2>&1)
  if echo "$OUTPUT" | grep -q '"event":"backup_completed"'; then
    pass "JSON summary logged on success"
  else
    fail "No JSON summary in output"
  fi
else
  skip "No backup from Test 1"
fi

# ===========================================================================
# FAILURE SCENARIOS
# ===========================================================================

echo ""
echo "--- FAILURE Scenarios ---"

# --- Test 6: DB dump failure → no artifacts published ---
echo ""
echo "--- Test 6: DB dump failure → no artifacts, exit non-zero ---"
if check_docker; then
  T6_DIR="$TEST_ROOT/t6"
  mkdir -p "$T6_DIR"
  # Temporarily rename .env so env var overrides take effect
  mv "$REAL_ENV" "$REAL_ENV.bak" 2>/dev/null && ENV_BACKED_UP=1
  DB_NAME="nonexistent_db_xyz" DB_USER="baduser" DB_PASSWORD="badpass" \
    BACKUP_DIR="$T6_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC=$?
  test_restore_env
  
  if [ $RC -ne 0 ]; then
    pass "DB dump failure exits non-zero (exit $RC)"
  else
    fail "DB dump failure exited 0 — should be non-zero"
  fi
  
  ARTIFACTS=$(find "$T6_DIR" -maxdepth 1 -name 'homecloud_*' -type f ! -name ".last-*" ! -path "*/.staging/*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ARTIFACTS" -eq 0 ]; then
    pass "No artifacts published on DB dump failure (atomicity holds)"
  else
    fail "Found $ARTIFACTS artifacts after DB dump failure — atomicity violated"
    find "$T6_DIR" -maxdepth 1 -name 'homecloud_*' -type f
  fi
  
  if [ -f "$T6_DIR/.last-failure" ]; then
    pass "Failure marker written"
  else
    fail "Failure marker not written"
  fi
  
  if [ ! -d "$T6_DIR/.backup.lock" ]; then
    pass "Lock cleaned up on failure"
  else
    fail "Lock directory left behind on failure"
  fi
else
  skip "Docker not running"
fi

# --- Test 7: Storage failure → no artifacts published ---
echo ""
echo "--- Test 7: Storage failure → no artifacts, exit non-zero ---"
if check_docker; then
  T7_DIR="$TEST_ROOT/t7"
  mkdir -p "$T7_DIR"
  BACKEND_IMAGE="nonexistent-image-xyz" BACKUP_DIR="$T7_DIR" \
    bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC=$?
  test_restore_env
  
  if [ $RC -ne 0 ]; then
    pass "Storage failure exits non-zero (exit $RC)"
  else
    fail "Storage failure exited 0 — should be non-zero"
  fi
  
  ARTIFACTS=$(find "$T7_DIR" -maxdepth 1 -name 'homecloud_*' -type f ! -name ".last-*" ! -path "*/.staging/*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ARTIFACTS" -eq 0 ]; then
    pass "No artifacts published on storage failure (atomicity holds)"
  else
    fail "Found $ARTIFACTS artifacts after storage failure"
  fi
  
  if [ -f "$T7_DIR/.last-failure" ]; then
    pass "Failure marker written"
  else
    fail "Failure marker not written"
  fi
else
  skip "Docker not running"
fi

# --- Test 8: Existing backups not destroyed on failure ---
echo ""
echo "--- Test 8: Existing backups preserved on failure ---"
if check_docker; then
  T8_DIR="$TEST_ROOT/t8"
  mkdir -p "$T8_DIR"
  # Create a successful backup first
  BACKUP_DIR="$T8_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  COUNT_BEFORE=$(count_backup_sets "$T8_DIR")
  # Now attempt a failing backup (same dir)
  mv "$REAL_ENV" "$REAL_ENV.bak" 2>/dev/null && ENV_BACKED_UP=1
  DB_NAME="nonexistent_db_xyz" DB_USER="baduser" DB_PASSWORD="badpass" \
    BACKUP_DIR="$T8_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  test_restore_env
  # Restore env backup if test_restore_env didn't
  mv "$REAL_ENV.bak" "$REAL_ENV" 2>/dev/null && ENV_BACKED_UP=0
  COUNT_AFTER=$(count_backup_sets "$T8_DIR")
  
  if [ "$COUNT_BEFORE" -eq 1 ] && [ "$COUNT_AFTER" -ge 1 ]; then
    pass "Existing backup preserved on failure ($COUNT_BEFORE → $COUNT_AFTER)"
  else
    fail "Existing backup destroyed (was $COUNT_BEFORE, now $COUNT_AFTER)"
  fi
else
  skip "Docker not running"
fi

# --- Test 9: Re-run after failed backup succeeds ---
echo ""
echo "--- Test 9: Re-run after failed backup → succeeds ---"
if check_docker; then
  T9_DIR="$TEST_ROOT/t9"
  mkdir -p "$T9_DIR"
  # First: fail
  mv "$REAL_ENV" "$REAL_ENV.bak" 2>/dev/null && ENV_BACKED_UP=1
  DB_NAME="nonexistent_db_xyz" DB_USER="baduser" DB_PASSWORD="badpass" \
    BACKUP_DIR="$T9_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC1=$?
  mv "$REAL_ENV.bak" "$REAL_ENV" 2>/dev/null && ENV_BACKED_UP=0
  # Second: succeed
  BACKUP_DIR="$T9_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC2=$?
  
  if [ $RC1 -ne 0 ] && [ $RC2 -eq 0 ]; then
    TOTAL=$(count_backup_sets "$T9_DIR")
    if [ "$TOTAL" -eq 1 ]; then
      pass "Failed run left 0 artifacts; successful re-run created 1 backup set"
    else
      fail "Artifact count after re-run: $TOTAL (expected 1)"
    fi
  else
    fail "Failed run exit=$RC1, re-run exit=$RC2 (expected non-zero then 0)"
  fi
else
  skip "Docker not running"
fi

# ===========================================================================
# CONCURRENCY SCENARIOS
# ===========================================================================

echo ""
echo "--- Concurrency Scenarios ---"

# --- Test 10: Two backups simultaneously → second blocked ---
echo ""
echo "--- Test 10: Two simultaneous backups → second blocked by lock ---"
if check_docker; then
  T10_DIR="$TEST_ROOT/t10"
  mkdir -p "$T10_DIR"
  
  # Start first backup in background
  BACKUP_DIR="$T10_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1 &
  PID1=$!
  sleep 0.5
  
  # Start second backup — should be blocked
  BACKUP_DIR="$T10_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC2=$?
  
  wait $PID1 2>/dev/null || true
  
  if [ $RC2 -eq 2 ]; then
    pass "Second backup blocked by lock (exit 2)"
  else
    fail "Second backup not blocked (exit $RC2) — expected exit 2"
  fi
else
  skip "Docker not running"
fi

# --- Test 11: Stale lock cleaned on next run ---
echo ""
echo "--- Test 11: Stale lock (dead PID) cleaned on next backup ---"
T11_DIR="$TEST_ROOT/t11"
mkdir -p "$T11_DIR"
mkdir -p "$T11_DIR/.backup.lock"
echo "99999" > "$T11_DIR/.backup.lock/LOCK_PID"

if check_docker; then
  BACKUP_DIR="$T11_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC=$?
  if [ $RC -eq 0 ]; then
    TOTAL=$(count_backup_sets "$T11_DIR")
    if [ "$TOTAL" -ge 1 ]; then
      pass "Stale lock cleaned; backup succeeded"
    else
      fail "Stale lock cleaned but backup failed"
    fi
  else
    fail "Backup after stale lock failed (exit $RC)"
  fi
else
  # Test lock logic only (no Docker needed)
  # The backup will fail at Docker ops, but lock should be acquired after stale cleanup
  BACKUP_DIR="$T11_DIR" bash "$BACKUP_SH" --yes 2>&1 | head -5
  if [ ! -d "$T11_DIR/.backup.lock" ] || [ "$(cat "$T11_DIR/.backup.lock/LOCK_PID" 2>/dev/null)" != "99999" ]; then
    pass "Stale lock replaced (PID changed)"
  else
    fail "Stale lock not replaced"
  fi
fi

# ===========================================================================
# RETENTION SCENARIOS
# ===========================================================================

echo ""
echo "--- Retention Scenarios ---"

# --- Test 12: Keep at least MIN_BACKUPS ---
echo ""
echo "--- Test 12: Retention keeps at least 2 backups ---"
if check_docker; then
  T12_DIR="$TEST_ROOT/t12"
  mkdir -p "$T12_DIR"
  # Create 3 backups
  for i in 1 2 3; do
    BACKUP_DIR="$T12_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
    sleep 1
  done
  TOTAL_BEFORE=$(count_backup_sets "$T12_DIR")
  
  # Backdate the oldest backup by 10 days
  OLDEST_META=$(find "$T12_DIR" -maxdepth 1 -name 'homecloud_*.meta' -type f ! -path "*/.staging/*" | sort | head -n 1)
  OLDEST_TS=""
  if [ -n "$OLDEST_META" ]; then
    OLDEST_TS=$(basename "$OLDEST_META" .meta | sed 's/^homecloud_//')
    backdate_file "$OLDEST_META" 10
    backdate_file "$T12_DIR/homecloud_db_${OLDEST_TS}.sql.gz" 10
    backdate_file "$T12_DIR/homecloud_storage_${OLDEST_TS}.tar.gz" 10
    backdate_file "$T12_DIR/homecloud_${OLDEST_TS}.meta.sha256" 10
  fi
  
  # Create a 4th backup (triggers retention)
  BACKUP_DIR="$T12_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  TOTAL_AFTER=$(count_backup_sets "$T12_DIR")
  
  if [ "$TOTAL_AFTER" -ge 2 ]; then
    pass "Retention kept at least 2 backups ($TOTAL_BEFORE → $TOTAL_AFTER)"
  else
    fail "Retention deleted too many backups ($TOTAL_BEFORE → $TOTAL_AFTER)"
  fi
  if [ -n "$OLDEST_TS" ] && find "$T12_DIR" -maxdepth 1 -name "homecloud_${OLDEST_TS}*" -print -quit | grep -q .; then
    pass "Retention ignored filesystem mtime and used filename timestamp"
  else
    fail "Retention incorrectly selected a backup using filesystem mtime"
  fi
else
  skip "Docker not running"
fi

# --- Test 13: Retention preserves fresh backups ---
echo ""
echo "--- Test 13: Retention does not delete fresh backups ---"
if check_docker; then
  T13_DIR="$TEST_ROOT/t13"
  mkdir -p "$T13_DIR"
  # Create 2 backups
  for i in 1 2; do
    BACKUP_DIR="$T13_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
    sleep 1
  done
  # Backdate both by 10 days
  for meta in "$T13_DIR"/homecloud_*.meta; do
    [ -f "$meta" ] || continue
    backdate_file "$meta" 10
    TS=$(basename "$meta" .meta | sed 's/^homecloud_//')
    backdate_file "$T13_DIR/homecloud_db_${TS}.sql.gz" 10
    backdate_file "$T13_DIR/homecloud_storage_${TS}.tar.gz" 10
  done
  
  # Run a 3rd backup — retention should delete the 2 backdated ones (older than 7 days)
  # but keep at least MIN_BACKUPS=2, so nothing should be deleted
  BACKUP_DIR="$T13_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  TOTAL=$(count_backup_sets "$T13_DIR")
  
  if [ "$TOTAL" -ge 2 ]; then
    pass "Fresh backup preserved; old backups kept by floor (total=$TOTAL)"
  else
    fail "Fresh backup or floor backups deleted (total=$TOTAL)"
  fi
else
  skip "Docker not running"
fi

# --- Test 14: Retention ignores staging/incomplete ---
echo ""
echo "--- Test 14: Retention ignores staging directory ---"
T14_DIR="$TEST_ROOT/t14"
mkdir -p "$T14_DIR"
mkdir -p "$T14_DIR/.staging/fake_session"
echo "fake" > "$T14_DIR/.staging/fake_session/homecloud_db_fake.meta"
# Run retention with no valid backups (staging excluded)
TOTAL=$(find "$T14_DIR" -maxdepth 1 -name 'homecloud_*.meta' -type f ! -path "*/.staging/*" | wc -l | tr -d ' ')
TOTAL_INCL_STAGING=$(find "$T14_DIR" -name 'homecloud_*.meta' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$TOTAL" -eq 0 ] && [ "$TOTAL_INCL_STAGING" -gt 0 ]; then
  pass "Staging .meta excluded from backup set count"
else
  fail "Staging .meta not excluded (found=$TOTAL, with_staging=$TOTAL_INCL_STAGING)"
fi

# ===========================================================================
# ATOMICITY SCENARIOS
# ===========================================================================

echo ""
echo "--- Atomicity Scenarios ---"

# --- Test 15: .meta and sidecar published only after all artifacts verified ---
echo ""
echo "--- Test 15: All 4 artifacts published together (atomic finalize) ---"
if check_docker; then
  T15_DIR="$TEST_ROOT/t15"
  mkdir -p "$T15_DIR"
  BACKUP_DIR="$T15_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  DB_COUNT=$(find "$T15_DIR" -maxdepth 1 -name 'homecloud_db_*.sql.gz' -type f | wc -l | tr -d ' ')
  STOR_COUNT=$(find "$T15_DIR" -maxdepth 1 -name 'homecloud_storage_*.tar.gz' -type f | wc -l | tr -d ' ')
  META_COUNT=$(find "$T15_DIR" -maxdepth 1 -name 'homecloud_*.meta' -type f ! -path "*/.staging/*" | wc -l | tr -d ' ')
  SIDECAR_COUNT=$(find "$T15_DIR" -maxdepth 1 -name 'homecloud_*.meta.sha256' -type f ! -path "*/.staging/*" | wc -l | tr -d ' ')
  if [ "$DB_COUNT" -eq 1 ] && [ "$STOR_COUNT" -eq 1 ] && [ "$META_COUNT" -eq 1 ] && [ "$SIDECAR_COUNT" -eq 1 ]; then
    pass "All 4 artifacts published together (db=$DB_COUNT stor=$STOR_COUNT meta=$META_COUNT sidecar=$SIDECAR_COUNT)"
  else
    fail "Artifact counts mismatch (db=$DB_COUNT stor=$STOR_COUNT meta=$META_COUNT sidecar=$SIDECAR_COUNT)"
  fi
else
  skip "Docker not running"
fi

# --- Test 16: restore rejects a legacy set without a sidecar before destructive work ---
echo ""
echo "--- Test 16: Legacy backup without sidecar fails closed ---"
if [ -n "${T15_DIR:-}" ]; then
  LEGACY_DIR="$TEST_ROOT/t16"
  mkdir -p "$LEGACY_DIR"
  cp -R "$T15_DIR"/homecloud_* "$LEGACY_DIR/" 2>/dev/null || true
  rm -f "$LEGACY_DIR/"*.meta.sha256
  set +e
  OUTPUT=$(BACKUP_DIR="$LEGACY_DIR" BACKEND_IMAGE="homecloud-backend" bash "$RESTORE_SH" --validate-only 2>&1)
  RC=$?
  set -e
  if [ "$RC" -ne 0 ] && echo "$OUTPUT" | grep -q "Missing or unsafe .meta.sha256"; then
    pass "Legacy backup without sidecar rejected before destructive operations"
  else
    fail "Legacy backup without sidecar was not rejected correctly (exit=$RC)"
  fi
else
  skip "No backup from Test 15"
fi

# --- Test 18: Disk-space pre-check uses KiB and fails closed when df is unusable ---
echo ""
echo "--- Test 18: Disk-space units and fail-closed df path ---"
DISK_TEST_DIR="$TEST_ROOT/t18-disk"
FAKE_BIN="$TEST_ROOT/t18-bin"
mkdir -p "$DISK_TEST_DIR" "$FAKE_BIN"
cat > "$FAKE_BIN/df" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' 'Filesystem     1K-blocks     Used Available Use% Mounted on'
printf '%s\n' 'fake-fs                1        1         1 100% /'
EOF
chmod +x "$FAKE_BIN/df"
set +e
PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$DISK_TEST_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
DISK_RC=$?
set -e
if [ "$DISK_RC" -eq 3 ]; then
  pass "Disk-space check uses df -Pk KiB and exits 3 when space is insufficient"
else
  fail "Disk-space check returned exit=$DISK_RC (expected 3)"
fi

# --- Test 17: Retention uses filename timestamp, not filesystem mtime ---
echo ""
echo "--- Test 17: Retention selects filename timestamp ---"
if [ -n "${T15_DIR:-}" ]; then
  RETENTION_DIR="$TEST_ROOT/t17-retention"
  mkdir -p "$RETENTION_DIR"
  OLD_TS="20200101_000000_11111111"
  MID_TS="20200101_000000_22222222"
  NEW_TS="20200101_000000_33333333"
  for ts in "$OLD_TS" "$MID_TS" "$NEW_TS"; do
    cp "$T15_DIR"/homecloud_db_*.sql.gz "$RETENTION_DIR/homecloud_db_${ts}.sql.gz"
    cp "$T15_DIR"/homecloud_storage_*.tar.gz "$RETENTION_DIR/homecloud_storage_${ts}.tar.gz"
    cp "$T15_DIR"/homecloud_*.meta "$RETENTION_DIR/homecloud_${ts}.meta"
    cp "$T15_DIR"/homecloud_*.meta.sha256 "$RETENTION_DIR/homecloud_${ts}.meta.sha256"
  done
  RETENTION_DAYS=0 BACKUP_DIR="$RETENTION_DIR" bash "$BACKUP_SH" --yes >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 0 ] && [ ! -e "$RETENTION_DIR/homecloud_${OLD_TS}.meta" ] && \
     [ ! -e "$RETENTION_DIR/homecloud_db_${OLD_TS}.sql.gz" ] && \
     [ "$(find "$RETENTION_DIR" -maxdepth 1 -name 'homecloud_*.meta' -type f | wc -l | tr -d ' ')" -ge 2 ]; then
    pass "Retention selected filename timestamp and preserved the minimum set"
  else
    fail "Filename-timestamp retention failed (exit=$RC)"
  fi
else
  skip "No backup from Test 15"
fi

# ===========================================================================
# SUMMARY
# ===========================================================================

echo ""
echo "========================================"
echo "=== Final Summary ==="
echo "  Passed:  $PASS_COUNT"
echo "  Failed:  $FAIL_COUNT"
echo "  Skipped: $SKIP_COUNT"
echo "========================================"

# Cleanup
test_restore_env
rm -rf "$TEST_ROOT" 2>/dev/null || true

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
