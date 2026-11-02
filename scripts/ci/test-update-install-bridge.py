"""Synthetic bridge state tests. No host, network, Docker or install process."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'update_install_bridge', ROOT / 'deploy/linux/update-install-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
IDENTITY = 'a' * 64
COMMIT = 'b' * 40


class BridgeState(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.manifest = {'manifest_sha256': IDENTITY, 'commit': COMMIT}

    def write(self, identity, status, phase):
        self.events.append((status, phase))

    def request(self, identity):
        self.events.append(('REQUEST', identity))
        return (1, 2, 3)

    def cleanup(self, token):
        self.events.append(('CLEANUP', token))

    def verify(self, identity):
        self.events.append(('VERIFY', identity))
        return COMMIT

    def fetch(self, identity, commit):
        self.events.append(('FETCH', identity))
        return self.manifest

    def install(self, manifest, identity):
        self.events.append(('INSTALL', identity))

    def pending(self):
        self.events.append(('PENDING', None))

    def exercise(self, **overrides):
        calls = dict(write_status=self.write, make_request=self.request,
                     cleanup_request=self.cleanup,
                     verify=self.verify, fetch=self.fetch,
                     run_install=self.install, check_pending=self.pending)
        calls.update(overrides)
        bridge.execute(IDENTITY, **calls)

    def test_durable_order_before_install(self):
        self.exercise()
        self.assertEqual(self.events, [
            ('RUNNING', 'VERIFY_TRUST'), ('PENDING', None),
            ('REQUEST', IDENTITY), ('VERIFY', IDENTITY),
            ('CLEANUP', (1, 2, 3)),
            ('RUNNING', 'FETCH_MANIFEST'), ('FETCH', IDENTITY),
            ('PENDING', None), ('RUNNING', 'INSTALLER'),
            ('INSTALL', IDENTITY), ('INSTALLED', 'COMPLETE')])

    def test_verifier_refusal_stops_without_install(self):
        def refuse(_):
            raise bridge.Stop('verification failed')
        with self.assertRaises(bridge.Stop):
            self.exercise(verify=refuse)
        self.assertEqual(self.events[-1], ('STOP', 'VERIFY_TRUST'))
        self.assertIn(('CLEANUP', (1, 2, 3)), self.events)
        self.assertNotIn(('INSTALL', IDENTITY), self.events)

    def test_manifest_drift_stops_without_install(self):
        self.manifest['commit'] = 'c' * 40
        with self.assertRaises(bridge.Stop):
            self.exercise()
        self.assertEqual(self.events[-1], ('STOP', 'VERIFY_TRUST'))
        self.assertNotIn(('INSTALL', IDENTITY), self.events)

    def test_network_error_stops_without_install(self):
        def unavailable(*_):
            raise ConnectionError('network unavailable')
        with self.assertRaises(ConnectionError):
            self.exercise(fetch=unavailable)
        self.assertEqual(self.events[-1], ('STOP', 'VERIFY_TRUST'))
        self.assertNotIn(('INSTALL', IDENTITY), self.events)

    def test_existing_request_stops_without_install(self):
        def duplicate(_):
            raise FileExistsError('request already exists')
        with self.assertRaises(FileExistsError):
            self.exercise(make_request=duplicate)
        self.assertEqual(self.events[-1], ('STOP', 'VERIFY_TRUST'))
        self.assertNotIn(('INSTALL', IDENTITY), self.events)

    def test_installer_ambiguity_requires_manual_recovery(self):
        def refuse(*_):
            raise TimeoutError('uncertain installer result')
        with self.assertRaises(TimeoutError):
            self.exercise(run_install=refuse)
        self.assertEqual(self.events[-1],
                         ('MANUAL_RECOVERY_REQUIRED', 'INSTALLER'))

    def test_pending_journal_blocks_before_install(self):
        count = 0
        def pending():
            nonlocal count
            count += 1
            if count == 2:
                raise bridge.Stop('pending')
        with self.assertRaises(bridge.Stop):
            self.exercise(check_pending=pending)
        self.assertEqual(self.events[-1], ('STOP', 'VERIFY_TRUST'))
        self.assertNotIn(('INSTALL', IDENTITY), self.events)

    def test_exact_verifier_result_required(self):
        valid = dict(status='HOST_VERIFIED_READ_ONLY', manifestSha256=IDENTITY,
                     commit=COMMIT, installation_enabled=False,
                     provenance_signature='UNSIGNED')
        self.assertEqual(bridge.verified_result(IDENTITY, json.dumps(valid)), COMMIT)
        for change in (dict(manifestSha256='c' * 64),
                       dict(installation_enabled=True),
                       dict(status='PASS'), dict(provenance_signature='SIGNED')):
            with self.subTest(change=change), self.assertRaises(bridge.Stop):
                bridge.verified_result(IDENTITY, json.dumps(valid | change))
        with self.assertRaises(bridge.Stop):
            bridge.verified_result(IDENTITY, '{}')

    def test_activation_remains_disabled(self):
        self.assertIs(bridge.PROVISIONED, False)


class RealBoundaryFunctions(unittest.TestCase):
    def test_execute_leaves_no_stale_request(self):
        with tempfile.TemporaryDirectory() as temp:
            inbox = Path(temp)
            request = inbox / 'request.json'
            states = []
            with patch.object(bridge, 'INBOX', inbox), patch.object(bridge, 'REQUEST', request), \
                    patch.object(bridge, 'directory'), patch.object(bridge.os, 'fchown'):
                bridge.execute(
                    IDENTITY, lambda _, state, phase: states.append((state, phase)),
                    bridge.create_verifier_request, bridge.cleanup_verifier_request,
                    lambda _: COMMIT,
                    lambda *_: {'manifest_sha256': IDENTITY, 'commit': COMMIT},
                    lambda *_: None, lambda: None)
            self.assertFalse(request.exists())
            self.assertEqual(states[-1], ('INSTALLED', 'COMPLETE'))

    def test_request_removed_after_success(self):
        with tempfile.TemporaryDirectory() as temp:
            inbox = Path(temp)
            request = inbox / 'request.json'
            with patch.object(bridge, 'INBOX', inbox), patch.object(bridge, 'REQUEST', request), \
                    patch.object(bridge, 'directory'), patch.object(bridge.os, 'fchown'):
                token = bridge.create_verifier_request(IDENTITY)
                self.assertEqual(json.loads(request.read_text())['manifestSha256'], IDENTITY)
                bridge.cleanup_verifier_request(token)
                self.assertFalse(request.exists())

    def test_replaced_request_is_retained_for_operator(self):
        with tempfile.TemporaryDirectory() as temp:
            inbox = Path(temp)
            request = inbox / 'request.json'
            with patch.object(bridge, 'INBOX', inbox), patch.object(bridge, 'REQUEST', request), \
                    patch.object(bridge, 'directory'), patch.object(bridge.os, 'fchown'):
                token = bridge.create_verifier_request(IDENTITY)
                request.unlink()
                request.write_text('replacement')
                with self.assertRaises(bridge.Stop):
                    bridge.cleanup_verifier_request(token)
                self.assertEqual(request.read_text(), 'replacement')
                self.assertEqual(inbox.stat().st_mode & 0o777, 0o770)

    def test_durable_status_replaces_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            status_dir = Path(temp)
            status = status_dir / 'current.json'
            status.write_text('{}')
            with patch.object(bridge, 'STATUS_DIR', status_dir), patch.object(bridge, 'STATUS', status), \
                    patch.object(bridge.os, 'fchown'):
                bridge.publish(IDENTITY, 'RUNNING', 'VERIFY_TRUST')
            value = json.loads(status.read_text())
            self.assertEqual((value['status'], value['phase'], value['manifestSha256']),
                             ('RUNNING', 'VERIFY_TRUST', IDENTITY))
            self.assertEqual(status.stat().st_mode & 0o777, 0o640)

    def test_receipt_requires_validation_required(self):
        with tempfile.TemporaryDirectory() as temp:
            status_dir = Path(temp)
            status = status_dir / 'current.json'
            value = dict(format=bridge.FORMAT, status='VALIDATION_REQUIRED',
                         manifestSha256=IDENTITY, phase=None,
                         updatedAt='2026-11-03T00:00:00Z')
            status.write_text(json.dumps(value))
            status.chmod(0o640)
            actual_fstat = os.fstat
            def root_stat(fd):
                info = actual_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0,
                                       st_gid=bridge.GID, st_nlink=info.st_nlink,
                                       st_size=info.st_size)
            with patch.object(bridge, 'STATUS_DIR', status_dir), patch.object(bridge, 'STATUS', status), \
                    patch.object(bridge, 'directory'), patch.object(bridge.os, 'fstat', root_stat):
                self.assertEqual(bridge.read_receipt(), IDENTITY)
                value['status'] = 'RUNNING'
                status.write_text(json.dumps(value))
                with self.assertRaises(bridge.Stop):
                    bridge.read_receipt()

    def test_lock_rejects_concurrent_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            status_dir = Path(temp)
            actual_fstat = os.fstat
            def root_stat(fd):
                info = actual_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0,
                                       st_nlink=info.st_nlink)
            with patch.object(bridge, 'STATUS_DIR', status_dir), \
                    patch.object(bridge.os, 'fstat', root_stat):
                first = bridge.acquire_lock()
                try:
                    with self.assertRaises(BlockingIOError):
                        bridge.acquire_lock()
                finally:
                    os.close(first)

    def test_verifier_and_installer_refusals(self):
        boundary = SimpleNamespace(trusted_path=lambda *_: None,
                                   validate_checkout=lambda *_: None,
                                   clean_environment=lambda: {})
        valid = dict(status='HOST_VERIFIED_READ_ONLY', manifestSha256=IDENTITY,
                     commit=COMMIT, installation_enabled=False,
                     provenance_signature='UNSIGNED')
        with patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(valid))):
            self.assertEqual(bridge.verify_host(IDENTITY, boundary), COMMIT)
        with patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout='')):
            with self.assertRaises(bridge.Stop):
                bridge.verify_host(IDENTITY, boundary)
            with self.assertRaises(bridge.Stop):
                bridge.install({'commit': COMMIT}, IDENTITY, boundary)


if __name__ == '__main__':
    unittest.main()
