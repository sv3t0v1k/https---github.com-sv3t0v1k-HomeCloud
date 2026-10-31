#!/usr/bin/env python3
"""TEST pair, refusal, race and rollback contract checks without Docker/server."""
import copy
import hashlib
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
        installer.deploy(manifest)


class TestChannelTests(unittest.TestCase):
    def setUp(self):
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
                self.assertEqual(json.loads((channel / 'last-status.json').read_text())['status'], 'STOP')
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
            ('stop', 'STOP_SERVICES'),
            ('backup', 'BACKUP'),
            ('rewrite', 'WRITE_REFS'),
            ('start', 'START_SERVICES'),
            ('verify-started', 'START_SERVICES'),
            ('smoke', 'SMOKE'),
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
                        return ''

                    def fake_backup(_active):
                        failure('backup')
                        return '20261031_120000_abcdefgh'

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
                        patches.enter_context(patch.object(installer, 'backup', side_effect=fake_backup))
                        patches.enter_context(patch.object(installer, 'rewrite_refs', side_effect=fake_rewrite))
                        patches.enter_context(patch.object(installer, 'smoke', side_effect=fake_smoke))
                        patches.enter_context(patch.multiple(
                            installer,
                            require_checkpoint_refs=lambda state: None,
                            precheck_source=lambda manifest, rollback: previous,
                            verify_started_images=lambda manifest, ids: failure('verify-started')))
                        patches.enter_context(patch.object(installer, 'atomic_json', side_effect=fake_atomic))
                        with self.assertRaisesRegex(RuntimeError, 'injected failure'):
                            installer.deploy(self.manifest)
                        pending_file = channel / 'pending.json'
                        self.assertEqual(json.loads(pending_file.read_text())['phase'], expected_phase)
                        self.assertEqual(pending_file.stat().st_mode & 0o777, 0o600)
                        self.assertFalse((channel / 'state.json').exists())
                        self.assertEqual(json.loads((channel / 'last-status.json').read_text())['status'], 'STOP')
                        # The exact same request must refuse before any Git or Docker work.
                        prior_operations = list(operations)
                        with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                            installer.deploy(self.manifest)
                        self.assertEqual(operations, prior_operations)
                        snapshot = json.loads(pending_file.read_text())
                        self.assertEqual(snapshot['before']['git_sha'], previous)
                        self.assertEqual(snapshot['target']['commit'], SHA)
                        if expected_phase in ('WRITE_REFS', 'START_SERVICES', 'SMOKE', 'COMMIT_STATE'):
                            self.assertEqual(snapshot['backup_id'], '20261031_120000_abcdefgh')
                        else:
                            self.assertNotIn('backup_id', snapshot)

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
              'backup_id': '20261031_120000_abcdefgh'}
        originals = copy.deepcopy(tx)
        report = installer.recovery_report(tx, self.state, 'd' * 40,
                        {role: image['ref'] for role, image in self.state['active']['images'].items()})
        self.assertEqual(report['backup_id'], tx['backup_id'])
        self.assertEqual(report['status'], 'MANUAL_RECOVERY_REQUIRED')
        self.assertFalse(report['automatic_rollback'])
        self.assertEqual(tx, originals)


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
                self.assertEqual(pending['before']['git_sha'], previous)
                self.assertFalse((channel / 'state.json').exists())
                with patch.object(installer, 'CHANNEL', channel):
                    with self.assertRaisesRegex(installer.Stop, 'incomplete TEST transaction'):
                        installer.guard_no_pending()
                report = installer.recovery_report(pending, self.state, previous,
                    {role: image['ref'] for role, image in self.state['active']['images'].items()})
                self.assertEqual(report['status'], 'MANUAL_RECOVERY_REQUIRED')
                self.assertFalse(report['automatic_rollback'])


if __name__ == '__main__':
    unittest.main()
