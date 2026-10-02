#!/usr/bin/env python3
"""Exercise actual cleanup function with mock Docker; never touch real volumes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
class Cleanup(unittest.TestCase):
 def test_owned_only_and_read_only_zero_docker(self):
  text=(ROOT/'scripts/tests/test-restore-safety.sh').read_text()
  start=text.index('OWNED_TEST_VOLUMES=()');end=text.index('trap cleanup EXIT',start)
  with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
   p=Path(tmp);log=p/'calls';fake=p/'docker'
   fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\ncase "$*" in "volume ls"*) echo unrelated-sentinel-volume;; esac\n');fake.chmod(0o700)
   env=dict(os.environ,PATH=tmp+':'+os.environ['PATH'],MOCK_LOG=str(log))
   script='set -euo pipefail\nFIXTURES_DIR="'+tmp+'/fixtures"\nSKIP_INTEGRATION=1\n'+text[start:end]+'\nOWNED_TEST_VOLUMES=(owned-only)\ncleanup\n'
   subprocess.run(['bash','-c',script],env=env,check=True)
   self.assertFalse(log.exists(),'read-only validation must not call Docker at cleanup')
   subprocess.run(['bash','-c',script.replace('SKIP_INTEGRATION=1','SKIP_INTEGRATION=0')],env=env,check=True)
   self.assertEqual(log.read_text().splitlines(),['volume rm -f owned-only'])
if __name__=='__main__':unittest.main()
