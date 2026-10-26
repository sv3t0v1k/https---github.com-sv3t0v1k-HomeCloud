#!/usr/bin/env python3
"""Adversarial aggregate coverage tests; environment contract has its own suite."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('coverage_policy', Path(__file__).with_name('policy-coverage.py'))
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = 'a'*40
        now = datetime.now(timezone.utc)
        self.db = dict(Version=2, UpdatedAt=(now-timedelta(hours=1)).isoformat(),
                       DownloadedAt=now.isoformat(), NextUpdate=(now+timedelta(hours=12)).isoformat())
        self.lock = json.loads(Path(__file__).with_name('production-images.lock.json').read_text())

    def write(self, name, value):
        p = self.root/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value))
        return p

    def report(self, name, image=True, high=False):
        return dict(ArtifactName=name, ArtifactType='container_image' if image else 'filesystem',
                    Trivy=dict(Version='0.76.0'),
                    Metadata=dict(ImageID='sha256:'+'b'*64, ImageConfig=dict(os='linux', architecture='amd64')),
                    Results=[dict(Class='os-pkgs', Packages=[dict(Name='libc', Version='1')],
                                  Vulnerabilities=[dict(PkgName='libc', VulnerabilityID='CVE-TEST', Severity='HIGH')] if high else [])])

    def test_missing_image_language_inventory_blocks(self):
        self.fixture()
        p = self.root/'image-backend.json'
        report = json.loads(p.read_text())
        report['Results'] = report['Results'][:1]
        p.write_text(json.dumps(report))
        binding = self.root/'backend.binding.json'
        data = json.loads(binding.read_text())
        data['scan_sha256'] = 'sha256:'+coverage.sha(p)
        binding.write_text(json.dumps(data))
        result = coverage.qualify(self.root, self.source)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertTrue(any('Missing installed Node' in error for error in result['errors']))

    def fixture(self):
        for role in (*coverage.RUNTIME, *coverage.STAGES, 'buildkit'):
            name = 'image-'+role+'.json' if role in ('backend', 'frontend') else role+'.scan.json'
            report = self.report('/tmp/'+role+'.tar')
            if role == 'backend' or role in coverage.STAGES:
                report['Results'].append(dict(Class='lang-pkgs', Type='node-pkg', Packages=[dict(Name='npm', Version='11')]))
            p = self.write(name, report)
            self.write(str(p.relative_to(self.root).with_suffix('.evidence.json')),
                       dict(evidence_status='PASS', source_kind='archive', vulnerability_db=self.db,
                            requested_reference='/tmp/'+role+'.tar'))
            platform = self.lock[role].split('@')[1] if role in self.lock else 'sha256:'+'c'*64
            self.write(role+'.binding.json', dict(format='homecloud-qualified-artifact-v1', role=role,
                       source_commit=self.source, platform='linux/amd64', binding='ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED',
                       platform_digest=platform, config_digest='sha256:'+'b'*64, archive_sha256='sha256:'+'d'*64,
                       scan_sha256='sha256:'+coverage.sha(p)))
            if role in ('backend', 'frontend'):
                self.write(role+'.loaded.binding.json', dict(binding='LOADED_EXACT_OCI_CONFIG_AND_FILESYSTEM',
                           role=role, source_commit=self.source, platform_digest=platform, config_digest='sha256:'+'b'*64))
            if role in coverage.STAGES:
                progress = self.write(role+'.progress.jsonl', {'fixture': 'cached'})
                metadata = self.write(role+'.build.json', {'fixture': 'built'})
                self.write(role+'.cache.json', dict(status='CACHED_RUNTIME_BUILD_OPERATIONS', role=role, source_commit=self.source,
                           config_digest='sha256:'+'b'*64, runtime_platform_digest='sha256:'+'c'*64,
                           progress_sha256=coverage.sha(progress), metadata_sha256=coverage.sha(metadata)))
        for name in coverage.ENVIRONMENTS:
            p = self.write('env-'+name+'/rootfs.json', self.report('/', image=False))
            rootfs_report = json.loads(p.read_text())
            rootfs_report['ArtifactName'] = 'runner-host' if name not in ('backend', 'pr-fast-backend') else 'container-root'
            p.write_text(json.dumps(rootfs_report))
            component = coverage.COMPONENTS.get(name, 'none')
            reports = {'rootfs': coverage.sha(p)}
            global_report = self.report('/usr/lib/node_modules', image=False)
            global_report['Results'] = [dict(Class='lang-pkgs', Type='node-pkg', Packages=[
                dict(Name='npm', Version='11'), dict(Name='bundled', Version='1')])]
            global_path = self.write('env-'+name+'/global-npm.json', global_report)
            reports['global-npm'] = coverage.sha(global_path)
            tools_report = self.report('/evidence/executed-tools', image=False)
            tools_report['Results'] = [dict(Class='lang-pkgs', Type='gobinary', Packages=[dict(Name='stdlib', Version='1')])]
            tp = self.write('env-'+name+'/tools.json', tools_report)
            reports['tools'] = coverage.sha(tp)
            ids = ['trivy']
            if name.startswith(('image-build-', 'base-', 'support-')):
                ids.append('image-trivy')
            if name == 'configuration':
                ids.append('compose')
            if name == 'secrets':
                ids.append('gitleaks')
            tool_paths = dict(trivy='/temp/environment-trivy/trivy', **{'image-trivy': '/temp/homecloud-trivy/trivy'}, compose='/temp/homecloud-compose-bin/docker-compose', gitleaks='/temp/gitleaks')
            tools = [dict(id=key, requested_path=tool_paths[key]) for key in ids]
            target = None
            if component != 'none':
                target = '/checkout/'+component+'/node_modules'
                r = self.report(target, image=False)
                r['Results'] = [dict(Class='lang-pkgs', Packages=[dict(Name='example', Version='1')], Vulnerabilities=[])]
                cp = self.write('env-'+name+'/component.json', r)
                reports['component'] = coverage.sha(cp)
            self.write('env-'+name+'/environment.json', dict(environment_id=name, source_commit=self.source,
                       evidence_status='PASS', report_sha256=reports, vulnerability_db=self.db,
                       workspace='/checkout', runner_temp='/temp', executed_tools=tools, component=component, component_target=target,
                       github=dict(runner_environment='github-hosted', runner_os='Linux', runner_arch='X64',
                                   image_os='ubuntu24', image_version='20261018.1.0'),
                       os_release='ID=ubuntu\nVERSION_ID="24.04"\n',
                       rootfs_artifact_name='runner-host' if name not in ('backend', 'pr-fast-backend') else 'container-root',
                       global_npm_root=dict(exit_code=0, stdout='/usr/lib/node_modules')))
        raw_lock = json.loads(Path(__file__).with_name('images.lock.json').read_text())
        for role in ('node', 'nginx', 'postgres', 'node-ci'):
            ref = ('node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd'
                   if role == 'node-ci' else raw_lock[role])
            p = self.write('image-base-'+role+'.json', self.report(ref, high=True))
            self.write(str(p.relative_to(self.root).with_suffix('.evidence.json')),
                       dict(evidence_status='PASS', source_kind='remote', vulnerability_db=self.db,
                            requested_reference=ref))

    def qualify(self, profile='release'):
        # Only the independently tested environment capture contract is abstracted here.
        with patch.object(coverage.environment, 'validate'):
            return coverage.qualify(self.root, self.source, profile)

    def test_lockfile_npm_cannot_replace_physical_inventory(self):
        self.fixture()
        p = self.root/'image-backend.json'
        report = json.loads(p.read_text())
        report['Results'][1]['Type'] = 'npm'
        p.write_text(json.dumps(report))
        binding = self.root/'backend.binding.json'
        data = json.loads(binding.read_text())
        data['scan_sha256'] = 'sha256:'+coverage.sha(p)
        binding.write_text(json.dumps(data))
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')

    def test_executed_temporary_tool_cannot_be_omitted(self):
        self.fixture()
        p = self.root/'env-configuration/environment.json'
        data = json.loads(p.read_text())
        data['executed_tools'] = data['executed_tools'][:1]
        p.write_text(json.dumps(data))
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')

    def test_empty_coverage_cannot_pass(self):
        r = self.qualify()
        self.assertEqual(r['status'], 'BLOCKED')
        self.assertEqual(r['coverage'], 'INCOMPLETE')

    def test_raw_findings_remain_visible_and_diagnostic(self):
        self.fixture()
        r = self.qualify()
        self.assertEqual(r['status'], 'PASS', r['errors'])
        self.assertTrue(all(x['findings']['HIGH'] == 1 and x['gate'] == 'DIAGNOSTIC' for x in r['raw_bases'].values()))

    def test_pull_request_profile_omits_only_raw_base_diagnostics(self):
        self.fixture()
        for role in coverage.RAW_BASES:
            report = self.root/f'image-base-{role}.json'
            report.unlink()
            report.with_suffix('.evidence.json').unlink()
        for environment in coverage.BASE_ENVIRONMENTS:
            shutil.rmtree(self.root/f'env-{environment}')
        result = self.qualify('pull-request')
        self.assertEqual(result['status'], 'PASS', result['errors'])
        self.assertEqual(result['qualification_profile'], 'pull-request')
        self.assertEqual(result['raw_bases'], {})
        self.assertFalse(set(coverage.BASE_ENVIRONMENTS) & set(result['environments']))

    def test_release_profile_still_requires_all_base_evidence(self):
        self.fixture()
        (self.root/'image-base-node.json').unlink()
        (self.root/'image-base-node.evidence.json').unlink()
        result = self.qualify('release')
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['coverage'], 'INCOMPLETE')
        self.assertTrue(any('raw_bases/node' in error for error in result['errors']))

    def test_unknown_profile_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'Unknown qualification profile'):
            self.qualify('diagnostic')

    def test_runner_findings_are_retained_separately_from_application_gates(self):
        self.fixture()
        path = self.root/'env-frontend/rootfs.json'
        report = json.loads(path.read_text())
        report['Results'][0]['Vulnerabilities'] = [dict(PkgName='runner-lib', VulnerabilityID='CVE-TEST', Severity='CRITICAL')]
        path.write_text(json.dumps(report))
        env_path = self.root/'env-frontend/environment.json'
        env = json.loads(env_path.read_text())
        env['report_sha256']['rootfs'] = coverage.sha(path)
        env_path.write_text(json.dumps(env))
        result = self.qualify()
        self.assertEqual(result['status'], 'PASS', result['errors'])
        scan = result['environments']['frontend']['scans']['rootfs']
        self.assertEqual(scan['gate'], 'PLATFORM_ASSURANCE')
        self.assertEqual(scan['findings'], {'CRITICAL': 1})
        self.assertTrue(scan['raw_findings_retained'])

    def test_global_npm_and_tools_findings_still_block(self):
        for report_name in ('global-npm', 'tools'):
            with self.subTest(report=report_name):
                self.fixture()
                path = self.root/f'env-frontend/{report_name}.json'
                report = json.loads(path.read_text())
                report['Results'][0]['Vulnerabilities'] = [dict(PkgName='runner-tool', VulnerabilityID='CVE-TEST', Severity='HIGH')]
                path.write_text(json.dumps(report))
                env_path = self.root/'env-frontend/environment.json'
                env = json.loads(env_path.read_text())
                env['report_sha256'][report_name] = coverage.sha(path)
                env_path.write_text(json.dumps(env))
                result = self.qualify()
                self.assertEqual(result['status'], 'BLOCKED', result['errors'])
                self.assertEqual(result['environments']['frontend']['scans'][report_name]['gate'], 'BLOCKED')

    def test_missing_environment_blocks(self):
        self.fixture()
        (self.root/'env-frontend/environment.json').unlink()
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')

    def test_component_cannot_be_silently_omitted(self):
        self.fixture()
        p = self.root/'env-backend/environment.json'
        data = json.loads(p.read_text())
        data.update(component='none', component_target=None)
        data['report_sha256'].pop('component')
        p.write_text(json.dumps(data))
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')

    def test_changed_scan_blocks_even_if_clean(self):
        self.fixture()
        p = self.root/'image-backend.json'
        report = json.loads(p.read_text())
        report['Metadata']['ImageID'] = 'sha256:'+'f'*64
        p.write_text(json.dumps(report))
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')

    def test_actual_runtime_high_still_blocks(self):
        self.fixture()
        report = json.loads((self.root/'image-backend.json').read_text())
        report['Results'][0]['Vulnerabilities'] = [dict(PkgName='libc', VulnerabilityID='CVE-TEST', Severity='HIGH')]
        p = self.write('image-backend.json', report)
        q = self.root/'backend.binding.json'
        proof = json.loads(q.read_text())
        proof['scan_sha256'] = 'sha256:'+coverage.sha(p)
        q.write_text(json.dumps(proof))
        r = self.qualify()
        self.assertEqual(r['coverage'], 'COVERED')
        self.assertEqual(r['status'], 'BLOCKED')

    def test_rebuilt_stage_never_counts_as_runtime_build(self):
        self.fixture()
        self.write('backend-deps.cache.json', dict(status='BLOCKED', role='backend-deps', source_commit=self.source))
        self.assertEqual(self.qualify()['coverage'], 'INCOMPLETE')


if __name__ == '__main__':
    unittest.main()
