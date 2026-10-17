#!/usr/bin/env python3
"""Severity mode and malformed-report rejection regressions."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('scan_policy', HERE / 'scan-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.report = dict(ArtifactName='fixture:ci', ArtifactType='container_image',
                           Metadata=dict(ImageConfig=dict(os='linux', architecture='amd64')),
                           Results=[dict(Class='os-pkgs', Vulnerabilities=[],
                                         Packages=[dict(Name='libc', Version='1.0')])])

    def finding(self, severity):
        report = copy.deepcopy(self.report)
        report['Results'][0]['Vulnerabilities'] = [dict(
            VulnerabilityID='CVE-TEST', PkgName='fixture', Severity=severity)]
        return report

    def test_strict_high_critical_and_diagnostic_retention(self):
        for severity in ('HIGH', 'CRITICAL'):
            report = self.finding(severity)
            self.assertEqual(policy.evaluate(report)['gate'], 'BLOCKED')
            summary = policy.evaluate(report, diagnostic=True)
            self.assertEqual(summary['gate'], 'DIAGNOSTIC')
            self.assertEqual(summary['findings'], {severity: 1})
            self.assertTrue(summary['high_critical_present'])

    def test_low_medium_pass(self):
        for severity in ('LOW', 'MEDIUM'):
            self.assertEqual(policy.evaluate(self.finding(severity))['gate'], 'PASS')

    def test_malformed_and_missing_os_fail_even_diagnostic(self):
        cases = [None, [], {}, {**self.report, 'Results': []},
                 {**self.report, 'Results': [dict(Class='lang-pkgs')]},
                 {**self.report, 'Results': ['bad']},
                 {**self.report, 'Results': [dict(Class='os-pkgs', Vulnerabilities=None)]},
                 {**self.report, 'Results': [dict(Class='os-pkgs', Vulnerabilities=[{}])]},
                 {**self.report, 'Metadata': dict(ImageConfig=dict(os='linux', architecture='arm64'))}]
        for report in cases:
            with self.subTest(report=report), self.assertRaises((ValueError, TypeError)):
                policy.evaluate(report, diagnostic=True)

    def test_environment_requires_os_scan_and_strict(self):
        report = {**self.finding('HIGH'), 'ArtifactType': 'filesystem'}
        report.pop('Metadata')
        self.assertEqual(policy.evaluate_environment(report)['gate'], 'BLOCKED')
        with self.assertRaises(ValueError):
            policy.evaluate_environment(self.report)

    def test_component_requires_package_inventory(self):
        report = dict(ArtifactType='filesystem', ArtifactName='/component',
                      Results=[dict(Class='lang-pkgs', Packages=[dict(Name='npm')])])
        self.assertEqual(policy.evaluate_environment(report, component=True)['gate'], 'PASS')
        for packages in (None, [], 'bad'):
            report['Results'][0]['Packages'] = packages
            with self.assertRaises(ValueError):
                policy.evaluate_environment(report, component=True)

    def test_os_inventory_required_for_image_and_rootfs(self):
        for packages in (None, [], 'bad', [{}], [dict(Name='libc')],
                         [dict(Name='libc', Version='')]):
            report = copy.deepcopy(self.report)
            report['Results'][0]['Packages'] = packages
            with self.subTest(packages=packages):
                with self.assertRaises(ValueError):
                    policy.evaluate(report, diagnostic=True)
                report['ArtifactType'] = 'filesystem'
                with self.assertRaises(ValueError):
                    policy.evaluate_environment(report)

    def test_cli_missing_truncated_unknown_mode_and_optimized_python(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            for content in (None, '{"Results":'):
                if content is not None:
                    path.write_text(content)
                result = subprocess.run(['python3', '-O', str(HERE / 'scan-policy.py'), str(path),
                                         '--diagnostic'], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)['gate'], 'INVALID')
            path.write_text(json.dumps(self.finding('CRITICAL')))
            result = subprocess.run(['python3', '-O', str(HERE / 'scan-policy.py'), str(path)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            result = subprocess.run(['python3', str(HERE / 'scan-policy.py'), str(path), '--unknown'],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
