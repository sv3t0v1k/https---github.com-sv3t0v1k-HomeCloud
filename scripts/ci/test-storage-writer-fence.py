#!/usr/bin/env python3
"""Portable API regressions; Linux cross-container proof is separate."""

import fcntl
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "deploy/linux/storage-writer-fence.py"

spec = importlib.util.spec_from_file_location(
    "storage_writer_fence", SOURCE
)
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)


class StorageWriterFenceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(
            prefix="hc-writer-fence-"
        )
        self.addCleanup(self.scratch.cleanup)
        self.root = str(Path(self.scratch.name).resolve())
        self.uid = os.geteuid()

    def acquire(self, root=None):
        return fence.acquire_storage_root_fence(
            root or self.root, self.uid
        )

    def test_valid_root_acquires_exclusive_lock(self):
        fd = self.acquire()
        try:
            self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))

            competing = os.open(
                self.root,
                os.O_RDONLY | os.O_DIRECTORY
            )
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(
                        competing,
                        fcntl.LOCK_EX | fcntl.LOCK_NB,
                    )
            finally:
                os.close(competing)
        finally:
            os.close(fd)

    def test_existing_writer_lock_refuses_maintenance(self):
        fd = self.acquire()
        try:
            with self.assertRaises(fence.StorageFenceBusy):
                self.acquire()
        finally:
            os.close(fd)

    def test_lock_is_released_after_fd_closes(self):
        fd = self.acquire()
        os.close(fd)

        again = self.acquire()
        os.close(again)

    def test_storage_symlink_is_refused(self):
        alias = str(Path(self.root) / "alias")
        os.symlink(self.root, alias)

        with self.assertRaises(fence.StorageFenceError):
            self.acquire(alias)

    def test_world_writable_root_is_refused(self):
        os.chmod(self.root, 0o777)
        with self.assertRaises(fence.StorageFenceError):
            self.acquire()

    def test_wrong_owner_identity_is_refused(self):
        with self.assertRaises(fence.StorageFenceError):
            fence.acquire_storage_root_fence(
                self.root, self.uid + 1
            )

    def test_relative_path_is_refused(self):
        with self.assertRaises(fence.StorageFenceError):
            self.acquire("relative-storage-root")

    def test_noncanonical_path_is_refused(self):
        with self.assertRaises(fence.StorageFenceError):
            self.acquire(self.root + "/.")

    def test_file_instead_of_directory_is_refused(self):
        filename = Path(self.root) / "regular-file"
        filename.write_text("not a directory")
        filename.chmod(0o700)

        with self.assertRaises(fence.StorageFenceError):
            self.acquire(str(filename))


if __name__ == "__main__":
    unittest.main()
