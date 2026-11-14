#!/usr/bin/env python3
"""Backup fence tests; real descriptors/flock, mocked Docker inspection."""

import copy
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(ROOT / "scripts"))
import recovery_storage as storage


class BackupFenceTests(unittest.TestCase):

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        parent = self.stack.enter_context(
            tempfile.TemporaryDirectory()
        )
        self.parent = Path(parent).resolve()

        self.root = self.parent / "storage"
        self.root.mkdir(mode=0o700)

        self.marker_root = self.parent / "maintenance"
        self.marker_root.mkdir(mode=0o711)
        self.marker_root.chmod(0o711)

        self.marker = (
            self.marker_root / storage.MAINTENANCE_MARKER
        )
        self.marker.write_bytes(storage.MAINTENANCE_PAYLOAD)
        self.marker.chmod(0o600)

        self.fd = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )
        self.addCleanup(os.close, self.fd)

        info = self.root.stat()

        self.cid = "a" * 64
        self.other = "b" * 64

        self.snapshot = {
            "container_id": self.cid,
            "image_id": "sha256:" + "c" * 64,
            "project": "homecloud-test",
            "target": "/storage",
            "type": "bind",
            "source": str(self.root),
            "bind_identity": [info.st_dev, info.st_ino],
        }

        self.backend = {
            "Id": self.cid,
            "Image": self.snapshot["image_id"],
            "State": {
                "Running": False,
                "Restarting": False,
                "Paused": False,
                "Status": "exited",
            },
            "Mounts": [{
                "Type": "bind",
                "Source": str(self.marker_root),
                "Destination": "/run/homecloud/maintenance",
                "RW": False,
            }],
        }

        self.running = []

        self.containers = {
            self.cid: self.backend,
            self.other: {
                "Id": self.other,
                "Config": {"Labels": {}},
                "Mounts": [],
            },
        }

        self.stack.enter_context(
            patch.object(storage.sys, "platform", "linux")
        )
        self.stack.enter_context(
            patch.object(storage.os, "geteuid", return_value=0)
        )
        self.stack.enter_context(
            patch.object(
                storage, "BACKUP_STORAGE_UID", info.st_uid
            )
        )
        self.stack.enter_context(
            patch.object(
                storage, "BACKUP_STATE_UID",
                self.marker_root.stat().st_uid,
            )
        )
        self.stack.enter_context(
            patch.object(
                storage, "BACKUP_STATE_GID",
                self.marker_root.stat().st_gid,
            )
        )
        self.stack.enter_context(
            patch.object(
                storage, "TEST_MAINTENANCE_ROOT",
                self.marker_root,
            )
        )
        self.stack.enter_context(
            patch.object(storage, "qualified_state_path")
        )
        self.stack.enter_context(
            patch.object(
                storage, "checked_storage",
                side_effect=lambda snapshot: snapshot,
            )
        )
        self.stack.enter_context(
            patch.object(
                storage, "query", side_effect=self.query
            )
        )
        self.stack.enter_context(
            patch.dict(os.environ, {
                "DOCKER_HOST": "unix:///var/run/docker.sock",
                "DOCKER_CONTEXT": "",
            })
        )

    def query(self, args, json_result=False):
        if args == ["docker", "ps", "-q", "--no-trunc"]:
            return "\n".join(self.running)

        if args[:2] == ["docker", "inspect"]:
            return [copy.deepcopy(self.containers[args[2]])]

        self.fail("Unexpected Docker query: " + repr(args))

    def acquire(self):
        storage.backup_fence(
            self.snapshot, self.fd, acquire=True
        )

    def recheck(self):
        storage.backup_fence(
            self.snapshot, self.fd, acquire=False
        )

    def test_acquire_and_verify_kernel_lock(self):
        self.acquire()
        self.recheck()

        independent = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )

        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(
                    independent,
                    fcntl.LOCK_EX | fcntl.LOCK_NB,
                )
        finally:
            os.close(independent)

    def test_competing_writer_lock_refused(self):
        independent = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )

        try:
            fcntl.flock(
                independent,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )

            with self.assertRaises(BlockingIOError):
                self.acquire()
        finally:
            os.close(independent)

    def test_missing_lock_not_reacquired_at_publication(self):
        with self.assertRaisesRegex(
            storage.StorageError,
            "not held continuously",
        ):
            self.recheck()

    def test_lost_lock_refuses_publication(self):
        self.acquire()
        fcntl.flock(self.fd, fcntl.LOCK_UN)

        with self.assertRaisesRegex(
            storage.StorageError,
            "not held continuously",
        ):
            self.recheck()

    def test_wrong_descriptor_refused(self):
        other = self.parent / "other-root"
        other.mkdir(mode=0o700)

        fd = os.open(
            other, os.O_RDONLY | os.O_DIRECTORY
        )
        try:
            with self.assertRaisesRegex(
                storage.StorageError,
                "descriptor does not match",
            ):
                storage.backup_fence(
                    self.snapshot, fd, acquire=True
                )
        finally:
            os.close(fd)

    def test_running_backend_refused(self):
        self.backend["State"]["Running"] = True

        with self.assertRaisesRegex(
            storage.StorageError, "fully stopped"
        ):
            self.acquire()

    def test_missing_inhibitor_refused(self):
        self.marker.unlink()

        with self.assertRaises(FileNotFoundError):
            self.acquire()

    def test_damaged_inhibitor_refused(self):
        self.marker.write_bytes(b"invalid")

        with self.assertRaisesRegex(
            storage.StorageError, "Invalid maintenance",
        ):
            self.acquire()

    def test_writable_maintenance_mount_refused(self):
        self.backend["Mounts"][0]["RW"] = True

        with self.assertRaisesRegex(
            storage.StorageError,
            "maintenance mount is not qualified",
        ):
            self.acquire()

    def test_other_writable_storage_container_refused(self):
        self.running = [self.other]

        self.containers[self.other]["Mounts"] = [{
            "Type": "bind",
            "Source": str(self.root),
            "Destination": "/other-storage",
            "RW": True,
        }]

        with self.assertRaisesRegex(
            storage.StorageError, "Writable container"
        ):
            self.acquire()

    def test_readonly_storage_container_allowed(self):
        self.running = [self.other]

        self.containers[self.other]["Mounts"] = [{
            "Type": "bind",
            "Source": str(self.root),
            "Destination": "/read-only",
            "RW": False,
        }]

        self.acquire()
        self.recheck()

    def test_parent_mount_refused(self):
        self.running = [self.other]

        self.containers[self.other]["Mounts"] = [{
            "Type": "bind",
            "Source": str(self.parent),
            "Destination": "/parent",
            "RW": True,
        }]

        with self.assertRaisesRegex(
            storage.StorageError, "Writable container"
        ):
            self.acquire()

    def test_remote_docker_refused(self):
        with patch.dict(os.environ, {
            "DOCKER_HOST": "tcp://remote.invalid:2375",
        }):
            with self.assertRaisesRegex(
                storage.StorageError, "local Docker socket"
            ):
                self.acquire()

    def test_named_volume_without_qualification_refused(self):
        self.snapshot["type"] = "volume"

        with self.assertRaisesRegex(
            storage.StorageError, "legacy bind storage"
        ):
            self.acquire()

    def test_writer_appearing_before_publication_refused(self):
        self.acquire()

        self.backend["State"]["Running"] = True

        with self.assertRaisesRegex(
            storage.StorageError, "fully stopped"
        ):
            self.recheck()



    def marker_identity(self):
        info = self.marker.stat()
        return [info.st_dev, info.st_ino]

    def test_verified_completion_removes_only_owned_marker(self):
        expected = self.marker_identity()

        def verify_under_lock(snapshot):
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

            self.assertTrue(self.marker.exists())

        with patch.object(
            storage,
            "verify_backup_completion_data",
            side_effect=verify_under_lock,
        ):
            storage.finish_test_backup(
                self.snapshot, expected
            )

        self.assertFalse(self.marker.exists())

        # The completion operation released its root lock.
        fcntl.flock(
            self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB
        )

    def test_completion_refuses_other_marker_identity(self):
        identity = self.marker_identity()
        identity[1] += 1

        with patch.object(
            storage, "verify_backup_completion_data"
        ):
            with self.assertRaisesRegex(
                storage.StorageError,
                "belongs to another operation",
            ):
                storage.finish_test_backup(
                    self.snapshot, identity
                )

        self.assertTrue(self.marker.exists())

    def test_readonly_marker_recheck_enforces_expected_identity(self):
        identity = self.marker_identity()
        identity[1] += 1
        with self.assertRaisesRegex(storage.StorageError, "belongs to another operation"):
            storage.verify_backup_inhibitor(
                self.snapshot, self.backend, expected_identity=identity,
            )
        self.assertTrue(self.marker.exists())

    def test_completion_failure_retains_marker(self):
        with patch.object(
            storage,
            "verify_backup_completion_data",
            side_effect=storage.StorageError(
                "pending copy reservation"
            ),
        ):
            with self.assertRaisesRegex(
                storage.StorageError,
                "pending copy reservation",
            ):
                storage.finish_test_backup(
                    self.snapshot,
                    self.marker_identity(),
                )

        self.assertTrue(self.marker.exists())

    def test_completion_requires_exclusive_root_lock(self):
        self.acquire()

        with patch.object(
            storage, "verify_backup_completion_data"
        ) as verify:
            with self.assertRaises(BlockingIOError):
                storage.finish_test_backup(
                    self.snapshot,
                    self.marker_identity(),
                )

            verify.assert_not_called()

        self.assertTrue(self.marker.exists())

    def test_completion_requires_owned_install_lock(self):
        channel = self.parent / "test-channel"
        channel.mkdir(mode=0o700)

        path = channel / "install.lock"

        fd = os.open(
            path, os.O_CREAT | os.O_RDWR, 0o600
        )

        try:
            with self.assertRaisesRegex(
                storage.StorageError, "lock is not held"
            ):
                storage.verify_test_install_lock(fd)

            fcntl.flock(
                fd, fcntl.LOCK_EX | fcntl.LOCK_NB
            )

            storage.verify_test_install_lock(fd)

            other = os.open(path, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    storage.verify_test_install_lock(other)
            finally:
                os.close(other)
        finally:
            os.close(fd)

    def test_completion_requires_durable_backup_checkpoint(self):
        import json

        channel = self.parent / "test-channel"
        channel.mkdir(mode=0o700)

        path = channel / "pending.json"
        backup_id = "20261112_080000_1234abcd"

        transaction = {
            "format": "homecloud-test-transaction-v1",
            "phase": "BACKUP",
            "backup_id": backup_id,
            "backup_maintenance": self.marker_identity(),
        }

        path.write_text(json.dumps(transaction))
        path.chmod(0o600)

        self.assertEqual(
            storage.read_test_backup_checkpoint(backup_id),
            self.marker_identity(),
        )

        for phase, observed_id in (
            ("STOP_SERVICES", backup_id),
            ("BACKUP", "20261112_080000_ffffffff"),
        ):
            with self.subTest(phase=phase, backup=observed_id):
                transaction["phase"] = phase
                path.write_text(json.dumps(transaction))

                with self.assertRaises(storage.StorageError):
                    storage.read_test_backup_checkpoint(
                        observed_id
                    )


class DescriptorLifetimeTests(unittest.TestCase):

    def test_bash_parent_retains_child_acquired_flock(self):
        with tempfile.TemporaryDirectory() as parent:
            path = str(Path(parent).resolve())

            # The first Python child acquires a lock on the
            # Bash parent's descriptor. It then exits.
            #
            # A second Python process must still see the lock.
            script = r"""
set -euo pipefail
exec 9<"$1"
"$2" -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
"$2" -c '
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("PASS: Bash parent still owns the kernel fence")
    else:
        sys.exit("STOP: lock disappeared with acquiring child")
finally:
    os.close(fd)
' "$1"
"""
            result = subprocess.run(
                ["bash", "-c", script,
                 "backup-fence-fixture", path, sys.executable],
                capture_output=True,
                text=True,
                timeout=15,
            )

            self.assertEqual(
                result.returncode, 0,
                result.stdout + result.stderr,
            )

            self.assertIn(
                "Bash parent still owns the kernel fence",
                result.stdout,
            )

            # After the Bash process exits, the lock is free.
            fd = os.open(
                path, os.O_RDONLY | os.O_DIRECTORY
            )
            try:
                fcntl.flock(
                    fd, fcntl.LOCK_EX | fcntl.LOCK_NB
                )
            finally:
                os.close(fd)

    def test_actual_backup_uses_fence_before_staging(self):
        source = (ROOT / "scripts/backup.sh").read_text()

        acquire = source.index("backup-fence-acquire")
        staging = source.index('mkdir -p "$SESSION_DIR"')
        recheck = source.index("backup-fence-check")

        self.assertLess(acquire, staging)
        self.assertLess(staging, recheck)
        self.assertIn(
            'exec 9<"$RECOVERY_STORAGE_SOURCE"',
            source,
        )




class ReleaseBackupLifecycleTests(unittest.TestCase):

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        tmp = self.stack.enter_context(
            tempfile.TemporaryDirectory()
        )

        self.parent = Path(tmp).resolve()
        self.root = self.parent / "storage"
        self.root.mkdir(mode=0o700)

        self.state = self.parent / "maintenance"
        self.state.mkdir(mode=0o711)
        self.state.chmod(0o711)

        self.marker = (
            self.state / storage.MAINTENANCE_MARKER
        )

        info = self.root.stat()

        self.snapshot = {
            "project": "homecloud-release",
            "type": "bind",
            "target": "/storage",
            "source": str(self.root),
            "bind_identity": [
                info.st_dev, info.st_ino
            ],
            "container_id": "a" * 64,
            "image_id": "sha256:" + "b" * 64,
        }

        self.services = {
            name: {
                "Id": str(index) * 64,
                "Image": "sha256:" + str(index) * 64,
            }
            for index, name in enumerate(
                ("db", "backend", "frontend", "ingress"),
                start=1,
            )
        }

        self.events = []

        for name, value in (
            ("RELEASE_PROJECT_ROOT", ROOT),
            ("RELEASE_MAINTENANCE_ROOT", self.state),
            ("BACKUP_STORAGE_UID", info.st_uid),
            ("BACKUP_STATE_UID", self.state.stat().st_uid),
            ("BACKUP_STATE_GID", self.state.stat().st_gid),
        ):
            self.stack.enter_context(
                patch.object(storage, name, value)
            )

        for name in (
            "backup_local_daemon",
            "qualified_state_path",
            "release_backend_admission",
            "verify_backup_inhibitor",
            "checked_storage",
            "verify_backup_writers",
        ):
            self.stack.enter_context(
                patch.object(storage, name)
            )

        self.stack.enter_context(
            patch.object(
                storage, "resolve_storage",
                return_value=self.snapshot,
            )
        )

        self.stack.enter_context(
            patch.object(
                storage, "release_service_inventory",
                return_value=self.services,
            )
        )

        self.stack.enter_context(
            patch.object(
                storage, "create_release_inhibit",
                side_effect=self.create_inhibit,
            )
        )

        self.stack.enter_context(
            patch.object(
                storage, "release_compose",
                side_effect=self.compose,
            )
        )

        self.stack.enter_context(
            patch.object(
                storage, "finish_backup_maintenance",
                side_effect=self.finish,
            )
        )

    def create_inhibit(self):
        fd = os.open(
            self.marker,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            os.write(fd, storage.MAINTENANCE_PAYLOAD)
            os.fsync(fd)
        finally:
            os.close(fd)

        self.events.append("inhibit")

    def compose(self, action, *args):
        if action == "stop":
            self.assertTrue(self.marker.exists())
            self.assertEqual(
                args,
                (
                    "--timeout", "60",
                    "ingress", "frontend", "backend",
                ),
            )
        elif action == "start":
            self.assertFalse(self.marker.exists())
            self.assertEqual(
                args,
                (
                    "backend",
                    "frontend", "ingress",
                ),
            )
        else:
            self.fail("Unexpected Compose action")

        self.events.append(action)

    def finish(self, snapshot, identity):
        self.assertEqual(snapshot, self.snapshot)
        info = self.marker.stat()

        self.assertEqual(
            identity, [info.st_dev, info.st_ino]
        )

        self.marker.unlink()
        self.events.append("finish")

    def test_release_success_and_real_operation_lock(self):
        with storage.release_backup_window():
            self.assertTrue(self.marker.exists())

            lock = (
                self.state / storage.RELEASE_OPERATION_LOCK
            )

            fd = os.open(lock, os.O_RDWR)

            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(
                        fd,
                        fcntl.LOCK_EX | fcntl.LOCK_NB,
                    )
            finally:
                os.close(fd)

            self.events.append("backup")

        self.assertEqual(
            self.events,
            [
                "inhibit", "stop", "backup",
                "finish", "start",
            ],
        )

        self.assertFalse(self.marker.exists())

        fd = storage.acquire_release_operation_lock()
        os.close(fd)

    def test_backup_failure_retains_marker(self):
        with self.assertRaisesRegex(
            RuntimeError, "backup failed"
        ):
            with storage.release_backup_window():
                raise RuntimeError("backup failed")

        self.assertTrue(self.marker.exists())

        self.assertEqual(
            self.events, ["inhibit", "stop"]
        )

    def test_existing_marker_refuses_without_stop(self):
        self.create_inhibit()

        with self.assertRaises(FileExistsError):
            with storage.release_backup_window():
                self.fail("Backup was admitted")

        self.assertEqual(self.events, ["inhibit"])

    def test_completion_failure_never_restarts(self):
        with patch.object(
            storage, "finish_backup_maintenance",
            side_effect=storage.StorageError(
                "unresolved journal"
            ),
        ):
            with self.assertRaises(storage.StorageError):
                with storage.release_backup_window():
                    self.events.append("backup")

        self.assertTrue(self.marker.exists())

        self.assertEqual(
            self.events,
            ["inhibit", "stop", "backup"],
        )

    def test_concurrent_release_operation_refused(self):
        fd = storage.acquire_release_operation_lock()

        try:
            with self.assertRaises(BlockingIOError):
                with storage.release_backup_window():
                    self.fail("Concurrent backup admitted")
        finally:
            os.close(fd)

        self.assertFalse(self.marker.exists())
        self.assertEqual(self.events, [])

    def test_test_project_refused_by_release_lifecycle(self):
        self.snapshot["project"] = "homecloud-test"

        with self.assertRaises(storage.StorageError):
            with storage.release_backup_window():
                self.fail("TEST runtime admitted as RELEASE")

        self.assertFalse(self.marker.exists())
        self.assertEqual(self.events, [])

    def test_restart_failure_is_not_reported_as_success(self):
        def fail_start(action, *args):
            if action == "start":
                raise storage.StorageError(
                    "restart failed"
                )
            self.compose(action, *args)

        with patch.object(
            storage, "release_compose",
            side_effect=fail_start,
        ):
            with self.assertRaisesRegex(
                storage.StorageError, "restart failed"
            ):
                with storage.release_backup_window():
                    self.events.append("backup")

        # Data capture and completion succeeded. Startup
        # failed afterwards, so maintenance was already
        # cleared. Do not misreport this as a failed capture.
        self.assertFalse(self.marker.exists())

        self.assertEqual(
            self.events,
            ["inhibit", "stop", "backup", "finish"],
        )


if __name__ == "__main__":
    unittest.main()
