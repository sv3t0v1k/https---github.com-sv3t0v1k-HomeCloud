#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?Provide production runner image}"
PLATFORM="${2:-linux/arm64}"
# Production PostgreSQL digest is architecture-specific.
# Backend remains native ARM64 on Apple Silicon.
PG_PLATFORM="linux/amd64"

PG_IMAGE="docker.io/library/postgres:16.15-alpine@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551"

TOKEN="hc-copy-e2e-$(date +%s)-$$"

NET="${TOKEN}-net"
STORAGE="${TOKEN}-storage"
STATE="${TOKEN}-state"
PGVOL="${TOKEN}-pg"

DB_CID=""
LOCK_CID=""
CREATED_NET=0
CREATED_STORAGE=0
CREATED_STATE=0
CREATED_PGVOL=0

cleanup() {
  rc=$?
  trap - EXIT

  if [ -n "$LOCK_CID" ]; then
    if ! docker rm -f "$LOCK_CID" >/dev/null; then
      echo "ERROR: fixture lock container cleanup failed: $LOCK_CID" >&2
      rc=1
    fi
  fi

  if [ -n "$DB_CID" ]; then
    if ! docker rm -f "$DB_CID" >/dev/null; then
      echo "ERROR: fixture DB container cleanup failed: $DB_CID" >&2
      rc=1
    fi
  fi

  if [ "$CREATED_NET" = 1 ]; then
    if ! docker network rm "$NET" >/dev/null; then
      echo "ERROR: fixture network cleanup failed: $NET" >&2
      rc=1
    fi
  fi

  for entry in \
    "$CREATED_STORAGE:$STORAGE" \
    "$CREATED_STATE:$STATE" \
    "$CREATED_PGVOL:$PGVOL"
  do
    flag="${entry%%:*}"
    volume="${entry#*:}"

    if [ "$flag" = 1 ]; then
      if ! docker volume rm "$volume" >/dev/null; then
        echo "WARNING: test volume retained: $volume"
        rc=1
      fi
    fi
  done

  echo "=== E2E CLEANUP RESULT: exit=$rc ==="
  exit "$rc"
}
trap cleanup EXIT

echo "=== TEST IMAGE IDENTITIES ==="

docker image inspect "$IMAGE" \
  --format 'Backend image: {{.Id}}'

if ! docker image inspect "$PG_IMAGE" \
  >/dev/null 2>&1; then
  docker pull --platform "$PG_PLATFORM" "$PG_IMAGE"
fi

docker image inspect "$PG_IMAGE" \
  --format 'PostgreSQL image: {{.Id}}'

echo "=== CREATE DISPOSABLE RESOURCES ==="

for v in "$STORAGE" "$STATE" "$PGVOL"; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    echo "STOP: fixture volume already exists: $v"
    exit 1
  fi
done

if docker network inspect "$NET" >/dev/null 2>&1; then
  echo "STOP: fixture network already exists"
  exit 1
fi

docker network create --internal "$NET" >/dev/null
CREATED_NET=1

docker volume create "$STORAGE" >/dev/null
CREATED_STORAGE=1

docker volume create "$STATE" >/dev/null
CREATED_STATE=1

docker volume create "$PGVOL" >/dev/null
CREATED_PGVOL=1

SM="type=volume,src=$STORAGE,dst=/storage"
MM="type=volume,src=$STATE,dst=/run/homecloud/maintenance"

# Credentials belong exclusively to this ephemeral database.
DB_URL="postgres://hc_fixture:hc_fixture_password@db:5432/hc_fixture"

echo "=== START ISOLATED POSTGRESQL ==="

DB_CID="$(
  docker run -d \
    --pull never \
    --platform "$PG_PLATFORM" \
    --network "$NET" \
    --network-alias db \
    --mount "type=volume,src=$PGVOL,dst=/var/lib/postgresql/data" \
    -e POSTGRES_USER=hc_fixture \
    -e POSTGRES_PASSWORD=hc_fixture_password \
    -e POSTGRES_DB=hc_fixture \
    "$PG_IMAGE"
)"

READY=0

for i in $(seq 1 60); do
  if docker exec "$DB_CID" \
    pg_isready \
    -h 127.0.0.1 \
    -U hc_fixture \
    -d hc_fixture \
    >/dev/null 2>&1; then
    READY=1
    break
  fi

  sleep 1
done

if [ "$READY" != 1 ]; then
  docker logs "$DB_CID"
  echo "STOP: PostgreSQL did not become ready"
  exit 1
fi

echo "PASS: disposable PostgreSQL ready"

echo "=== PROVISION TEST STORAGE ==="

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network none \
  --user 0:0 \
  --mount "$SM" \
  --mount "$MM" \
  --entrypoint sh \
  "$IMAGE" -ec '
    mkdir -p /storage/.tmp

    chown 1001:1001 /storage /storage/.tmp
    chmod 700 /storage /storage/.tmp

    chown 0:0 /run/homecloud/maintenance
    chmod 711 /run/homecloud/maintenance
  '

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network none \
  --user 1001:1001 \
  --mount "$SM" \
  --entrypoint node \
  "$IMAGE" -e '
    const registry = require(
      "/app/dist/storage/storage-mount-registry.js"
    );
    registry.bootstrapLegacyMarker("/storage");
    console.log("PASS: real storage identity enrolled");
  '

echo "=== APPLY ACTUAL APPLICATION MIGRATIONS ==="

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network "$NET" \
  --user 1001:1001 \
  --mount "$SM" \
  -e NODE_ENV=production \
  -e STORAGE_PATH=/storage \
  -e DATABASE_URL="$DB_URL" \
  -e UPLOAD_SSD_ENABLED=false \
  -e UPLOAD_SSD_RECOVERY_MODE=manual \
  "$IMAGE" \
  node ./node_modules/typeorm/cli.js \
    migration:run \
    -d dist/data-source.js \
    --transaction all

echo "=== VERIFY COPY JOURNAL EXISTS ==="

sql() {
  docker exec "$DB_CID" \
    psql -X -A -t \
    -v ON_ERROR_STOP=1 \
    -U hc_fixture \
    -d hc_fixture \
    -c "$1"
}

test "$(sql \
  "SELECT count(*) FROM file_copy_admission WHERE id=true")" = 1

echo "PASS: actual copy admission migration applied"

echo "=== CREATE REAL DATABASE FIXTURES ==="

SEED=$(cat <<'JS'
"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

const applicationDatabase = require(
  "/app/dist/data-source.js"
).default;
// Fixture-only seed connection; real migration/recovery use fenced entrypoints.
const database = new (require("typeorm").DataSource)(applicationDatabase.options);

const { UserEntity } = require(
  "/app/dist/entities/user.entity.js"
);

const { FileEntity } = require(
  "/app/dist/entities/file.entity.js"
);

const { LEGACY_STORAGE_ID } = require(
  "/app/dist/storage/storage-mount-registry.js"
);

async function main() {
  await database.initialize();

  try {
    const users = database.getRepository(UserEntity);
    const files = database.getRepository(FileEntity);


    const operations = [
      [
        "11111111-2222-3333-4444-555555555551",
        "absent.bin",
      ],
      [
        "11111111-2222-3333-4444-555555555552",
        "present.bin",
      ],
      [
        "11111111-2222-3333-4444-555555555553",
        "metadata.bin",
      ],
      [
        "11111111-2222-3333-4444-555555555554",
        "locked.bin",
      ],
    ];

    const owners = [];

    for (const [index, [id, filename]]
      of operations.entries()) {

      const owner = await users.save({
        email: `fixture-${index + 1}@example.test`,
        password: "fixture-not-an-account",
        name: `Recovery fixture ${index + 1}`,
        storageQuota: 1000000,
        storageUsed: 1,
      });

      assert.equal(owner.id, index + 1);

      owners.push(owner);

      const directory = `/storage/${owner.id}`;
      const sourcePath = `${directory}/source.bin`;
      const sourceKey = `${owner.id}/source.bin`;
      const targetKey = `${owner.id}/${filename}`;

      fs.mkdirSync(directory, { mode: 0o700 });

      fs.writeFileSync(sourcePath, "X", {
        mode: 0o600,
      });

      const source = await files.save({
        name: "source.bin",
        storagePath: sourcePath,
        storageLocationId: LEGACY_STORAGE_ID,
        relativeObjectKey: sourceKey,
        size: 1,
        mimeType: "application/octet-stream",
        isFolder: false,
        isDeleted: false,
        userId: owner.id,
      });

      await database.query(
        `INSERT INTO file_copy_operations
          (
            id,
            "userId",
            "sourceFileId",
            "storageLocationId",
            "relativeObjectKey",
            bytes,
            state
          )
         VALUES
           ($1::uuid,$2,$3,$4::uuid,$5,$6,'reserved')`,
        [
          id,
          owner.id,
          source.id,
          LEGACY_STORAGE_ID,
          targetKey,
          1,
        ],
      );
    }

    // Scenario 2: destination inode still exists.
    fs.writeFileSync(
      "/storage/2/present.bin",
      "MUST-NOT-BE-DELETED",
      { mode: 0o600 },
    );

    // Scenario 3: metadata still exists even though
    // its physical destination is absent.
    await files.save({
      name: "metadata.bin",
      storagePath: "/storage/3/metadata.bin",
      storageLocationId: LEGACY_STORAGE_ID,
      relativeObjectKey: "3/metadata.bin",
      size: 1,
      mimeType: "application/octet-stream",
      isFolder: false,
      isDeleted: true,
      userId: owners[2].id,
    });

    console.log(
      "PASS: four users / four independent reservations"
    );

  } finally {
    await database.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
JS
)

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network "$NET" \
  --user 1001:1001 \
  --mount "$SM" \
  -e DATABASE_URL="$DB_URL" \
  --entrypoint node \
  "$IMAGE" -e "$SEED"

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='reserved'")" = 4

echo "=== VERIFY FIXTURE ADMISSION INVARIANTS ==="

test "$(sql \
  "SELECT count(DISTINCT \"userId\") FROM file_copy_operations WHERE state='reserved'")" = 4

test "$(sql \
  "SELECT count(*) FROM users")" = 4

test "$(sql \
  "SELECT count(*) FROM files")" = 5

echo "PASS: one active reservation per independent user"

echo "=== ENABLE DURABLE MAINTENANCE ==="

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network none \
  --user 0:0 \
  --mount "$MM" \
  --entrypoint sh \
  "$IMAGE" -ec '
    umask 077
    printf "homecloud-maintenance-v1\n" \
      > /run/homecloud/maintenance/maintenance.inhibit

    chmod 600 \
      /run/homecloud/maintenance/maintenance.inhibit

    sync
  '

recover() {
  docker run --rm \
    --init \
    --pull never \
    --platform "$PLATFORM" \
    --network "$NET" \
    --user 1001:1001 \
    --mount "$SM" \
    --mount "$MM,readonly" \
    -e NODE_ENV=production \
    -e STORAGE_PATH=/storage \
    -e DATABASE_URL="$DB_URL" \
    -e UPLOAD_SSD_ENABLED=false \
    -e UPLOAD_SSD_RECOVERY_MODE=manual \
    -e HOMECLOUD_MAINTENANCE_REQUIRED=1 \
    --entrypoint node \
    "$IMAGE" \
    dist/files/file-copy-recovery-cli.js "$1"
}

state() {
  sql "SELECT state FROM file_copy_operations WHERE id='$1'::uuid"
}

must_refuse() {
  local out
  local rc=0

  out="$(recover "$1" 2>&1)" || rc=$?

  printf '%s\n' "$out"

  if [ "$rc" != 1 ]; then
    echo "STOP: unexpected recovery exit code: $rc"
    exit 1
  fi

  printf '%s\n' "$out" | grep -Fq \
    "STOP: offline copy recovery failed"

  if printf '%s\n' "$out" | grep -Fxq \
    "COPY_RECOVERY_RELEASED"; then
    echo "BLOCKER: refused recovery reported success"
    exit 1
  fi
}

OP1="11111111-2222-3333-4444-555555555551"
OP2="11111111-2222-3333-4444-555555555552"
OP3="11111111-2222-3333-4444-555555555553"
OP4="11111111-2222-3333-4444-555555555554"

echo "=== CASE 1: PROVEN ABSENCE RELEASES RESERVATION ==="

OUT="$(recover "$OP1")"
printf '%s\n' "$OUT"

printf '%s\n' "$OUT" | grep -Fxq \
  COPY_RECOVERY_RELEASED

test "$(state "$OP1")" = released

echo "PASS: real PostgreSQL transaction released absent destination"

echo "=== CASE 2: EXISTING INODE MUST BLOCK RECOVERY ==="

must_refuse "$OP2"

test "$(state "$OP2")" = reserved

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network none \
  --user 1001:1001 \
  --mount "$SM,readonly" \
  --entrypoint node \
  "$IMAGE" -e '
    const fs = require("node:fs");
    const assert = require("node:assert/strict");

    assert.equal(
      fs.readFileSync("/storage/2/present.bin", "utf8"),
      "MUST-NOT-BE-DELETED",
    );

    console.log("PASS: destination bytes preserved");
  '

echo "PASS: existing inode retains reservation"

echo "=== CASE 3: SOFT-DELETED METADATA MUST BLOCK ==="

must_refuse "$OP3"

test "$(state "$OP3")" = reserved

test "$(sql \
  "SELECT count(*) FROM files
    WHERE \"storagePath\"='/storage/3/metadata.bin'
      AND \"isDeleted\"=true")" = 1

echo "PASS: soft-deleted metadata remains authoritative"

echo "=== CASE 4: REPEATED RELEASE IS REFUSED ==="

must_refuse "$OP1"

test "$(state "$OP1")" = released

echo "PASS: repeated release fails closed"

echo "=== CASE 5: CONCURRENT ROOT LOCK MUST BLOCK ==="

LOCK_CID="$(
  docker run -d \
    --init \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 1001:1001 \
    --mount "$SM" \
    --entrypoint node \
    "$IMAGE" -e '
      const fs = require("node:fs");

      const { SecureFilesystem } = require(
        "/app/dist/uploads/secure-filesystem.js"
      );

      const root = "/storage";
      const boundary = new SecureFilesystem(
        root, fs.lstatSync(root),
      );

      const fd = boundary.directory(root);
      boundary.lock(fd);

      console.log("ROOT_LOCK_HELD");

      setInterval(() => {}, 1000);
    '
)"

READY=0

for i in $(seq 1 100); do
  if docker logs "$LOCK_CID" 2>&1 | \
    grep -Fxq ROOT_LOCK_HELD; then
    READY=1
    break
  fi

  sleep 0.1
done

if [ "$READY" != 1 ]; then
  docker logs "$LOCK_CID"
  echo "STOP: competing lock was not established"
  exit 1
fi

must_refuse "$OP4"

test "$(state "$OP4")" = reserved

docker rm -f "$LOCK_CID" >/dev/null
LOCK_CID=""

# Positive control: after the competing lock is gone,
# the exact same operation must be recoverable.
OUT="$(recover "$OP4")"
printf '%s\n' "$OUT"

printf '%s\n' "$OUT" | grep -Fxq \
  COPY_RECOVERY_RELEASED

test "$(state "$OP4")" = released

echo "PASS: recovery requires exclusive storage root lock"

echo "=== FINAL DATABASE INVARIANTS ==="

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='released'")" = 2

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='reserved'")" = 2

test "$(sql \
  "SELECT count(*) FROM file_copy_operations")" = 4

test "$(sql \
  "SELECT count(*) FROM files")" = 5

test "$(sql \
  "SELECT count(*) FROM users")" = 4

docker run --rm \
  --pull never \
  --platform "$PLATFORM" \
  --network none \
  --user 0:0 \
  --mount "$MM,readonly" \
  --entrypoint sh \
  "$IMAGE" -ec '
    marker=/run/homecloud/maintenance/maintenance.inhibit

    test -f "$marker"
    test ! -L "$marker"

    test "$(stat -c "%u:%g:%a" "$marker")" = "0:0:600"
    test "$(cat "$marker")" = "homecloud-maintenance-v1"

    echo "PASS: maintenance inhibitor retained"
  '


echo "=== SHARED BACKUP / RESTORE GUARD ==="

GUARD_SQL="scripts/recovery-pending.sql"
test -f "$GUARD_SQL"

guard_psql() {
  docker exec -i "$DB_CID" \
    psql -X -A -t \
    -v ON_ERROR_STOP=1 \
    -U hc_fixture \
    -d hc_fixture
}

guard_refuses() {
  local setup="$1"
  local expected="$2"
  local out
  local rc=0

  out="$(
    {
      printf 'BEGIN;\n%s\n' "$setup"
      cat "$GUARD_SQL"
      printf '\nROLLBACK;\n'
    } | guard_psql 2>&1
  )" || rc=$?

  test "$rc" = 3

  printf '%s\n' "$out" | grep -Fq "$expected"

  echo "PASS: $expected"
}

guard_allows() {
  local setup="$1"

  {
    printf 'BEGIN;\n%s\n' "$setup"
    cat "$GUARD_SQL"
    printf '\nROLLBACK;\n'
  } | guard_psql >/dev/null
}

# Test-only SQL changes are enclosed in an isolated
# PostgreSQL transaction; no fixture state is persisted.

echo "=== GUARD CASE 1: RESERVED OPERATIONS ==="

guard_refuses \
  "SELECT 1;" \
  "Unsupported pending file copy operations"

echo "=== GUARD CASE 2: CLEANUP REQUIRED ==="

guard_refuses \
  "UPDATE file_copy_operations SET state='cleanup_required' WHERE state='reserved';" \
  "Unsupported pending file copy operations"

echo "=== GUARD CASE 3: CLEAN COPY JOURNAL ==="

guard_allows \
  "UPDATE file_copy_operations SET state='released' WHERE state='reserved';"

echo "PASS: resolved journal allowed"

echo "=== GUARD CASE 4: INCOMPLETE JOURNAL SCHEMA ==="

guard_refuses \
  "DROP TABLE file_copy_admission;" \
  "Incomplete file copy journal schema"

echo "=== GUARD CASE 5: MIGRATION WITHOUT TABLES ==="

guard_refuses \
  "DROP TABLE file_copy_operations, file_copy_admission;" \
  "File copy migration exists without journal tables"

echo "=== GUARD CASE 6: HISTORICAL SCHEMA ==="

guard_allows \
  "DROP TABLE file_copy_operations, file_copy_admission;
   DELETE FROM migrations WHERE timestamp=1792831300000;"

echo "PASS: pre-copy historical schema allowed"

echo "=== GUARD CASE 7: INVALID ADMISSION SINGLETON ==="

guard_refuses \
  "DELETE FROM file_copy_admission;" \
  "Invalid file copy admission singleton"

echo "=== GUARD CASE 8: INVALID MIGRATION IDENTITY ==="

guard_refuses \
  "UPDATE migrations SET name='InvalidCopyMigration' WHERE timestamp=1792831300000;" \
  "Invalid file copy migration identity"

echo "=== VERIFY GUARD TESTS LEFT FIXTURES UNCHANGED ==="

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='released'")" = 2

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='reserved'")" = 2

test "$(sql \
  "SELECT count(*) FROM file_copy_admission WHERE id=true")" = 1

test "$(sql \
  "SELECT count(*) FROM migrations WHERE timestamp=1792831300000 AND name='FileCopyAdmission1792831300000'")" = 1

echo "PASS: all guard-test transactions rolled back"
echo "=== PASS: 8/8 SHARED RECOVERY GUARD SCENARIOS ==="

echo "=== REAL RESTORE VALIDATOR SCENARIOS ==="

# Use separate databases inside the disposable PostgreSQL
# container. The original recovery fixtures remain unchanged.
VALIDATION_DB="hc_validator"
REPLAY_DB="hc_replay"

sql "CREATE DATABASE hc_validator TEMPLATE hc_fixture;"
sql "CREATE DATABASE hc_replay;"

validator_sql() {
  docker exec -i "$DB_CID" \
    psql -X -A -t \
    -v ON_ERROR_STOP=1 \
    -U hc_fixture \
    -d "$VALIDATION_DB" "$@"
}

# Load ONLY the actual restore validation function.
# Never source restore.sh itself: it has destructive top-level code.

VALIDATOR_SOURCE="$(
  python3 -B - <<'PY_VALIDATOR'
from pathlib import Path

s = Path("scripts/restore.sh").read_text()

start = "validate_restored_database() {"
end = "remove_restore_migration_container() {"

if s.count(start) != 1 or s.count(end) != 1:
    raise SystemExit("Unexpected restore validator boundaries")

body = s.split(start, 1)[1].split(end, 1)[0]

print(start + body)
PY_VALIDATOR
)"

# Capture the complete function before loading it.
# Avoid source/process-substitution incompatibilities on macOS.
if [ -z "$VALIDATOR_SOURCE" ]; then
  echo "STOP: restore validator extraction returned no code"
  exit 1
fi

bash -n <<< "$VALIDATOR_SOURCE"

# The source is the exact locally checked-out restore function,
# not external input or the executable restore.sh top-level body.
eval "$VALIDATOR_SOURCE"

declare -F validate_restored_database >/dev/null

unset VALIDATOR_SOURCE

echo "PASS: original restore validator loaded successfully"

# Dependencies used by the original restore validator.
CORE_TABLE_NAMES="users files folders share_links upload_sessions refresh_tokens migrations"
SCRIPT_DIR="$(pwd)/scripts"

validation_psql() {
  validator_sql "$@"
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validator_refuses() {
  local mode="$1"
  local expected="$2"
  local out
  local rc=0

  out="$(validate_restored_database "$mode" 2>&1)" || rc=$?

  if [ "$rc" != 1 ]; then
    printf '%s\n' "$out"
    echo "STOP: unexpected validator exit code: $rc"
    exit 1
  fi

  printf '%s\n' "$out" | grep -Fq "$expected"

  echo "PASS: $expected"
}

echo "=== VALIDATOR CASE 1: PENDING COPY JOURNAL ==="

validator_refuses \
  current \
  "Unsupported pending SSD/copy state"

echo "=== PREPARE CLEAN TEST-ONLY SCHEMA ==="

# This is a disposable fixture DB, NOT a recovery procedure.
# Remove unresolved test records only from the cloned DB.
# The original E2E reservations are never modified.
validator_sql -c "
  DELETE FROM file_copy_operations
  WHERE state IN ('reserved','cleanup_required');
" >/dev/null

test "$(validator_sql -c \
  "SELECT count(*) FROM file_copy_operations WHERE state='released';")" = 2

echo "=== VALIDATOR CASE 2: CURRENT 17-TABLE SCHEMA ==="

validate_restored_database current

echo "PASS: original restore validator accepts current schema"

echo "=== VALIDATOR CASE 3: REAL DUMP AND SQL REPLAY ==="

# Actual PostgreSQL dump, actual PostgreSQL replay.
# No application filesystem or production mount is used.

docker exec "$DB_CID" \
  pg_dump \
  -U hc_fixture \
  -d hc_validator \
  --clean \
  --if-exists \
  | docker exec -i "$DB_CID" \
      psql -X \
      -v ON_ERROR_STOP=1 \
      -U hc_fixture \
      -d hc_replay \
      >/dev/null

(
  VALIDATION_DB="$REPLAY_DB"

  validate_restored_database current

  test "$(validator_sql -c \
    "SELECT count(*) FROM migrations;")" = 31

  test "$(validator_sql -c \
    "SELECT count(*) FROM file_copy_operations WHERE state='released';")" = 2

  test "$(validator_sql -c \
    "SELECT count(*) FROM file_copy_admission WHERE id=true;")" = 1
)

echo "PASS: real pg_dump / psql replay preserves qualified schema"

echo "=== VALIDATOR CASE 4: WRONG MIGRATION IDENTITY ==="

validator_sql -c "
  UPDATE migrations
  SET name='InvalidCopyMigration'
  WHERE timestamp=1792831300000;
" >/dev/null

validator_refuses \
  current \
  "Schema migration set differs from confirmed inventory"

validator_sql -c "
  UPDATE migrations
  SET name='FileCopyAdmission1792831300000'
  WHERE timestamp=1792831300000;
" >/dev/null

echo "=== VALIDATOR CASE 5: REQUIRED JOURNAL COLUMN MISSING ==="

validator_sql -c '
  ALTER TABLE file_copy_operations
  DROP COLUMN "updatedAt";
' >/dev/null

validator_refuses \
  current \
  "Current schema copy journal columns are missing"

validator_sql -c '
  ALTER TABLE file_copy_operations
  ADD COLUMN "updatedAt" timestamptz NOT NULL DEFAULT now();
' >/dev/null

echo "=== VALIDATOR CASE 6: HISTORICAL 15-TABLE SCHEMA ==="

validator_sql -c "
  DROP TABLE file_copy_operations, file_copy_admission;
  DELETE FROM migrations WHERE timestamp=1792831300000;
" >/dev/null

validate_restored_database historical

echo "PASS: original validator accepts historical schema"

echo "=== VALIDATOR CASE 7: HISTORICAL IS NOT CURRENT ==="

validator_refuses \
  current \
  "Migration compatibility failed: expected current 17-table schema"

echo "=== VERIFY ORIGINAL E2E DATABASE UNCHANGED ==="

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='released'")" = 2

test "$(sql \
  "SELECT count(*) FROM file_copy_operations WHERE state='reserved'")" = 2

test "$(sql \
  "SELECT count(*) FROM migrations")" = 31

echo "PASS: original E2E fixtures remain intact"
echo "=== PASS: 7/7 REAL RESTORE VALIDATOR SCENARIOS ==="




echo "=== PASS: 5/5 REAL COPY RECOVERY E2E SCENARIOS ==="
