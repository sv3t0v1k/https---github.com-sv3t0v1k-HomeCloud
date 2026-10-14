#!/usr/bin/env python3
"""Adversarial freshness/identity cases and end-to-end severity gate checks."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('scan_evidence', HERE / 'scan-evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.metadata = dict(Version=2, UpdatedAt=(self.now-timedelta(hours=1)).isoformat(),
                             DownloadedAt=self.now.isoformat(),
                             NextUpdate=(self.now+timedelta(hours=12)).isoformat())
        self.report = dict(ArtifactName='fixture:ci', ArtifactType='container_image',
                           Trivy=dict(Version='0.75.0'),
                           Metadata=dict(ImageID='sha256:fixture',
                                         ImageConfig=dict(os='linux', architecture='amd64')),
                           Results=[dict(Class='os-pkgs', Type='alpine', Vulnerabilities=[],
                                         Packages=[dict(Name='libc', Version='1.0')])])

    def test_fresh(self):
        evidence.validate(self.report, self.metadata, 'fixture:ci', self.now)

    def test_trivy_nanoseconds(self):
        self.assertEqual(evidence.timestamp('2026-10-14T07:11:52.271767627Z'),
                         datetime(2026, 10, 14, 7, 11, 52, 271767, tzinfo=timezone.utc))

    def test_invalid_db(self):
        for changes in (dict(Version=1), dict(UpdatedAt=(self.now-timedelta(hours=25)).isoformat()),
                        dict(UpdatedAt=(self.now+timedelta(hours=1)).isoformat()),
                        dict(DownloadedAt=(self.now+timedelta(hours=1)).isoformat()),
                        dict(DownloadedAt=(self.now-timedelta(hours=3)).isoformat()),
                        dict(NextUpdate=self.now.isoformat()), dict(UpdatedAt='2026-10-14T00:00:00')):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                evidence.validate(self.report, {**self.metadata, **changes}, 'fixture:ci', self.now)

    def test_wrong_target_platform_scanner(self):
        for change in (dict(ArtifactName='other:ci'), dict(Trivy=dict(Version='unknown')),
                       dict(Metadata=dict(ImageConfig=dict(os='linux', architecture='arm64')))):
            with self.subTest(change=change), self.assertRaises(ValueError):
                evidence.validate({**self.report, **change}, self.metadata, 'fixture:ci', self.now)

    def invoke(self, severity=None, metadata=None, source='remote', mode=None, invalid=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(self.report)
            if source == 'archive':
                report['ArtifactName'] = str(root/'image.oci')
            if invalid:
                report['Results'] = [dict(Class='lang-pkgs')]
            if severity:
                report['Results'][0]['Vulnerabilities'] = [dict(
                    VulnerabilityID='CVE-TEST', PkgName='fixture', Severity=severity)]
            (root/'fixture.json').write_text(json.dumps(report))
            (root/'cache/db').mkdir(parents=True)
            (root/'cache/db/metadata.json').write_text(json.dumps(metadata or self.metadata))
            scanner = root/'trivy'
            scanner.write_text('''#!/usr/bin/env python3
import os,pathlib,sys
args=sys.argv[1:]
assert args[args.index('--ignorefile')+1] == '/dev/null'
assert args[args.index('--config')+1] == '/dev/null'
assert '--ignore-unfixed=false' in args
assert '--list-all-pkgs' in args
if os.environ['SOURCE'] == 'archive':
    assert '--input' in args and '--image-src' not in args
else:
    assert args[args.index('--image-src')+1] == os.environ['SOURCE']
pathlib.Path(args[args.index('--output')+1]).write_text(pathlib.Path(os.environ['FIXTURE']).read_text())
''')
            scanner.chmod(0o700)
            output = root/'scan.json'
            arguments = ['sh', str(HERE/'scan-image.sh'), str(scanner), source,
                         report['ArtifactName'], str(output)]
            if mode:
                arguments.append(mode)
            result = subprocess.run(arguments, capture_output=True, text=True,
                                    env={**os.environ, 'FIXTURE': str(root/'fixture.json'),
                                         'SOURCE': source})
            sidecar = json.loads(output.with_suffix('.evidence.json').read_text())
            self.assertEqual(json.loads(output.read_text()), report)
            return result.returncode, sidecar

    def test_severity_still_blocks(self):
        for severity in ('HIGH', 'CRITICAL'):
            with self.subTest(severity=severity):
                code, sidecar = self.invoke(severity)
                self.assertNotEqual(code, 0)
                self.assertEqual(sidecar['evidence_status'], 'PASS')  # Evidence validity, not release approval.

    def test_clean_and_medium(self):
        for severity in (None, 'MEDIUM'):
            code, sidecar = self.invoke(severity)
            self.assertEqual(code, 0)
            self.assertEqual(sidecar['requested_reference'], 'fixture:ci')

    def test_archive_exact_input_and_default_strict(self):
        code, sidecar = self.invoke(source='archive')
        self.assertEqual(code, 0)
        self.assertEqual(sidecar['source_kind'], 'archive')
        code, _ = self.invoke(source='archive', severity='HIGH')
        self.assertNotEqual(code, 0)

    def test_diagnostic_severity_does_not_hide_invalidity(self):
        code, _ = self.invoke(severity='CRITICAL', mode='diagnostic')
        self.assertEqual(code, 0)
        code, _ = self.invoke(severity='CRITICAL', mode='diagnostic', invalid=True)
        self.assertNotEqual(code, 0)
        code, sidecar = self.invoke(mode='diagnostic', metadata={**self.metadata,
                                   'UpdatedAt': (self.now-timedelta(hours=25)).isoformat()})
        self.assertNotEqual(code, 0)
        self.assertEqual(sidecar['evidence_status'], 'BLOCKED')

    def test_unknown_source_rejected(self):
        with self.assertRaises(ValueError):
            evidence.validate(self.report, self.metadata, 'fixture:ci', self.now, 'unknown')

    def test_stale_sidecar_retained(self):
        code, sidecar = self.invoke(metadata={**self.metadata,
                                             'UpdatedAt': (self.now-timedelta(hours=25)).isoformat()})
        self.assertNotEqual(code, 0)
        self.assertEqual(sidecar['evidence_status'], 'BLOCKED')
        self.assertIn('24 hours', sidecar['error'])


if __name__ == '__main__':
    unittest.main()
