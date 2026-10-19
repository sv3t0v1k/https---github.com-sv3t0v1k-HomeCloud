#!/usr/bin/env python3
"""Adversarial tests for the apt-installed skopeo dependency closure."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('skopeo_closure', HERE / 'skopeo-closure.py')
closure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(closure)


class SkopeoClosureTests(unittest.TestCase):
    @staticmethod
    def compare_versions(actual, operator, expected):
        left, right = tuple(map(int, actual.split('.'))), tuple(map(int, expected.split('.')))
        return {'=': left == right, '>=': left >= right, '<=': left <= right,
                '>': left > right, '<': left < right, '>>': left > right, '<<': left < right}[operator]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'etc/apt').mkdir(parents=True)
        (self.root / 'var/lib/apt/lists').mkdir(parents=True)
        (self.root / 'var/cache/apt/archives').mkdir(parents=True)
        (self.root / 'etc/apt/sources.list.d').mkdir()
        sources = self.root / 'etc/apt/sources.list.d/ubuntu.sources'
        sources.write_text('deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main\n')
        self.indexes = []
        self.indexes.append(dict(path='etc/apt/sources.list.d/ubuntu.sources', sha256=closure.sha256(sources)))
        for relative, content in (('var/lib/apt/lists/archive_InRelease', 'signed release fixture'),
                                  ('var/lib/apt/lists/archive_main_Packages', 'package index fixture')):
            path = self.root / relative
            path.write_text(content)
            self.indexes.append(dict(path=relative, sha256=hashlib.sha256(content.encode()).hexdigest()))
        keyring = self.root / 'usr/share/keyrings/ubuntu-archive-keyring.gpg'
        keyring.parent.mkdir(parents=True)
        keyring.write_bytes(b'fixture trusted keyring')
        apt_config = 'APT::Get::AllowUnauthenticated "false";\n'
        update_log = self.root / 'apt-update.log'
        update_log.write_text('apt-get update succeeded\n')
        self.baseline = 'libc6:amd64\t2.39\tamd64\tinstalled\t\t\t\tno\n'
        self.installed = ('libc6:amd64\t2.39\tamd64\tinstalled\t\t\t\tno\n'
                          'skopeo:amd64\t1.16.1\tamd64\tinstalled\t\tlibc6 (>= 2.34)\t\tno\n')
        self.lib = self.root / 'usr/lib/x86_64-linux-gnu/libc.so.6'
        self.lib.parent.mkdir(parents=True)
        self.lib.write_bytes(b'fixture libc')
        self.binary = self.root / 'usr/bin/skopeo'
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b'fixture skopeo executable')
        self.deb = self.root / 'var/cache/apt/archives/skopeo_1.16.1_amd64.deb'
        self.deb.write_bytes(b'fixture apt archive')
        self.evidence = dict(
            format=closure.FORMAT, source_commit='a' * 40, run_id='123', attempt='1', native_arch='amd64',
            image_os='ubuntu24', image_version='20261018.1.0',
            baseline_packages=self.baseline,
            baseline_sha256=hashlib.sha256(self.baseline.encode()).hexdigest(),
            installed_packages=self.installed,
            installed_inventory_sha256=hashlib.sha256(self.installed.encode()).hexdigest(),
            apt_metadata=dict(files=self.indexes, sources=[self.indexes[0]],
                              keyrings=[dict(path='usr/share/keyrings/ubuntu-archive-keyring.gpg', sha256=closure.sha256(keyring))],
                              apt_config=apt_config, apt_config_sha256=hashlib.sha256(apt_config.encode()).hexdigest()),
            apt_update=dict(command=['apt-get', 'update', '--error-on=any'], exit_code=0,
                            log_path='apt-update.log', log_sha256=closure.sha256(update_log)),
            packages=[
                dict(package=dict(name='libc6', package='libc6:amd64', version='2.39', arch='amd64', pre_depends='', depends='', provides=[], multi_arch='no'),
                     files=[dict(path=str(self.lib), kind='file', sha256=closure.sha256(self.lib))],
                     origin=dict(kind='github-hosted-image', image_os='ubuntu24', image_version='20261018.1.0')),
                dict(package=dict(name='skopeo', package='skopeo:amd64', version='1.16.1', arch='amd64', pre_depends='', depends='libc6 (>= 2.34)', provides=[], multi_arch='no'),
                     files=[dict(path=str(self.binary), kind='file', sha256=closure.sha256(self.binary))],
                     origin=dict(kind='signed-apt-index', source='skopeo', filename='pool/main/s/skopeo/skopeo_1.16.1_amd64.deb',
                                 archive_sha256=closure.sha256(self.deb), repository_origins=['500 https://archive.ubuntu.com/ubuntu noble/main amd64 Packages'],
                                 archive_path='var/cache/apt/archives/skopeo_1.16.1_amd64.deb'))],
            skopeo=dict(path=str(self.binary), sha256=closure.sha256(self.binary),
                        ldd=[dict(path=str(self.lib), resolved_path=str(self.lib), sha256=closure.sha256(self.lib), owners=['libc6:amd64'])]))
        self.rootfs = dict(ArtifactType='filesystem', ArtifactName='runner-host', Trivy={'Version': '0.76.0'},
                           Results=[dict(Class='os-pkgs',
                                         Packages=[dict(Name='libc6', Version='2.39', Arch='amd64'),
                                                   dict(Name='skopeo', Version='1.16.1', Arch='amd64'),
                                                   dict(Name='bash', Version='5.2', Arch='amd64')],
                                         Vulnerabilities=[dict(VulnerabilityID='CVE-PLATFORM', PkgName='bash', InstalledVersion='5.2', Severity='HIGH')])])

    def check(self):
        live = dict(installed_packages=self.installed, native_arch='amd64',
                    files={('libc6', 'amd64'): self.evidence['packages'][0]['files'],
                           ('skopeo', 'amd64'): self.evidence['packages'][1]['files']},
                    skopeo_sha256=self.evidence['skopeo']['sha256'], ldd=self.evidence['skopeo']['ldd'])
        return closure.validate_evidence(self.evidence, self.rootfs, 'a' * 40, '123', '1',
                                         'ubuntu24', '20261018.1.0', live, str(self.root),
                                         compare=lambda actual, operator, expected: actual == expected or operator == '>=' and actual == '2.39')

    def test_complete_closure_passes_while_unrelated_host_findings_remain(self):
        result = self.check()
        self.assertEqual(result['gate'], 'PASS')
        self.assertEqual(result['packages'], 2)

    def test_v1_evidence_is_rejected_after_closure_format_upgrade(self):
        self.evidence['format'] = 'homecloud-skopeo-apt-closure-v1'
        with self.assertRaisesRegex(ValueError, 'Missing or unsupported skopeo closure evidence'):
            self.check()

    def test_v1_baseline_is_rejected_explicitly(self):
        path = self.root / 'old-baseline.json'
        path.write_text(json.dumps(dict(format='homecloud-skopeo-apt-closure-v1')))
        with self.assertRaisesRegex(ValueError, 'Missing or unsupported skopeo baseline evidence format'):
            closure.capture(str(path), str(self.root / 'out.json'), str(self.binary), '0')

    def test_unknown_package_dependency_blocks(self):
        packages = closure.inventory(self.installed)
        packages[('skopeo', 'amd64')]['depends'] = 'libunknown (>= 1)'
        with self.assertRaisesRegex(ValueError, r'Unresolved installed dependency.*field=depends relation=libunknown \(>= 1\)'):
            closure.dependency_closure(packages, 'skopeo', compare=lambda *_: True)

    def test_all_elf_owner_roots_are_included(self):
        packages = closure.inventory('skopeo\t1\tamd64\tinstalled\t\t\t\tno\nlibelf\t1\tamd64\tinstalled\t\t\t\tno\n')
        self.assertEqual(closure.dependency_closure(packages, ['skopeo', 'libelf']),
                         {('skopeo', 'amd64'), ('libelf', 'amd64')})

    def test_ubuntu_container_network_stack_virtual_dependency_resolves_via_provides(self):
        packages = closure.inventory(
            'golang-github-containers-common\t0.57.4+ds1-2ubuntu0.2\tall\tinstalled\t'
            '\tcontainer-network-stack, golang-github-containers-image\t\tno\n'
            'containernetworking-plugins:amd64\t1.1.1+ds1-3ubuntu0.24.04.3\tamd64\tinstalled\t'
            '\t\tcontainer-network-stack (= 1)\tno\n'
            'golang-github-containers-image\t5.29.2\tall\tinstalled\t\t\t\tno\n')
        self.assertEqual(
            closure.dependency_closure(packages, 'golang-github-containers-common'),
            {('golang-github-containers-common', 'all'),
             ('containernetworking-plugins', 'amd64'),
             ('golang-github-containers-image', 'all')})

    def test_versioned_virtual_provides_must_satisfy_requested_version(self):
        packages = closure.inventory(
            'consumer\t1\tamd64\tinstalled\t\tvirtual-network (>= 2)\t\tno\n'
            'provider:amd64\t1\tamd64\tinstalled\t\t\tvirtual-network (= 2)\tno\n')
        self.assertEqual(closure.dependency_closure(packages, 'consumer', compare=self.compare_versions),
                         {('consumer', 'amd64'), ('provider', 'amd64')})
        packages[('consumer', 'amd64')]['depends'] = 'virtual-network (>= 3)'
        with self.assertRaisesRegex(ValueError, 'Unresolved installed dependency'):
            closure.dependency_closure(packages, 'consumer', compare=self.compare_versions)

    def test_unversioned_provide_cannot_satisfy_versioned_dependency(self):
        packages = closure.inventory(
            'consumer\t1\tamd64\tinstalled\t\tvirtual-network (>= 1)\t\tno\n'
            'provider:amd64\t1\tamd64\tinstalled\t\t\tvirtual-network\tno\n')
        with self.assertRaisesRegex(ValueError, 'Unresolved installed dependency'):
            closure.dependency_closure(packages, 'consumer', compare=self.compare_versions)

    def test_native_and_any_qualifiers_enforce_architecture_metadata(self):
        packages = closure.inventory(
            'consumer\t1\tamd64\tinstalled\t\tlibnative:native, liballowed:any\t\tno\n'
            'libnative:arm64\t1\tarm64\tinstalled\t\t\t\tforeign\n'
            'liballowed:arm64\t1\tarm64\tinstalled\t\t\t\tno\n')
        with self.assertRaisesRegex(ValueError, 'field=depends relation=libnative:native'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('libnative', 'arm64')]['multi_arch'] = 'allowed'
        with self.assertRaisesRegex(ValueError, 'field=depends relation=libnative:native'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('consumer', 'amd64')]['depends'] = 'liballowed:any'
        with self.assertRaisesRegex(ValueError, 'field=depends relation=liballowed:any'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('liballowed', 'arm64')]['multi_arch'] = 'allowed'
        self.assertIn(('liballowed', 'arm64'), closure.dependency_closure(
            packages, 'consumer', native_arch='amd64'))

    def test_architecture_all_is_native_arch_not_a_wildcard(self):
        packages = closure.inventory(
            'consumer:arm64\t1\tarm64\tinstalled\t\tvirtual-lib, virtual-lib:arm64, virtual-lib:native\t\tno\n'
            'virtual-lib\t1\tall\tinstalled\t\t\t\tno\n')
        with self.assertRaisesRegex(ValueError, 'field=depends relation=virtual-lib'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('consumer', 'arm64')]['depends'] = 'virtual-lib:arm64'
        with self.assertRaisesRegex(ValueError, 'relation=virtual-lib:arm64'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('consumer', 'arm64')]['depends'] = 'virtual-lib:native'
        self.assertEqual(closure.dependency_closure(packages, 'consumer', native_arch='amd64'),
                         {('consumer', 'arm64'), ('virtual-lib', 'all')})

    def test_unqualified_cross_arch_requires_multi_arch_foreign(self):
        packages = closure.inventory(
            'consumer:arm64\t1\tarm64\tinstalled\t\tlibcommon\t\tno\n'
            'libcommon:amd64\t1\tamd64\tinstalled\t\t\t\tsame\n')
        with self.assertRaisesRegex(ValueError, 'Unresolved installed dependency'):
            closure.dependency_closure(packages, 'consumer', native_arch='amd64')
        packages[('libcommon', 'amd64')]['multi_arch'] = 'foreign'
        self.assertIn(('libcommon', 'amd64'), closure.dependency_closure(
            packages, 'consumer', native_arch='amd64'))

    def test_unsupported_dependency_grammar_blocks(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported Debian dependency expression'):
            closure.relation_groups('libc6 [amd64]')

    def test_high_or_critical_in_closure_blocks(self):
        for severity in ('HIGH', 'CRITICAL'):
            with self.subTest(severity=severity):
                self.rootfs['Results'][0]['Vulnerabilities'] = [
                    dict(VulnerabilityID='CVE-CLOSURE', PkgName='libc6', InstalledVersion='2.39', Severity=severity)]
                with self.assertRaisesRegex(ValueError, 'High/Critical'):
                    self.check()

    def test_missing_closure_package_in_scan_blocks(self):
        self.rootfs['Results'][0]['Packages'] = self.rootfs['Results'][0]['Packages'][1:]
        with self.assertRaisesRegex(ValueError, 'missing from rootfs scan inventory'):
            self.check()

    def test_missing_apt_source_hash_blocks(self):
        self.evidence['packages'][1]['origin']['archive_sha256'] = 'bad'
        with self.assertRaisesRegex(ValueError, 'Incomplete apt package source/hash'):
            self.check()

    def test_downloaded_archive_hash_mismatch_blocks(self):
        self.deb.write_bytes(b'changed package archive')
        with self.assertRaisesRegex(ValueError, 'Downloaded apt package hash mismatch'):
            self.check()

    def test_missing_package_index_evidence_blocks(self):
        self.evidence['apt_metadata']['files'] = [item for item in self.indexes if 'Packages' not in item['path']]
        with self.assertRaisesRegex(ValueError, 'Incomplete APT Release or package index'):
            self.check()

    def test_trusted_source_override_blocks(self):
        source = self.root / 'etc/apt/sources.list.d/ubuntu.sources'
        for value in ('yes', 'true', 'ON', '1'):
            with self.subTest(value=value):
                source.write_text(f'deb [trusted={value}] http://example.invalid/ubuntu noble main\n')
                self.evidence['apt_metadata']['sources'][0]['sha256'] = closure.sha256(source)
                self.evidence['apt_metadata']['files'][0]['sha256'] = closure.sha256(source)
                with self.assertRaisesRegex(ValueError, 'Insecure apt source override'):
                    self.check()

    def test_unconfigured_repository_origin_blocks(self):
        self.evidence['packages'][1]['origin']['repository_origins'] = [
            '500 https://untrusted.invalid/ubuntu noble/main amd64 Packages']
        with self.assertRaisesRegex(ValueError, 'not bound to an enabled apt source'):
            self.check()

    def test_origin_requires_exact_enabled_suite_and_component(self):
        configured = closure.configured_apt_repositories([
            'deb https://archive.ubuntu.com/ubuntu noble main\n'])
        self.assertTrue(closure.origin_matches_configured(
            '500 https://archive.ubuntu.com/ubuntu noble/main amd64 Packages', configured, 'amd64'))
        self.assertFalse(closure.origin_matches_configured(
            '500 https://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages', configured))
        self.assertFalse(closure.origin_matches_configured(
            '500 https://archive.ubuntu.com/ubuntu noble/universe amd64 Packages', configured, 'amd64'))
        self.assertFalse(closure.origin_matches_configured(
            '500 https://archive.ubuntu.com/ubuntu noble/main arm64 Packages', configured, 'amd64'))

    def test_redirected_global_apt_trust_root_blocks(self):
        with self.assertRaisesRegex(ValueError, 'global trust roots are redirected'):
            closure.apt_global_trust_paths('Dir::Etc::TrustedParts "/tmp/custom-keys";')

    def test_redirected_apt_source_paths_block(self):
        for setting in ('Dir::Etc::sourcelist "/tmp/sources.list";',
                        'Dir::Etc::sourceparts "/tmp/sources.d";'):
            with self.subTest(setting=setting), self.assertRaisesRegex(ValueError, 'source or configuration paths are redirected'):
                closure.apt_global_trust_paths(setting)

    def test_redirected_apt_state_and_cache_paths_block(self):
        for setting in ('Dir "/tmp/";', 'Dir::State::lists "/tmp/apt-lists";',
                        'Dir::Cache::archives "/tmp/apt-archives";',
                        'Dir::Cache::pkgcache "/tmp/pkgcache";'):
            with self.subTest(setting=setting), self.assertRaisesRegex(ValueError, 'state, index, or package cache paths are redirected'):
                closure.apt_global_trust_paths(setting)

    def test_symlinked_apt_source_evidence_blocks(self):
        source_dir = self.root / 'etc/apt/sources.list.d'
        alias = source_dir / 'alias.list'
        alias.symlink_to(source_dir / 'ubuntu.sources')
        with self.assertRaisesRegex(ValueError, 'evidence contains a symlink'):
            closure.reject_symlinks_below((self.root / 'etc/apt',))

    def test_unhandled_architecture_source_modifiers_block(self):
        for modifier in ('arch+=arm64', 'arch-=amd64'):
            with self.subTest(modifier=modifier), self.assertRaisesRegex(ValueError, 'Unsupported apt architecture source modifier'):
                closure.configured_apt_repositories([
                    f'deb [{modifier}] https://archive.ubuntu.com/ubuntu noble main\n'])

    def test_apt_update_failure_or_missing_evidence_blocks(self):
        self.evidence['apt_update']['exit_code'] = 100
        with self.assertRaisesRegex(ValueError, 'APT update evidence missing or unsuccessful'):
            self.check()
        self.evidence.pop('apt_update')
        with self.assertRaisesRegex(ValueError, 'APT update evidence missing or unsuccessful'):
            self.check()

    def test_apt_unauthenticated_configuration_blocks(self):
        for value in ('true', 'yes', 'ON', '1'):
            with self.subTest(value=value):
                config = f'APT::Get::AllowUnauthenticated "{value}";\n'
                self.evidence['apt_metadata']['apt_config'] = config
                self.evidence['apt_metadata']['apt_config_sha256'] = hashlib.sha256(config.encode()).hexdigest()
                with self.assertRaisesRegex(ValueError, 'APT insecure repository configuration is enabled'):
                    self.check()

    def test_signed_by_outside_hashed_keyring_roots_blocks(self):
        with self.assertRaisesRegex(ValueError, 'outside hashed keyring directories'):
            closure.source_signed_by_paths(['deb [signed-by=/tmp/custom.gpg] https://archive.ubuntu.com/ubuntu noble main'], self.root)

    def test_signed_by_keyring_without_hash_evidence_blocks(self):
        self.evidence['apt_metadata']['keyrings'] = []
        with self.assertRaisesRegex(ValueError, 'Incomplete APT source/index/keyring/configuration evidence'):
            self.check()

    def test_apt_update_log_hash_mismatch_blocks(self):
        (self.root / 'apt-update.log').write_text('apt-get update failed\n')
        with self.assertRaisesRegex(ValueError, 'APT update log evidence missing or changed'):
            self.check()

    def test_unknown_elf_library_owner_blocks(self):
        self.evidence['skopeo']['ldd'][0]['owners'] = ['unknown-runtime:amd64']
        with self.assertRaises(ValueError):
            self.check()

    def test_unbound_or_incomplete_vulnerability_report_blocks(self):
        self.rootfs['Results'][0]['Vulnerabilities'] = [
            dict(VulnerabilityID='CVE-MISSING-VERSION', PkgName='libc6', Severity='HIGH')]
        with self.assertRaisesRegex(ValueError, 'Malformed rootfs vulnerability'):
            self.check()
        self.rootfs['Results'][0]['Vulnerabilities'] = [
            dict(VulnerabilityID='CVE-UNKNOWN-PACKAGE', PkgName='not-in-report', InstalledVersion='1', Severity='HIGH')]
        with self.assertRaisesRegex(ValueError, 'not bound to its package inventory'):
            self.check()

    def test_changed_installed_library_blocks(self):
        self.lib.write_bytes(b'mutated libc')
        with self.assertRaisesRegex(ValueError, 'dependency file changed'):
            self.check()

    def test_missing_baseline_or_inventory_evidence_blocks(self):
        self.evidence['baseline_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Baseline package inventory hash mismatch'):
            self.check()

    def test_run_and_runner_identity_are_bound(self):
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            closure.validate_evidence(self.evidence, self.rootfs, 'a' * 40, '124', '1',
                                      'ubuntu24', '20261018.1.0', {}, str(self.root))
        self.evidence['packages'][0]['origin']['image_version'] = '20261017.1.0'
        with self.assertRaisesRegex(ValueError, 'Baseline package source identity mismatch'):
            self.check()


if __name__ == '__main__':
    unittest.main()
