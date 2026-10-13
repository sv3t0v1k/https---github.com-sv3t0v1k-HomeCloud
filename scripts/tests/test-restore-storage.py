#!/usr/bin/env python3
"""A failed restore's retained artifacts must survive every automatic retry."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class RetainedArtifacts(unittest.TestCase):
    def test_retained_directories_files_and_symlinks_are_preserved(self):
        source = (ROOT / 'scripts/restore.sh').read_text()
        start = source.index('set -e\nSTORAGE_ROOT="$1"')
        end = source.index('# --- 1. Prepare:', start)
        block = source[start:end]
        for name in ('.restore-staging', '.restore-swap'):
            for kind in ('directory','file','symlink'):
                with self.subTest(name=name,kind=kind), tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
                    directory=Path(tmp); retained=directory/name
                    if kind=='directory':
                        retained.mkdir(); (retained/'original').write_bytes(b'last good copy')
                    elif kind=='file': retained.write_bytes(b'last good copy')
                    else: retained.symlink_to('missing-original')
                    result=subprocess.run(['sh','-c',block,'fixture',tmp,'0'],capture_output=True,text=True)
                    self.assertNotEqual(result.returncode,0,result.stderr)
                    self.assertIn('operator review',result.stderr)
                    self.assertTrue(retained.exists() or retained.is_symlink())
                    if kind=='directory': self.assertEqual((retained/'original').read_bytes(),b'last good copy')
                    if kind=='file': self.assertEqual(retained.read_bytes(),b'last good copy')
                    if kind=='symlink': self.assertEqual(os.readlink(retained),'missing-original')

    def test_preflight_and_backup_refuse_retained_artifacts(self):
        helper=ROOT/'scripts/recovery-storage.sh'
        shim='''set -euo pipefail
source "$1"
recovery_storage_run() { shift 3; "$@"; }
BACKEND_IMAGE=fixture
RECOVERY_STORAGE_TARGET="$2"
recovery_storage_assert_clean
'''
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
            directory=Path(tmp)
            run=lambda:subprocess.run(['bash','-c',shim,'fixture',str(helper),tmp],capture_output=True,text=True)
            self.assertEqual(run().returncode,0)
            (directory/'.restore-swap').mkdir()
            self.assertNotEqual(run().returncode,0)
            self.assertTrue((directory/'.restore-swap').is_dir())

if __name__=='__main__': unittest.main()
