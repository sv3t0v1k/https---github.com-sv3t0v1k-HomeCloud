#!/usr/bin/env python3
"""Isolated SSH handoff contract tests; do not run systemd, SSH or Docker."""
import copy
import importlib.util
import io
import os
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


job = load('test_channel_ssh_job_tests', ROOT / 'deploy/linux/test-job.py')
contract = job.contract
installer = job.installer
SHA = 'a' * 40
REPO = 'owner/homecloud'


def proof(role):
    return {'index_digest': 'sha256:' + ('1' if role == 'backend' else '2') * 64,
            'platform_digest': 'sha256:' + ('3' if role == 'backend' else '4') * 64,
            'statement_digest': 'sha256:' + ('5' if role == 'backend' else '6') * 64,
            'commit': SHA, 'repository': 'ghcr.io/' + REPO + '/' + role,
            'version': 'test-' + SHA, 'platform': 'linux/amd64',
            'verified': 'DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS',
            'signature': 'UNSIGNED'}


class TestSSHJob(unittest.TestCase):
    def setUp(self):
        roles = ('backend', 'frontend')
        self.manifest = contract.build(SHA, REPO, '123', '1',
                {role: proof(role)['index_digest'] for role in roles},
                {role: proof(role) for role in roles})

    @staticmethod
    def fixture_private_file(path):
        # Test files are owned by the current user. Production still requires root:0600.
        if path.is_symlink() or not path.is_file() or \
                path.stat().st_uid != os.geteuid() or \
                stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise installer.Stop('missing private file')
        return path

    def context(self, directory):
        stack = ExitStack()
        folder = Path(directory)
        stack.enter_context(patch.object(job, 'CHANNEL', folder))
        stack.enter_context(patch.object(job, 'JOB', folder / 'ssh-job.json'))
        stack.enter_context(patch.object(job, 'MANIFEST', folder / 'ssh-manifest.json'))
        stack.enter_context(patch.object(job, 'preflight'))
        stack.enter_context(patch.object(installer, 'CHANNEL', folder))
        stack.enter_context(patch.object(installer, 'guard_no_pending'))
        stack.enter_context(patch.object(installer, 'private_file', side_effect=self.fixture_private_file))
        return stack

    def input(self, manifest):
        return patch.object(job.sys, 'stdin', io.TextIOWrapper(
            io.BytesIO(json.dumps(manifest).encode('utf-8')), encoding='utf-8'))

    def test_submit_stages_private_manifest_and_detached_service(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp), self.input(self.manifest):
            with patch.object(job.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='active\n')) as launch:
                job.submit()
            self.assertEqual(json.loads(job.MANIFEST.read_text()), self.manifest)
            self.assertEqual(stat.S_IMODE(job.MANIFEST.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(job.JOB.stat().st_mode), 0o600)
            self.assertEqual(job.read_job()['status'], 'QUEUED')
            args = launch.call_args.args[0]
            self.assertEqual(args[0], '/usr/bin/systemd-run')
            self.assertIn('--no-block', args)
            self.assertIn('--collect', args)
            self.assertIn('--property=Restart=no', args)
            self.assertNotIn('--pipe', args)
            self.assertNotIn('--pty', args)
            self.assertEqual(args[-3:], [str(job.ROOT / 'deploy/linux/test-job.py'),
                                         'worker', self.manifest['manifest_sha256']])
            self.assertNotIn(json.dumps(self.manifest), repr(args))
            self.assertIsNone(launch.call_args.kwargs.get('stdin'))

    def test_duplicate_submission_is_idempotent_and_not_queued_again(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp):
            with patch.object(job.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='active\n')) as launch:
                with self.input(self.manifest):
                    job.submit()
                with self.input(self.manifest):
                    job.submit()
                self.assertEqual(launch.call_count, 2)  # one systemd + one status probe
                self.assertEqual(launch.call_args.args[0][0], '/usr/bin/systemctl')

    def test_other_manifest_is_blocked_during_existing_job(self):
        second = copy.deepcopy(self.manifest)
        second['ci']['attempt'] = '2'
        second['manifest_sha256'] = contract.identity(second)
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp), \
             patch.object(job.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            with self.input(self.manifest):
                job.submit()
            with self.input(second):
                with self.assertRaisesRegex(installer.Stop, 'existing SSH job'):
                    job.submit()
            self.assertEqual(job.read_job()['id'], self.manifest['manifest_sha256'])

    def test_failed_handoff_requires_manual_review(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp), self.input(self.manifest), \
             patch.object(job.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(installer.Stop, 'handoff uncertain'):
                job.submit()
            self.assertEqual(job.read_job()['status'], 'STOP')

    def test_worker_commits_only_verified_state(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp):
            installer.atomic_json(job.MANIFEST, self.manifest)
            job.write_job(self.manifest['manifest_sha256'], 'QUEUED')
            installed = {role: {'ref': installer.image_ref(self.manifest, role),
                                'sha': self.manifest['commit']} for role in ('backend', 'frontend')}
            with patch.object(installer, 'deploy') as deploy, \
                 patch.object(installer, 'load_state', return_value={'active': {'images': installed}}):
                job.worker(self.manifest['manifest_sha256'])
            deploy.assert_called_once()
            self.assertEqual(job.read_job()['status'], 'INSTALLED')

    def test_worker_failure_is_stop_without_automatic_retry(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp):
            installer.atomic_json(job.MANIFEST, self.manifest)
            job.write_job(self.manifest['manifest_sha256'], 'QUEUED')
            with patch.object(installer, 'deploy', side_effect=installer.Stop('mock failure')):
                with self.assertRaisesRegex(installer.Stop, 'mock failure'):
                    job.worker(self.manifest['manifest_sha256'])
            self.assertEqual(job.read_job()['status'], 'STOP')
            with self.assertRaisesRegex(installer.Stop, 'not queued'):
                job.worker(self.manifest['manifest_sha256'])

    def test_lost_worker_never_reports_success(self):
        receipt = {'format': job.JOB_FORMAT, 'id': self.manifest['manifest_sha256'],
                   'status': 'RUNNING', 'updated_at': '2026-10-31T00:00:00Z'}
        with patch.object(job.subprocess, 'run', return_value=SimpleNamespace(
                returncode=3, stdout='inactive\n')):
            self.assertEqual(job.display_status(receipt)['status'], 'UNKNOWN_REQUIRES_REVIEW')
        with patch.object(job.subprocess, 'run', side_effect=OSError('systemd unavailable')):
            self.assertEqual(job.display_status(receipt)['status'], 'UNKNOWN_REQUIRES_REVIEW')
        with patch.object(job.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout='active\n')):
            self.assertEqual(job.display_status(receipt)['status'], 'RUNNING')

    def test_reject_symlink_job_and_oversized_input(self):
        with tempfile.TemporaryDirectory() as tmp, self.context(tmp):
            target = Path(tmp) / 'elsewhere.json'
            target.write_text('{}')
            job.JOB.symlink_to(target)
            with self.assertRaisesRegex(installer.Stop, 'missing private file'):
                job.read_job()
            job.JOB.unlink()
            with patch.object(job.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b' ' * (job.MAX_INPUT + 1)))):
                with self.assertRaisesRegex(installer.Stop, 'too large'):
                    job.submit()
            self.assertFalse(job.JOB.exists())

    def test_contract_includes_job_runner(self):
        self.assertIn('deploy/linux/test-job.py', installer.LOCKED_FILES)
        self.assertIn('deploy/linux/test-job.py', contract.FILES)


if __name__ == '__main__':
    unittest.main()
