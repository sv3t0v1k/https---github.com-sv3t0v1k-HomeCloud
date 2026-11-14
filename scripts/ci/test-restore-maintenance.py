#!/usr/bin/env python3
"""Real operation/storage flock, mocked Docker lifecycle."""

from contextlib import ExitStack
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import recovery_storage as storage
import restore_storage as restore
import restore_maintenance as maintenance

REAL_ASSERT_ROOT = restore.assert_root


class RestoreMaintenanceTests(unittest.TestCase):

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        self.parent = Path(self.stack.enter_context(
            tempfile.TemporaryDirectory()
        )).resolve()

        self.root = self.parent / "storage"
        self.root.mkdir(mode=0o700)
        (self.root / restore.TEMP).mkdir(mode=0o700)

        self.state = self.parent / "maintenance"
        self.state.mkdir(mode=0o711)

        self.lock = self.parent / "install.lock"
        self.token = "a" * 32

        self.marker = self.state / storage.MAINTENANCE_MARKER

        info = self.root.stat()

        self.snapshot = {
            "project": "homecloud-test",
            "type": "bind",
            "target": "/storage",
            "source": str(self.root),
            "bind_identity": [info.st_dev, info.st_ino],
        }

        for module, name, value in (
            (storage, "BACKUP_STATE_UID", os.getuid()),
            (storage, "BACKUP_STATE_GID", os.getgid()),
            (storage, "BACKUP_STORAGE_UID", info.st_uid),
            (restore, "RESTORE_UID", info.st_uid),
            (restore, "RESTORE_GID", info.st_gid),
        ):
            self.stack.enter_context(
                patch.object(module, name, value)
            )

        for module, name in (
            (storage, "backup_local_daemon"),
            (storage, "checked_storage"),
            (storage, "verify_backup_writers"),
            (storage, "verify_backup_inhibitor"),
            (restore, "reject_nested_mounts"),
            (maintenance, "validate_backend"),
        ):
            self.stack.enter_context(patch.object(module, name))

        self.stack.enter_context(patch.object(restore, "assert_root", return_value=self.root))
        self.services = {
            name: {"Id": str(index) * 64, "Image": "sha256:" + str(index) * 64}
            for index, name in enumerate(("db", "backend", "frontend", "ingress"), 1)
        }
        self.stack.enter_context(patch.object(storage, "release_service_inventory", return_value=self.services))

        self.stop = self.stack.enter_context(
            patch.object(storage, "release_compose")
        )

        self.stack.enter_context(patch.object(
            maintenance, "create_inhibit",
            side_effect=self.create_marker,
        ))

        maintenance.prepare_lock(self.lock)

        self.fd = os.open(self.lock, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)

        self.root_fd = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )
        self.addCleanup(os.close, self.root_fd)

    def create_marker(self, state):
        fd = os.open(
            self.marker,
            os.O_CREAT | os.O_WRONLY | os.O_EXCL,
            0o600,
        )
        with os.fdopen(fd, "wb") as stream:
            stream.write(storage.MAINTENANCE_PAYLOAD)
            stream.flush()
            os.fsync(stream.fileno())

    def begin(self):
        return maintenance.begin(
            self.snapshot, self.state,
            self.lock, self.fd, self.token,
        )

    def acquire(self):
        return maintenance.acquire_root(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
        )

    def receipt(self):
        return maintenance.read_receipt(
            self.state, self.snapshot, self.token,
        )

    def test_durable_checkpoint_precedes_stop(self):
        def stop(*args):
            self.assertTrue(self.marker.exists())
            self.assertEqual(
                self.receipt()["phase"], "INHIBITED"
            )

        self.stop.side_effect = stop

        self.begin()

        self.assertEqual(
            self.receipt()["phase"], "WRITERS_STOPPED"
        )

    def test_actual_exclusive_root_lock(self):
        self.begin()
        self.acquire()

        self.assertEqual(
            self.receipt()["phase"], "ROOT_FENCED"
        )

        contender = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(
                    contender,
                    fcntl.LOCK_EX | fcntl.LOCK_NB,
                )
        finally:
            os.close(contender)

    def test_competing_operation_refused(self):
        contender = os.open(self.lock, os.O_RDONLY)
        try:
            fcntl.flock(
                contender, fcntl.LOCK_EX | fcntl.LOCK_NB
            )
            with self.assertRaises(BlockingIOError):
                self.begin()
        finally:
            os.close(contender)

        self.assertFalse(self.marker.exists())
        self.stop.assert_not_called()

    def check_root(self):
        with patch.object(restore, "assert_root", REAL_ASSERT_ROOT):
            maintenance.check_root(
                self.snapshot, self.state, self.lock,
                self.fd, self.root_fd, self.token,
            )

    def test_restore_cli_rechecks_inherited_fences_without_backup_environment(self):
        self.begin()
        self.acquire()
        payload = {"snapshot": self.snapshot, "services": self.services,
                   "state": str(self.state), "lock": str(self.lock), "token": self.token}
        probe = r'''
import fcntl,json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import recovery_storage as s, restore_storage as r, restore_maintenance as m
fixture=json.loads(sys.argv[2])
# Duplicate above reserved FDs before dup2, preserving possible FD8/9 collisions.
op=fcntl.fcntl(int(sys.argv[3]),fcntl.F_DUPFD,20)
root=fcntl.fcntl(int(sys.argv[4]),fcntl.F_DUPFD,20)
os.dup2(op,8); os.dup2(root,9)
s.BACKUP_STATE_UID=os.geteuid(); s.BACKUP_STATE_GID=os.getegid()
s.BACKUP_STORAGE_UID=os.geteuid()
r.RESTORE_UID=os.geteuid(); r.RESTORE_GID=os.getegid()
s.backup_local_daemon=lambda:None
s.resolve_storage=lambda:fixture["snapshot"]
s.checked_storage=lambda snapshot:None
s.verify_backup_writers=lambda snapshot:fixture["services"]["backend"]
s.verify_backup_inhibitor=lambda *args,**kwargs:None
s.release_service_inventory=lambda *args,**kwargs:fixture["services"]
r.reject_nested_mounts=lambda root:None
m.runtime=lambda snapshot:(Path(fixture["state"]),Path(fixture["lock"]))
os.environ.pop("HOMECLOUD_BACKUP_MARKER_IDENTITY",None)
assert Path(fixture["state"],m.RECEIPT).is_file()
sys.argv=["restore-maintenance","check-root",fixture["token"]]
raise SystemExit(m.main())
'''
        result = subprocess.run(
            [sys.executable, "-B", "-c", probe, str(ROOT / "scripts"),
             json.dumps(payload), str(self.fd), str(self.root_fd)],
            pass_fds=(self.fd, self.root_fd), capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("RESTORE_ROOT_VERIFIED", result.stdout)
        self.assertEqual(self.receipt()["phase"], "ROOT_FENCED")

    def test_root_recheck_refuses_wrong_token_and_phase(self):
        self.begin()
        self.acquire()
        with self.assertRaises(storage.StorageError):
            maintenance.check_root(self.snapshot, self.state, self.lock, self.fd, self.root_fd, "b" * 32)
        receipt = self.receipt()
        receipt["phase"] = "WRITERS_STOPPED"
        maintenance.write_receipt(self.state, receipt)
        with self.assertRaisesRegex(storage.StorageError, "phase"):
            self.check_root()

    def test_root_recheck_refuses_lost_operation_lock(self):
        self.begin()
        self.acquire()
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        with self.assertRaisesRegex(storage.StorageError, "not held"):
            self.check_root()

    def test_root_recheck_refuses_lost_root_lock(self):
        self.begin()
        self.acquire()
        fcntl.flock(self.root_fd, fcntl.LOCK_UN)
        with self.assertRaisesRegex(storage.StorageError, "not held continuously"):
            self.check_root()
        self.assertEqual(self.receipt()["phase"], "ROOT_FENCED")

    def test_root_recheck_cannot_borrow_another_root_lock_owner(self):
        self.begin()
        self.acquire()
        fcntl.flock(self.root_fd, fcntl.LOCK_UN)
        contender = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.check_root()
        finally:
            os.close(contender)

    def test_root_recheck_refuses_replaced_storage_root(self):
        self.begin()
        self.acquire()
        self.root.rename(self.parent / "original-storage")
        self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(storage.StorageError, "descriptor"):
            self.check_root()

    def test_root_recheck_refuses_replaced_marker_or_migration_permit(self):
        self.begin()
        self.acquire()
        permit = self.state / ("restore-migration." + self.token)
        permit.symlink_to("missing")
        with self.assertRaisesRegex(storage.StorageError, "permit"):
            self.check_root()
        permit.unlink()
        replacement = self.state / "new-marker"
        replacement.write_bytes(storage.MAINTENANCE_PAYLOAD)
        replacement.chmod(0o600)
        os.replace(replacement, self.marker)
        with self.assertRaisesRegex(storage.StorageError, "identity mismatch"):
            self.check_root()

    def test_root_recheck_refuses_resumed_writer(self):
        self.begin()
        self.acquire()
        with patch.object(storage, "verify_backup_writers", side_effect=storage.StorageError("writer resumed")):
            with self.assertRaisesRegex(storage.StorageError, "writer resumed"):
                self.check_root()
        self.assertTrue(self.marker.exists())

    def test_root_recheck_binds_inhibitor_to_durable_receipt(self):
        self.begin()
        self.acquire()
        expected = self.receipt()["marker_identity"]
        with patch.object(storage, "verify_backup_inhibitor", side_effect=storage.StorageError("bad payload")) as inhibitor:
            with self.assertRaisesRegex(storage.StorageError, "bad payload"):
                self.check_root()
            inhibitor.assert_called_once_with(
                self.snapshot, storage.verify_backup_writers.return_value,
                expected_identity=expected,
            )

    def test_root_recheck_refuses_checkpoint_changed_during_checks(self):
        self.begin()
        self.acquire()
        def change_receipt(*args, **kwargs):
            receipt = self.receipt()
            receipt["phase"] = "STORAGE_STAGED"
            maintenance.write_receipt(self.state, receipt)
        with patch.object(storage, "verify_backup_inhibitor", side_effect=change_receipt):
            with self.assertRaisesRegex(storage.StorageError, "checkpoint changed"):
                self.check_root()

    def test_root_recheck_refuses_replaced_service_identity(self):
        self.begin()
        self.acquire()
        self.services["db"] = {"Id": "f" * 64, "Image": "sha256:" + "1" * 64}
        with self.assertRaisesRegex(storage.StorageError, "service identity"):
            self.check_root()

    def test_shell_uses_restore_check_and_stops_before_sql_on_refusal(self):
        source = (ROOT / "scripts/restore.sh").read_text()
        start = source.index('python3 -B "$RESTORE_MAINTENANCE" check-root "$RESTORE_TOKEN"')
        end = source.index("# Fully validate", start)
        block = source[start:end]
        self.assertNotIn("backup-fence-check", source)
        log = self.parent / "restore-check-calls"
        shim = r'''set -euo pipefail
RESTORE_MAINTENANCE=/fixture/restore_maintenance.py
RESTORE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
die() { exit 61; }
python3() {
  test "$3" = check-root
  test "$4" = "$RESTORE_TOKEN"
  printf '%s\n' "$*" >> "$TEST_LOG"
  return "$TEST_STATUS"
}
'''
        for status in (0, 9):
            with self.subTest(status=status):
                log.write_text("")
                result = subprocess.run(
                    ["bash", "-c", shim + block + '\nprintf "SQL_SENTINEL\\n" >> "$TEST_LOG"\n'],
                    env={**os.environ, "TEST_STATUS": str(status), "TEST_LOG": str(log)},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0 if status == 0 else 61, result.stderr)
                self.assertEqual("SQL_SENTINEL" in log.read_text(), status == 0)

    def test_pending_test_install_refused(self):
        (self.lock.parent / "pending.json").write_text("{}")

        with self.assertRaises(storage.StorageError):
            self.begin()

        self.assertFalse(self.marker.exists())
        self.stop.assert_not_called()

    def test_existing_inhibitor_refused(self):
        self.create_marker(self.state)

        with self.assertRaises(storage.StorageError):
            self.begin()

        self.stop.assert_not_called()

    def test_stop_failure_preserves_checkpoint(self):
        self.stop.side_effect = RuntimeError("stop failed")

        with self.assertRaises(RuntimeError):
            self.begin()

        self.assertTrue(self.marker.exists())

        self.assertEqual(
            self.receipt()["phase"], "INHIBITED"
        )

        with self.assertRaises(storage.StorageError):
            self.acquire()

    def test_shell_fences_partial_begin_failure(self):
        source = (ROOT / "scripts/restore.sh").read_text()
        cleanup = source[source.index("restore_cleanup() {"):source.index("trap restore_cleanup EXIT")]
        start = source.index('RESTORE_MAINTENANCE="$SCRIPT_DIR/restore_maintenance.py"')
        stop = source.index('exec 9<"$RECOVERY_STORAGE_SOURCE"', start)
        admission = source[start:stop]
        log = self.parent / "calls"
        environment = dict(os.environ, TEST_LOG=str(log), TEST_LOCK=str(self.lock))
        shim = r'''set -euo pipefail
SCRIPT_DIR=/unused
RESTORE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
err() { :; }
die() { exit 1; }
remove_restore_migration_container() { :; }
remove_validation_container() { :; }
docker() { printf '%s\n' "$*" >> "$TEST_LOG"; }
python3() {
  case "$*" in
    *prepare) printf '%s\n' "$TEST_LOCK" ;;
    *' lock') : ;;
    *' begin '*) return 9 ;;
    *' retain '*) printf 'retain\n' >> "$TEST_LOG" ;;
    *) return 99 ;;
  esac
}
'''
        result = subprocess.run(["bash", "-c", shim + cleanup + "\ntrap restore_cleanup EXIT\n" + admission],
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(log.read_text().splitlines(), ["retain", "compose stop ingress frontend backend"])

    def test_invalid_staging_never_advances_database_checkpoint(self):
        self.begin()
        self.acquire()
        (self.root / "original").write_bytes(b"original bytes")
        with patch.object(restore, "extract_archive", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.stage()
        self.assertEqual(self.receipt()["phase"], "ROOT_FENCED")
        self.assertEqual((self.root / "original").read_bytes(), b"original bytes")
        self.assertTrue(self.marker.exists())
        self.assertTrue((self.root / restore.STAGE).exists())
        self.assertFalse((self.root / restore.SWAP).exists())
        with self.assertRaises(storage.StorageError):
            maintenance.mark_database_restored(
                self.snapshot, self.state, self.lock,
                self.fd, self.root_fd, self.token,
            )

    def test_marker_substitution_refused(self):
        self.begin()

        replacement = self.state / "replacement"
        replacement.write_bytes(storage.MAINTENANCE_PAYLOAD)
        replacement.chmod(0o600)
        os.replace(replacement, self.marker)

        with self.assertRaises(storage.StorageError):
            self.acquire()

    def test_wrong_token_refused(self):
        self.begin()

        self.token = "b" * 32

        with self.assertRaises(storage.StorageError):
            self.acquire()

    def test_missing_operation_lock_refused(self):
        self.begin()

        fcntl.flock(self.fd, fcntl.LOCK_UN)

        with self.assertRaises(storage.StorageError):
            self.acquire()

    def test_retained_storage_refused_before_inhibit(self):
        (self.root / restore.SWAP).mkdir()

        with self.assertRaises(storage.StorageError):
            self.begin()

        self.assertFalse(self.marker.exists())
        self.stop.assert_not_called()



    def prepare_migration(self):
        self.begin()
        self.acquire()

        (self.root / "original").write_bytes(b"retained")
        self.stage()

        maintenance.mark_database_restored(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
        )

        maintenance.switch_storage(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
            self.archive, self.checksum, 1,
        )

        self.assertEqual(
            self.receipt()["phase"], "STORAGE_SWITCHED"
        )

        fcntl.flock(self.root_fd, fcntl.LOCK_UN)

        self.stack.enter_context(
            patch.object(storage, "query", return_value="")
        )

    def stage(self):
        self.archive = self.parent / "backup.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            item = tarfile.TarInfo("new")
            item.size = len(b"restored")
            archive.addfile(item, io.BytesIO(b"restored"))
        self.archive.chmod(0o600)
        self.checksum = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        return maintenance.stage_storage(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
            self.archive, self.checksum, 1,
        )

    def test_database_checkpoint_requires_validated_staging(self):
        self.begin()
        self.acquire()
        with self.assertRaisesRegex(storage.StorageError, "database restore phase"):
            maintenance.mark_database_restored(
                self.snapshot, self.state, self.lock,
                self.fd, self.root_fd, self.token,
            )
        self.stage()
        self.assertEqual(self.receipt()["phase"], "STORAGE_STAGED")
        self.assertEqual(self.receipt()["staged_storage"]["archive_sha256"], self.checksum)
        (self.root / restore.STAGE / "new").write_bytes(b"tampered")
        with self.assertRaisesRegex(storage.StorageError, "content changed"):
            maintenance.verify_staged(
                self.snapshot, self.state, self.lock,
                self.fd, self.root_fd, self.token,
            )
        self.assertEqual(self.receipt()["phase"], "STORAGE_STAGED")

    def migrate(self):
        return maintenance.run_migration(
            self.snapshot, self.state, self.lock,
            self.fd, self.token,
        )

    def test_migration_handoff_and_reacquisition(self):
        self.prepare_migration()

        permit = maintenance.migration_permit(
            self.state, self.token
        )

        def migrate(*args):
            self.assertEqual(args[-1], self.token)
            self.assertEqual(
                args[-2], "--restore-migration"
            )
            self.assertTrue(self.marker.exists())
            self.assertTrue(permit.exists())
            self.assertEqual(
                self.receipt()["phase"], "MIGRATION_RUNNING"
            )

            # An actual independent descriptor can now acquire
            # the root fence, as the migration supervisor does.
            fd = os.open(
                self.root, os.O_RDONLY | os.O_DIRECTORY
            )
            try:
                fcntl.flock(
                    fd, fcntl.LOCK_EX | fcntl.LOCK_NB
                )
            finally:
                os.close(fd)

        self.stop.side_effect = migrate
        self.migrate()

        self.assertFalse(permit.exists())
        self.assertTrue(self.marker.exists())
        self.assertEqual(
            self.receipt()["phase"], "MIGRATED"
        )

        maintenance.acquire_after_migration(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
        )

        self.assertEqual(
            self.receipt()["phase"],
            "POST_MIGRATION_FENCED",
        )

        fd = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(
                    fd, fcntl.LOCK_EX | fcntl.LOCK_NB
                )
        finally:
            os.close(fd)

    def test_migration_failure_preserves_permit_and_checkpoint(self):
        self.prepare_migration()

        self.stop.side_effect = RuntimeError(
            "migration failed"
        )

        with self.assertRaises(RuntimeError):
            self.migrate()

        self.assertTrue(self.marker.exists())
        self.assertTrue(
            maintenance.migration_permit(
                self.state, self.token
            ).exists()
        )

        self.assertEqual(
            self.receipt()["phase"], "MIGRATION_RUNNING"
        )

        # No blind retry of an uncertain migration.
        with self.assertRaises(storage.StorageError):
            self.migrate()

    def test_migration_requires_completed_storage_switch(self):
        self.begin()
        self.acquire()

        with self.assertRaises(storage.StorageError):
            self.migrate()

    def test_migration_refuses_competing_root_lock(self):
        self.prepare_migration()

        fcntl.flock(
            self.root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB
        )

        with self.assertRaises(BlockingIOError):
            self.migrate()

        self.assertEqual(
            self.receipt()["phase"], "STORAGE_SWITCHED"
        )

        self.assertFalse(
            maintenance.migration_permit(
                self.state, self.token
            ).exists()
        )

    def test_retained_migration_container_prevents_completion(self):
        self.prepare_migration()

        with patch.object(
            storage, "query",
            side_effect=["", "", "a" * 64],
        ):
            with self.assertRaisesRegex(
                storage.StorageError,
                "container remains",
            ):
                self.migrate()

        self.assertTrue(self.marker.exists())
        self.assertTrue(
            maintenance.migration_permit(
                self.state, self.token
            ).exists()
        )

    def test_swap_substitution_prevents_migration(self):
        self.prepare_migration()

        swap = self.root / restore.SWAP
        swap.rename(self.root / "retained-old")
        swap.mkdir(mode=0o700)

        with self.assertRaisesRegex(
            storage.StorageError,
            "identity changed",
        ):
            self.migrate()

        self.assertEqual(
            self.receipt()["phase"], "STORAGE_SWITCHED"
        )


    def prepare_completion(self):
        self.prepare_migration()
        self.migrate()

        maintenance.acquire_after_migration(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
        )

        self.stack.enter_context(
            patch.object(
                restore, "assert_root", return_value=self.root
            )
        )

        self.stack.enter_context(
            patch.object(maintenance, "verify_pending")
        )

        self.stack.enter_context(
            patch.object(storage, "verify_backup_completion_data")
        )

        self.reconciliation = self.stack.enter_context(
            patch.object(maintenance, "run_reconciliation")
        )

        def clear_marker(*args, **kwargs):
            if kwargs.get("clear"):
                self.assertEqual(
                    self.receipt()["phase"], "READY"
                )
                self.marker.unlink()

        storage.verify_backup_inhibitor.side_effect = clear_marker

    def complete(self):
        maintenance.complete_restore(
            self.snapshot, self.state, self.lock,
            self.fd, self.root_fd, self.token,
        )

    def test_failed_reconciliation_preserves_old_storage(self):
        self.prepare_completion()

        self.reconciliation.side_effect = storage.StorageError(
            "reconciliation failed"
        )

        with self.assertRaises(storage.StorageError):
            self.complete()

        self.assertTrue(self.marker.exists())
        self.assertEqual(
            (self.root / restore.SWAP / "original").read_bytes(),
            b"retained",
        )
        self.assertEqual(
            self.receipt()["phase"], "POST_MIGRATION_FENCED"
        )

    def test_completion_data_failure_preserves_old_storage(self):
        self.prepare_completion()
        storage.verify_backup_completion_data.side_effect = storage.StorageError("journal unavailable")
        with self.assertRaisesRegex(storage.StorageError, "journal unavailable"):
            self.complete()
        self.assertEqual((self.root / restore.SWAP / "original").read_bytes(), b"retained")
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.receipt()["phase"], "POST_MIGRATION_FENCED")

    def test_migration_permit_is_bound_to_marker_identity(self):
        self.begin()
        original = maintenance.migration_permit(self.state, self.token)
        original.write_bytes(b"old permit")
        original.chmod(0o600)
        replacement = self.state / "replacement"
        replacement.write_bytes(storage.MAINTENANCE_PAYLOAD)
        replacement.chmod(0o600)
        os.replace(replacement, self.marker)
        self.assertNotEqual(maintenance.migration_permit(self.state, self.token), original)
        self.assertFalse(maintenance.migration_permit(self.state, self.token).exists())

    def test_successful_completion_clears_only_after_verification(self):
        self.prepare_completion()
        self.complete()

        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / restore.SWAP).exists())

        receipt = maintenance.read_receipt(
            self.state, self.snapshot, self.token,
            allow_ready=True,
        )

        self.assertEqual(receipt["phase"], "READY")

        with patch.object(storage, "release_service_inventory", return_value=self.services):
            maintenance.acknowledge_restart(
                self.snapshot, self.state, self.lock,
                self.fd, self.token,
            )

        self.assertFalse(
            (self.state / maintenance.RECEIPT).exists()
        )

    def test_replaced_frontend_refused_after_data_completion(self):
        self.prepare_completion()
        self.complete()
        changed = {name: dict(item) for name, item in self.services.items()}
        changed["frontend"]["Id"] = "f" * 64
        with patch.object(storage, "release_service_inventory", return_value=changed):
            with self.assertRaisesRegex(storage.StorageError, "containers changed"):
                maintenance.restart_restored_services(
                    self.snapshot, self.state, self.lock, self.fd, self.token,
                )
            with self.assertRaisesRegex(storage.StorageError, "containers changed"):
                maintenance.acknowledge_restart(
                    self.snapshot, self.state, self.lock, self.fd, self.token,
                )
        self.assertTrue((self.state / maintenance.RECEIPT).exists())

    def test_restart_failure_recreates_inhibitor(self):
        self.prepare_completion()
        self.complete()

        maintenance.retain_after_failure(
            self.snapshot, self.state, self.lock,
            self.fd, self.token,
        )

        self.assertTrue(self.marker.exists())
        self.assertEqual(
            self.receipt()["phase"], "RESTART_FAILED"
        )

    def kill_at_completion(self, point):
        """Actual process death and durable local files; Docker stays mocked."""
        child = os.fork()
        if child == 0:
            try:
                if point == "RECONCILED":
                    maintenance.remove_tree_at = lambda *args: os.kill(os.getpid(), signal.SIGKILL)
                elif point == "READY_BEFORE_CLEAR":
                    previous = storage.verify_backup_inhibitor.side_effect
                    def clear(*args, **kwargs):
                        if kwargs.get("clear"):
                            os.kill(os.getpid(), signal.SIGKILL)
                        return previous(*args, **kwargs)
                    storage.verify_backup_inhibitor.side_effect = clear
                self.complete()
                if point == "READY_AFTER_CLEAR":
                    os.kill(os.getpid(), signal.SIGKILL)
            except BaseException:
                os._exit(71)
            os._exit(72)
        _, status = os.waitpid(child, 0)
        self.assertTrue(os.WIFSIGNALED(status), "fixture did not reach the crash point")
        self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)

    def test_sigkill_after_reconciled_retains_verified_swap_and_receipt(self):
        self.prepare_completion()
        self.kill_at_completion("RECONCILED")
        self.assertEqual(self.receipt()["phase"], "RECONCILED")
        self.assertEqual((self.root / restore.SWAP / "original").read_bytes(), b"retained")
        self.assertTrue(self.marker.exists())
        with self.assertRaises(storage.StorageError):
            self.begin()

    def test_sigkill_after_ready_before_clear_cannot_restart(self):
        self.prepare_completion()
        self.kill_at_completion("READY_BEFORE_CLEAR")
        self.assertEqual(self.receipt()["phase"], "READY")
        self.assertTrue(self.marker.exists())
        self.assertFalse((self.root / restore.SWAP).exists())
        with self.assertRaisesRegex(storage.StorageError, "verified completion checkpoint"):
            maintenance.restart_restored_services(self.snapshot, self.state, self.lock, self.fd, self.token)

    def test_sigkill_after_clear_blocks_next_operation_and_can_refence(self):
        self.prepare_completion()
        self.kill_at_completion("READY_AFTER_CLEAR")
        receipt = maintenance.read_receipt(self.state, self.snapshot, self.token, allow_ready=True)
        self.assertEqual(receipt["phase"], "READY")
        self.assertFalse(self.marker.exists())
        with self.assertRaisesRegex(storage.StorageError, "Existing maintenance"):
            self.begin()
        maintenance.retain_after_failure(self.snapshot, self.state, self.lock, self.fd, self.token)
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.receipt()["phase"], "RESTART_FAILED")

    def test_completion_refuses_unverified_phase(self):
        self.begin()
        self.acquire()

        with self.assertRaises(storage.StorageError):
            self.complete()

        self.assertTrue(self.marker.exists())


    def test_swap_cleanup_never_follows_symlinks(self):
        self.prepare_completion()

        outside = self.parent / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_bytes(b"must survive")

        swap = self.root / restore.SWAP
        (swap / "external-link").symlink_to(outside)
        (swap / "nested").mkdir()
        (swap / "nested/file").write_bytes(b"old data")

        self.complete()

        self.assertEqual(
            sentinel.read_bytes(), b"must survive"
        )
        self.assertFalse(swap.exists())
        self.assertFalse(self.marker.exists())

if __name__ == "__main__":
    unittest.main()
