#!/usr/bin/env bash
# Host-side recovery contracts. Docker interactions are fixture controlled.
set -euo pipefail
cd "$(dirname "$0")/../.."
for suite in \
  scripts/ci/test-recovery-restart.py \
  scripts/ci/test-test-channel-restart.py \
  scripts/ci/test-backup-archive.py \
  scripts/ci/test-historical-storage-archive.py \
  scripts/ci/test-historical-schema-fixture.py \
  scripts/ci/test-backup-fence.py \
  scripts/ci/test-backup-capture.py \
  scripts/ci/test-maintenance-inhibit.py \
  scripts/ci/test-maintenance-window.py \
  scripts/ci/test-storage-writer-fence.py \
  scripts/ci/test-recover-copy.py \
  scripts/ci/test-restore-storage-fence.py \
  scripts/ci/test-restore-maintenance.py \
  scripts/ci/test-restore-validator.py \
  scripts/ci/test-restore-runtime-context.py \
  scripts/ci/test-restore-e2e-launcher.py \
  scripts/ci/test-restore-fault-driver.py \
  scripts/ci/test-restore-e2e-cgroup.py \
  scripts/ci/test-pr45-qualification.py \
  scripts/tests/test-restore-schema.py \
  scripts/tests/test-restore-preflight.py \
  scripts/tests/test-restore-cleanup.py \
  scripts/tests/test-restore-health.py \
  scripts/tests/test-restore-storage.py \
  scripts/tests/test-scheduled-operations.py
do
  printf '%s\n' "$suite"
  python3 -B "$suite"
done
node --test backend/test/restore-migration-admission.runtime.cjs
node --test scripts/ci/test-native-boundary-preflight.cjs
node --test scripts/ci/test-historical-schema-producer.cjs
