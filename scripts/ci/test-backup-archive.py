#!/usr/bin/env python3
"""Exercise actual backup tar arguments against storage identity and user bytes."""
import io
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import unittest


class BackupArchiveTests(unittest.TestCase):
    def test_backup_preserves_user_tmp_extension_and_omits_local_identity(self):
        source = (Path(__file__).resolve().parents[1] / "backup.sh").read_text()
        line = next(line.strip() for line in source.splitlines() if line.strip().startswith("tar -czf - "))
        args = shlex.split(line.split(' > "$STAGING_STOR"; then')[0])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".tmp").mkdir()
            (root / ".tmp" / "unfinished").write_bytes(b"unpublished")
            (root / ".homecloud-storage-identity").write_bytes(b"host-local identity")
            (root / "7").mkdir()
            (root / "7" / "user.tmp").write_bytes(b"published user bytes")
            (root / "7" / "normal.bin").write_bytes(b"other bytes")
            args = [str(root) if arg == "$RECOVERY_STORAGE_TARGET" else arg for arg in args]
            # BSD tar otherwise adds macOS AppleDouble metadata; production
            # runs Linux tar. Keep this fixture's contents portable.
            archive = subprocess.check_output(args, env={**os.environ, "COPYFILE_DISABLE": "1"})
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as stream:
                entries = {member.name: stream.extractfile(member).read()
                           for member in stream if member.isfile()}
        self.assertEqual(entries, {
            "./7/user.tmp": b"published user bytes",
            "./7/normal.bin": b"other bytes",
        })


if __name__ == "__main__":
    unittest.main()
