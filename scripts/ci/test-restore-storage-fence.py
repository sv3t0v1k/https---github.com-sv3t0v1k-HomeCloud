#!/usr/bin/env python3
"""Real root flock and filesystem tests for host-side restore."""

from contextlib import ExitStack
import fcntl
import hashlib
import io
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(ROOT / "scripts"))

import recovery_storage as storage
import restore_storage as restore


class RestoreStorageTests(unittest.TestCase):

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        temporary = self.stack.enter_context(
            tempfile.TemporaryDirectory()
        )

        self.parent = Path(temporary).resolve()

        self.root = self.parent / "storage"
        self.root.mkdir(mode=0o700)

        (self.root / ".tmp").mkdir(mode=0o700)
        (self.root / ".tmp" / "old-upload").write_bytes(b"old")
        (self.root / "old.txt").write_bytes(b"old-file")

        (self.root / "old-dir").mkdir()
        (self.root / "old-dir" / "data").write_bytes(
            b"old-directory"
        )

        self.archive = self.parent / "backup.tar.gz"

        self.fd = os.open(
            self.root, os.O_RDONLY | os.O_DIRECTORY
        )

        self.addCleanup(os.close, self.fd)

        info = self.root.stat()

        self.snapshot = {
            "type": "bind",
            "target": "/storage",
            "source": str(self.root),
            "bind_identity": [
                info.st_dev, info.st_ino
            ],
        }

        for module, name, value in (
            (restore, "RESTORE_UID", info.st_uid),
            (restore, "RESTORE_GID", info.st_gid),
            (storage, "BACKUP_STORAGE_UID", info.st_uid),
        ):
            self.stack.enter_context(
                patch.object(module, name, value)
            )

        # The actual backup_fence is used with real
        # flock, descriptors and inode validation.
        # Only the Docker/host-specific checks are mocked.
        for name in (
            "backup_local_daemon",
            "checked_storage",
            "verify_backup_writers",
        ):
            self.stack.enter_context(
                patch.object(storage, name)
            )

        self.stack.enter_context(
            patch.object(
                restore, "reject_nested_mounts"
            )
        )

        fcntl.flock(
            self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB
        )

    def create_archive(self, entries):
        with tarfile.open(
            self.archive, "w:gz"
        ) as archive:
            for name, data in entries:
                if isinstance(data, tarfile.TarInfo):
                    archive.addfile(data)
                    continue

                item = tarfile.TarInfo(name)

                if data is None:
                    item.type = tarfile.DIRTYPE
                    archive.addfile(item)
                else:
                    item.size = len(data)
                    item.mode = 0o777
                    archive.addfile(
                        item, io.BytesIO(data)
                    )

        self.archive.chmod(0o600)

        return hashlib.sha256(
            self.archive.read_bytes()
        ).hexdigest()

    def restore(self, checksum, count):
        return restore.restore_storage(
            self.snapshot,
            self.fd,
            self.archive,
            checksum,
            count,
        )

    def assert_original(self):
        self.assertEqual(
            (self.root / "old.txt").read_bytes(),
            b"old-file",
        )

        self.assertEqual(
            (
                self.root / "old-dir" / "data"
            ).read_bytes(),
            b"old-directory",
        )

    def test_switch_preserves_application_storage_identity(self):
        marker = self.root / restore.IDENTITY_MARKER
        marker.write_bytes(b"existing storage identity")
        marker.chmod(0o600)
        original = marker.stat()
        checksum = self.create_archive([("./new.txt", b"restored")])
        self.restore(checksum, 1)
        self.assertEqual(marker.read_bytes(), b"existing storage identity")
        self.assertEqual((marker.stat().st_dev, marker.stat().st_ino),
                         (original.st_dev, original.st_ino))
        self.assertFalse((self.root / restore.SWAP / restore.IDENTITY_MARKER).exists())

    def enroll_target(self):
        marker = self.root / restore.IDENTITY_MARKER
        marker.write_bytes(restore.LEGACY_IDENTITY_BYTES)
        marker.chmod(0o600)
        return marker, marker.stat()

    def test_historical_marker_is_metadata_and_never_replaces_target(self):
        marker, before = self.enroll_target()
        checksum = self.create_archive([
            ("./" + restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES),
            ("./1/new.txt", b"historic bytes"),
            ("./1/" + restore.IDENTITY_MARKER, b"ordinary nested payload"),
        ])
        checkpoint = restore.stage_storage(
            self.snapshot, self.fd, self.archive, checksum, 3,
        )
        self.assertEqual(checkpoint["archive_file_count"], 3)
        self.assertEqual(checkpoint["file_count"], 2)
        self.assertEqual(checkpoint["historical_identity_count"], 1)
        self.assertFalse((self.root / restore.STAGE / restore.IDENTITY_MARKER).exists())
        self.assert_original()
        self.assertEqual(restore.switch_staged_storage(self.snapshot, self.fd, checkpoint), 2)
        self.assertEqual(marker.read_bytes(), restore.LEGACY_IDENTITY_BYTES)
        self.assertEqual((marker.stat().st_dev, marker.stat().st_ino),
                         (before.st_dev, before.st_ino))
        self.assertEqual((self.root / "1" / restore.IDENTITY_MARKER).read_bytes(),
                         b"ordinary nested payload")
        self.assertFalse((self.root / restore.SWAP / restore.IDENTITY_MARKER).exists())

    def test_historical_marker_only_backup_restores_empty_payload(self):
        marker, before = self.enroll_target()
        checksum = self.create_archive([(restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES)])
        self.assertEqual(self.restore(checksum, 1), 0)
        self.assertEqual(marker.stat().st_ino, before.st_ino)
        self.assertEqual(set(os.listdir(self.root)), {restore.IDENTITY_MARKER, ".tmp", restore.SWAP})

    def test_historical_marker_cannot_enroll_missing_target(self):
        checksum = self.create_archive([(restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES)])
        with self.assertRaises(FileNotFoundError):
            self.restore(checksum, 1)
        self.assert_original()
        self.assertFalse((self.root / restore.IDENTITY_MARKER).exists())
        self.assertFalse((self.root / restore.SWAP).exists())

    def test_historical_marker_checkpoint_rejects_target_replacement(self):
        marker, before = self.enroll_target()
        checksum = self.create_archive([(restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES)])
        checkpoint = restore.stage_storage(self.snapshot, self.fd, self.archive, checksum, 1)
        marker.rename(self.root / "retained-marker")
        marker.write_bytes(restore.LEGACY_IDENTITY_BYTES)
        marker.chmod(0o600)
        with self.assertRaisesRegex(storage.StorageError, "identity changed"):
            restore.switch_staged_storage(self.snapshot, self.fd, checkpoint)
        self.assert_original()
        self.assertFalse((self.root / restore.SWAP).exists())

    def test_prepared_tree_substitution_fails_before_switch(self):
        checksum = self.create_archive([("./new.txt", b"restored")])
        checkpoint = restore.stage_storage(
            self.snapshot, self.fd, self.archive, checksum, 1,
        )
        self.assert_original()
        self.assertFalse((self.root / restore.SWAP).exists())
        (self.root / restore.STAGE / "new.txt").write_bytes(b"modified")
        with self.assertRaisesRegex(storage.StorageError, "content changed"):
            restore.switch_staged_storage(self.snapshot, self.fd, checkpoint)
        self.assert_original()
        self.assertFalse((self.root / restore.SWAP).exists())

    def test_success_preserves_old_files_and_root_inode(self):
        before = self.root.stat()

        checksum = self.create_archive([
            (".", None),
            ("./1", None),
            ("./1/new.txt", b"restored"),
            ("./top-level.txt", b"regular file"),
        ])

        self.assertEqual(
            self.restore(checksum, 2), 2
        )

        self.assertEqual(
            (self.root / "1/new.txt").read_bytes(),
            b"restored",
        )

        self.assertEqual(
            (
                self.root / "top-level.txt"
            ).read_bytes(),
            b"regular file",
        )

        self.assertEqual(
            (
                self.root / restore.SWAP / "old.txt"
            ).read_bytes(),
            b"old-file",
        )

        self.assertEqual(
            (
                self.root / restore.SWAP
                / "old-dir/data"
            ).read_bytes(),
            b"old-directory",
        )

        self.assertFalse(
            (self.root / restore.STAGE).exists()
        )

        self.assertEqual(
            list((self.root / ".tmp").iterdir()), []
        )
        self.assertEqual(
            (self.root / restore.SWAP / ".tmp/old-upload").read_bytes(),
            b"old",
        )

        after = self.root.stat()

        self.assertEqual(
            (before.st_dev, before.st_ino),
            (after.st_dev, after.st_ino),
        )

        self.assertEqual(
            stat.S_IMODE(after.st_mode), 0o700
        )

        for name, mode in (
            ("1", 0o700),
            ("1/new.txt", 0o600),
            ("top-level.txt", 0o600),
            (".tmp", 0o700),
        ):
            info = (self.root / name).stat()

            self.assertEqual(
                stat.S_IMODE(info.st_mode), mode
            )

            self.assertEqual(
                (info.st_uid, info.st_gid),
                (before.st_uid, before.st_gid),
            )

    def test_empty_archive_retains_old_storage(self):
        checksum = self.create_archive([
            (".", None),
        ])

        self.assertEqual(
            self.restore(checksum, 0), 0
        )

        self.assertEqual(
            set(os.listdir(self.root)),
            {".tmp", restore.SWAP},
        )

        self.assertEqual(
            (
                self.root / restore.SWAP / "old.txt"
            ).read_bytes(),
            b"old-file",
        )

    def test_wrong_checksum_does_not_mutate_storage(self):
        self.create_archive([
            ("new.txt", b"new"),
        ])

        with self.assertRaisesRegex(
            storage.StorageError, "checksum"
        ):
            self.restore("0" * 64, 1)

        self.assert_original()

        self.assertFalse(
            (self.root / restore.STAGE).exists()
        )

    def test_missing_root_lock_does_not_mutate(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        fcntl.flock(self.fd, fcntl.LOCK_UN)

        with self.assertRaises(storage.StorageError):
            self.restore(checksum, 1)

        self.assert_original()

        self.assertFalse(
            (self.root / restore.STAGE).exists()
        )

    def test_lock_survives_restore_child_lifetime(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        self.restore(checksum, 1)

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

    def test_malicious_path_refused_before_switch(self):
        checksum = self.create_archive([
            ("../escape.txt", b"malicious"),
        ])

        with self.assertRaises(storage.StorageError):
            self.restore(checksum, 1)

        self.assert_original()

        self.assertFalse(
            (self.parent / "escape.txt").exists()
        )

        self.assertFalse(
            (self.root / restore.SWAP).exists()
        )

    def test_reserved_restore_path_refused(self):
        checksum = self.create_archive([
            (".restore-swap/attack", b"bad"),
        ])

        with self.assertRaisesRegex(
            storage.StorageError, "Reserved"
        ):
            self.restore(checksum, 1)

        self.assert_original()

    def test_symlink_archive_member_refused(self):
        link = tarfile.TarInfo("link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"

        checksum = self.create_archive([
            ("link", link),
        ])

        with self.assertRaisesRegex(
            storage.StorageError, "Nonregular"
        ):
            self.restore(checksum, 0)

        self.assert_original()

    def test_duplicate_member_refused(self):
        checksum = self.create_archive([
            ("new.txt", b"first"),
            ("./new.txt", b"second"),
        ])

        with self.assertRaisesRegex(
            storage.StorageError, "Duplicate"
        ):
            self.restore(checksum, 2)

        self.assert_original()

    def test_file_count_mismatch_preserves_original(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        with self.assertRaisesRegex(
            storage.StorageError, "file count"
        ):
            self.restore(checksum, 2)

        self.assert_original()

        self.assertFalse(
            (self.root / restore.SWAP).exists()
        )

    def test_retained_artifact_refused(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        retained = self.root / restore.SWAP
        retained.mkdir()
        sentinel = retained / "original"
        sentinel.write_bytes(b"only surviving copy")

        with self.assertRaisesRegex(
            storage.StorageError, "operator review"
        ):
            self.restore(checksum, 1)

        self.assertEqual(
            sentinel.read_bytes(),
            b"only surviving copy",
        )

        self.assert_original()

    def test_interrupted_switch_retains_original_regular_file(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        real_rename = os.rename

        def fail_switch(src, dst, **kwargs):
            if src == "new.txt":
                raise OSError("injected switch failure")

            return real_rename(src, dst, **kwargs)

        with patch.object(
            restore.os, "rename",
            side_effect=fail_switch,
        ):
            with self.assertRaisesRegex(
                OSError, "injected switch"
            ):
                self.restore(checksum, 1)

        self.assertEqual(
            (
                self.root / restore.SWAP / "old.txt"
            ).read_bytes(),
            b"old-file",
        )

        self.assertEqual(
            (
                self.root / restore.SWAP
                / "old-dir/data"
            ).read_bytes(),
            b"old-directory",
        )

        self.assertEqual(
            (
                self.root / restore.STAGE / "new.txt"
            ).read_bytes(),
            b"new",
        )

    def test_wrong_storage_root_owner_refused(self):
        checksum = self.create_archive([
            ("new.txt", b"new"),
        ])

        with patch.object(
            restore,
            "RESTORE_GID",
            self.root.stat().st_gid + 1,
        ):
            with self.assertRaisesRegex(
                storage.StorageError, "ownership"
            ):
                self.restore(checksum, 1)

        self.assert_original()


class RestoreAdmissionTests(unittest.TestCase):

    def test_nested_mount_inventory_refused(self):
        root = Path("/srv/homecloud/storage")

        safe = (
            "36 25 8:1 / /srv/homecloud/storage rw "
            "- ext4 /dev/sda1 rw\n"
        )

        restore.reject_nested_mounts(
            root, inventory=safe
        )

        unsafe = safe + (
            "37 36 8:2 / /srv/homecloud/storage/sub rw "
            "- ext4 /dev/sdb1 rw\n"
        )

        with self.assertRaisesRegex(
            storage.StorageError, "Nested"
        ):
            restore.reject_nested_mounts(
                root, inventory=unsafe
            )

    def test_actual_destructive_path_order(self):
        source = (ROOT / "scripts/restore.sh").read_text()

        anchors = [
            'Validation complete (--validate-only;',
            'begin "$RESTORE_TOKEN"',
            'acquire-root "$RESTORE_TOKEN"',
            '"$RESTORE_MAINTENANCE" stage',
            'verify-staged "$RESTORE_TOKEN"',
            'DROP SCHEMA public CASCADE',
            'db-restored "$RESTORE_TOKEN"',
            '"$RESTORE_MAINTENANCE" switch',
            'migrate "$RESTORE_TOKEN"',
            'acquire-after-migration "$RESTORE_TOKEN"',
            'validate_restored_database current',
            'complete "$RESTORE_TOKEN"',
            '"$RESTORE_MAINTENANCE" restart "$RESTORE_TOKEN"',
            'restore_ack || die',
        ]

        positions = []
        previous = 0

        for anchor in anchors:
            index = source.index(anchor, previous)
            positions.append(index)
            previous = index + len(anchor)

        self.assertEqual(positions, sorted(positions))

        self.assertNotIn(
            'recovery_storage_run rw', source
        )


if __name__ == "__main__":
    unittest.main()
