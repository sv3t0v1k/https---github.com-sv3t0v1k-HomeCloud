#!/usr/bin/env python3
"""Restore HTTP gate regression; every Docker call is a shell fixture."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import re
import shutil
import unittest

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--baseline-root', type=Path)
options, remaining = parser.parse_known_args()
sys.argv = [sys.argv[0], *remaining]
ROOT = options.baseline_root or Path(__file__).resolve().parents[2]

class HealthGate(unittest.TestCase):
    def gate(self, body, rc=0):
        source = (ROOT / 'scripts/restore.sh').read_text()
        block = source.split('# --- Health check (actual HTTP probe, output captured) ---', 1)[1]
        shim = '''set -euo pipefail
log() { :; }; err() { printf '%s\\n' "$*" >&2; }
sleep() { :; }
docker() { cat >/dev/null; printf '%s' "$TEST_BODY"; return "$TEST_RC"; }
RECOVERY_STORAGE_TYPE=fixture; RECOVERY_STORAGE_TARGET=/fixture
STORAGE_VOLUME=fixture; BACKEND_IMAGE=fixture
'''
        return subprocess.run(['bash', '-c', shim + block], capture_output=True, text=True,
                              env=dict(os.environ, TEST_BODY=json.dumps(body) if not isinstance(body, str) else body, TEST_RC=str(rc)))

    def test_ready_http200(self):
        self.assertEqual(self.gate({'status':'ready', 'checks':{'database':'ok','storage':'ok'}}).returncode, 0)

    def test_http_error_with_ok_body_is_failure(self):
        self.assertNotEqual(self.gate({'status':'ready', 'checks':{'database':'ok','storage':'ok'}}, 1).returncode, 0)

    def test_not_ready_body_is_failure(self):
        self.assertNotEqual(self.gate({'status':'not_ready','checks':{'database':'ok','storage':'failed'}}).returncode, 0)

    def test_unrelated_ok_string_is_failure(self):
        self.assertNotEqual(self.gate({'error':'ok'}).returncode, 0)

    def test_missing_checks_is_failure(self):
        self.assertNotEqual(self.gate({'status':'ready'}).returncode, 0)

    def test_invalid_json_is_failure(self):
        self.assertNotEqual(self.gate('not JSON').returncode, 0)

    def test_probe_has_bounded_total_deadline_without_network(self):
        if not shutil.which('node'): self.skipTest('Node unavailable')
        source=(ROOT/'scripts/restore.sh').read_text()
        match=re.search(r"BACKEND_HEALTH=\$\(echo '([^']+)'",source)
        self.assertIsNotNone(match)
        # The actual probe runs with a module shim, never a network connection.
        stub="const Module=require('module'),events=require('events');const old=Module._load;Module._load=function(id,...args){if(id==='http')return {get(){const pending=setInterval(()=>{},1000);const q=new events.EventEmitter();q.setTimeout=()=>q;q.destroy=error=>{clearInterval(pending);q.emit('error',error);};return q;}};return old.call(this,id,...args);};"
        with tempfile.TemporaryDirectory(dir='/private/tmp') as tmp:
            module=Path(tmp)/'http-fixture.cjs';module.write_text(stub)
            start=time.monotonic()
            try:
                result=subprocess.run(['node','--require',str(module),'-e',match.group(1)],capture_output=True,timeout=8)
            except subprocess.TimeoutExpired:
                self.fail('Actual probe did not terminate within bounded deadline')
            self.assertNotEqual(result.returncode,0)
            self.assertGreater(time.monotonic()-start,4.5)
            self.assertLess(time.monotonic()-start,8)

    def test_empty_response_is_failure(self):
        self.assertNotEqual(self.gate('').returncode, 0)

if __name__ == '__main__':
    unittest.main()
