#!/usr/bin/env bash
set -euo pipefail
umask 077

cd /opt/homecloud

: "${HOMECLOUD_E2E_PLATFORM:?Launcher must supply native E2E platform}"
python3 -B scripts/ci/restore-runtime-preflight.py
case "${HOMECLOUD_E2E_ENCRYPTED:-0}" in
  0) ;;
  1) command -v age >/dev/null; command -v age-keygen >/dev/null ;;
  *) exit 2 ;;
esac
case "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}:${HOMECLOUD_E2E_ENCRYPTED:-0}" in
  0:0|0:1|1:0) ;;
  *) exit 2 ;;
esac
case "${HOMECLOUD_E2E_FAULT_CASE:-none}" in
  none) ;;
  partial-stop|staged|db-restored|reconciled|ready-before-clear|ready-after-clear|foreign-writer)
    test "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}:${HOMECLOUD_E2E_ENCRYPTED:-0}" = 0:0 ;;
  *) exit 2 ;;
esac

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH

WORK="$(mktemp -d /tmp/homecloud-e2e.XXXXXX)"
LOOP=""
DAEMON=""
UUID=""

export COMPOSE_PROJECT_NAME=homecloud-restore-e2e
export COMPOSE_FILE="$WORK/compose.yml"
export COMPOSE_DISABLE_ENV_FILE=1
export COMPOSE_ENV_FILES=/dev/null

cleanup() {
  RC=$?
  trap - EXIT

  if [ "$RC" -ne 0 ]; then
    echo "=== E2E FAILURE ==="
    if [ -n "$DAEMON" ] && [ -f "$COMPOSE_FILE" ]; then
      docker compose ps --all || true
      docker compose logs --tail 80 backend db || true
    fi
    ls -la /etc/homecloud/maintenance 2>/dev/null || true
    cat /etc/homecloud/maintenance/restore.pending.json 2>/dev/null || true
    tail -30 "$WORK/dockerd.log" 2>/dev/null || true
  fi

  if [ -n "$DAEMON" ]; then
    if [ -f "$COMPOSE_FILE" ]; then
      docker compose down --volumes --remove-orphans \
        >/dev/null 2>&1 || true
    fi
    kill "$DAEMON" 2>/dev/null || true
    wait "$DAEMON" 2>/dev/null || true
  fi

  if mountpoint -q /mnt/hc-e2e; then
    umount /mnt/hc-e2e || true
  fi

  if [ -n "$UUID" ]; then
    rm -f "/dev/disk/by-uuid/$UUID"
  fi

  if [ -n "$LOOP" ]; then
    losetup -d "$LOOP" || true
  fi

  exit "$RC"
}

trap cleanup EXIT

echo "=== PRIVATE DOCKER DAEMON ==="

python3 -B scripts/ci/restore-e2e-cgroup.py

dockerd \
  --host=unix:///var/run/docker.sock \
  --storage-driver=vfs \
  --exec-opt=native.cgroupdriver=cgroupfs \
  --iptables=false \
  --ip6tables=false \
  >"$WORK/dockerd.log" 2>&1 &

DAEMON=$!
READY=0

for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    READY=1
    break
  fi
  kill -0 "$DAEMON"
  sleep 1
done

test "$READY" = 1
docker load

echo "=== NESTED RESOURCE LIMIT PREFLIGHT ==="
# Exercise the same resource controls that restore's isolated PostgreSQL and
# migration containers need, before allocating storage or stopping writers.
docker run --rm --pull=never --network none --read-only \
  --security-opt no-new-privileges --memory 512m --cpus 1 --pids-limit 128 \
  --entrypoint sh "$HOMECLOUD_E2E_STUB_IMAGE" -ec '
    grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status
    test "$(cat /sys/fs/cgroup/cgroup.type)" = domain
    test "$(cat /sys/fs/cgroup/memory.max)" = 536870912
    test "$(cat /sys/fs/cgroup/pids.max)" = 128
    read quota period < /sys/fs/cgroup/cpu.max
    test "$quota" -gt 0
    test "$quota" = "$period"
    echo "PASS: nested seccomp and memory/CPU/PID limits applied by kernel"
  '

echo "=== EXT4 FIXTURE ==="

mkdir -p /mnt/hc-e2e /etc/homecloud

truncate -s 512M "$WORK/disk.img"
mkfs.ext4 -q -F "$WORK/disk.img"

LOOP="$(losetup --find --show "$WORK/disk.img")"
mount -t ext4 "$LOOP" /mnt/hc-e2e

UUID="$(blkid -s UUID -o value "$LOOP")"
test -n "$UUID"

mkdir -p /dev/disk/by-uuid

# Real non-root backend must traverse the UUID alias directories.
chmod 755 /dev/disk /dev/disk/by-uuid

ln -s "../../$(basename "$LOOP")" "/dev/disk/by-uuid/$UUID"

PG_UID="$(docker run --rm --network none --entrypoint id \
  postgres:16-alpine -u postgres)"

PG_GID="$(docker run --rm --network none --entrypoint id \
  postgres:16-alpine -g postgres)"

mkdir -p \
  /mnt/hc-e2e/db \
  /mnt/hc-e2e/storage/.tmp \
  /etc/homecloud/maintenance \
  "$WORK/backups"

chown "$PG_UID:$PG_GID" /mnt/hc-e2e/db

chown 1001:65533 \
  /mnt/hc-e2e/storage \
  /mnt/hc-e2e/storage/.tmp

chmod 700 /mnt/hc-e2e/db /mnt/hc-e2e/storage \
  /mnt/hc-e2e/storage/.tmp "$WORK/backups"

chmod 755 /etc/homecloud
chmod 711 /etc/homecloud/maintenance

for ROLE in db backend; do
  printf "homecloud-v1 %s %s\n" "$ROLE" "$UUID" \
    > "/mnt/hc-e2e/.homecloud-$ROLE"
done

chown "$PG_UID:$PG_GID" /mnt/hc-e2e/.homecloud-db
chown 1001:65533 /mnt/hc-e2e/.homecloud-backend

chmod 400 /mnt/hc-e2e/.homecloud-db \
  /mnt/hc-e2e/.homecloud-backend

printf "db %s /mnt/hc-e2e /mnt/hc-e2e/db %s %s dedicated\n" \
  "$UUID" "$PG_UID" "$PG_GID" \
  > /etc/homecloud/startup-db.gate

printf "backend %s /mnt/hc-e2e /mnt/hc-e2e/storage 1001 65533 dedicated\n" \
  "$UUID" > /etc/homecloud/startup-backend.gate

chmod 644 /etc/homecloud/startup-*.gate

echo "=== ENROLL LEGACY STORAGE IDENTITY ==="

docker run --rm --pull=never --network none \
  --user 1001:65533 \
  --mount type=bind,src=/mnt/hc-e2e/storage,dst=/storage \
  --entrypoint node \
  homecloud-restore-e2e-backend:local \
  -e "require('./dist/storage/storage-mount-registry.js').bootstrapLegacyMarker('/storage')"

test "$(stat -c "%u:%g:%a" /mnt/hc-e2e/storage/.homecloud-storage-identity)" = "1001:65533:600"

echo "PASS: production legacy storage identity enrolled"


export HOMECLOUD_CONFIG_MODE=environment
export DB_NAME=fixture
export DB_USER=fixture

export DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
export JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export JWT_REFRESH_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export REDIS_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"

export STORAGE_PATH=/storage
export BACKUP_DIR="$WORK/backups"
export BACKEND_IMAGE=homecloud-restore-e2e-backend:local
export BACKUP_WRITE_BARRIER_CONFIRMED=1

echo "=== COMPOSE FIXTURE ==="

python3 -B - <<'PY'
import json
import os
from pathlib import Path

env = os.environ
root = "/mnt/hc-e2e"
gate = "/opt/homecloud/deploy/linux/startup-gate.sh"

def mounts(role, target, directory):
    return [
        f"{root}/{directory}:{target}",
        f"{gate}:/run/homecloud/startup-gate.sh:ro",
        f"/etc/homecloud/startup-{role}.gate:/run/homecloud/startup.gate:ro",
        "/proc/1/mountinfo:/run/homecloud/host-mountinfo:ro",
        "/dev:/run/homecloud/dev:ro",
        f"{root}/.homecloud-{role}:/run/homecloud/volume-marker:ro",
    ]

def health(command):
    return {
        "test": command,
        "interval": "3s",
        "timeout": "5s",
        "retries": 40,
    }

backend_env = {
    key: env[key] for key in (
        "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET",
        "JWT_REFRESH_SECRET", "REDIS_PASSWORD", "STORAGE_PATH"
    )
}

backend_env.update({
    "NODE_ENV": "production",
    "PORT": "3000",
    "DATABASE_URL": (
        f"postgres://{env['DB_USER']}:{env['DB_PASSWORD']}"
        f"@db:5432/{env['DB_NAME']}"
    ),
    "FRONTEND_URL": "https://restore-fixture.example.invalid",
    "TRUSTED_PROXY_IP": "192.0.2.1",
    "UPLOAD_SSD_ENABLED": "false",
    "UPLOAD_SSD_RECOVERY_MODE": "manual",
    "MAX_FILE_SIZE": "104857600",
    "MAX_TOTAL_SIZE": "1073741824",
    "MAX_CHUNK_SIZE": "52428800",
})

services = {
    "db": {
        "image": "postgres:16-alpine",
        "pull_policy": "never",
        "entrypoint": ["sh", "/run/homecloud/startup-gate.sh", "db"],
        "command": ["postgres"],
        "environment": {
            "POSTGRES_USER": env["DB_USER"],
            "POSTGRES_DB": env["DB_NAME"],
            "POSTGRES_PASSWORD": env["DB_PASSWORD"],
        },
        "volumes": mounts("db", "/var/lib/postgresql/data", "db"),
        "healthcheck": health([
            "CMD", "pg_isready", "-h", "127.0.0.1",
            "-U", env["DB_USER"], "-d", env["DB_NAME"],
        ]),
    },
    "backend": {
        "image": env["BACKEND_IMAGE"],
        "pull_policy": "never",
        "user": "1001:65533",
        "init": True,
        "entrypoint": ["sh", "/run/homecloud/startup-gate.sh", "backend"],
        "command": ["node", "dist/main.js"],
        "environment": backend_env,
        "volumes": mounts("backend", "/storage", "storage") + [
            "/etc/homecloud/maintenance:/run/homecloud/maintenance:ro"
        ],
        "depends_on": {"db": {"condition": "service_healthy"}},
        "healthcheck": health(["CMD", "node", "docker/healthcheck.cjs"]),
    },
}

for service, dependency in (
    ("frontend", "backend"), ("ingress", "frontend")
):
    services[service] = {
        "image": env.get("HOMECLOUD_E2E_STUB_IMAGE", "alpine:latest"),
        "pull_policy": "never",
        "command": ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done"],
        "depends_on": {dependency: {"condition": "service_healthy"}},
        "healthcheck": health(["CMD", "true"]),
    }

config = {
    "name": env["COMPOSE_PROJECT_NAME"],
    "services": services,
    "networks": {"default": {"internal": True}},
}

Path(env["COMPOSE_FILE"]).write_text(json.dumps(config))
PY

chmod 600 "$COMPOSE_FILE"

echo "=== START REAL DATABASE AND BACKEND ==="

docker compose up -d --wait --wait-timeout 180
docker compose ps

test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
  -c 'SHOW server_version')" = 16.15
echo "PASS: actual PostgreSQL16.15"

docker compose logs backend db \
  | grep -F "PASS: HomeCloud startup disk gate"

cat > "$WORK/api.cjs" <<'JS'
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const base = "http://127.0.0.1:3000/api/v1";
const credentials = {
  email: "restore-fixture@example.invalid",
  password: "E2eFixture!726184",
};
const payload = Buffer.from("HomeCloud backup restore proof\n");

async function request(path, method, body, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;

  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(base + path, {
    method, headers, body,
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  assert.equal(result.success, true);
  return result.data;
}

async function main() {
  const mode = process.env.HC_ACTION;

  const auth = await request(
    mode === "register" ? "/auth/register" : "/auth/login",
    "POST",
    mode === "register"
      ? {...credentials, name: "Restore fixture"}
      : credentials
  );

  const token = auth.accessToken;
  assert.ok(token);

  if (mode === "register") {
    console.log("PASS: fixture user registered");
    return;
  }

  if (mode === "seed" || mode === "mutate") {
    const filename = mode === "seed"
      ? "before-backup.txt" : "after-backup.txt";

    const bytes = mode === "seed"
      ? payload : Buffer.from("must disappear\n");

    const session = await request("/uploads/session", "POST", {
      filename,
      totalSize: bytes.length,
      chunkSize: bytes.length,
      expectedSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }, token);

    assert.ok(session.uploadId);

    const form = new FormData();
    form.append("chunkIndex", "0");
    form.append("chunk", new Blob([bytes]), filename);

    await request(
      `/uploads/session/${session.uploadId}/chunk`, "POST", form, token
    );

    await request(
      `/uploads/session/${session.uploadId}/complete`,
      "POST", undefined, token
    );

    console.log(`PASS: uploaded ${filename}`);
    return;
  }

  const result = await request("/files", "GET", undefined, token);
  const files = Array.isArray(result) ? result : result.files;

  assert.ok(Array.isArray(files));

  const original = files.find(file => file.name === "before-backup.txt");

  assert.ok(original);
  assert.ok(!files.some(file => file.name === "after-backup.txt"));

  const download = await fetch(`${base}/files/${original.id}/download`, {
    headers: {authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(20000),
  });

  assert.ok(download.ok);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);

  console.log("PASS: restored download contains exact original bytes");
  console.log("PASS: post-backup file absent");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
JS

echo "=== REGISTER FIXTURE USER ==="

docker compose exec -T -e HC_ACTION=register backend node \
  < "$WORK/api.cjs"

echo "=== ASSIGN FIXTURE QUOTA ==="

test "$COMPOSE_PROJECT_NAME" = homecloud-restore-e2e
test "$DB_NAME" = fixture
test "$DB_USER" = fixture

QUOTA_RESULT="$(docker compose exec -T db \
  psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At <<'SQL'
WITH updated AS (
  UPDATE users
  SET "storageQuota" = 104857600
  WHERE email = 'restore-fixture@example.invalid'
    AND "storageUsed" = 0
    AND "storageQuota" = 0
  RETURNING id
)
SELECT count(*) FROM updated;
SQL
)"

test "$QUOTA_RESULT" = 1

echo "PASS: fixture quota assigned (100 MiB)"

docker compose ps --all -q | sort > "$WORK/original-containers"
stat -c '%d:%i' /mnt/hc-e2e/storage/.homecloud-storage-identity \
  > "$WORK/original-storage-identity"

echo "=== SEED DATA THROUGH REAL API ==="

docker compose exec -T -e HC_ACTION=seed backend node \
  < "$WORK/api.cjs"

verify_restored_state() {
echo "=== VERIFY RESTORED DATA ==="

docker compose exec -T -e HC_ACTION=verify backend node \
  < "$WORK/api.cjs"

echo "=== VERIFY MAINTENANCE CLEANUP ==="

docker compose ps --all -q | sort > "$WORK/restored-containers"
cmp "$WORK/original-containers" "$WORK/restored-containers"
test "$(stat -c '%d:%i' /mnt/hc-e2e/storage/.homecloud-storage-identity)" = \
  "$(cat "$WORK/original-storage-identity")"

CONSISTENCY="$(docker compose exec -T db \
  psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At <<'SQL'
SELECT count(*) FROM users u
WHERE email = 'restore-fixture@example.invalid'
  AND "storageQuota" = 104857600
  AND "storageUsed" = (SELECT COALESCE(sum(size),0) FROM files f
                        WHERE f."userId"=u.id AND NOT f."isFolder")
  AND (SELECT count(*) FROM files f WHERE f."userId"=u.id
       AND f.name='before-backup.txt' AND NOT f."isDeleted") = 1
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f."userId"=u.id
                  AND f.name='after-backup.txt')
  AND NOT EXISTS (SELECT 1 FROM file_copy_operations
                  WHERE state IN ('reserved','cleanup_required'));
SQL
)"
test "$CONSISTENCY" = 1
echo "PASS: original containers, storage identity, quota and journal consistent"

PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
from pathlib import Path

state = Path("/etc/homecloud/maintenance")
root = Path("/mnt/hc-e2e/storage")

assert not (state / "maintenance.inhibit").exists()
assert not (state / "restore.pending.json").exists()
assert not list(state.glob("restore-migration.*"))
assert not (root / ".restore-staging").exists()
assert not (root / ".restore-swap").exists()

print("PASS: no residual maintenance or restore artifacts")
PY
}

echo "=== FENCED BACKUP ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  echo "=== REAL ENCRYPTED PRODUCTION COORDINATOR ==="
  export BACKUP_PRODUCTION_DIR="$WORK/encrypted-local"
  export BACKUP_OFFSITE_DIR="$WORK/encrypted-offsite"
  export BACKUP_OFFSITE_CONFIRMED=1
  export BACKUP_WRITE_BARRIER_CONFIRMED=1
  export BACKUP_AGE_IDENTITY_FILE="$WORK/age-identity"
  export BACKUP_AGE_RECIPIENTS_FILE="$WORK/age-recipients"
  mkdir -m 0700 "$BACKUP_PRODUCTION_DIR" "$BACKUP_OFFSITE_DIR"
  age-keygen -o "$BACKUP_AGE_IDENTITY_FILE" 2>/dev/null
  age-keygen -y "$BACKUP_AGE_IDENTITY_FILE" > "$BACKUP_AGE_RECIPIENTS_FILE"
  chmod 0600 "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_AGE_RECIPIENTS_FILE"
  # The actual coordinator captures the backup operation FD and invokes the
  # real raw producer. No stubbed child, pre-stopped writer or fake manifest.
  bash scripts/backup-production.sh
  GENERATION="$(python3 -B - <<'PY'
import json
import os
from pathlib import Path
import re

local = Path(os.environ['BACKUP_PRODUCTION_DIR'])
remote = Path(os.environ['BACKUP_OFFSITE_DIR'])
marker = json.loads((local / 'last-backup-success.json').read_text())
name = marker['generation']
assert re.fullmatch(r'hc_\d{8}T\d{6}Z_[0-9a-f]{16}', name)
assert marker['offsite_verified'] is True
for directory in (local, remote):
    assert {p.name for p in (directory / name).iterdir()} == {'backup.age', 'manifest.json'}
    assert not list(directory.glob('.plaintext_*'))
    assert not (directory / '.production.lock').exists()
assert (local / name / 'backup.age').read_bytes().startswith(b'age-encryption.org/v1\n')
for member in ('backup.age', 'manifest.json'):
    assert (local / name / member).read_bytes() == (remote / name / member).read_bytes()
print(name)
PY
)"
else
PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
import subprocess
import json
import os
import recovery_storage as storage

with storage.release_backup_window() as capture:
    fd = capture["operation_fd"]
    subprocess.run(
        ["bash", "/opt/homecloud/scripts/backup.sh", "--yes"],
        env={**os.environ, "HOMECLOUD_BACKUP_OPERATION_FD": str(fd),
             "HOMECLOUD_BACKUP_MARKER_IDENTITY": json.dumps(capture["marker_identity"])},
        pass_fds=(fd,),
        check=True,
    )

print("PASS: actual Backup and fenced restart")
PY
fi

if [ "${HOMECLOUD_E2E_FAULT_CASE:-none}" != none ]; then
  docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
  python3 -B scripts/ci/test-restore-fault-e2e.py "$HOMECLOUD_E2E_FAULT_CASE" "$WORK"
  echo "PASS: REAL RESTORE FAULT CASE $HOMECLOUD_E2E_FAULT_CASE"
  exit 0
fi

if [ "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}" = 1 ]; then
  for table_count in 7 8 9 10 11 13 15; do
    echo "=== HISTORICAL DATABASE: $table_count TABLES ==="
    schema_dir="$WORK/historical-schema-$table_count"
    python3 -B scripts/ci/test-historical-schema-e2e.py "$table_count" "$schema_dir"
    docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
    BACKUP_DIR="$schema_dir" bash scripts/restore.sh --validate-only
    test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
      -c "SELECT count(*) FROM files WHERE name='after-backup.txt' AND NOT \"isDeleted\"")" = 1
    BACKUP_DIR="$schema_dir" bash scripts/restore.sh --yes
    verify_restored_state
    echo "PASS: HISTORICAL DATABASE $table_count TABLES -> CURRENT17 -> REAL API"
  done
  docker compose ps
  echo "PASS: HISTORICAL DATABASE SCHEMA MATRIX 7/8/9/10/11/13/15"
  exit 0
fi

echo "=== MODIFY REAL DATA ==="

docker compose exec -T -e HC_ACTION=mutate backend node \
  < "$WORK/api.cjs"

echo "=== VALIDATE-ONLY RESTORE ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  bash scripts/restore-offsite.sh "$GENERATION" --validate-only
  # Validation must leave the post-backup mutation intact.
  test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
    -c "SELECT count(*) FROM files WHERE name='after-backup.txt' AND NOT \"isDeleted\"")" = 1
else
  bash scripts/restore.sh --validate-only
fi

echo "=== ACTUAL RESTORE ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  bash scripts/restore-offsite.sh "$GENERATION" --yes
else
  bash scripts/restore.sh --yes
fi


verify_restored_state

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  python3 -B - <<'PY'
import json
import os
from pathlib import Path

local = Path(os.environ['BACKUP_PRODUCTION_DIR'])
for operation, event in (('restore-validation', 'encrypted_offsite_validation_completed'),
                         ('restore', 'encrypted_offsite_restore_completed')):
    marker = json.loads((local / ('last-' + operation + '-success.json')).read_text())
    assert marker['event'] == event
    assert (local / marker['generation'] / 'backup.age').is_file()
assert not list(local.glob('.restore_*'))
assert not list(local.glob('.plaintext_*'))
assert not (local / '.production.lock').exists()
print('PASS: production encrypted coordinator markers and plaintext cleanup')
PY
  docker compose ps
  echo "PASS: REAL ENCRYPTED BACKUP -> OFFSITE -> RESTORE E2E"
  exit 0
fi

echo "=== HISTORICAL ARCHIVE WITH ROOT IDENTITY METADATA ==="

# Construct the old producer's archive shape from this disposable backup.
# The original backup remains byte-for-byte unchanged.
export HOMECLOUD_HISTORICAL_FIXTURE="$WORK/historical-backups"
PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import restore_storage as restore

original = Path(os.environ["BACKUP_DIR"])
metas = list(original.glob("homecloud_*.meta"))
assert len(metas) == 1
meta_path = metas[0]
meta = json.loads(meta_path.read_bytes())
fixture = Path(os.environ["HOMECLOUD_HISTORICAL_FIXTURE"])
fixture.mkdir(mode=0o700)
for key in ("db_dump", "storage_archive"):
    assert Path(meta[key]).name == meta[key]
archive_path = original / meta["storage_archive"]
original_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
original_meta_hash = hashlib.sha256(meta_path.read_bytes()).hexdigest()
marker = Path("/mnt/hc-e2e/storage/.homecloud-storage-identity").read_bytes()
assert marker == restore.LEGACY_IDENTITY_BYTES
archive_fixture = fixture / meta["storage_archive"]
with tarfile.open(archive_path, "r:gz") as source:
    with tarfile.open(archive_fixture, "w:gz") as target:
        for entry, _, historical in restore.checked_archive_members(source):
            assert not historical, "New backup must omit root identity"
            if entry.isfile():
                with source.extractfile(entry) as stream:
                    target.addfile(entry, stream)
            else:
                target.addfile(entry)
        entry = tarfile.TarInfo("./" + restore.IDENTITY_MARKER)
        entry.size, entry.mode, entry.uid, entry.gid = len(marker), 0o600, 1001, 65533
        target.addfile(entry, io.BytesIO(marker))
archive_fixture.chmod(0o600)
shutil.copyfile(original / meta["db_dump"], fixture / meta["db_dump"])
(fixture / meta["db_dump"]).chmod(0o600)
meta["storage_file_count"] += 1
meta["storage_archive_size"] = archive_fixture.stat().st_size
meta["storage_archive_sha256"] = hashlib.sha256(archive_fixture.read_bytes()).hexdigest()
metadata = json.dumps(meta, sort_keys=True, indent=2).encode() + b"\n"
(fixture / meta_path.name).write_bytes(metadata)
(fixture / meta_path.name).chmod(0o600)
sidecar = fixture / (meta_path.name + ".sha256")
sidecar.write_text(hashlib.sha256(metadata).hexdigest() + "  " + meta_path.name + "\n")
sidecar.chmod(0o600)
assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == original_hash
assert hashlib.sha256(meta_path.read_bytes()).hexdigest() == original_meta_hash
print("PASS: old archive layout constructed without modifying original backup")
PY

docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
BACKUP_DIR="$HOMECLOUD_HISTORICAL_FIXTURE" bash scripts/restore.sh --validate-only
BACKUP_DIR="$HOMECLOUD_HISTORICAL_FIXTURE" bash scripts/restore.sh --yes
verify_restored_state
echo "PASS: HISTORICAL ROOT IDENTITY BACKUP -> RESTORE"

docker compose ps

echo "PASS: REAL BACKUP -> RESTORE E2E"
