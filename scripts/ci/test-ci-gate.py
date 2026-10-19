#!/usr/bin/env python3
"""Fail-closed tests for the required CI job set and PR-only base scan skip."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ci_gate', Path(__file__).with_name('ci-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def results(self):
        return {name: {'result': 'success'} for name in gate.REQUIRED}

    def test_successful_required_jobs_pass_in_all_profiles(self):
        for profile in gate.PROFILES:
            gate.validate(self.results(), profile)

    def test_only_pull_request_may_skip_four_base_image_scans(self):
        results = self.results()
        results['base-image-scan']['result'] = 'skipped'
        gate.validate(results, 'pull-request')
        for profile in ('main', 'release'):
            with self.subTest(profile=profile), self.assertRaisesRegex(ValueError, 'unexpectedly skipped'):
                gate.validate(results, profile)

    def test_other_skips_fail_even_in_pull_request(self):
        results = self.results()
        results['support-images']['result'] = 'skipped'
        with self.assertRaisesRegex(ValueError, 'unexpectedly skipped'):
            gate.validate(results, 'pull-request')

    def test_failed_base_scan_never_passes(self):
        results = self.results()
        results['base-image-scan']['result'] = 'failure'
        for profile in gate.PROFILES:
            with self.subTest(profile=profile), self.assertRaisesRegex(ValueError, 'failed'):
                gate.validate(results, profile)

    def test_missing_or_unknown_jobs_and_profiles_fail(self):
        results = self.results()
        results.pop('secrets')
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            gate.validate(results, 'pull-request')
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            gate.validate(self.results(), 'diagnostic')


if __name__ == '__main__':
    unittest.main()
