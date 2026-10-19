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
        for field in ['source_commit', 'github']:
            changed = copy.deepcopy(self.record)
            changed[field] = 'b'*40 if field == 'source_commit' else {**self.github, 'run_attempt': '2'}
            with self.assertRaises(ValueError):
                minimize.validate(changed, 'a'*40, self.github)

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
