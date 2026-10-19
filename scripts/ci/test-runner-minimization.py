#!/usr/bin/env python3
"""Adversarial host guard and retained minimization identity tests; no host mutation."""
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


minimize = module('minimize-runner')
environment = module('environment-evidence')


class MinimizationTests(unittest.TestCase):
    def setUp(self):
        self.github = dict(run_id='123', run_attempt='1', sha='c'*40,
                           job='base-image-scan', runner_environment='github-hosted')
        self.record = dict(format=minimize.FORMAT, source_commit='a'*40, github=self.github,
                           removed_paths=[minimize.TARGET], absent_after=True,
                           status='REMOVED_BEFORE_WORKLOAD', rootfs_scope_changed=False)
        self.evidence = dict(environment_id='base-node-ci', source_commit='a'*40,
                             github=self.github, runner_minimization=self.record)

    def test_exact_disposable_host_record(self):
        environment.validate_minimization(self.evidence)

    def test_missing_record_blocks(self):
        del self.evidence['runner_minimization']
        with self.assertRaises(ValueError):
            environment.validate_minimization(self.evidence)

    def test_event_sha_and_checked_out_source_are_both_bound(self):
        # A pull-request merge SHA differs from the explicitly checked-out head.
        environment.validate_minimization(self.evidence)
        self.evidence['runner_minimization'] = {**self.record, 'github': {
            key: value for key, value in self.github.items() if key != 'sha'}}
        with self.assertRaises(ValueError):
            environment.validate_minimization(self.evidence)

    def test_main_emits_actual_capture_identity(self):
        env = dict(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', GITHUB_SHA='c'*40,
                   GITHUB_JOB='base-image-scan', RUNNER_ENVIRONMENT='github-hosted')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(minimize, 'context', return_value=(root, root)), \
                    patch.object(minimize, 'TARGET', str(root/'absent-sdk')), \
                    patch.dict(minimize.os.environ, env), \
                    patch.object(minimize.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')) as run, \
                    patch.object(minimize.subprocess, 'check_output', return_value='a'*40), \
                    redirect_stdout(io.StringIO()):
                minimize.main()
            emitted = json.loads((root/'homecloud-runner-minimization.json').read_text())
            self.assertEqual(emitted['github'], self.github)
            self.assertEqual(emitted['source_commit'], self.evidence['source_commit'])
            self.assertEqual(run.call_count, 1)  # ownership query only; no sudo or removal

    def test_changed_source_or_execution_identity_blocks(self):
        for field in ['source_commit']:
            changed = copy.deepcopy(self.record)
            changed[field] = 'b'*40
            with self.assertRaises(ValueError):
                minimize.validate(changed, 'a'*40, self.github)

    def test_required_github_identity_fields_must_be_present_on_both_sides(self):
        for field in minimize.GITHUB_IDENTITY_FIELDS:
            with self.subTest(missing_record_field=field):
                changed = copy.deepcopy(self.record)
                del changed['github'][field]
                with self.assertRaisesRegex(ValueError, field):
                    minimize.validate(changed, 'a'*40, self.github)
            with self.subTest(missing_expected_field=field):
                expected = dict(self.github)
                del expected[field]
                with self.assertRaisesRegex(ValueError, field):
                    minimize.validate(self.record, 'a'*40, expected)

    def test_required_github_identity_mismatches_block_individually(self):
        for field in minimize.GITHUB_IDENTITY_FIELDS:
            changed = copy.deepcopy(self.record)
            changed['github'][field] = 'different-'+field
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                minimize.validate(changed, 'a'*40, self.github)

    def test_additional_github_fields_are_permitted(self):
        extended_environment = {**self.github, 'runner_os': 'Linux', 'runner_arch': 'X64',
                                'image_os': 'ubuntu24', 'image_version': '20261018.1.0',
                                'context_marker': 'environment-only'}
        extended_record = copy.deepcopy(self.record)
        extended_record['github']['image_version'] = '20261018.1.0'
        extended_record['github']['context_marker'] = 'record-only'
        minimize.validate(extended_record, 'a'*40, extended_environment)

    def test_malformed_context_shapes_and_required_values_block(self):
        with self.assertRaises(ValueError):
            minimize.validate([], 'a'*40, self.github)
        changed = copy.deepcopy(self.record)
        changed['github'] = None
        with self.assertRaises(ValueError):
            minimize.validate(changed, 'a'*40, self.github)
        with self.assertRaises(ValueError):
            minimize.validate(self.record, 'a'*40, [])
        for field in minimize.GITHUB_IDENTITY_FIELDS:
            for invalid in ('', None, 1):
                changed = copy.deepcopy(self.record)
                changed['github'][field] = invalid
                with self.subTest(side='record', field=field, value=invalid), self.assertRaisesRegex(ValueError, field):
                    minimize.validate(changed, 'a'*40, self.github)
                expected = dict(self.github)
                expected[field] = invalid
                with self.subTest(side='expected', field=field, value=invalid), self.assertRaisesRegex(ValueError, field):
                    minimize.validate(self.record, 'a'*40, expected)

    def test_deleted_scope_or_scan_exclusion_cannot_substitute(self):
        for field, value in [('removed_paths', ['/usr/share']), ('removed_paths', []),
                             ('rootfs_scope_changed', True), ('absent_after', False),
                             ('status', 'SKIPPED')]:
            with self.assertRaises(ValueError):
                minimize.validate({**self.record, field: value}, 'a'*40, self.github)

    def test_local_mac_and_non_hosted_linux_rejected_before_any_command(self):
        with patch.object(minimize.subprocess, 'run') as run:
            for env in [{}, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'self-hosted'}]:
                with self.assertRaises(ValueError):
                    minimize.context(env)
            with patch.object(minimize.platform, 'system', return_value='Darwin'):
                with self.assertRaises(ValueError):
                    minimize.context({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'})
            run.assert_not_called()

    def test_host_rootfs_is_retained_and_classified_separately(self):
        script = Path(__file__).with_name('scan-environment.sh').read_text()
        self.assertIn('--parallel 0 --timeout 60m', script)
        self.assertNotIn('/usr/share/dotnet', script)
        self.assertNotIn('--skip-files', script)
        self.assertIn('--platform-host-evidence', script)
        self.assertIn('if [ "$environment_id" = backend ]', script)


if __name__ == '__main__':
    unittest.main()
