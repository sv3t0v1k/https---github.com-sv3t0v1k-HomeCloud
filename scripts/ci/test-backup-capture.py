#!/usr/bin/env python3
"""Capture admission: real operation OFDs/markers; Docker inventory is mocked."""
import fcntl
import importlib.util
import json
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import recovery_storage as storage

spec = importlib.util.spec_from_file_location("capture_storage_fixture", Path(__file__).with_name("test-backup-fence.py"))
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.BackupFenceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.channel = self.fixture.parent / "test-channel"
        self.channel.mkdir(mode=0o700)
        self.lock = self.channel / "install.lock"
        self.fd = os.open(self.lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, self.fd)
        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = self.fixture.marker.stat()
        self.marker = [info.st_dev, info.st_ino]
        self.transaction = {"format": "homecloud-test-transaction-v1", "phase": "BACKUP",
                            "backup_maintenance": self.marker}
        self.write_checkpoint()

    def write_checkpoint(self):
        path = self.channel / "pending.json"
        path.write_text(json.dumps(self.transaction))
        path.chmod(0o600)

    def capture(self, fd=None, marker=None):
        storage.verify_backup_capture(self.fixture.snapshot,
                                      self.fd if fd is None else fd,
                                      self.marker if marker is None else marker)

    def test_owned_test_capture_does_not_require_future_backup_id(self):
        self.assertNotIn("backup_id", self.transaction)
        self.capture()
        self.assertTrue(self.fixture.marker.exists())

    def test_completion_cannot_use_capture_without_backup_id(self):
        with self.assertRaisesRegex(storage.StorageError, "backup identity"):
            storage.read_test_backup_checkpoint(None)

    def test_cli_refuses_bad_operation_before_storage_lock(self):
        environment = {"RECOVERY_STORAGE_SNAPSHOT": json.dumps(self.fixture.snapshot),
                       "HOMECLOUD_BACKUP_MARKER_IDENTITY": json.dumps(self.marker)}
        for action in ("backup-fence-acquire", "backup-fence-check"):
            with self.subTest(action=action), patch.object(sys, "argv", ["recovery", action]):
                with patch.dict(os.environ, environment):
                    with patch.object(storage, "verify_inherited_operation_lock", side_effect=OSError("bad FD8")):
                        with patch.object(storage, "backup_fence") as fence, redirect_stderr(io.StringIO()):
                            self.assertEqual(storage.main(), 1)
                        fence.assert_not_called()

    def test_cli_rechecks_owner_after_storage_fence(self):
        environment = {"RECOVERY_STORAGE_SNAPSHOT": json.dumps(self.fixture.snapshot),
                       "HOMECLOUD_BACKUP_MARKER_IDENTITY": json.dumps(self.marker)}
        for action in ("backup-fence-acquire", "backup-fence-check"):
            with self.subTest(action=action), patch.object(sys, "argv", ["recovery", action]):
                with patch.dict(os.environ, environment):
                    with patch.object(storage, "verify_backup_capture", side_effect=[None, storage.StorageError("changed owner")]) as gate:
                        with patch.object(storage, "backup_fence") as fence, redirect_stderr(io.StringIO()):
                            self.assertEqual(storage.main(), 1)
                        self.assertEqual(gate.call_count, 2)
                        gate.assert_called_with(self.fixture.snapshot, 8, self.marker)
                        fence.assert_called_once_with(self.fixture.snapshot, 9, acquire=action.endswith("acquire"))

    def test_missing_unlocked_and_wrong_descriptor_refused(self):
        with self.assertRaises((OSError, ValueError)):
            self.capture(fd=-1)
        with self.assertRaises(storage.StorageError):
            self.capture(fd=self.fixture.fd)
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        with self.assertRaisesRegex(storage.StorageError, "not held"):
            self.capture()

    def test_independent_ofd_cannot_borrow_another_owners_lock(self):
        other = os.open(self.lock, os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                self.capture(fd=other)
        finally:
            os.close(other)

    def test_wrong_marker_or_unrelated_test_phase_refused(self):
        with self.assertRaises(storage.StorageError):
            self.capture(marker=[self.marker[0], self.marker[1] + 1])
        self.transaction["phase"] = "STOP_SERVICES"
        self.write_checkpoint()
        with self.assertRaisesRegex(storage.StorageError, "checkpoint"):
            self.capture()

    def test_restore_receipt_and_stale_permit_refuse_capture(self):
        for name in ("restore.pending.json", "restore-migration." + "a" * 32):
            with self.subTest(name=name):
                path = self.fixture.marker_root / name
                path.symlink_to("missing")
                try:
                    with self.assertRaisesRegex(storage.StorageError, "restore"):
                        self.capture()
                finally:
                    path.unlink()

    def test_release_capture_uses_the_release_operation_lock(self):
        snapshot = {**self.fixture.snapshot, "project": "release"}
        lock = self.fixture.marker_root / storage.RELEASE_OPERATION_LOCK
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(storage, "RELEASE_MAINTENANCE_ROOT", self.fixture.marker_root):
                storage.verify_backup_capture(snapshot, fd, self.marker)
                with self.assertRaises(storage.StorageError):
                    storage.verify_backup_capture(snapshot, self.fd, self.marker)
        finally:
            os.close(fd)

    def test_subprocess_inherits_actual_lock_and_shell_preserves_fd9_collision(self):
        # Only host ancestry/UID is substituted for this portable test.
        # The actual shared OFD, flock contention and inode checks execute.
        probe = '''import os,sys
sys.path.insert(0,sys.argv[1])
import recovery_storage as s
s.qualified_state_path=lambda _:None
s.BACKUP_STATE_UID=os.geteuid()
from pathlib import Path
s.verify_inherited_operation_lock(Path(sys.argv[2]),int(sys.argv[3]))
'''
        result = subprocess.run([sys.executable, "-B", "-c", probe,
                                 str(ROOT / "scripts"), str(self.lock), str(self.fd)],
                                pass_fds=(self.fd,), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

        source = (ROOT / "scripts/backup.sh").read_text()
        start = source.index("# Inherit the caller")
        end = source.index('python3 "$SCRIPT_DIR/recovery_storage.py" backup-fence-acquire', start)
        script = ('set -eu\nerr() { echo "$*" >&2; }\nexec 9<&"$ORIGINAL_FD"\n'
                  'HOMECLOUD_BACKUP_OPERATION_FD=9\n' + source[start:end] +
                  '\n"$PYTHON" -B -c "$PROBE" "$SCRIPTS" "$LOCK" 8\n')
        result = subprocess.run(["bash", "-c", script], pass_fds=(self.fd,),
                                env={**os.environ, "ORIGINAL_FD": str(self.fd),
                                     "RECOVERY_STORAGE_SOURCE": str(self.fixture.root),
                                     "PYTHON": sys.executable, "PROBE": probe,
                                     "SCRIPTS": str(ROOT / "scripts"), "LOCK": str(self.lock)},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_encrypted_coordinator_child_preserves_real_lock_descriptor(self):
        spec = importlib.util.spec_from_file_location("cipher_capture_child", ROOT / "scripts/backup-production.py")
        coordinator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(coordinator)
        probe = '''import fcntl,os,sys
fd=int(sys.argv[1])
assert os.fstat(fd).st_ino==os.stat(sys.argv[2]).st_ino
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
contender=os.open(sys.argv[2],os.O_RDWR)
try:
    try: fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: pass
    else: raise SystemExit(22)
finally:os.close(contender)
'''
        coordinator.child([sys.executable, "-B", "-c", probe, str(self.fd), str(self.lock)],
                          pass_fds=(self.fd,))



if __name__ == "__main__":
    unittest.main()
