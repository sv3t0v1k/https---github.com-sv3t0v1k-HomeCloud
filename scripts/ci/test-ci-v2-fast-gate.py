#!/usr/bin/env python3
"""Negative routing checks for the proposed Fast/Integration aggregate gate."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ci_v2_fast_gate', Path(__file__).with_name('ci-v2-fast-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FastGateTests(unittest.TestCase):
    def setUp(self):
        self.results = {name: {'result': 'success'} for name in gate.REQUIRED}

    def test_complete_current_run_passes(self):
        gate.validate(self.results)

    def test_missing_job_blocks(self):
        self.results.pop('backend')
        with self.assertRaisesRegex(ValueError, 'Missing'):
            gate.validate(self.results)

    def test_skipped_or_failed_job_blocks(self):
        for name in gate.REQUIRED:
            for state in ('skipped', 'failure', 'cancelled', None):
                with self.subTest(name=name, state=state):
                    results = {key: dict(value) for key, value in self.results.items()}
                    results[name]['result'] = state
                    with self.assertRaisesRegex(ValueError, 'failed or skipped'):
                        gate.validate(results)

    def test_test_push_allows_only_pr_qualification_skip(self):
        self.results['recovery-qualification']['result'] = 'skipped'
        gate.validate(self.results, 'push')
        for name in gate.REQUIRED - {'recovery-qualification'}:
            with self.subTest(name=name):
                results = {key: dict(value) for key, value in self.results.items()}
                results[name]['result'] = 'skipped'
                with self.assertRaisesRegex(ValueError, 'failed or skipped'):
                    gate.validate(results, 'push')

    def test_test_push_cannot_hide_a_failed_qualification(self):
        for state in ('failure', 'cancelled', None):
            with self.subTest(state=state):
                self.results['recovery-qualification']['result'] = state
                with self.assertRaisesRegex(ValueError, 'failed or skipped'):
                    gate.validate(self.results, 'push')

    def test_unknown_event_refused(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            gate.validate(self.results, 'workflow_dispatch')


if __name__ == '__main__':
    unittest.main()
