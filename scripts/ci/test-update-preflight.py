#!/usr/bin/env python3
"""Exact TEST update mounts without touching a real Docker host."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('update_preflight_test', ROOT / 'deploy/linux/preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
selector_spec = importlib.util.spec_from_file_location('test_compose_profile', ROOT / 'deploy/linux/test-compose-profile.py')
selector = importlib.util.module_from_spec(selector_spec)
selector_spec.loader.exec_module(selector)


def mount(target, source, read_only=False):
    return {'type': 'bind', 'target': target, 'source': source,
            'read_only': read_only, 'bind': {'create_host_path': False}}


def service_mounts(role, data):
    marker = str(Path(data).parent / ('.homecloud-' + role))
    return [mount('/storage' if role == 'backend' else '/var/lib/postgresql/data', data),
            mount('/run/homecloud/startup-gate.sh', str(ROOT / 'deploy/linux/startup-gate.sh'), True),
            mount('/run/homecloud/startup.gate', '/etc/homecloud-test/startup-' + role + '.gate', True),
            mount('/run/homecloud/host-mountinfo', '/proc/1/mountinfo', True),
            mount('/run/homecloud/dev', '/dev', True),
            mount('/run/homecloud/volume-marker', marker, True)] + (
                [mount('/run/homecloud/maintenance',
                       '/etc/homecloud-test/maintenance', True)]
                if role == 'backend' else [])


def config(test=True):
    backend = {'restart': 'unless-stopped', 'user': '1001:65533',
               'environment': {'UPLOAD_SSD_ENABLED': 'false', 'UPLOAD_SSD_RECOVERY_MODE': 'manual',
                               'STORAGE_PATH': '/storage', 'NODE_ENV': 'production'},
               'entrypoint': ['sh', '/run/homecloud/startup-gate.sh', 'backend'],
               'command': ['node', 'dist/main.js'], 'mem_limit': 1024**3,
               'image': 'ghcr.io/example/backend@sha256:' + 'a' * 64,
               'volumes': service_mounts('backend', '/test/hdd/storage')}
    if test:
        backend['environment'].update(UPDATE_CHANNEL='test', UPDATE_INSTALL_BRIDGE_ENABLED='true',
            UPDATE_REQUEST_INBOX='/run/homecloud-update/inbox',
            UPDATE_STATUS_FILE='/run/homecloud-update/status/current.json',
            UPDATE_INSTALLED_METADATA_PATH='/run/homecloud-update/status/installed.json',
            UPDATE_TEST_CANDIDATE_PATH='/run/homecloud-update/status/available.json',
            UPDATE_GITHUB_TOKEN='', UPDATE_GITHUB_USER='')
        backend['volumes'] += [mount('/run/homecloud-update/inbox', '/var/lib/homecloud-update/inbox'),
                               mount('/run/homecloud-update/status', '/var/lib/homecloud-update/status', True)]
    db = {'restart': 'unless-stopped', 'entrypoint': ['sh', '/run/homecloud/startup-gate.sh', 'db'],
          'command': ['postgres'], 'mem_limit': 512 * 1024**2,
          'volumes': service_mounts('db', '/test/ssd/postgres')}
    return {'name': 'homecloud-test', 'services': {'backend': backend, 'db': db,
            'frontend': {'restart': 'unless-stopped', 'image': 'ghcr.io/example/frontend@sha256:' + 'b' * 64,
                         'mem_limit': 128 * 1024**2},
            'ingress': {'restart': 'unless-stopped', 'mem_limit': 128 * 1024**2}}}


class UpdateMountContract(unittest.TestCase):
    def setUp(self):
        self.inventory = {'hdd': {'data': '/test/hdd/storage'},
                          'ssd': {'data': '/test/ssd/postgres'}}

    def check(self, candidate):
        def directory(source):
            return Path(source)
        def stat(path, *args, **kwargs):
            if str(path).endswith('/maintenance'):
                return SimpleNamespace(st_uid=0, st_gid=0, st_mode=0o711)
            mode = 0o770 if str(path).endswith('/inbox') else 0o750
            return SimpleNamespace(st_uid=0, st_gid=65533, st_mode=mode)
        def lstat(path, *args, **kwargs):
            return SimpleNamespace(st_uid=0, st_gid=0, st_mode=0o40755)
        with patch.object(preflight, 'check_inventory_layout', return_value='/etc/homecloud-test'), \
             patch.object(preflight, 'ordinary_directory', side_effect=directory), \
             patch.object(Path, 'stat', stat), patch.object(Path, 'lstat', lstat), \
             patch.object(preflight.os, 'listxattr', return_value=[], create=True):
            preflight.check_config(candidate, self.inventory)

    def test_exact_nine_mount_test_and_existing_seven_mount_profile(self):
        self.check(config())
        self.check(config(test=False))
        disabled = config(test=False)
        disabled['services']['backend']['environment'].update(
            UPDATE_CHANNEL='test', UPDATE_INSTALL_BRIDGE_ENABLED='false')
        self.check(disabled)

    def test_refuses_extra_or_retargeted_mount(self):
        for change in ('extra', 'retarget', 'writable_status'):
            with self.subTest(change=change):
                candidate = copy.deepcopy(config())
                volumes = candidate['services']['backend']['volumes']
                if change == 'extra': volumes.append(mount('/tmp/extra', '/tmp/extra'))
                if change == 'retarget': volumes[-1]['source'] = '/tmp/status'
                if change == 'writable_status': volumes[-1]['read_only'] = False
                with self.assertRaises(preflight.Refusal):
                    self.check(candidate)

    def test_maintenance_mount_cannot_be_removed_or_modified(self):
        for change in ('removed', 'retarget', 'writable'):
            with self.subTest(change=change):
                candidate = copy.deepcopy(config())
                volumes = candidate['services']['backend']['volumes']
                index = next(
                    i for i, m in enumerate(volumes)
                    if m['target'] == '/run/homecloud/maintenance'
                )
                if change == 'removed':
                    volumes.pop(index)
                elif change == 'retarget':
                    volumes[index]['source'] = '/tmp/untrusted-maintenance'
                else:
                    volumes[index]['read_only'] = False
                with self.assertRaises(preflight.Refusal):
                    self.check(candidate)

    def test_overlay_selection_needs_exact_root_authorization(self):
        def content(runtime, marker=b'homecloud-test-install-v1\n'):
            return lambda path: runtime if path == selector.RUNTIME else marker
        with patch.object(selector, 'private_bytes', side_effect=content(b'UPDATE_INSTALL_BRIDGE_ENABLED=false\n')):
            self.assertFalse(selector.enabled())
        with patch.object(selector, 'private_bytes', side_effect=content(b'UPDATE_INSTALL_BRIDGE_ENABLED=true\n')):
            self.assertTrue(selector.enabled())
            self.assertEqual(len(selector.files()), 4)
        for runtime, marker in ((b'UPDATE_INSTALL_BRIDGE_ENABLED=true\n', b'wrong'),
                                (b'UPDATE_INSTALL_BRIDGE_ENABLED=true\nUPDATE_INSTALL_BRIDGE_ENABLED=true\n',
                                 b'homecloud-test-install-v1\n')):
            with self.subTest(runtime=runtime, marker=marker), \
                 patch.object(selector, 'private_bytes', side_effect=content(runtime, marker)):
                with self.assertRaises(ValueError):
                    selector.enabled()

    @unittest.skipUnless(shutil.which('docker'), 'Compose проверяется в configuration job')
    def test_actual_compose_merge_keeps_default_closed(self):
        fixture = {
            'COMPOSE_PROJECT_NAME': 'homecloud-test-ci', 'DB_PASSWORD': 'fixture',
            'JWT_SECRET': 'fixture', 'JWT_REFRESH_SECRET': 'fixture',
            'REDIS_PASSWORD': 'fixture', 'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture',
            'SSD_DB_DIR': '/tmp/homecloud-ci-ssd', 'HDD_STORAGE_DIR': '/tmp/homecloud-ci-hdd',
            'PUBLIC_ORIGIN': 'https://example.test', 'FRONTEND_PROXY_IP': '172.30.1.2',
            'INGRESS_PROXY_IP': '172.30.2.2', 'PUBLIC_HOST': 'example.test',
            'PUBLIC_HTTP_PORT': '18080', 'PUBLIC_HTTPS_PORT': '18443',
            'TLS_CERT_DIR': '/tmp/homecloud-ci-tls', 'ACME_WEBROOT_DIR': '/tmp/homecloud-ci-acme',
            'BACKEND_PROXY_SUBNET': '172.30.1.0/24', 'INGRESS_SUBNET': '172.30.2.0/24',
            'PUBLIC_BIND_IP': '127.0.0.1',
            'RELEASE_BACKEND_IMAGE': 'ghcr.io/example/backend@sha256:' + 'a' * 64,
            'RELEASE_FRONTEND_IMAGE': 'ghcr.io/example/frontend@sha256:' + 'b' * 64,
        }
        with tempfile.TemporaryDirectory() as temp:
            env_file = Path(temp) / 'runtime.env'
            env_file.write_text(''.join(k + '=' + v + '\n' for k, v in fixture.items()))
            for enabled, expected_mounts in ((False, 7), (True, 9)):
                files = selector.BASE + ((selector.OVERLAY,) if enabled else ())
                command = ['docker', 'compose', '--env-file', str(env_file)]
                for name in files:
                    command += ['-f', str(ROOT / name)]
                output = subprocess.run(command + ['config', '--format', 'json'],
                                        capture_output=True, text=True, timeout=30, check=True)
                backend = json.loads(output.stdout)['services']['backend']
                self.assertEqual(len(backend['volumes']), expected_mounts)
                self.assertEqual(backend['environment']['UPDATE_INSTALL_BRIDGE_ENABLED'],
                                 'true' if enabled else 'false')
                targets = {item['target'] for item in backend['volumes']}
                self.assertEqual({'/run/homecloud-update/inbox', '/run/homecloud-update/status'} <= targets,
                                 enabled)


if __name__ == '__main__':
    unittest.main()
