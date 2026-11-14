#!/usr/bin/env python3
"""Historical marker compatibility uses the actual preflight/staging parser."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import restore_storage as restore


class HistoricalArchiveTests(unittest.TestCase):
    def archive(self, entries):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for name, payload in entries:
                entry = name if isinstance(name, tarfile.TarInfo) else tarfile.TarInfo(name)
                if payload is not None:
                    entry.size = len(payload)
                archive.addfile(entry, io.BytesIO(payload) if payload is not None else None)
        stream.seek(0)
        return stream

    def checked(self, entries):
        with tarfile.open(fileobj=self.archive(entries), mode="r:gz") as archive:
            return list(restore.checked_archive_members(archive))

    def test_valid_marker_and_new_markerless_archives(self):
        for name in (restore.IDENTITY_MARKER, "./" + restore.IDENTITY_MARKER):
            checked = self.checked([(name, restore.LEGACY_IDENTITY_BYTES), ("1/bytes.bin", b"bytes")])
            self.assertEqual([row[2] for row in checked], [True, False])
        self.assertFalse(self.checked([("1/bytes.bin", b"bytes")])[0][2])

    def test_unknown_or_noncanonical_marker_fails(self):
        for payload in (b"", b"x" * 1025,
                        restore.LEGACY_IDENTITY_BYTES.replace(b'legacy-storage', b'other-storage'),
                        restore.LEGACY_IDENTITY_BYTES.replace(b'"version":1', b'"version":2'),
                        restore.LEGACY_IDENTITY_BYTES.replace(b'"version":1', b'"version":0,"version":1'),
                        restore.LEGACY_IDENTITY_BYTES.rstrip(),
                        json.dumps(json.loads(restore.LEGACY_IDENTITY_BYTES)).encode()):
            with self.subTest(payload=payload[:30]):
                with self.assertRaises(restore.storage.StorageError):
                    self.checked([(restore.IDENTITY_MARKER, payload)])

    def test_marker_links_directory_and_children_fail(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE):
            entry = tarfile.TarInfo(restore.IDENTITY_MARKER)
            entry.type = kind
            entry.linkname = "1/bytes.bin"
            with self.subTest(kind=kind):
                with self.assertRaises(restore.storage.StorageError):
                    self.checked([(entry, None)])
        with self.assertRaises(restore.storage.StorageError):
            self.checked([(restore.IDENTITY_MARKER + "/child", b"unsafe")])

    def test_marker_duplicate_aliases_fail(self):
        with self.assertRaisesRegex(restore.storage.StorageError, "Duplicate"):
            self.checked([(restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES),
                          ("./" + restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES)])

    def test_sparse_marker_is_rejected_without_reading_content(self):
        for sparse in ([], [(0, 10)]):
            entry = tarfile.TarInfo(restore.IDENTITY_MARKER)
            entry.size = len(restore.LEGACY_IDENTITY_BYTES)
            entry.sparse = sparse
            with self.subTest(sparse=sparse):
                with self.assertRaisesRegex(restore.storage.StorageError, "metadata"):
                    list(restore.checked_archive_members([entry]))

    def test_cli_ignores_only_validated_root_marker_for_migration_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "historic.tar.gz"
            path.write_bytes(self.archive([
                (restore.IDENTITY_MARKER, restore.LEGACY_IDENTITY_BYTES),
                ("./1/user.txt", b"user bytes"),
                ("1/" + restore.IDENTITY_MARKER, b"ordinary payload"),
            ]).getvalue())
            for action in ("scan-archive", "sparse-metadata"):
                result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/restore_storage.py"),
                                         action, str(path)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                if action == "sparse-metadata":
                    self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], [
                        {"name": "./1/user.txt", "size": 10},
                        {"name": "1/" + restore.IDENTITY_MARKER, "size": 16},
                    ])
            path.write_bytes(self.archive([(restore.IDENTITY_MARKER, b"malformed")]).getvalue())
            for action in ("scan-archive", "sparse-metadata"):
                result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/restore_storage.py"),
                                         action, str(path)], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    def test_marker_contract_matches_application_marker_contents(self):
        source = (ROOT / "backend/src/storage/storage-mount-registry.ts").read_text()
        marker = json.loads(restore.LEGACY_IDENTITY_BYTES)
        self.assertIn('LEGACY_STORAGE_ID = "' + marker["storageLocationId"] + '"', source)
        self.assertIn('LEGACY_STORAGE_KEY = "' + marker["machineKey"] + '"', source)
        # Application's canonical writer is executed in Linux E2E as well.
        self.assertEqual(restore.LEGACY_IDENTITY_BYTES,
                         json.dumps(marker, separators=(",", ":")).encode() + b"\n")


if __name__ == "__main__":
    unittest.main()
