#!/usr/bin/env python3
"""Fail-closed scope/freshness tests; no filesystem scan is executed locally."""
import copy
import json
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('environment_evidence', Path(__file__).with_name('environment-evidence.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.db = dict(Version=2, UpdatedAt=(self.now - timedelta(hours=1)).isoformat(),
                       DownloadedAt=self.now.isoformat(), NextUpdate=(self.now + timedelta(hours=4)).isoformat())
        self.evidence = dict(source_kind='actual-job-filesystem', platform='linux/x86_64',
                             workspace='/checkout', rootfs_excluded_dirs=['/proc', '/checkout'],
                             component_target='/checkout/backend', source_commit='a' * 40,
                             global_npm_manifests=[dict(name='npm', version='11.0.0', path='/usr/lib/node_modules/npm/package.json'), dict(name='bundled', version='1.0.0', path='/usr/lib/node_modules/npm/node_modules/bundled/package.json')],
                             global_npm_inventory=dict(exit_code=0, stdout=json.dumps({'dependencies': {'npm': {'version': '11.0.0'}}})),
                             component_npm_manifests=[dict(name='example', version='1.0.0', path='/checkout/backend/node_modules/example/package.json')],
                             component_npm_inventory=dict(exit_code=0, stdout=json.dumps({'dependencies': {'example': {'version': '1.0.0'}}})),
                             os_package_inventory={'exit_code': 0, 'stdout': 'libc\t1\tamd64\tinstalled'},
                             tools={'node': {'exit_code': 0}, 'npm': {'exit_code': 0}})
        self.reports = {
            'rootfs': dict(ArtifactType='filesystem', ArtifactName='/', Trivy={'Version': '0.75.0'},
                           Results=[dict(Class='os-pkgs', Packages=[{'Name': 'libc', 'Version': '1', 'Arch': 'amd64'}]),
                                    dict(Class='lang-pkgs', Type='node-pkg', Target='Node.js', Packages=[
                                        dict(Name='npm', Version='11.0.0', FilePath='usr/lib/node_modules/npm/package.json'),
                                        dict(Name='bundled', Version='1.0.0', FilePath='usr/lib/node_modules/npm/node_modules/bundled/package.json')])]),
            'component': dict(ArtifactType='filesystem', ArtifactName='/checkout/backend', Trivy={'Version': '0.75.0'},
                              Results=[dict(Class='lang-pkgs', Type='npm', Packages=[dict(Name='example', Version='1.0.0', FilePath='node_modules/example/package.json')])])}

    def check(self):
        module.validate(self.evidence, self.reports, self.db, self.now)

    def test_actual_environment(self):
        self.check()

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
