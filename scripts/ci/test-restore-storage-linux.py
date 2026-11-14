#!/usr/bin/env python3
"""Real Linux storage restore, UID/GID, flock and SIGKILL.

Docker inspection alone is mocked. All filesystem operations,
processes, descriptors and locks are real.
"""

from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import io
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import recovery_storage as storage
import restore_storage as restore


@contextmanager
def docker_fixture():
    with ExitStack() as stack:
        for name in (
            "backup_local_daemon",
            "checked_storage",
            "verify_backup_writers",
        ):
            stack.enter_context(patch.object(storage, name))
        yield


def make_fixture(parent):
    root = parent / "storage"
    root.mkdir(mode=0o700)
    os.chown(root, 1001, 65533)

    temporary = root / ".tmp"
    temporary.mkdir(mode=0o700)
    os.chown(temporary, 1001, 65533)

    (temporary / "old-upload").write_bytes(b"old-upload")
    (root / "old.txt").write_bytes(b"original-data")

    archive = parent / "backup.tar.gz"

    with tarfile.open(archive, "w:gz") as tar:
        entry = tarfile.TarInfo("./new.txt")
        entry.size = len(b"restored-data")
        tar.addfile(entry, io.BytesIO(b"restored-data"))

    archive.chmod(0o600)

    return root, archive


def snapshot_for(root):
    info = root.stat()

    return {
        "type": "bind",
        "target": "/storage",
        "source": str(root),
        "bind_identity": [info.st_dev, info.st_ino],
    }


def open_root(root):
    return os.open(
        root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    )


def perform(root, archive, fd):
    return restore.restore_storage(
        snapshot_for(root),
        fd,
        archive,
        hashlib.sha256(archive.read_bytes()).hexdigest(),
        1,
    )


def crash_worker(parent):
    root = parent / "storage"
    archive = parent / "backup.tar.gz"

    with docker_fixture():
        fd = open_root(root)

        storage.backup_fence(
            snapshot_for(root), fd, acquire=True
        )

        child = os.fork()

        if child != 0:
            _, status = os.waitpid(child, 0)
            os._exit(os.waitstatus_to_exitcode(status))

        # This child inherits the actual locked open-file description.
        # Stop at the point old data is already in swap, but the
        # restored data has not yet been moved into the root.

        original_rename = os.rename

        def pause_before_switch(src, dst, **kwargs):
            if src == "new.txt":
                (parent / "child-ready").write_text(
                    str(os.getpid())
                )
                while True:
                    signal.pause()

            return original_rename(src, dst, **kwargs)

        with patch.object(
            restore.os, "rename", side_effect=pause_before_switch
        ):
            perform(root, archive, fd)

        os._exit(99)


class LinuxRestoreTests(unittest.TestCase):

    def test_actual_ownership_and_successful_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root, archive = make_fixture(parent)

            before = root.stat()

            with docker_fixture():
                fd = open_root(root)
                try:
                    storage.backup_fence(
                        snapshot_for(root), fd, acquire=True
                    )
                    self.assertEqual(perform(root, archive, fd), 1)
                finally:
                    os.close(fd)

            after = root.stat()

            self.assertEqual(
                (before.st_dev, before.st_ino),
                (after.st_dev, after.st_ino),
            )

            new = root / "new.txt"

            self.assertEqual(new.read_bytes(), b"restored-data")
            self.assertEqual(
                (new.stat().st_uid, new.stat().st_gid),
                (1001, 65533),
            )
            self.assertEqual(
                stat.S_IMODE(new.stat().st_mode), 0o600
            )

            temporary = root / ".tmp"

            self.assertEqual(
                (temporary.stat().st_uid, temporary.stat().st_gid),
                (1001, 65533),
            )
            self.assertEqual(
                stat.S_IMODE(temporary.stat().st_mode), 0o700
            )
            self.assertEqual(list(temporary.iterdir()), [])

            self.assertEqual(
                (root / restore.SWAP / "old.txt").read_bytes(),
                b"original-data",
            )
            self.assertEqual(
                (root / restore.SWAP / ".tmp/old-upload").read_bytes(),
                b"old-upload",
            )

    def test_sigkill_parent_and_writer_preserves_data(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root, _ = make_fixture(parent)

            worker = subprocess.Popen([
                sys.executable, "-B", __file__,
                "--crash-worker", str(parent),
            ])

            child = None
            contender = None

            try:
                deadline = time.monotonic() + 15

                while not (parent / "child-ready").exists():
                    self.assertIsNone(
                        worker.poll(), "worker exited before switch"
                    )
                    if time.monotonic() >= deadline:
                        self.fail("timeout reaching crash checkpoint")
                    time.sleep(0.02)

                child = int((parent / "child-ready").read_text())

                self.assertEqual(
                    (root / restore.SWAP / "old.txt").read_bytes(),
                    b"original-data",
                )

                self.assertEqual(
                    (root / restore.STAGE / "new.txt").read_bytes(),
                    b"restored-data",
                )

                # Actual SIGKILL of the parent process.
                worker.kill()
                self.assertEqual(worker.wait(timeout=5), -9)

                contender = open_root(root)

                # The surviving child must still own the kernel lock.
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(
                        contender, fcntl.LOCK_EX | fcntl.LOCK_NB
                    )

                self.assertFalse((root / "new.txt").exists())

                # Actual SIGKILL of the storage writer.
                os.kill(child, signal.SIGKILL)
                child = None

                deadline = time.monotonic() + 5

                while True:
                    try:
                        fcntl.flock(
                            contender, fcntl.LOCK_EX | fcntl.LOCK_NB
                        )
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            self.fail("root flock was not released")
                        time.sleep(0.02)

                # Neither old nor new bytes were destroyed.
                self.assertEqual(
                    (root / restore.SWAP / "old.txt").read_bytes(),
                    b"original-data",
                )
                self.assertEqual(
                    (root / restore.STAGE / "new.txt").read_bytes(),
                    b"restored-data",
                )

            finally:
                if child is not None:
                    try:
                        os.kill(child, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=5)

                if contender is not None:
                    os.close(contender)


if __name__ == "__main__":
    if sys.platform != "linux" or os.geteuid() != 0:
        raise SystemExit("Linux root test environment required")

    if len(sys.argv) == 3 and sys.argv[1] == "--crash-worker":
        crash_worker(Path(sys.argv[2]))
    else:
        unittest.main()
