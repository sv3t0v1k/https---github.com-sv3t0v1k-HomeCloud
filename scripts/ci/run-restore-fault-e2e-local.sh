#!/usr/bin/env bash
# Seven fresh disposable environments, same current/retained product candidate.
set -euo pipefail
cd "$(dirname "$0")/../.."
platform="${1:-linux/arm64}"
for fault in partial-stop staged db-restored reconciled ready-before-clear ready-after-clear foreign-writer; do
  bash scripts/ci/run-restore-e2e-local.sh "$platform" "--fault-case=$fault"
done
echo "PASS: REAL RESTORE FAULT MATRIX 7/7"
