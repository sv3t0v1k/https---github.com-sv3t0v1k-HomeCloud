#!/usr/bin/env python3
"""TEST pair, refusal, race and rollback contract checks without Docker/server."""
import copy
import hashlib
import gzip
import io
import tarfile
import zlib
import json
import subprocess
import importlib.util
from pathlib import Path
import os
import multiprocessing
import signal
from contextlib import ExitStack
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = load('test_channel_contract_test', ROOT / 'scripts/ci/test-channel.py')
installer = load('test_channel_installer_test', ROOT / 'deploy/linux/test-channel.py')
SHA = 'a' * 40
REPO = 'owner/homecloud'


def proof(role):
    return dict(index_digest='sha256:' + ('1' if role == 'backend' else '2') * 64,
                platform_digest='sha256:' + ('3' if role == 'backend' else '4') * 64,
                statement_digest='sha256:' + ('5' if role == 'backend' else '6') * 64,
                commit=SHA, repository='ghcr.io/' + REPO + '/' + role,
                version='test-' + SHA, platform='linux/amd64',
                verified='DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS', signature='UNSIGNED')


def suspended_install_process(channel, ready_pipe, state, applied, manifest):
    """Signal-safe fixture: stop phase is reached, then await termination."""
    previous = 'd' * 40
    # The root-only deploy precondition is mocked below. The lock itself must
    # still be created and validated against the child's real effective UID.
    actual_euid = os.geteuid()
    real_acquire_lock = installer.acquire_lock

    def acquire_test_lock(path):
        with patch.object(installer.os, 'geteuid', return_value=actual_euid):
            return real_acquire_lock(path)

    def fake_compose(*args, **kwargs):
        if args and args[0] == 'stop':
            ready_pipe.send('STOP_SERVICES')
            signal.pause()
        return ''

    with ExitStack() as patches:
        patches.enter_context(patch.object(installer, 'ROOT', Path('/home/hs/homecloud-test')))
        patches.enter_context(patch.object(installer, 'CHANNEL', Path(channel)))
        patches.enter_context(patch.object(installer, 'private_dir'))
        patches.enter_context(patch.object(installer, 'guard_no_maintenance'))
        patches.enter_context(patch.object(
            installer, 'begin_backup_maintenance',
            return_value=[1, 2],
        ))
        patches.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
        patches.enter_context(patch.object(installer, 'acquire_lock', side_effect=acquire_test_lock))
        patches.enter_context(patch.object(installer, 'load_state', return_value=state))
        patches.enter_context(patch.object(installer, 'require_checkpoint_refs'))
        patches.enter_context(patch.object(installer, 'run', return_value=''))
        patches.enter_context(patch.object(installer, 'active_images', return_value=state['active']['images']))
        patches.enter_context(patch.object(installer, 'applied_migrations', return_value=applied))
        patches.enter_context(patch.object(installer, 'precheck_source', return_value=previous))
        patches.enter_context(patch.object(installer, 'safe_checkout', return_value=previous))
        patches.enter_context(patch.object(installer, 'verify_pulled', return_value={
            'backend': 'sha256:' + 'e' * 64, 'frontend': 'sha256:' + 'f' * 64}))
        patches.enter_context(patch.object(installer, 'compose', side_effect=fake_compose))
        patches.enter_context(patch.object(installer, 'backup', return_value='20261031_120000_aabbccdd'))
        patches.enter_context(patch.object(installer, 'ensure_recovery_pins'))
        patches.enter_context(patch.object(installer, 'sync_recovery_pins'))
        installer.deploy(manifest)


class TestChannelTests(unittest.TestCase):
    def setUp(self):
        admission = patch.object(installer, 'guard_no_maintenance')
        admission.start()
        self.addCleanup(admission.stop)

        self.proofs = {role: proof(role) for role in ('backend', 'frontend')}
        self.digests = {role: self.proofs[role]['index_digest'] for role in self.proofs}
        self.manifest = contract.build(SHA, REPO, '123', '1', self.digests, self.proofs)
        self.state = dict(format='homecloud-test-install-v1',
                          active=dict(images={role: dict(ref='old-' + role, id='sha256:' + role[0] * 64,
                                                        sha='b' * 40 if role == 'backend' else 'c' * 40)
                                              for role in ('backend', 'frontend')},
                                      schema_migrations=copy.deepcopy(self.manifest['schema_migrations']), manifest=None),
                          history=[])
        self.applied = sorted(item['name'] for item in self.manifest['schema_migrations'])


    def test_ci_only_scripts_match_verifier_and_installer(self):
        host = load(
            'd52_host_verify',
            ROOT / 'deploy/linux/update-host-verify.py'
        )
        self.assertEqual(
            installer.CI_ONLY_SCRIPT_CHANGES,
            host.CI_ONLY_SCRIPT_CHANGES
        )

        for path, permitted in (
            ('scripts/ci/stage-cache-proof.py', True),
            ('scripts/ci/test-test-channel.py', True),
            ('scripts/ci/provenance.py', False),
            ('scripts/ci/test-channel.py', False),
            ('scripts/backup.sh', False),
        ):
            def fake_run(*args, **kwargs):
                if args[:3] == ('git', 'status', '--porcelain'):
                    return ''
                if args[:3] == ('git', 'rev-parse', 'HEAD'):
                    return 'b' * 40
                if args[:3] == ('git', 'remote', 'get-url'):
                    return 'https://github.com/' + REPO
                if args[:3] == ('git', 'rev-parse', 'FETCH_HEAD'):
                    return SHA
                if args[:2] == ('git', 'rev-parse') and (
                    args[2].endswith(':deploy')
                ):
                    return 'same-tree'
                if args[:2] == ('git', 'diff-tree'):
                    return path + chr(0)
                if args[:2] == ('git', 'ls-tree'):
                    return (
                        '100644 blob ' + 'f' * 40
                        + chr(9) + args[-1]
                    )
                if args[:2] == ('git', 'fetch'):
                    return ''
                raise AssertionError('Unexpected Git command: ' + str(args))

            with self.subTest(path=path):
                with patch.object(installer, 'run', side_effect=fake_run), patch.object(installer, 'verify_ci_only_blob'):
                    with patch.object(installer,
                                      'require_current_test_head'):
                        with patch.object(installer,
                                          'LOCKED_FILES', ()):
                            if permitted:
                                self.assertEqual(
                                    installer.precheck_source(
                                        self.manifest, False
                                    ),
                                    'b' * 40
                                )
                            else:
                                with self.assertRaisesRegex(
                                    installer.Stop,
                                    'root helper tree changed'
                                ):
                                    installer.precheck_source(
                                        self.manifest, False
                                    )

    def test_exact_pair_and_manifest_checksum(self):
        self.assertEqual(contract.shape(self.manifest)['commit'], SHA)
        for mutation in (lambda x: x['images']['frontend'].update(digest='sha256:' + '9' * 64),
                         lambda x: x.update(commit='b' * 40),
                         lambda x: x['ci'].update(attempt='2')):
            candidate = copy.deepcopy(self.manifest)
            mutation(candidate)
            with self.assertRaises(ValueError): contract.shape(candidate)

    def test_mixed_provenance_rejected(self):
        self.proofs['frontend']['commit'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'provenance'):
            contract.build(SHA, REPO, '123', '1', self.digests, self.proofs)

    def test_install_plan_preserves_mixed_installed_shas(self):
        actual = self.state['active']['images']
        result = installer.plan(self.manifest, self.state, self.applied, actual)
        self.assertEqual(result['decision'], 'INSTALL')
        self.assertEqual(self.state['active']['images']['frontend']['sha'], 'c' * 40)

    def test_changed_image_or_migration_blocks(self):
        actual = copy.deepcopy(self.state['active']['images'])
        actual['backend']['id'] = 'sha256:' + '9' * 64
        with self.assertRaisesRegex(installer.Stop, 'running images'):
            installer.plan(self.manifest, self.state, self.applied, actual)
        with self.assertRaisesRegex(installer.Stop, 'migration'):
            installer.plan(self.manifest, self.state, self.applied[:-1], self.state['active']['images'])
        self.state['active']['schema_migrations'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(installer.Stop, 'migration'):
            installer.plan(self.manifest, self.state, self.applied, self.state['active']['images'])

    def test_same_sha_skips_and_rollback_is_explicit(self):
        for role in ('backend', 'frontend'):
            self.state['active']['images'][role]['sha'] = SHA
            self.state['active']['images'][role]['ref'] = installer.image_ref(self.manifest, role)
        self.assertEqual(installer.plan(self.manifest, self.state, self.applied,
                                       self.state['active']['images'])['decision'], 'ALREADY_INSTALLED')
        self.state['active']['images']['backend']['sha'] = 'b' * 40
        with self.assertRaisesRegex(installer.Stop, 'rollback source'):
            installer.plan(self.manifest, self.state, self.applied, self.state['active']['images'], rollback=True)
        self.state['active']['manifest'] = copy.deepcopy(self.manifest)
        with self.assertRaisesRegex(installer.Stop, 'absent from journal'):
            installer.plan(self.manifest, self.state, self.applied, self.state['active']['images'], rollback=True)

    def test_same_commit_different_digest_is_not_installed(self):
        for role in ('backend', 'frontend'):
            self.state['active']['images'][role]['sha'] = SHA
        # An image rebuilt from the same commit is not the same immutable artifact.
        self.assertEqual(installer.plan(self.manifest, self.state, self.applied,
                                       self.state['active']['images'])['decision'], 'INSTALL')
        for role in ('backend', 'frontend'):
            self.state['active']['images'][role]['ref'] = installer.image_ref(self.manifest, role)
        self.assertEqual(installer.plan(self.manifest, self.state, self.applied,
                                       self.state['active']['images'])['decision'], 'ALREADY_INSTALLED')

    def test_baseline_preserves_mixed_installed_revisions(self):
        images = copy.deepcopy(self.state['active']['images'])
        proposed = installer.baseline_from_evidence(images,
                    copy.deepcopy(self.manifest['schema_migrations']), self.applied)
        self.assertEqual(proposed['active']['images']['backend']['sha'], 'b' * 40)
        self.assertEqual(proposed['active']['images']['frontend']['sha'], 'c' * 40)
        self.assertIsNone(proposed['active']['manifest'])
        self.assertEqual(proposed['history'], [])

    def test_baseline_rejects_unproven_schema_or_image(self):
        images = copy.deepcopy(self.state['active']['images'])
        schema = copy.deepcopy(self.manifest['schema_migrations'])
        with self.assertRaisesRegex(installer.Stop, 'database migration'):
            installer.baseline_from_evidence(images, schema, [])
        images['backend']['sha'] = 'unknown'
        with self.assertRaisesRegex(installer.Stop, 'image evidence'):
            installer.baseline_from_evidence(images, schema, self.applied)
        images['backend']['sha'] = 'b' * 40
        schema[0]['sha256'] = 'invalid'
        with self.assertRaisesRegex(installer.Stop, 'schema evidence'):
            installer.baseline_from_evidence(images, schema, self.applied)

    def test_installed_migrations_read_from_backend_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            migration = root / 'backend/src/migrations/1000000000000-First.ts'
            migration.parent.mkdir(parents=True)
            initial = b'export class First1000000000000 {}\n'
            migration.write_bytes(initial)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test',
                            '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                                          text=True).strip()
            migration.write_bytes(b'export class Modified1000000000000 {}\n')
            with patch.object(installer, 'ROOT', root):
                actual = installer.committed_schema(sha)
            self.assertEqual(actual, [{'name': 'First1000000000000',
                                       'file': '1000000000000-First.ts',
                                       'sha256': hashlib.sha256(initial).hexdigest()}])

    def test_pending_transaction_blocks_retries_even_after_power_loss(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(installer, 'CHANNEL', Path(tmp)):
                installer.guard_no_pending()
                transaction = {'format': installer.TX_FORMAT, 'before': {}, 'target': {}}
                installer.record_phase(transaction, 'CHECKOUT')
                pending = Path(tmp) / 'pending.json'
                self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                    installer.guard_no_pending()
                installer.record_phase(transaction, 'STOP_SERVICES')
                self.assertEqual(json.loads(pending.read_text())['phase'], 'STOP_SERVICES')
                self.assertEqual(json.loads(pending.read_text())['format'], installer.TX_FORMAT)

    def test_recovery_report_is_read_only_and_does_not_auto_rollback(self):
        old = self.state['active']['images']
        target_refs = {role: installer.image_ref(self.manifest, role)
                       for role in ('backend', 'frontend')}
        transaction = {'format': installer.TX_FORMAT, 'phase': 'WRITE_REFS',
                       'before': {'git_sha': 'b' * 40, 'images': copy.deepcopy(old)},
                       'target': {'commit': SHA, 'refs': target_refs}}
        original = copy.deepcopy(transaction)
        current = {role: old[role]['ref'] for role in ('backend', 'frontend')}
        report = installer.recovery_report(transaction, self.state, 'b' * 40, current)
        self.assertEqual(report['status'], 'MANUAL_RECOVERY_REQUIRED')
        self.assertTrue(report['state_matches_previous'])
        self.assertTrue(report['configured_refs_match_previous'])
        self.assertFalse(report['configured_refs_match_target'])
        self.assertFalse(report['automatic_rollback'])
        self.assertEqual(transaction, original)
        modified = copy.deepcopy(self.state)
        modified['active']['images']['frontend']['sha'] = SHA
        report = installer.recovery_report(transaction, modified, SHA, target_refs)
        self.assertFalse(report['state_matches_previous'])
        self.assertTrue(report['configured_refs_match_target'])
        with self.assertRaisesRegex(installer.Stop, 'invalid TEST transaction'):
            installer.recovery_report({}, self.state, SHA, current)

    def test_failed_deploy_keeps_durable_pending_and_blocks_retry(self):
        # No server, Docker or Git mutation: fail at the first guarded action.
        with tempfile.TemporaryDirectory() as tmp:
            import os
            root = Path('/home/hs/homecloud-test')
            channel = Path(tmp)
            state = copy.deepcopy(self.state)
            previous = 'd' * 40
            def fake_run(*args, **kwargs):
                if args[:3] == ('git', 'rev-parse', 'HEAD'): return previous
                if args[:2] == ('git', 'status'): return ''
                return ''
            with patch.object(installer, 'ROOT', root), \
                 patch.object(installer, 'CHANNEL', channel), \
                 patch.object(installer, 'private_dir'), \
                 patch.object(installer.os, 'geteuid', return_value=0), \
                 patch.object(installer, 'acquire_lock', side_effect=lambda p: os.open(p, os.O_CREAT | os.O_RDWR, 0o600)), \
                 patch.object(installer, 'load_state', return_value=state), \
                 patch.object(installer, 'run', side_effect=fake_run), \
                 patch.object(installer, 'active_images', return_value=state['active']['images']), \
                 patch.object(installer, 'require_checkpoint_refs'), \
                 patch.object(installer, 'precheck_source', return_value=previous), \
                 patch.object(installer, 'applied_migrations', return_value=self.applied), \
                 patch.object(installer, 'safe_checkout', side_effect=RuntimeError('simulated crash')):
                with self.assertRaisesRegex(RuntimeError, 'simulated crash'):
                    installer.deploy(self.manifest)
                pending = json.loads((channel / 'pending.json').read_text())
                self.assertEqual(pending['phase'], 'CHECKOUT')
                self.assertEqual(pending['before']['git_sha'], previous)
                self.assertEqual(json.loads((channel / 'last-status.json').read_text())['status'], 'MANUAL_RECOVERY_REQUIRED')
                with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                    installer.guard_no_pending()
                self.assertFalse((channel / 'state.json').exists())

    def test_recovery_inspection_never_creates_lock_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'install.lock'
            with self.assertRaisesRegex(installer.Stop, 'install lock missing'):
                installer.acquire_readonly_lock(path)
            self.assertFalse(path.exists())
            fd = installer.acquire_lock(path)
            try:
                with self.assertRaisesRegex(installer.Stop, 'currently running'):
                    installer.acquire_readonly_lock(path)
            finally:
                import os
                os.close(fd)
            fd = installer.acquire_readonly_lock(path)
            import os
            os.close(fd)

    def test_nonblocking_install_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'install.lock'
            first = installer.acquire_lock(path)
            try:
                with self.assertRaisesRegex(installer.Stop, 'in progress'):
                    installer.acquire_lock(path)
            finally:
                import os
                os.close(first)
            second = installer.acquire_lock(path)
            import os
            os.close(second)

    def test_crash_matrix_preserves_durable_pending_and_never_retries(self):
        # Fault injection at each externally meaningful transition. Nothing is
        # executed on a real host; all Docker/Git/service operations are mocked.
        import os
        crashes = (
            ('checkout', 'CHECKOUT'),
            ('pull', 'VERIFY_IMAGES'),
            ('prebackup', 'PREBACKUP'),
            ('inhibit', 'STOP_SERVICES'),
            ('stop', 'STOP_SERVICES'),
            ('backup', 'BACKUP'),
            ('finish', 'BACKUP'),
            ('rewrite', 'WRITE_REFS'),
            ('start', 'START_SERVICES'),
            ('verify-started', 'START_SERVICES'),
            ('smoke', 'SMOKE'),
            ('recovery-sync', 'SMOKE'),
            ('state-write', 'COMMIT_STATE'),
        )
        previous = 'd' * 40
        with tempfile.TemporaryDirectory() as parent:
            for stage, expected_phase in crashes:
                with self.subTest(failure_at=stage):
                    channel = Path(parent) / stage
                    channel.mkdir(mode=0o700)
                    state = copy.deepcopy(self.state)
                    operations = []

                    def failure(operation):
                        operations.append(operation)
                        if stage == operation:
                            raise RuntimeError('injected failure: ' + operation)

                    def fake_run(*args, **_kwargs):
                        if args[:3] == ('git', 'rev-parse', 'HEAD'):
                            return previous
                        if args[:2] == ('git', 'status'):
                            return ''
                        return ''

                    def fake_compose(*args, **_kwargs):
                        if args and args[0] == 'stop':
                            failure('stop')
                        if args and args[0] == 'up':
                            failure('start')
                        if args and args[0] == 'start':
                            operations.append('rollback-start')
                        return ''

                    marker_active = [False]

                    def fake_preparation(_state):
                        failure('prebackup')

                    def fake_begin():
                        marker_active[0] = True
                        failure('inhibit')
                        return [1, 2]

                    def fake_guard():
                        if marker_active[0]:
                            raise installer.Stop('maintenance active')

                    def fake_backup(_active, _fd, _marker):
                        self.assertTrue(marker_active[0])
                        self.assertIn('stop', operations)
                        failure('backup')
                        return '20261031_120000_aabbccdd'

                    def fake_finish(_active, backup_id, _fd):
                        self.assertTrue(marker_active[0])
                        checkpoint = json.loads(
                            (channel / 'pending.json').read_text()
                        )
                        self.assertEqual(
                            checkpoint['backup_id'], backup_id
                        )
                        self.assertEqual(
                            checkpoint['backup_maintenance'], [1, 2]
                        )
                        failure('finish')
                        marker_active[0] = False

                    real_atomic = installer.atomic_json

                    def fake_atomic(path, value):
                        if Path(path).name == 'state.json':
                            failure('state-write')
                        return real_atomic(path, value)

                    def fake_checkout(*_args):
                        failure('checkout')
                        return previous

                    def fake_pull(*_args):
                        failure('pull')
                        return {role: 'sha256:' + 'e' * 64 for role in ('backend', 'frontend')}

                    def fake_rewrite(*_args):
                        failure('rewrite')

                    def fake_smoke():
                        failure('smoke')

                    def fake_sync(*_args):
                        failure('recovery-sync')

                    # ExitStack avoids Python 3.9's 20-block compiler limit for
                    # many context managers in one with-statement.
                    with ExitStack() as patches:
                        patches.enter_context(patch.object(installer, 'ROOT', Path('/home/hs/homecloud-test')))
                        patches.enter_context(patch.object(installer, 'CHANNEL', channel))
                        patches.enter_context(patch.object(installer, 'private_dir'))
                        patches.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
                        patches.enter_context(patch.object(
                            installer, 'acquire_lock',
                            side_effect=lambda p: os.open(p, os.O_CREAT | os.O_RDWR, 0o600)))
                        patches.enter_context(patch.object(installer, 'load_state', return_value=state))
                        patches.enter_context(patch.object(installer, 'run', side_effect=fake_run))
                        patches.enter_context(patch.object(
                            installer, 'active_images', return_value=state['active']['images']))
                        patches.enter_context(patch.object(installer, 'applied_migrations', return_value=self.applied))
                        patches.enter_context(patch.object(installer, 'safe_checkout', side_effect=fake_checkout))
                        patches.enter_context(patch.object(installer, 'verify_pulled', side_effect=fake_pull))
                        patches.enter_context(patch.object(installer, 'compose', side_effect=fake_compose))
                        patches.enter_context(patch.object(
                            installer, 'restart_existing_services',
                            side_effect=lambda: operations.append('rollback-start')))
                        patches.enter_context(patch.object(installer, 'backup', side_effect=fake_backup))
                        patches.enter_context(patch.object(
                            installer, 'ensure_recovery_pins',
                            side_effect=fake_preparation))
                        patches.enter_context(patch.object(
                            installer, 'begin_backup_maintenance',
                            side_effect=fake_begin))
                        patches.enter_context(patch.object(
                            installer, 'guard_no_maintenance',
                            side_effect=fake_guard))
                        patches.enter_context(patch.object(
                            installer, 'complete_backup_maintenance',
                            side_effect=fake_finish))
                        patches.enter_context(patch.object(installer, 'sync_recovery_pins', side_effect=fake_sync))
                        patches.enter_context(patch.object(installer, 'rewrite_refs', side_effect=fake_rewrite))
                        patches.enter_context(patch.object(installer, 'smoke', side_effect=fake_smoke))
                        patches.enter_context(patch.multiple(
                            installer,
                            require_checkpoint_refs=lambda state: None,
                            precheck_source=lambda manifest, rollback: previous,
                            verify_started_images=lambda manifest, ids: failure('verify-started')))
                        patches.enter_context(patch.object(installer, 'atomic_json', side_effect=fake_atomic))
                        patches.enter_context(patch.object(installer, 'rewrite_checkpoint_refs'))
                        patches.enter_context(patch.object(installer.boundary, 'validate_checkout'))
                        with self.assertRaisesRegex(RuntimeError, 'injected failure'):
                            installer.deploy(self.manifest)
                        pending_file = channel / 'pending.json'
                        self.assertEqual(json.loads(pending_file.read_text())['phase'], expected_phase)
                        self.assertEqual(pending_file.stat().st_mode & 0o777, 0o600)
                        self.assertFalse((channel / 'state.json').exists())
                        self.assertEqual(json.loads((channel / 'last-status.json').read_text())['status'],
                            'ROLLED_BACK' if expected_phase in ('CHECKOUT', 'VERIFY_IMAGES', 'PREBACKUP', 'WRITE_REFS') else 'MANUAL_RECOVERY_REQUIRED')

                        if stage in ('inhibit', 'stop', 'backup', 'finish'):
                            self.assertTrue(marker_active[0])
                            self.assertNotIn('rollback-start', operations)
                            self.assertNotIn('start', operations)

                        self.assertLessEqual(
                            operations.count('backup'), 1
                        )
                        # The exact same request must refuse before any Git or Docker work.
                        prior_operations = list(operations)
                        with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                            installer.deploy(self.manifest)
                        self.assertEqual(operations, prior_operations)
                        snapshot = json.loads(pending_file.read_text())
                        self.assertEqual(snapshot['before']['git_sha'], previous)
                        self.assertEqual(snapshot['target']['commit'], SHA)
                        if stage == 'finish' or expected_phase in ('WRITE_REFS', 'START_SERVICES', 'SMOKE', 'COMMIT_STATE'):
                            self.assertEqual(snapshot['backup_id'], '20261031_120000_aabbccdd')
                        else:
                            self.assertNotIn('backup_id', snapshot)
                        if stage == 'prebackup':
                            self.assertNotIn('backup', operations)
                            self.assertNotIn('inhibit', operations)
                            self.assertNotIn('stop', operations)
                            self.assertNotIn('rewrite', operations)
                        if stage in ('start', 'verify-started', 'smoke', 'state-write'):
                            self.assertNotEqual(snapshot.get('recovery_status'), 'ROLLED_BACK')

    def test_pretransaction_failure_does_not_create_false_stop_status(self):
        # A failed read-only preflight does not require a manual rollback.
        import os
        with tempfile.TemporaryDirectory() as tmp:
            channel = Path(tmp)
            with patch.object(installer, 'ROOT', Path('/home/hs/homecloud-test')), \
                 patch.object(installer, 'CHANNEL', channel), \
                 patch.object(installer, 'private_dir'), \
                 patch.object(installer.os, 'geteuid', return_value=0), \
                 patch.object(installer, 'acquire_lock',
                              side_effect=lambda p: os.open(p, os.O_CREAT | os.O_RDWR, 0o600)), \
                 patch.object(installer, 'load_state', return_value=copy.deepcopy(self.state)), \
                 patch.object(installer, 'require_checkpoint_refs'), \
                 patch.object(installer, 'run', side_effect=RuntimeError('preflight refused')):
                with self.assertRaisesRegex(RuntimeError, 'preflight refused'):
                    installer.deploy(self.manifest)
            self.assertFalse((channel / 'pending.json').exists())
            self.assertFalse((channel / 'last-status.json').exists())
            self.assertFalse((channel / 'state.json').exists())

    def test_readonly_recovery_lock_never_creates_or_bypasses_active_install(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'install.lock'
            with self.assertRaisesRegex(installer.Stop, 'lock missing'):
                installer.acquire_readonly_lock(lock)
            self.assertFalse(lock.exists())
            writer = installer.acquire_lock(lock)
            try:
                with self.assertRaisesRegex(installer.Stop, 'currently running'):
                    installer.acquire_readonly_lock(lock)
            finally:
                os.close(writer)
            reader = installer.acquire_readonly_lock(lock)
            os.close(reader)

    def test_recovery_report_includes_verified_backup_identity(self):
        tx = {'format': installer.TX_FORMAT, 'phase': 'SMOKE',
              'before': {'git_sha': 'd' * 40, 'images': copy.deepcopy(self.state['active']['images'])},
              'target': {'commit': SHA, 'refs': {role: installer.image_ref(self.manifest, role)
                                                 for role in ('backend', 'frontend')}},
              'backup_id': '20261031_120000_aabbccdd'}
        originals = copy.deepcopy(tx)
        report = installer.recovery_report(tx, self.state, 'd' * 40,
                        {role: image['ref'] for role, image in self.state['active']['images'].items()})
        self.assertEqual(report['backup_id'], tx['backup_id'])
        self.assertEqual(report['status'], 'MANUAL_RECOVERY_REQUIRED')
        self.assertFalse(report['automatic_rollback'])
        self.assertEqual(tx, originals)


    def test_recovery_refuses_ambiguous_or_changed_state_without_mutation(self):
        for failure in ('target-started', 'schema', 'containers', 'journal'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp, ExitStack() as patches:
                tx = {'format': installer.TX_FORMAT, 'phase': 'WRITE_REFS',
                      'before': {'git_sha': 'd' * 40}, 'target': {}}
                if failure == 'target-started': tx['phase'] = 'START_SERVICES'
                patches.enter_context(patch.object(installer, 'CHANNEL', Path(tmp)))
                patches.enter_context(patch.object(installer, 'load_state', return_value=(
                    {} if failure == 'journal' else self.state)))
                patches.enter_context(patch.object(installer, 'applied_migrations', return_value=(
                    self.applied + ['UnprovenMigration'] if failure == 'schema' else self.applied)))
                patches.enter_context(patch.object(installer, 'active_images', return_value=(
                    {} if failure == 'containers' else self.state['active']['images'])))
                run = patches.enter_context(patch.object(installer, 'run'))
                refs = patches.enter_context(patch.object(installer, 'rewrite_checkpoint_refs'))
                compose = patches.enter_context(patch.object(installer, 'compose'))
                self.assertEqual(installer.recover_before_start(tx, self.state, self.applied),
                                 'MANUAL_RECOVERY_REQUIRED')
                run.assert_not_called()
                refs.assert_not_called()
                compose.assert_not_called()
                self.assertEqual(json.loads((Path(tmp) / 'pending.json').read_text())['recovery_status'],
                                 'MANUAL_RECOVERY_REQUIRED')
                with self.assertRaises(installer.Stop): installer.guard_no_pending()

    def test_recovery_restores_only_existing_containers_and_checks_health(self):
        for failure in (None, 'start', 'health', 'checkout', 'refs', 'schema-after', 'boundary'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp, ExitStack() as patches:
                tx = {'format': installer.TX_FORMAT, 'phase': 'BACKUP',
                      'before': {'git_sha': 'd' * 40}, 'target': {}}
                patches.enter_context(patch.object(installer, 'CHANNEL', Path(tmp)))
                patches.enter_context(patch.object(installer, 'load_state', return_value=self.state))
                patches.enter_context(patch.object(installer, 'applied_migrations', side_effect=(
                    [self.applied, self.applied + ['Unknown']] if failure == 'schema-after' else lambda: self.applied)))
                patches.enter_context(patch.object(installer, 'active_images', return_value=self.state['active']['images']))
                patches.enter_context(patch.object(installer.boundary, 'validate_checkout', side_effect=(
                    ValueError('unsafe checkout') if failure == 'boundary' else None)))
                checkout = patches.enter_context(patch.object(installer, 'run', side_effect=(
                    RuntimeError('checkout failed') if failure == 'checkout' else None)))
                refs = patches.enter_context(patch.object(installer, 'rewrite_checkpoint_refs', side_effect=(
                    RuntimeError('refs failed') if failure == 'refs' else None)))
                compose = patches.enter_context(patch.object(installer, 'restart_existing_services', side_effect=(
                    RuntimeError('start failed') if failure == 'start' else None)))
                health = patches.enter_context(patch.object(installer, 'smoke', side_effect=(
                    RuntimeError('health failed') if failure == 'health' else None)))
                expected = 'ROLLED_BACK' if failure is None else 'MANUAL_RECOVERY_REQUIRED'
                self.assertEqual(installer.recover_before_start(tx, self.state, self.applied), expected)
                self.assertEqual(json.loads((Path(tmp) / 'pending.json').read_text())['recovery_status'], expected)
                self.assertFalse((Path(tmp) / 'state.json').exists())
                self.assertTrue(all(call.args == () for call in compose.call_args_list))
                if failure is None:
                    checkout.assert_any_call('git', 'checkout', '--detach', 'd' * 40)
                    refs.assert_called_once_with(self.state['active']['images'])
                    compose.assert_called_once_with()
                    health.assert_called_once()
                with self.assertRaises(installer.Stop): installer.guard_no_pending()

    def test_backup_verification_rejects_corruption_and_unusable_artifacts(self):
        # Exercise actual gzip/tar/checksum parsing; only ownership is replaced
        # because these local fixtures deliberately do not require root.
        cases = ('valid', 'checksum', 'size', 'metadata', 'sql', 'tar-traversal', 'tar-link', 'inventory', 'migrations')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                backup_id = '20261031_120000_aabbccdd'
                db = directory / ('homecloud_db_' + backup_id + '.sql.gz')
                storage = directory / ('homecloud_storage_' + backup_id + '.tar.gz')
                with gzip.open(db, 'wb') as stream:
                    stream.write(b'SELECT 1;\n' if case == 'sql' else b'CREATE TABLE example (id int);\n')
                with tarfile.open(storage, 'w:gz') as archive:
                    member = tarfile.TarInfo('../escape' if case == 'tar-traversal' else 'storage/file')
                    if case == 'tar-link':
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/etc/shadow'
                        archive.addfile(member)
                    else:
                        member.size = 4
                        archive.addfile(member, io.BytesIO(b'data'))
                meta = {'format_version': '1', 'backup_id': backup_id,
                        'storage_file_count': 2 if case == 'inventory' else 1,
                        'migration_count': len(self.state['active']['schema_migrations']) + (case == 'migrations')}
                for key, path in (('db_dump', db), ('storage_archive', storage)):
                    meta.update({key: path.name, key + '_size': path.stat().st_size,
                                 key + '_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
                if case == 'checksum': meta['db_dump_sha256'] = '0' * 64
                if case == 'size': meta['storage_archive_size'] += 1
                metadata = directory / ('homecloud_' + backup_id + '.meta')
                metadata.write_text(json.dumps(meta))
                sidecar = Path(str(metadata) + '.sha256')
                sidecar.write_text(('0' * 64 if case == 'metadata' else hashlib.sha256(metadata.read_bytes()).hexdigest()) + '  ' + metadata.name + '\n')
                recovery = directory / 'recovery.env'
                recovery.write_text('BACKUP_DIR=' + str(directory) + '\n')
                with patch.object(installer, 'backup_configuration', return_value={'BACKUP_DIR': str(directory)}), \
                     patch.object(installer, 'private_file', side_effect=lambda path: path), \
                     patch.object(installer, 'private_dir'), \
                     patch.object(installer, 'validate_backup_database', create=True):
                    if case == 'valid': installer.verify_backup(backup_id, self.state['active'])
                    else:
                        with self.assertRaises(installer.Stop):
                            installer.verify_backup(backup_id, self.state['active'])

    def test_stale_source_is_refused_without_transaction(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            channel = Path(tmp)
            state = copy.deepcopy(self.state)
            def fake_run(*args, **_kw):
                if args[:3] == ('git', 'rev-parse', 'HEAD'):
                    return 'd' * 40
                return ''
            with patch.object(installer, 'ROOT', Path('/home/hs/homecloud-test')), \
                 patch.object(installer, 'CHANNEL', channel), \
                 patch.object(installer, 'private_dir'), \
                 patch.object(installer.os, 'geteuid', return_value=0), \
                 patch.object(installer, 'acquire_lock', side_effect=lambda p: os.open(p, os.O_CREAT | os.O_RDWR, 0o600)), \
                 patch.object(installer, 'load_state', return_value=state), \
                 patch.object(installer, 'require_checkpoint_refs'), \
                 patch.object(installer, 'run', side_effect=fake_run), \
                 patch.object(installer, 'active_images', return_value=state['active']['images']), \
                 patch.object(installer, 'applied_migrations', return_value=self.applied), \
                 patch.object(installer, 'precheck_source', side_effect=installer.Stop('test branch moved or unavailable')):
                with self.assertRaisesRegex(installer.Stop, 'test branch moved'):
                    installer.deploy(self.manifest)
            self.assertFalse((channel / 'pending.json').exists())
            self.assertFalse((channel / 'last-status.json').exists())

    def test_runtime_ref_drift_rejected_before_stop(self):
        with patch.object(installer, 'env_values', return_value={
                'RELEASE_BACKEND_IMAGE': 'wrong-backend',
                'RELEASE_FRONTEND_IMAGE': 'wrong-frontend'}):
            with self.assertRaisesRegex(installer.Stop, 'runtime image refs'):
                installer.require_checkpoint_refs(self.state)

    def test_backup_uses_running_test_admin_id_for_compose_identity(self):
        active = self.state['active']
        current = {f'RELEASE_{role.upper()}_IMAGE': active['images'][role]['ref']
                   for role in ('backend', 'frontend')}
        current['UPDATE_ADMIN_USER_ID'] = '1'
        backup_id = '20261105_230000_1234abcd'

        def run_backup(*args, **kwargs):
            self.assertEqual(args[0], 'bash')
            self.assertEqual(kwargs['env']['UPDATE_ADMIN_USER_ID'], '1')
            self.assertEqual(kwargs['pass_fds'], (37,))
            self.assertEqual(kwargs['env']['HOMECLOUD_BACKUP_OPERATION_FD'], '37')
            self.assertEqual(json.loads(kwargs['env']['HOMECLOUD_BACKUP_MARKER_IDENTITY']), [1, 2])
            return json.dumps({'event': 'backup_completed', 'backup_id': backup_id})

        with patch.object(installer, 'backup_configuration', return_value={}), \
             patch.object(installer, 'env_values', return_value=current), \
             patch.object(installer, 'run', side_effect=run_backup), \
             patch.object(installer, 'verify_backup') as verified:
            self.assertEqual(installer.backup(active, 37, [1, 2]), backup_id)
            verified.assert_called_once_with(backup_id, active)

        current['UPDATE_ADMIN_USER_ID'] = '1\nCOMPOSE_FILE=untrusted'
        with patch.object(installer, 'backup_configuration', return_value={}), \
             patch.object(installer, 'env_values', return_value=current), \
             patch.object(installer, 'run') as run:
            with self.assertRaisesRegex(installer.Stop, 'invalid TEST update admin ID'):
                installer.backup(active, 37, [1, 2])
            run.assert_not_called()

    def test_post_start_verification_rejects_wrong_image_id_or_ref(self):
        ids = {role: 'sha256:' + 'e' * 64 for role in ('backend', 'frontend')}
        refs = {role: installer.image_ref(self.manifest, role) for role in ids}
        actual = {role: {'ref': refs[role], 'id': ids[role], 'sha': SHA} for role in ids}
        with patch.object(installer, 'running_images', return_value=actual):
            self.assertEqual(installer.verify_started_images(self.manifest, ids), actual)
        actual['frontend']['id'] = 'sha256:' + '9' * 64
        with patch.object(installer, 'running_images', return_value=actual):
            with self.assertRaisesRegex(installer.Stop, 'started TEST image'):
                installer.verify_started_images(self.manifest, ids)
        actual['frontend']['id'] = ids['frontend']
        actual['frontend']['ref'] = 'wrong'
        with patch.object(installer, 'running_images', return_value=actual):
            with self.assertRaisesRegex(installer.Stop, 'started TEST image'):
                installer.verify_started_images(self.manifest, ids)

    def test_running_images_reads_actual_container_ref_not_state(self):
        import json
        id1 = 'sha256:' + 'a' * 64
        expected = {'backend': 'reg/backend@sha256:' + 'b' * 64,
                    'frontend': 'reg/frontend@sha256:' + 'c' * 64}
        def fake_compose(*args, **kw):
            return ('a' * 12) if args[-1] == 'backend' else ('b' * 12)
        def fake_run(*args, **kw):
            if args[3] == 'inspect' and args[4] in ('a' * 12, 'b' * 12):
                role = 'backend' if args[4] == 'a' * 12 else 'frontend'
                return json.dumps([{'Image': id1, 'Config': {'Image': expected[role]}}])
            return json.dumps([{'Id': id1, 'Config': {'Labels': {
                'org.opencontainers.image.revision': SHA}}}])
        with patch.object(installer, 'compose', side_effect=fake_compose), \
             patch.object(installer, 'run', side_effect=fake_run):
            self.assertEqual(installer.running_images(expected)['backend']['ref'], expected['backend'])
            with self.assertRaisesRegex(installer.Stop, 'reference mismatch'):
                installer.running_images(dict(expected, backend='wrong'))

    def test_dry_run_does_not_create_lock_file(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            channel = Path(tmp)
            with patch.object(installer, 'ROOT', Path('/home/hs/homecloud-test')), \
                 patch.object(installer, 'CHANNEL', channel), \
                 patch.object(installer, 'private_dir'), \
                 patch.object(installer.os, 'geteuid', return_value=0):
                with self.assertRaisesRegex(installer.Stop, 'install lock missing'):
                    installer.deploy(self.manifest, dry_run=True)
            self.assertFalse((channel / 'install.lock').exists())

    def test_backup_identity_durably_saved_before_ref_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            tx = {'format': installer.TX_FORMAT, 'before': {}, 'target': {}}
            with patch.object(installer, 'CHANNEL', Path(tmp)):
                installer.record_phase(tx, 'BACKUP')
                tx['backup_id'] = 'verified-backup-id'
                installer.record_phase(tx, 'BACKUP')
                data = json.loads((Path(tmp) / 'pending.json').read_text())
                self.assertEqual(data['backup_id'], 'verified-backup-id')
                self.assertEqual(data['phase'], 'BACKUP')


    def test_smoke_checks_public_https_and_private_backend_readiness(self):
        with tempfile.TemporaryDirectory() as tmp:
            fullchain = Path(tmp) / 'current' / 'fullchain.pem'
            fullchain.parent.mkdir()
            fullchain.write_text('dummy test certificate')
            env = {'PUBLIC_ORIGIN': 'https://test.example', 'TLS_CERT_DIR': tmp}
            with patch.object(installer, 'env_values', return_value=env), \
                 patch.object(installer, 'run', return_value='200') as public, \
                 patch.object(installer, 'compose', return_value='') as internal:
                installer.smoke()
            self.assertIn('https://test.example/', public.call_args.args)
            self.assertEqual(internal.call_args.args,
                             ('exec', '-T', 'backend', 'node', 'docker/healthcheck.cjs'))
            self.assertEqual(internal.call_args.kwargs, {'timeout': 15})

    def test_smoke_refuses_public_200_when_backend_not_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert = Path(tmp) / 'current' / 'fullchain.pem'
            cert.parent.mkdir()
            cert.write_text('dummy test certificate')
            env = {'PUBLIC_ORIGIN': 'https://test.example', 'TLS_CERT_DIR': tmp}
            with patch.object(installer, 'env_values', return_value=env), \
                 patch.object(installer, 'run', return_value='200'), \
                 patch.object(installer, 'compose', side_effect=installer.Stop('backend readiness refused')):
                with self.assertRaisesRegex(installer.Stop, 'backend readiness refused'):
                    installer.smoke()

    def test_smoke_does_not_probe_backend_after_public_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert = Path(tmp) / 'current' / 'fullchain.pem'
            cert.parent.mkdir()
            cert.write_text('dummy test certificate')
            env = {'PUBLIC_ORIGIN': 'https://test.example', 'TLS_CERT_DIR': tmp}
            with patch.object(installer, 'env_values', return_value=env), \
                 patch.object(installer, 'run', return_value='503'), \
                 patch.object(installer, 'compose') as internal:
                with self.assertRaisesRegex(installer.Stop, 'public HTTPS smoke failed'):
                    installer.smoke()
                internal.assert_not_called()

    @unittest.skipUnless(os.name == 'posix' and hasattr(signal, 'SIGKILL'),
                         'POSIX signals required')
    def test_process_termination_after_stop_preserves_pending(self):
        # Simulate installer death from an SSH/job cancellation or power loss.
        # This is a local signal simulation, not a network/SSH acceptance test.
        previous = 'd' * 40
        ctx = multiprocessing.get_context('spawn')
        for sig in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=sig), tempfile.TemporaryDirectory() as tmp:
                channel = Path(tmp)
                receiver, sender = ctx.Pipe(duplex=False)
                proc = ctx.Process(target=suspended_install_process,
                    args=(tmp, sender, copy.deepcopy(self.state), self.applied, self.manifest))
                proc.start()
                sender.close()
                try:
                    self.assertTrue(receiver.poll(10), 'child never reached STOP_SERVICES')
                    self.assertEqual(receiver.recv(), 'STOP_SERVICES')
                    if sig == signal.SIGTERM:
                        proc.terminate()
                    else:
                        proc.kill()
                    proc.join(10)
                    self.assertEqual(proc.exitcode, -sig)
                finally:
                    receiver.close()
                    if proc.is_alive():
                        proc.kill()
                    proc.join(10)
                pending = json.loads((channel / 'pending.json').read_text())
                self.assertEqual(pending['phase'], 'STOP_SERVICES')
                self.assertEqual(pending['backup_maintenance'], [1, 2])
                self.assertEqual(pending['before']['git_sha'], previous)
                self.assertFalse((channel / 'state.json').exists())
                with patch.object(installer, 'CHANNEL', channel):
                    with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                        installer.guard_no_pending()
                report = installer.recovery_report(pending, self.state, previous,
                    {role: image['ref'] for role, image in self.state['active']['images'].items()})
                self.assertEqual(report['status'], 'MANUAL_RECOVERY_REQUIRED')
                self.assertFalse(report['automatic_rollback'])


class RecoveryPinTests(unittest.TestCase):
    @staticmethod
    def checkpoint(backend, frontend):
        return {'images': {
            role: {'ref': 'ghcr.io/owner/homecloud/' + role + '@sha256:' + digest * 64}
            for role, digest in (('backend', backend), ('frontend', frontend))}}

    def test_sync_changes_only_verified_pins_atomically(self):
        before = self.checkpoint('1', '2')
        after = self.checkpoint('3', '4')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'recovery.env'
            path.write_text('DB_NAME=homecloud\n' + ''.join(
                key + '=' + before['images'][role]['ref'] + '\n' for key, role in
                (('RELEASE_BACKEND_IMAGE', 'backend'),
                 ('RELEASE_FRONTEND_IMAGE', 'frontend'), ('BACKEND_IMAGE', 'backend'))))
            path.chmod(0o600)
            def values(*_args):
                return dict(line.split('=', 1) for line in path.read_text().splitlines())
            with patch.object(installer, 'RECOVERY', path), \
                 patch.object(installer, 'env_values', return_value={'DB_NAME': 'homecloud'}), \
                 patch.object(installer.boundary, 'validate_backup_configuration', side_effect=values), \
                 patch.object(installer.os, 'fchown'), \
                 patch.object(installer, 'private_file', side_effect=lambda p: p):
                installer.sync_recovery_pins(before, after)
                updated = values()
                self.assertEqual(updated['DB_NAME'], 'homecloud')
                self.assertEqual(updated['RELEASE_BACKEND_IMAGE'], after['images']['backend']['ref'])
                self.assertEqual(updated['RELEASE_FRONTEND_IMAGE'], after['images']['frontend']['ref'])
                self.assertEqual(updated['BACKEND_IMAGE'], after['images']['backend']['ref'])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertFalse(list(Path(tmp).glob('.recovery-env-*')))

    def test_sync_refuses_unrelated_drift_and_unrecognized_pin(self):
        before = self.checkpoint('1', '2')
        after = self.checkpoint('3', '4')
        for bad in ('DB_NAME=other', 'RELEASE_BACKEND_IMAGE=unrecognized'):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'recovery.env'
                original = 'DB_NAME=homecloud\n' + ''.join(
                    key + '=' + before['images'][role]['ref'] + '\n' for key, role in
                    (('RELEASE_BACKEND_IMAGE', 'backend'),
                     ('RELEASE_FRONTEND_IMAGE', 'frontend'), ('BACKEND_IMAGE', 'backend')))
                original = '\n'.join(bad if line.startswith(bad.split('=')[0] + '=') else line
                                     for line in original.splitlines()) + '\n'
                path.write_text(original)
                with patch.object(installer, 'RECOVERY', path), \
                     patch.object(installer, 'env_values', return_value={'DB_NAME': 'homecloud'}), \
                     patch.object(installer.boundary, 'validate_backup_configuration',
                                  side_effect=lambda *_: dict(line.split('=', 1) for line in path.read_text().splitlines())), \
                     patch.object(installer, 'private_file', side_effect=lambda p: p):
                    with self.assertRaises(installer.Stop):
                        installer.sync_recovery_pins(before, after)
                    self.assertEqual(path.read_text(), original)



class RealGitPolicyTests(unittest.TestCase):
    """Real Git objects, without refs, worktrees or checkout changes."""

    def git(self, *args, data=None):
        env = os.environ.copy()
        env.update({
            "GIT_AUTHOR_NAME": "HomeCloud Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "HomeCloud Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
        })
        env.update(self.git_env)
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null",
             "-c", "commit.gpgsign=false",
             "-c", f"safe.directory={ROOT}", *args],
            cwd=ROOT, env=env, input=data,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False
        )
        if result.returncode:
            self.fail(
                "Git fixture failed: "
                + result.stderr.decode("utf-8", errors="replace")
            )
        return result.stdout

    def replace_in_tree(self, tree, parts, mode, kind, oid):
        rows = []
        found = False

        for rec in self.git("ls-tree", "-z", tree).split(b"\0"):
            if not rec:
                continue
            meta, name = rec.split(b"\t", 1)
            m, k, old_oid = meta.split()
            if name == parts[0].encode():
                found = True
                if len(parts) > 1:
                    self.assertEqual(k, b"tree")
                    old_oid = self.replace_in_tree(
                        old_oid.decode(), parts[1:],
                        mode, kind, oid
                    ).encode()
                elif mode is None:
                    continue
                else:
                    m, k, old_oid = (
                        mode.encode(), kind.encode(), oid.encode()
                    )
            rows.append((m, k, old_oid, name))

        if not found:
            self.assertEqual(len(parts), 1)
            self.assertIsNotNone(mode)
            rows.append((
                mode.encode(), kind.encode(),
                oid.encode(), parts[0].encode()
            ))

        raw = b"".join(
            m + b" " + k + b" " + h + b"\t" + n + b"\0"
            for m, k, h, n in rows
        )
        return self.git("mktree", "-z", "--missing", data=raw).decode().strip()

    def test_real_git_trust_policy(self):
        objects = ROOT / ".git" / "objects"
        self.assertTrue(objects.is_dir())

        overlay = tempfile.TemporaryDirectory(
            prefix="d52-git-objects-",
        )
        self.addCleanup(overlay.cleanup)
        self.git_env = {
            "GIT_OBJECT_DIRECTORY": overlay.name,
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(objects),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "safe.directory",
            "GIT_CONFIG_VALUE_0": str(ROOT),
        }

        host = load(
            "real_git_host_verifier",
            ROOT / "deploy/linux/update-host-verify.py"
        )
        modules = host.load_helpers(ROOT)
        source_env = modules["boundary"].clean_environment()
        source_env.update(self.git_env)
        source = host.GitSource(ROOT, source_env)

        # Construct an isolated Git-object baseline matching
        # the currently installed operational contract.
        #
        # No checkout, index, branch, worktree or real HEAD
        # changes. Objects are written only to the existing
        # temporary object overlay owned by this test.
        real_head = self.git("rev-parse", "HEAD").decode().strip()
        base_tree = self.git(
            "rev-parse", "HEAD^{tree}"
        ).decode().strip()

        protected_paths = set(installer.LOCKED_FILES)
        protected_paths.update(contract.FILES)

        # Include the actual local migration inventory too.
        migration_dir = ROOT / "backend/src/migrations"

        local_migrations = {
            path.relative_to(ROOT).as_posix()
            for path in migration_dir.glob("*.ts")
        }

        self.assertTrue(local_migrations)

        migration_prefix = "backend/src/migrations/"

        raw_inventory = self.git(
            "ls-tree", "-r", "--name-only", "-z",
            real_head, "--", migration_prefix,
        )

        # Git -z uses actual NUL bytes, not escaped text.
        committed_migrations = {
            item.decode("utf-8")
            for item in raw_inventory.split(bytes([0]))
            if item
        }

        self.assertTrue(committed_migrations)

        for name in committed_migrations:
            self.assertTrue(
                name.startswith(migration_prefix),
                f"Unexpected migration path: {name!r}",
            )
            self.assertEqual(
                len(name.split("/")), 4,
                f"Invalid migration path: {name!r}",
            )
            self.assertIsNotNone(
                contract.MIGRATION.fullmatch(
                    name[len(migration_prefix):]
                ),
                f"Invalid migration filename: {name!r}",
            )

        print(
            f"PASS: Git inventory parsed: "
            f"{len(committed_migrations)} committed migrations",
            flush=True,
        )

        # Remove obsolete migration paths from the synthetic
        # tree only. Never remove anything from the workspace.
        for name in sorted(
            committed_migrations - local_migrations
        ):
            base_tree = self.replace_in_tree(
                base_tree,
                name.split("/"),
                None,
                "blob",
                "",
            )

        protected_paths.update(local_migrations)

        for name in sorted(protected_paths):
            path = ROOT / name

            self.assertTrue(
                path.is_file() and not path.is_symlink(),
                f"Missing or unsafe protected fixture: {name}",
            )

            raw = path.read_bytes()

            oid = self.git(
                "hash-object", "-w", "--stdin",
                data=raw,
            ).decode().strip()

            mode = (
                "100755"
                if path.stat().st_mode & 0o111
                else "100644"
            )

            base_tree = self.replace_in_tree(
                base_tree,
                name.split("/"),
                mode,
                "blob",
                oid,
            )

        base = self.git(
            "commit-tree", base_tree,
            "-p", real_head,
            "-m", "Тестовый baseline защищённого контракта",
        ).decode().strip()

        # The verifier's current revision is the synthetic
        # fixture baseline, not the developer's real HEAD.
        # All Git tree/blob reads and hash checks remain real.
        fixture_head = patch.object(
            source, "head",
            return_value=base.encode("ascii"),
        )
        fixture_head.start()
        self.addCleanup(fixture_head.stop)

        read, _ = source.reader(base)

        for name in installer.LOCKED_FILES:
            self.assertEqual(
                read(name),
                (ROOT / name).read_bytes(),
                f"Fixture/live contract mismatch: {name}",
            )

        print(
            "\nPASS: synthetic Git baseline matches "
            f"{len(installer.LOCKED_FILES)} protected files",
            flush=True,
        )

        # Build the entire fixture manifest from the same immutable
        # Git tree. The working directory may contain uncommitted
        # migrations that do not belong to the fixture's base commit.
        import re

        migration_prefix = "backend/src/migrations/"
        migration_paths = sorted(
            item.decode("utf-8")
            for item in self.git(
                "ls-tree", "-r", "--name-only", "-z",
                base, "--", migration_prefix,
            ).split(bytes([0]))
            if item
        )

        self.assertEqual(
            set(migration_paths),
            local_migrations,
            "Synthetic Git migration inventory differs from fixture",
        )

        base_migrations = []

        for path in migration_paths:
            filename = path[len(migration_prefix):]

            self.assertIsNotNone(
                contract.MIGRATION.fullmatch(filename),
                f"Invalid fixture migration: {filename}",
            )

            raw = read(path)

            classes = re.findall(
                r"export class ([A-Za-z0-9]+)",
                raw.decode("utf-8"),
            )

            self.assertEqual(len(classes), 1)

            base_migrations.append({
                "name": classes[0],
                "file": filename,
                "sha256": hashlib.sha256(raw).hexdigest(),
            })

        self.assertTrue(base_migrations)

        self.assertEqual(
            len({item["name"] for item in base_migrations}),
            len(base_migrations),
        )

        print(
            "\nGit fixture migrations: "
            f"base={len(base_migrations)}, "
            f"working_tree={len(contract.schema(ROOT))}",
            flush=True,
        )

        original = {
            "commit": base,
            "repository": "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud",
            "source_files": {
                name: hashlib.sha256(read(name)).hexdigest()
                for name in contract.FILES
            },
            "schema_migrations": base_migrations,
        }

        self.assertEqual(
            host.CI_ONLY_SCRIPT_CHANGES,
            installer.CI_ONLY_SCRIPT_CHANGES
        )

        scenarios = [
            ("scripts/ci/stage-cache-proof.py", "100644", "blob", True),
            ("scripts/ci/stage-cache-proof.py", "100644", "missing-blob", False),
            ("scripts/ci/stage-cache-proof.py", "100644", "corrupt-blob", False),
            ("scripts/ci/stage-cache-proof.py", "100644", "oversized-blob", False),
            ("scripts/ci/stage-cache-proof.py\trogue", "100644", "blob", False),
            ("scripts/ci/test-stage-cache-proof.py", "100755", "blob", True),
            ("scripts/ci/provenance.py", "100644", "blob", False),
            ("scripts/backup.sh", "100644", "blob", False),
            ("scripts/ci/unexpected-helper.py", "100644", "blob", False),
            ("scripts/ci/stage-cache-proof.py", "120000", "blob", False),
            ("scripts/ci/stage-cache-proof.py", "160000", "commit", False),
            ("scripts/ci/stage-cache-proof.py", None, "blob", False),
            ("deploy/linux/update-host-verify.py", "100644", "blob", False),
            ("deploy/linux/test-channel.py", "100644", "blob", False),
            ("deploy/linux/maintenance-inhibit.py", "100644", "blob", False),
            ("deploy/linux/maintenance-window.py", "100644", "blob", False),
            ("deploy/linux/storage-writer-fence.py", "100644", "blob", False),
            ("deploy/linux/recover-copy.py", "100644", "blob", False),
            ("docker-compose.project-test-updates.yml", "100644", "blob", False),
            ("docker-compose.project-test-updates.yml", "100755", "mode-only", False),
            ("docker-compose.project-test-updates.yml", "120000", "blob", False),
            ("docker-compose.project-test-updates.yml", None, "blob", False),
        ]

        real_run = installer.run

        for path, mode, kind, permitted in scenarios:
            if mode is None:
                oid = ""
            elif kind == "commit":
                oid = base
            elif kind == "mode-only":
                original_entry = self.git(
                    "ls-tree", base, "--", path
                ).decode().strip()
                metadata, sep, observed = original_entry.partition("\t")
                self.assertTrue(sep)
                self.assertEqual(observed, path)
                old_mode, old_type, oid = metadata.split()
                self.assertEqual(old_type, "blob")
                self.assertIn(old_mode, ("100644", "100755"))
                mode = "100755" if old_mode == "100644" else "100644"
                kind = "blob"
            elif kind == "missing-blob":
                oid = "f" * 40
                kind = "blob"
            elif kind == "corrupt-blob":
                oid = self.git(
                    "hash-object", "-w", "--stdin",
                    data=b"original integrity fixture"
                ).decode().strip()
                replacement = b"tampered integrity fixture"
                raw = (
                    b"blob " + str(len(replacement)).encode()
                    + b"\0" + replacement
                )
                object_path = (
                    Path(overlay.name) / oid[:2] / oid[2:]
                )
                self.assertTrue(object_path.is_file())
                object_path.chmod(0o600)
                try:
                    object_path.write_bytes(zlib.compress(raw))
                finally:
                    object_path.chmod(0o444)
                kind = "blob"
            elif kind == "oversized-blob":
                oid = self.git(
                    "hash-object", "-w", "--stdin",
                    data=b"x" * (16 * 1024 * 1024 + 1)
                ).decode().strip()
                kind = "blob"
            else:
                oid = self.git(
                    "hash-object", "-w", "--stdin",
                    data=b"git policy regression fixture\n"
                ).decode().strip()

            tree = self.replace_in_tree(
                base_tree, path.split("/"), mode, kind, oid
            )
            target = self.git(
                "commit-tree", tree, "-p", base,
                "-m", "Regression fixture"
            ).decode().strip()

            manifest = dict(original, commit=target)

            def fake_run(*args, **kwargs):
                if args[:3] == ("git", "status", "--porcelain"):
                    return ""
                if args[:3] == ("git", "remote", "get-url"):
                    return "https://github.com/" + manifest["repository"]
                if args[:2] == ("git", "fetch"):
                    return ""
                if args[:3] == ("git", "rev-parse", "HEAD"):
                    return base
                if args[:3] == ("git", "rev-parse", "FETCH_HEAD"):
                    return target
                return real_run(*args, **kwargs)

            with self.subTest(path=path, mode=mode):
                if permitted:
                    host.target_sources(manifest, contract, source)
                else:
                    with self.assertRaises(
                        (ValueError, subprocess.CalledProcessError)
                    ):
                        host.target_sources(manifest, contract, source)

                with patch.object(
                    installer, "run", side_effect=fake_run
                ), patch.object(
                    installer, "require_current_test_head"
                ), patch.object(
                    installer.boundary, "clean_environment",
                    return_value=source_env
                ):
                    if permitted:
                        self.assertEqual(
                            installer.precheck_source(
                                manifest, False
                            ),
                            base
                        )
                    else:
                        with self.assertRaises(installer.Stop):
                            installer.precheck_source(
                                manifest, False
                            )

        # Negative control: both Git revisions agree, but the
        # installed operational file differs. The real SHA256
        # comparison MUST reject this scenario.
        stale_name = "scripts/backup.sh"

        stale_raw = (
            (ROOT / stale_name).read_bytes()
            + b"\\n# stale operational fixture\\n"
        )

        stale_oid = self.git(
            "hash-object", "-w", "--stdin",
            data=stale_raw,
        ).decode().strip()

        stale_tree = self.replace_in_tree(
            base_tree,
            stale_name.split("/"),
            "100644",
            "blob",
            stale_oid,
        )

        stale = self.git(
            "commit-tree", stale_tree,
            "-p", base,
            "-m", "Тест несовпадения защищённого файла",
        ).decode().strip()

        stale_manifest = dict(original, commit=stale)
        stale_manifest["source_files"] = dict(
            original["source_files"]
        )
        stale_manifest["source_files"][stale_name] = (
            hashlib.sha256(stale_raw).hexdigest()
        )

        def stale_run(*args, **kwargs):
            if args[:3] == ("git", "status", "--porcelain"):
                return ""

            if args[:3] == ("git", "remote", "get-url"):
                return (
                    "https://github.com/"
                    + stale_manifest["repository"]
                )

            if args[:2] == ("git", "fetch"):
                return ""

            if args[:3] in (
                ("git", "rev-parse", "HEAD"),
                ("git", "rev-parse", "FETCH_HEAD"),
            ):
                return stale

            return real_run(*args, **kwargs)

        with patch.object(
            installer, "run", side_effect=stale_run
        ), patch.object(
            installer, "require_current_test_head"
        ), patch.object(
            installer.boundary, "clean_environment",
            return_value=source_env
        ):
            with self.assertRaisesRegex(
                installer.Stop,
                "operational/Compose contract changed",
            ):
                installer.precheck_source(
                    stale_manifest, False
                )

        print(
            "PASS: real live-file SHA256 mismatch rejected",
            flush=True,
        )

        self.assertEqual(
            self.git("rev-parse", "HEAD").decode().strip(),
            real_head,
        )


class MaintenanceAdmissionTests(unittest.TestCase):

    def test_maintenance_inhibitor_is_not_bypassed(self):
        from types import SimpleNamespace

        info = SimpleNamespace(
            st_uid=0,
            st_gid=0,
            st_mode=0o40711,
        )

        with patch.object(
            installer.boundary, 'trusted_path'
        ), patch.object(
            Path, 'lstat', return_value=info
        ), patch.object(
            installer.maintenance,
            'assert_operation_allowed',
            side_effect=installer.maintenance.MaintenanceInhibited(
                'fixture inhibitor'
            ),
        ) as check:
            with self.assertRaisesRegex(
                installer.Stop, 'maintenance admission refused'
            ):
                installer.guard_no_maintenance()

            check.assert_called_once_with(
                str(installer.RUNTIME / 'maintenance')
            )

    def test_missing_maintenance_directory_is_refused(self):
        with patch.object(
            installer.boundary,
            'trusted_path',
            side_effect=FileNotFoundError('missing fixture'),
        ), patch.object(
            installer.maintenance, 'assert_operation_allowed'
        ) as check:
            with self.assertRaisesRegex(
                installer.Stop, 'maintenance admission refused'
            ):
                installer.guard_no_maintenance()

            check.assert_not_called()

    def test_unsafe_maintenance_mode_is_refused(self):
        from types import SimpleNamespace

        for uid, gid, mode in (
            (1001, 0, 0o40711),
            (0, 1001, 0o40711),
            (0, 0, 0o40777),
            (0, 0, 0o120711),
        ):
            with self.subTest(uid=uid, gid=gid, mode=mode):
                info = SimpleNamespace(
                    st_uid=uid, st_gid=gid, st_mode=mode,
                )

                with patch.object(
                    installer.boundary, 'trusted_path'
                ), patch.object(
                    Path, 'lstat', return_value=info
                ), patch.object(
                    installer.maintenance, 'assert_operation_allowed'
                ) as check:
                    with self.assertRaises(installer.Stop):
                        installer.guard_no_maintenance()

                    check.assert_not_called()

    def test_clean_maintenance_admission(self):
        from types import SimpleNamespace

        info = SimpleNamespace(
            st_uid=0, st_gid=0, st_mode=0o40711
        )

        with patch.object(
            installer.boundary, 'trusted_path'
        ), patch.object(
            Path, 'lstat', return_value=info
        ), patch.object(
            installer.maintenance, 'assert_operation_allowed'
        ) as check:
            installer.guard_no_maintenance()
            check.assert_called_once()

    def test_start_refused_before_compose_and_lock_released(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent).resolve()
            fd = os.open(
                str(root / 'install.lock'),
                os.O_CREAT | os.O_RDWR,
                0o600,
            )

            with patch.object(
                installer, 'ROOT', Path('/home/hs/homecloud-test')
            ), patch.object(
                installer, 'CHANNEL', root
            ), patch.object(
                installer.os, 'geteuid', return_value=0
            ), patch.object(
                installer, 'private_dir'
            ), patch.object(
                installer, 'acquire_lock', return_value=fd
            ) as acquire, patch.object(
                installer, 'guard_no_pending'
            ), patch.object(
                installer, 'guard_no_maintenance',
                side_effect=installer.Stop('maintenance active'),
            ), patch.object(
                installer, 'run'
            ) as run, patch.object(
                installer, 'compose'
            ) as compose:
                with self.assertRaisesRegex(
                    installer.Stop, 'maintenance active'
                ):
                    installer.start_services()

                acquire.assert_called_once_with(
                    root / 'install.lock'
                )
                run.assert_not_called()
                compose.assert_not_called()

            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_start_rechecks_after_preflight(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent).resolve()
            fd = os.open(
                str(root / 'install.lock'),
                os.O_CREAT | os.O_RDWR,
                0o600,
            )

            with patch.object(
                installer, 'ROOT', Path('/home/hs/homecloud-test')
            ), patch.object(
                installer, 'CHANNEL', root
            ), patch.object(
                installer.os, 'geteuid', return_value=0
            ), patch.object(
                installer, 'private_dir'
            ), patch.object(
                installer, 'acquire_lock', return_value=fd
            ), patch.object(
                installer, 'guard_no_pending'
            ), patch.object(
                installer, 'guard_no_maintenance',
                side_effect=[
                    None,
                    installer.Stop('inhibit appeared'),
                ],
            ) as admission, patch.object(
                installer, 'run', return_value=''
            ) as preflight, patch.object(
                installer, 'compose'
            ) as compose:
                with self.assertRaisesRegex(
                    installer.Stop, 'inhibit appeared'
                ):
                    installer.start_services()

                self.assertEqual(admission.call_count, 2)
                preflight.assert_called_once()
                compose.assert_not_called()

            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_install_refuses_maintenance_before_mutation(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent).resolve()

            for dry_run, rollback in (
                (False, False),
                (False, True),
                (True, False),
            ):
                with self.subTest(
                    dry_run=dry_run, rollback=rollback
                ):
                    fd = os.open(
                        str(root / 'install.lock'),
                        os.O_CREAT | os.O_RDWR,
                        0o600,
                    )

                    with patch.object(
                        installer, 'ROOT',
                        Path('/home/hs/homecloud-test')
                    ), patch.object(
                        installer, 'CHANNEL', root
                    ), patch.object(
                        installer.os, 'geteuid', return_value=0
                    ), patch.object(
                        installer, 'private_dir'
                    ), patch.object(
                        installer, 'acquire_lock', return_value=fd
                    ), patch.object(
                        installer, 'acquire_readonly_lock',
                        return_value=fd
                    ), patch.object(
                        installer, 'guard_no_pending'
                    ), patch.object(
                        installer, 'guard_no_maintenance',
                        side_effect=installer.Stop('maintenance active'),
                    ), patch.object(
                        installer, 'load_state'
                    ) as load_state, patch.object(
                        installer, 'compose'
                    ) as compose, patch.object(
                        installer, 'run'
                    ) as run:
                        with self.assertRaisesRegex(
                            installer.Stop, 'maintenance active'
                        ):
                            installer.deploy(
                                {},
                                rollback=rollback,
                                dry_run=dry_run,
                            )

                        load_state.assert_not_called()
                        compose.assert_not_called()
                        run.assert_not_called()

                    self.assertFalse(
                        (root / 'pending.json').exists()
                    )

                    with self.assertRaises(OSError):
                        os.fstat(fd)


if __name__ == '__main__':
    unittest.main()
