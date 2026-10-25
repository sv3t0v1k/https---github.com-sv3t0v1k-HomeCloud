#!/usr/bin/env python3
"""A changed extracted Trivy binary cannot reuse a verified archive/cache."""
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

HELPER = Path(__file__).with_name('verify-trivy-archive.sh')
INSTALLER = Path(__file__).with_name('install-trivy.sh')


class TrivyArchiveTests(unittest.TestCase):
    def test_verified_archive_content_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source'
            source.mkdir()
            binary = source/'trivy'
            binary.write_text('#!/bin/sh\necho trivy\n')
            binary.chmod(0o755)
            archive = source/'trivy.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(binary, arcname='trivy')
            good = subprocess.run(['sh', str(HELPER), str(archive), str(binary), str(root/'good')],
                                  capture_output=True, text=True)
            self.assertEqual(good.returncode, 0, good.stderr)
            binary.write_text('#!/bin/sh\necho substituted\n')
            binary.chmod(0o755)
            bad = subprocess.run(['sh', str(HELPER), str(archive), str(binary), str(root/'bad')],
                                 capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)
            # The installer must also reject a self-made archive lacking the pinned digest.
            rejected = subprocess.run(['sh', str(INSTALLER), str(root/'reused'), str(source)],
                                      capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == '__main__':
    unittest.main()
