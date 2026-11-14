#!/usr/bin/env bash
# Rebuild the current sources into the existing isolated nested-Docker fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."
PLATFORM="${1:-linux/arm64}"
ENCRYPTED=0
HISTORICAL_SCHEMA=0
FAULT_CASE=none
case "${2:-}" in
  "") ;;
  --encrypted-only) ENCRYPTED=1 ;;
  --historical-schema-only) HISTORICAL_SCHEMA=1 ;;
  --fault-case=*) FAULT_CASE="${2#--fault-case=}" ;;
  *) exit 2 ;;
esac
case "$FAULT_CASE" in none|partial-stop|staged|db-restored|reconciled|ready-before-clear|ready-after-clear|foreign-writer) ;; *) exit 2 ;; esac
test "$#" -le 2
# DinD/runc must run natively; an emulated daemon cannot qualify this E2E.
TOOL_PLATFORM="$PLATFORM"
STUB_IMAGE="${HOMECLOUD_E2E_STUB_IMAGE:-alpine:latest}"
case "$PLATFORM" in linux/arm64|linux/amd64) ;; *) exit 1 ;; esac

# No host socket/data/source bind mounts are passed into the test container.
docker info >/dev/null
engine_platform="$(docker info --format '{{.OSType}}/{{.Architecture}}')"
case "$engine_platform" in linux/aarch64) engine_platform=linux/arm64 ;; linux/x86_64) engine_platform=linux/amd64 ;; esac
if [ "$engine_platform" != "$PLATFORM" ]; then
  echo "STOP: native Docker Engine $PLATFORM required; actual $engine_platform" >&2
  exit 1
fi
for image in postgres:16-alpine "$STUB_IMAGE"; do
  docker image inspect "$image" >/dev/null
  test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = "$PLATFORM"
done
# Own the fixture base build so a preceding AMD qualification cannot leave a
# stale/emulated DinD base behind. This does not build another product image.
docker build --platform "$TOOL_PLATFORM" -t homecloud-restore-e2e-runner:local \
  - < scripts/ci/restore-e2e-runner.Dockerfile
test "$(docker image inspect homecloud-restore-e2e-runner:local --format '{{.Os}}/{{.Architecture}}')" = "$TOOL_PLATFORM"

if [ -n "${HOMECLOUD_E2E_BACKEND_IMAGE:-}" ]; then
  # CI tests the retained OCI candidate, never a second rebuild.
  candidate_id="$(docker image inspect "$HOMECLOUD_E2E_BACKEND_IMAGE" --format '{{.Id}}')"
  docker tag "$HOMECLOUD_E2E_BACKEND_IMAGE" homecloud-restore-e2e-backend:local
  test "$(docker image inspect homecloud-restore-e2e-backend:local --format '{{.Id}}')" = "$candidate_id"
else
  docker build --pull=false --platform "$PLATFORM" \
    -t homecloud-restore-e2e-backend:local backend
fi
test "$(docker image inspect homecloud-restore-e2e-backend:local --format '{{.Os}}/{{.Architecture}}')" = "$PLATFORM"
docker image inspect homecloud-restore-e2e-backend:local --format 'E2E backend: {{.Id}}'
docker run --rm --pull=never --platform "$PLATFORM" --network none --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node homecloud-restore-e2e-backend:local \
  -e "$(cat scripts/ci/native-boundary-preflight.cjs)" -- --strict

# Allowlist source files: no Git metadata, env files, keys or user data.
# A Docker build context is a test artifact, never another Git checkout.
python3 -B scripts/ci/restore-e2e-context.py | docker build --pull=false --network none \
  --platform "$TOOL_PLATFORM" -t homecloud-restore-e2e-runtime:local -

# Check the actual image, unprivileged and without mounts, before nested dockerd.
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  -e "HOMECLOUD_E2E_PLATFORM=$PLATFORM" \
  --platform "$TOOL_PLATFORM" --entrypoint python3 homecloud-restore-e2e-runtime:local \
  -B /opt/homecloud/scripts/ci/restore-runtime-preflight.py

docker save homecloud-restore-e2e-backend:local postgres:16-alpine "$STUB_IMAGE" \
  | docker run --rm -i --privileged --cgroupns=private --network none \
      --platform "$TOOL_PLATFORM" \
      -e "HOMECLOUD_E2E_STUB_IMAGE=$STUB_IMAGE" \
      -e "HOMECLOUD_E2E_ENCRYPTED=$ENCRYPTED" \
      -e "HOMECLOUD_E2E_HISTORICAL_SCHEMA=$HISTORICAL_SCHEMA" \
      -e "HOMECLOUD_E2E_FAULT_CASE=$FAULT_CASE" \
      -e "HOMECLOUD_E2E_PLATFORM=$PLATFORM" \
      --mount type=volume,dst=/var/lib/docker,volume-nocopy \
      --mount type=volume,dst=/tmp,volume-nocopy \
      homecloud-restore-e2e-runtime:local
