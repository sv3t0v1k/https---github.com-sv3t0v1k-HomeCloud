#!/usr/bin/env python3
"""Process-level synthetic host drills; never calls Docker or the installer."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy/linux/update-install-bridge.py'
spec = importlib.util.spec_from_file_location('phase3_bridge_drill', SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
IDENTITY = 'a' * 64
COMMIT = 'b' * 40


class HostProcessDrills(unittest.TestCase):
    def receipt(self, status='VALIDATION_REQUIRED'):
        return dict(format=bridge.FORMAT, status=status,
                    manifestSha256=IDENTITY, phase=None,
                    updatedAt='2026-11-03T00:00:00Z')

    def root_stat(self, original):
        def stat_fd(fd):
            info = original(fd)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0,
                                   st_gid=bridge.GID, st_nlink=info.st_nlink,
                                   st_size=info.st_size)
        return stat_fd

    def assert_refuses_restart(self, status_file):
        original = os.fstat
        with patch.object(bridge, 'STATUS', status_file), \
             patch.object(bridge, 'directory'), \
             patch.object(bridge.os, 'fstat', self.root_stat(original)):
            with self.assertRaises(bridge.Stop):
                bridge.read_receipt()

    def wait_marker(self, marker, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if marker.exists():
                return
            finished, _ = os.waitpid(pid, os.WNOHANG)
            if finished:
                self.fail('synthetic child exited before interruption')
            time.sleep(0.01)
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        self.fail('synthetic child did not reach interruption point')

    @unittest.skipUnless(hasattr(os, 'fork') and hasattr(signal, 'SIGKILL'),
                         'requires POSIX process signals')
    def test_sigterm_sigkill_preserve_durable_status_and_pending(self):
        for stage in ('VERIFY_TRUST', 'INSTALLER'):
            for sig in (signal.SIGTERM, signal.SIGKILL):
                with self.subTest(stage=stage, signal=sig), tempfile.TemporaryDirectory() as temp:
                    base = Path(temp)
                    status = base / 'current.json'
                    status.write_text(json.dumps(self.receipt()))
                    marker = base / 'entered'
                    pending = base / 'pending.json'
                    pid = os.fork()
                    if pid == 0:
                        try:
                            bridge.STATUS_DIR = base
                            bridge.STATUS = status
                            bridge.os.fchown = lambda *_: None

                            def pause_at(point):
                                if point == stage:
                                    if point == 'INSTALLER':
                                        pending.write_text('{"phase":"START_SERVICES"}')
                                    marker.touch()
                                    while True:
                                        signal.pause()

                            def write(identity, state, phase):
                                bridge.publish(identity, state, phase)
                                pause_at(phase)

                            bridge.execute(
                                IDENTITY, write, lambda _: COMMIT,
                                lambda *_: {'commit': COMMIT, 'manifest_sha256': IDENTITY},
                                lambda *_: None, lambda: None)
                        except BaseException:
                            os._exit(2)
                        os._exit(0)
                    try:
                        self.wait_marker(marker, pid)
                        os.kill(pid, sig)
                        _, result = os.waitpid(pid, 0)
                        self.assertEqual(os.WTERMSIG(result), sig)
                        persisted = json.loads(status.read_text())
                        self.assertEqual((persisted['status'], persisted['phase']),
                                         ('RUNNING', stage))
                        self.assertEqual(status.stat().st_mode & 0o777, 0o640)
                        self.assert_refuses_restart(status)
                        self.assertEqual(pending.exists(), stage == 'INSTALLER')
                        if stage == 'INSTALLER':
                            self.assertEqual(json.loads(pending.read_text())['phase'],
                                             'START_SERVICES')
                    finally:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_network_and_corrupt_manifest_stop_before_installer(self):
        for failure in ('network', 'manifest'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                base = Path(temp)
                status = base / 'current.json'
                status.write_text(json.dumps(self.receipt()))
                calls = []
                def fetch(*_):
                    if failure == 'network':
                        raise ConnectionError('synthetic network outage')
                    return {'commit': 'c' * 40, 'manifest_sha256': IDENTITY}
                with patch.object(bridge, 'STATUS_DIR', base), patch.object(bridge, 'STATUS', status), \
                     patch.object(bridge.os, 'fchown'):
                    with self.assertRaises((ConnectionError, bridge.Stop)):
                        bridge.execute(
                            IDENTITY, bridge.publish, lambda _: COMMIT, fetch,
                            lambda *_: calls.append('installer'), lambda: None)
                self.assertEqual(json.loads(status.read_text())['status'], 'STOP')
                self.assertEqual(calls, [])
                self.assert_refuses_restart(status)

    def test_ambiguous_installer_keeps_pending_and_requires_manual_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            status = base / 'current.json'
            status.write_text(json.dumps(self.receipt()))
            pending = base / 'pending.json'
            def fail_install(*_):
                pending.write_text('{"phase":"SMOKE"}')
                raise TimeoutError('synthetic health check timeout')
            with patch.object(bridge, 'STATUS_DIR', base), patch.object(bridge, 'STATUS', status), \
                 patch.object(bridge.os, 'fchown'):
                with self.assertRaises(TimeoutError):
                    bridge.execute(
                        IDENTITY, bridge.publish, lambda _: COMMIT,
                        lambda *_: {'commit': COMMIT, 'manifest_sha256': IDENTITY},
                        fail_install, lambda: None)
            self.assertEqual(json.loads(status.read_text())['status'],
                             'MANUAL_RECOVERY_REQUIRED')
            self.assertEqual(json.loads(pending.read_text())['phase'], 'SMOKE')
            self.assert_refuses_restart(status)

    def test_unprovisioned_worker_cli_refuses_before_host_writes(self):
        result = subprocess.run([sys.executable, '-I', '-S', str(SCRIPT)],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.strip(),
                         'STOP: host installer bridge refused; operator review required')


if __name__ == '__main__':
    unittest.main()
