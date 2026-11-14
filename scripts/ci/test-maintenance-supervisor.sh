#!/usr/bin/env bash
set -euo pipefail

# Dedicated disposable volume. Never use Compose project storage.
IMAGE="${1:?Provide an already-built local backend builder image}"
PLATFORM="${2:-linux/arm64}"

VOL="hc-maintenance-supervisor-$$"
CREATED=0
CID=""

cleanup() {
  rc=$?
  trap - EXIT

  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi

  if [ "$CREATED" = 1 ]; then
    if ! docker volume rm "$VOL" >/dev/null 2>&1; then
      echo "WARNING: disposable test volume cleanup failed: $VOL" >&2
      rc=1
    fi
  fi

  exit "$rc"
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null

if docker volume inspect "$VOL" >/dev/null 2>&1; then
  echo "STOP: test volume already exists"
  exit 1
fi

docker volume create "$VOL" >/dev/null
CREATED=1

MOUNT="type=volume,src=$VOL,dst=/run/homecloud/maintenance"

root_action() {
  docker run --rm \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 0:0 \
    --mount "type=volume,src=$VOL,dst=/state" \
    --entrypoint sh "$IMAGE" -ec "$1"
}

root_action '
  chown 0:0 /state
  chmod 711 /state
  test "$(stat -c "%u:%g:%a" /state)" = "0:0:711"
'

ACTOR=$(cat <<'JS'
"use strict";

const fs = require("node:fs");
const {
  runWithRootFence,
} = require("/app/docker/copy-root-fence-supervisor.cjs");

const root = fs.mkdtempSync("/tmp/hc-maint-supervisor-");
const mode = process.argv[1];

const phaseOne = mode === "race"
  ? `
      const fs = require("node:fs");

      console.log("PHASE_ONE");

      const marker =
        "/run/homecloud/maintenance/maintenance.inhibit";

      const deadline = Date.now() + 15000;

      const timer = setInterval(() => {
        if (fs.existsSync(marker)) {
          clearInterval(timer);
          process.exit(0);
        }

        if (Date.now() > deadline) {
          clearInterval(timer);
          process.exit(91);
        }
      }, 50);
    `
  : 'console.log("PHASE_ONE")';

const phases = [
  [process.execPath, ["-e", phaseOne]],
  [process.execPath, ["-e", 'console.log("PHASE_TWO")']],
];

(async () => {
  try {
    const code = await runWithRootFence(root, phases);

    if (code !== 0) {
      throw new Error("Unexpected phase exit: " + code);
    }

    console.log("SUPERVISOR_OK");
  } catch (error) {
    console.error("DENIED:", error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  }
})();
JS
)

run_actor() {
  docker run --rm \
    --init \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 1001:1001 \
    -e HOMECLOUD_MAINTENANCE_REQUIRED=1 \
    --mount "$MOUNT,readonly" \
    --entrypoint node \
    "$IMAGE" -e "$ACTOR" normal
}

echo "=== CASE 1: NO MARKER / BOTH PHASES ALLOWED ==="

OUT="$(run_actor 2>&1)"
printf '%s\n' "$OUT"

printf '%s\n' "$OUT" | grep -Fxq PHASE_ONE
printf '%s\n' "$OUT" | grep -Fxq PHASE_TWO
printf '%s\n' "$OUT" | grep -Fxq SUPERVISOR_OK

echo "PASS: uninhibited startup"

echo "=== CASE 2: MARKER EXISTS / NO PHASE ALLOWED ==="

root_action '
  umask 077
  : > /state/maintenance.inhibit
'

if OUT="$(run_actor 2>&1)"; then
  echo "BLOCKER: inhibited supervisor started"
  exit 1
fi

printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | grep -Fq \
  "Maintenance startup is inhibited"

if printf '%s\n' "$OUT" | grep -Eq '^PHASE_(ONE|TWO)$'; then
  echo "BLOCKER: phase executed under maintenance"
  exit 1
fi

echo "PASS: post-lock admission refuses existing marker"

echo "=== CASE 3: MISSING REQUIRED MOUNT ==="

if OUT="$(
  docker run --rm \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 1001:1001 \
    -e HOMECLOUD_MAINTENANCE_REQUIRED=1 \
    --entrypoint node \
    "$IMAGE" -e "$ACTOR" normal 2>&1
)"; then
  echo "BLOCKER: missing maintenance mount accepted"
  exit 1
fi

printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | grep -Fq \
  "Required maintenance mount is missing"

if printf '%s\n' "$OUT" | grep -Eq '^PHASE_(ONE|TWO)$'; then
  echo "BLOCKER: phase executed without required mount"
  exit 1
fi

echo "PASS: missing mount fails closed"

echo "=== CASE 4: WRITABLE MOUNT REFUSED ==="

# Remove ONLY the marker in our disposable test volume.
root_action 'rm /state/maintenance.inhibit'

if OUT="$(
  docker run --rm \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 1001:1001 \
    -e HOMECLOUD_MAINTENANCE_REQUIRED=1 \
    --mount "$MOUNT" \
    --entrypoint node \
    "$IMAGE" -e "$ACTOR" normal 2>&1
)"; then
  echo "BLOCKER: writable maintenance mount accepted"
  exit 1
fi

printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | grep -Fq \
  "Maintenance mount must be readonly"

echo "PASS: writable mount fails closed"

echo "=== CASE 5: MARKER ARRIVES BETWEEN PHASES ==="

CID="$(
  docker run -d \
    --init \
    --pull never \
    --platform "$PLATFORM" \
    --network none \
    --user 1001:1001 \
    -e HOMECLOUD_MAINTENANCE_REQUIRED=1 \
    --mount "$MOUNT,readonly" \
    --entrypoint node \
    "$IMAGE" -e "$ACTOR" race
)"

READY=0
for i in $(seq 1 100); do
  if docker logs "$CID" 2>&1 | grep -Fxq PHASE_ONE; then
    READY=1
    break
  fi
  sleep 0.1
done

if [ "$READY" != 1 ]; then
  docker logs "$CID" || true
  echo "STOP: phase one did not start"
  exit 1
fi

# The first phase is running with the inherited root flock.
# Root requests maintenance before the next phase.
root_action '
  umask 077
  : > /state/maintenance.inhibit
'

EXIT_CODE="$(docker wait "$CID")"

OUT="$(docker logs "$CID" 2>&1)"
printf '%s\n' "$OUT"

test "$EXIT_CODE" = 1

printf '%s\n' "$OUT" | grep -Fxq PHASE_ONE
printf '%s\n' "$OUT" | grep -Fq \
  "Maintenance startup is inhibited"

if printf '%s\n' "$OUT" | grep -Fxq PHASE_TWO; then
  echo "BLOCKER: next phase ran after inhibit"
  exit 1
fi

if printf '%s\n' "$OUT" | grep -Fxq SUPERVISOR_OK; then
  echo "BLOCKER: inhibited supervisor reported success"
  exit 1
fi

echo "PASS: next phase denied after maintenance race"

docker rm "$CID" >/dev/null
CID=""

echo "=== PASS: 5/5 MAINTENANCE SUPERVISOR SCENARIOS ==="
