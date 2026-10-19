#!/usr/bin/env python3
"""Fail-closed scope/freshness tests; no filesystem scan is executed locally."""
import copy
import hashlib
import json
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('environment_evidence', Path(__file__).with_name('environment-evidence.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.db = dict(Version=2, UpdatedAt=(self.now - timedelta(hours=1)).isoformat(),
                       DownloadedAt=self.now.isoformat(), NextUpdate=(self.now + timedelta(hours=4)).isoformat())
        self.evidence = dict(source_kind='actual-job-filesystem', environment_id='backend', platform='linux/x86_64',
                             workspace='/checkout', rootfs_excluded_dirs=['/proc', '/checkout'],
                             component_target='/checkout/backend/node_modules', rootfs_artifact_name='runner-host', executed_tools_target='/evidence/executed-tools', executed_tools=[dict(id='trivy', version=dict(exit_code=0, stdout='Version: 0.76.0'))], source_commit='a' * 40,
                             global_npm_manifests=[dict(name='npm', version='11.0.0', path='/usr/lib/node_modules/npm/package.json'), dict(name='bundled', version='1.0.0', path='/usr/lib/node_modules/npm/node_modules/bundled/package.json')],
                             global_npm_inventory=dict(exit_code=0, stdout=json.dumps({'dependencies': {'npm': {'version': '11.0.0'}}})),
                             global_npm_root={'exit_code': 0, 'stdout': '/usr/lib/node_modules'},
                             component_npm_manifests=[dict(name='example', version='1.0.0', path='/checkout/backend/node_modules/example/package.json')],
                             component_npm_inventory=dict(exit_code=0, stdout=json.dumps({'dependencies': {'example': {'version': '1.0.0'}}})),
                             os_package_inventory={'exit_code': 0, 'stdout': 'libc\t1\tamd64\tinstalled'},
                             tools={'node': {'exit_code': 0}, 'npm': {'exit_code': 0}})
        self.reports = {
            'tools': dict(ArtifactType='filesystem', ArtifactName='/evidence/executed-tools', Trivy={'Version':'0.76.0'}, Results=[dict(Class='lang-pkgs', Type='gobinary', Target='trivy', Packages=[dict(Name='github.com/aquasecurity/trivy', Version='v0.76.0')])]),
            'rootfs': dict(ArtifactType='filesystem', ArtifactName='runner-host', Trivy={'Version': '0.76.0'},
                           Results=[dict(Class='os-pkgs', Packages=[{'Name': 'libc', 'Version': '1', 'Arch': 'amd64'}]),
                                    dict(Class='lang-pkgs', Type='node-pkg', Target='Node.js', Packages=[
                                        dict(Name='npm', Version='11.0.0', FilePath='usr/lib/node_modules/npm/package.json'),
                                        dict(Name='bundled', Version='1.0.0', FilePath='usr/lib/node_modules/npm/node_modules/bundled/package.json')])]),
            'global-npm': dict(ArtifactType='filesystem', ArtifactName='/usr/lib/node_modules', Trivy={'Version': '0.76.0'},
                               Results=[dict(Class='lang-pkgs', Type='node-pkg', Packages=[
                                   dict(Name='npm', Version='11.0.0', FilePath='npm/package.json'),
                                   dict(Name='bundled', Version='1.0.0', FilePath='npm/node_modules/bundled/package.json')])]),
            'component': dict(ArtifactType='filesystem', ArtifactName='/checkout/backend/node_modules', Trivy={'Version': '0.76.0'},
                              Results=[dict(Class='lang-pkgs', Type='node-pkg', Packages=[dict(Name='example', Version='1.0.0', FilePath='example/package.json')])])}

    def check(self):
        module.validate(self.evidence, self.reports, self.db, self.now)

    def test_staged_binary_preserves_mode_bytes_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'staged'
            source.write_bytes(b'synthetic-executable-fixture')
            source.chmod(0o751)
            original = source.stat()
            digest = module.stage_executed_binary(source, target)
            self.assertEqual(source.read_bytes(), target.read_bytes())
            self.assertEqual(source.stat().st_mode & 0o777, 0o751)
            self.assertEqual(target.stat().st_mode & 0o777, 0o751)
            self.assertEqual(source.stat().st_mtime_ns, original.st_mtime_ns)
            self.assertEqual(len(digest), 64)
            source.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'executable mode'):
                module.stage_executed_binary(source, target)

    def test_executed_tool_version_failure_blocks(self):
        self.evidence['executed_tools'][0]['version']['exit_code'] = 1
        with self.assertRaisesRegex(ValueError, 'version command failed'):
            self.check()
        self.evidence['executed_tools'][0]['version'].update(exit_code=0, stdout='')
        with self.assertRaisesRegex(ValueError, 'version command failed'):
            self.check()

    def test_wrong_binary_target_or_language_cannot_cover_tool(self):
        tool = self.reports['tools']['Results'][0]
        tool['Target'] = 'unrelated/trivy'
        with self.assertRaisesRegex(ValueError, 'executed tool'):
            self.check()
        tool['Target'] = 'trivy'
        tool['Type'] = 'npm'
        with self.assertRaisesRegex(ValueError, 'executed tool'):
            self.check()

    def test_missing_executed_binary_inventory_blocks(self):
        self.reports['tools']['Results'] = []
        with self.assertRaisesRegex(ValueError, 'executed tool'):
            self.check()

    def test_rootfs_hostname_is_observed_identity(self):
        self.check()
        self.reports['rootfs']['ArtifactName'] = '/'
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.check()

    def test_actual_environment(self):
        self.check()

    def test_host_platform_requires_supported_provider_identity(self):
        evidence = copy.deepcopy(self.evidence)
        evidence['os_release'] = 'ID=ubuntu\nVERSION_ID="24.04"\n'
        evidence['environment_id'] = 'frontend'
        evidence['github'] = dict(runner_environment='github-hosted', runner_os='Linux', runner_arch='X64',
                                  image_os='ubuntu24', image_version='20261018.1.0')
        module.validate_host_platform_identity(evidence)
        for key, value in (('runner_environment', 'self-hosted'), ('runner_os', 'Windows'),
                           ('runner_arch', 'ARM64'), ('image_os', 'ubuntu26'), ('image_version', '')):
            changed = copy.deepcopy(evidence)
            changed['github'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.validate_host_platform_identity(changed)
        evidence['os_release'] = 'ID=debian\nVERSION_ID="12"\n'
        with self.assertRaisesRegex(ValueError, 'does not match'):
            module.validate_host_platform_identity(evidence)

    def test_release_tool_contract_requires_exact_registry_and_bound_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'skopeo-closure.json'
            closure = dict(format='homecloud-skopeo-apt-closure-v1', source_commit='a' * 40,
                           run_id='123', attempt='1', image_os='ubuntu24', image_version='20261018.1.0')
            path.write_text(json.dumps(closure))
            with patch.dict('os.environ', dict(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1',
                                               ImageOS='ubuntu24', ImageVersion='20261018.1.0')):
                with patch.object(module.subprocess, 'check_output', return_value='a' * 40 + '\n'):
                    registrations = [dict(id=name, path='/usr/bin/'+name) for name in ('docker', 'gh', 'skopeo')]
                    self.assertEqual(len(module.validate_skopeo_tool_contract('release-images', registrations, str(path))), 64)
                    with self.assertRaisesRegex(ValueError, 'exactly the tools'):
                        module.validate_skopeo_tool_contract('release-images', registrations[:2], str(path))
                    with self.assertRaisesRegex(ValueError, 'complete apt closure'):
                        module.validate_skopeo_tool_contract('release-images', registrations, None)
                    closure['attempt'] = '2'
                    path.write_text(json.dumps(closure))
                    with self.assertRaisesRegex(ValueError, 'source/run/runner'):
                        module.validate_skopeo_tool_contract('release-images', registrations, str(path))
                    closure['attempt'] = '1'
                    path.write_text(json.dumps(closure))
                    skopeo_only = [dict(id='skopeo', path='/usr/bin/skopeo')]
                    self.assertEqual(len(module.validate_skopeo_tool_contract(
                        'skopeo-qualification', skopeo_only, str(path))), 64)
                    for invalid in (skopeo_only + [dict(id='gh', path='/usr/bin/gh')], registrations[:2]):
                        with self.assertRaisesRegex(ValueError, 'exactly the tools'):
                            module.validate_skopeo_tool_contract('skopeo-qualification', invalid, str(path))
                    with self.assertRaisesRegex(ValueError, 'complete apt closure'):
                        module.validate_skopeo_tool_contract('skopeo-qualification', skopeo_only, None)

    def test_release_scan_requires_complete_closure_artifact_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            closure = root / 'skopeo-closure.json'
            summary = root / 'skopeo-closure-summary.json'
            rootfs = root / 'rootfs.json'
            closure_data = dict(source_commit='a'*40, run_id='123', attempt='1',
                                skopeo=dict(sha256='b'*64, path='/usr/bin/skopeo'))
            closure.write_text(json.dumps(closure_data))
            rootfs.write_text('{"Results":[]}')
            summary_data = dict(gate='PASS', evidence_sha256=hashlib.sha256(closure.read_bytes()).hexdigest(),
                                rootfs_report_sha256=hashlib.sha256(rootfs.read_bytes()).hexdigest())
            summary.write_text(json.dumps(summary_data))
            evidence = dict(environment_id='release-images', source_commit='a'*40,
                            github=dict(run_id='123', run_attempt='1'),
                            skopeo_closure_sha256=summary_data['evidence_sha256'],
                            executed_tools=[dict(id=name, sha256='b'*64 if name == 'skopeo' else 'c'*64,
                                                 real_path='/usr/bin/skopeo' if name == 'skopeo' else '/usr/bin/'+name)
                                            for name in ('docker', 'gh', 'skopeo', 'trivy')])
            self.assertEqual(module.validate_skopeo_closure_artifacts(evidence, root)['gate'], 'PASS')
            evidence['environment_id'] = 'skopeo-qualification'
            evidence['executed_tools'] = [tool for tool in evidence['executed_tools'] if tool['id'] in ('skopeo', 'trivy')]
            self.assertEqual(module.validate_skopeo_closure_artifacts(evidence, root)['gate'], 'PASS')
            evidence['executed_tools'].append(dict(id='gh', sha256='c'*64, real_path='/usr/bin/gh'))
            with self.assertRaisesRegex(ValueError, 'incomplete executed tool set'):
                module.validate_skopeo_closure_artifacts(evidence, root)
            summary.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing strict'):
                module.validate_skopeo_closure_artifacts(evidence, root)

    def test_skopeo_pr_qualification_is_read_only_and_required_by_gate(self):
        workflow = Path(__file__).parents[2] / '.github/workflows/ci.yml'
        text = workflow.read_text()
        start = text.index('  skopeo-qualification:\n')
        end = text.index('  policy-coverage:\n', start)
        job = text[start:end]
        gate_start = text.index('  gate:\n', end)
        gate = text[gate_start:]
        self.assertIn('permissions:\n      contents: read', job)
        self.assertIn('name: environment-skopeo-qualification-', job)
        self.assertIn('homecloud-skopeo-qualification-start-v1', job)
        self.assertIn('homecloud-skopeo-qualification-result-v1', job)
        self.assertIn('status="PASS" if job == "success" and scan == "success" else "BLOCKED"', job)
        self.assertIn('        if: always()\n        with:', job)
        self.assertIn('skopeo-tools.json', job)
        self.assertIn('shutil.which("skopeo")', job)
        self.assertNotIn('packages: write', job)
        for forbidden in ('secrets.', 'docker/login-action', 'gh api', 'GH_TOKEN', 'ghcr.io'):
            self.assertNotIn(forbidden, job)
        needs = next(line for line in gate.splitlines() if line.strip().startswith('needs:'))
        self.assertIn('skopeo-qualification', needs)

    def test_checkout_exclusion_mandatory(self):
        self.evidence['rootfs_excluded_dirs'] = ['/proc']
        with self.assertRaisesRegex(ValueError, 'Checkout'):
            self.check()

    def test_image_report_cannot_substitute_environment(self):
        self.reports['rootfs']['ArtifactType'] = 'container_image'
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.check()

    def test_target_binding(self):
        self.reports['component']['ArtifactName'] = '/checkout'
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.check()

    def test_missing_component_inventory_blocks(self):
        self.reports['component']['Results'][0]['Packages'] = []
        with self.assertRaisesRegex(ValueError, 'absent|inventory'):
            self.check()

    def test_stale_database_blocks(self):
        self.db['UpdatedAt'] = (self.now - timedelta(days=2)).isoformat()
        with self.assertRaisesRegex(ValueError, 'Stale'):
            self.check()

    def test_mismatched_platform_blocks(self):
        self.evidence['platform'] = 'darwin/arm64'
        with self.assertRaisesRegex(ValueError, 'Linux'):
            self.check()

    def test_java_inventory_requires_fresh_identification_db(self):
        self.reports['rootfs']['Results'].append(dict(Class='lang-pkgs', Type='jar', Packages=[{'Name': 'jar'}]))
        with self.assertRaisesRegex(ValueError, 'Java'):
            self.check()
        java = dict(Version=1, UpdatedAt=(self.now - timedelta(days=3)).isoformat(),
                    DownloadedAt=self.now.isoformat(), NextUpdate=(self.now + timedelta(days=1)).isoformat())
        module.validate(self.evidence, self.reports, self.db, self.now, java)
        java['NextUpdate'] = (self.now - timedelta(minutes=1)).isoformat()
        with self.assertRaisesRegex(ValueError, 'Java'):
            module.validate(self.evidence, self.reports, self.db, self.now, java)

    def test_missing_installed_os_package_blocks(self):
        self.evidence['os_package_inventory']['stdout'] += '\nlibmissing\t2\tamd64\tinstalled'
        with self.assertRaisesRegex(ValueError, 'Installed OS package absent'):
            self.check()

    def test_os_versions_reconstruct_epoch_release(self):
        self.evidence['os_package_inventory']['stdout'] = 'libc:amd64\t2:1.2.3-4+deb12u1\tamd64\tinstalled'
        self.reports['rootfs']['Results'][0]['Packages'][0].update(Version='1.2.3', Epoch=2, Release='4+deb12u1')
        self.check()
        self.evidence['os_package_inventory']['stdout'] = 'libc\t0:1.2.3-4+deb12u1\tamd64\tinstalled'
        self.reports['rootfs']['Results'][0]['Packages'][0]['Epoch'] = 0
        self.check()

    def test_successful_npm_optional_empty_slots_are_not_installed(self):
        inventory = dict(exit_code=0, stdout=json.dumps({'dependencies': {
            'installed': {'version': '1', 'dependencies': {'optional': {}}}}}))
        self.assertEqual(module.inventory_graph(inventory), {('installed', '1')})
        inventory['stdout'] = json.dumps({'dependencies': {'bad': {'resolved': 'https://example.test'}}})
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            module.inventory_graph(inventory)
        inventory['stdout'] = json.dumps({'dependencies': {'bad': {'missing': True}}})
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            module.inventory_graph(inventory)

    def test_npm_alias_matches_manifest_canonical_identity(self):
        manifests = [dict(name='canonical', version='1', path='/usr/lib/node_modules/alias/package.json')]
        graph = dict(exit_code=0, stdout=json.dumps({'dependencies': {'alias': {'version': '1'}}}))
        report = dict(Results=[dict(Class='lang-pkgs', Type='node-pkg', Target='Node.js', Packages=[dict(Name='canonical', Version='1', FilePath='usr/lib/node_modules/alias/package.json')])])
        module.validate_installed(report, manifests, graph, '/')
        report['Results'][0]['Packages'][0]['Name'] = 'alias'
        with self.assertRaisesRegex(ValueError, 'absent'):
            module.validate_installed(report, manifests, graph, '/')

    def test_global_inventory_command_failure_blocks(self):
        self.evidence['global_npm_inventory']['exit_code'] = 1
        with self.assertRaisesRegex(ValueError, 'command failed'):
            self.check()

    def test_lockfile_only_report_cannot_cover_installed_manifest(self):
        self.reports['component']['Results'][0]['Packages'][0]['FilePath'] = 'package-lock.json'
        with self.assertRaisesRegex(ValueError, 'absent'):
            self.check()

    def test_bundled_npm_package_omission_blocks(self):
        self.reports['rootfs']['Results'][1]['Packages'].pop()
        with self.assertRaisesRegex(ValueError, 'bundled'):
            self.check()

    def test_npm_graph_must_match_installed_manifests(self):
        self.evidence['component_npm_inventory']['stdout'] = json.dumps({'dependencies': {'missing': {'version': '9.0.0'}}})
        with self.assertRaisesRegex(ValueError, 'cover npm graph'):
            self.check()

    def test_manifest_traversal_ignores_external_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = root / 'node_modules'
            modules.mkdir()
            package = modules / 'safe'
            package.mkdir()
            (package / 'package.json').write_text(json.dumps(dict(name='safe', version='1')))
            (modules / 'outside').symlink_to('/checkout/scripts')
            (package / 'node_modules').symlink_to('/checkout/scripts')
            self.assertEqual(module.installed_manifests(modules, '/checkout'),
                             [dict(name='safe', version='1', path=str((package / 'package.json').resolve()))])
            with self.assertRaisesRegex(ValueError, 'outside checkout'):
                module.installed_manifests('/checkout/node_modules', '/checkout')

    def test_scope_rejects_checkout_or_symlink_component(self):
        with self.assertRaises(ValueError):
            module.scopes('/', 'none')
        with self.assertRaises(ValueError):
            module.scopes('/checkout', '../scripts')
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'backend').symlink_to('/tmp')
            with self.assertRaises(ValueError):
                module.scopes(directory, 'backend')


if __name__ == '__main__':
    unittest.main()
