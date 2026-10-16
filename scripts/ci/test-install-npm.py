#!/usr/bin/env python3
"""Защита npm bootstrap: checksum до процесса, host guard и очистка при сбое."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('install_npm', Path(__file__).with_name('install-npm.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class NpmBootstrapTests(unittest.TestCase):
    def test_mac_local_and_self_hosted_fail_before_network_or_commands(self):
        with patch.object(bootstrap.urllib.request, 'urlopen') as download, \
                patch.object(bootstrap.subprocess, 'run') as run:
            for system, env in [('Darwin', {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}),
                                ('Linux', {}),
                                ('Linux', {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'self-hosted'})]:
                with patch.object(bootstrap.platform, 'system', return_value=system), \
                        patch.dict(bootstrap.os.environ, env, clear=True):
                    with self.assertRaises(ValueError):
                        bootstrap.main()
            download.assert_not_called()
            run.assert_not_called()

    def test_invalid_temporary_root_rejected(self):
        with patch.object(bootstrap.platform, 'system', return_value='Linux'):
            for root in ['', 'relative', '/homecloud-npm-bootstrap-missing']:
                with self.assertRaises(ValueError):
                    bootstrap.context({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                                       'RUNNER_TEMP': root})

    def test_corrupted_archive_rejected_before_lookup_or_npm(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'npm.tgz'
            archive.write_bytes(b'altered archive')
            with patch.object(bootstrap.shutil, 'which') as lookup, \
                    patch.object(bootstrap.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    bootstrap.install(archive, Path(directory) / 'cache')
                lookup.assert_not_called()
                run.assert_not_called()

    def test_verified_archive_installs_offline_without_scripts_and_checks_version(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'npm.tgz'
            archive.write_bytes(b'verified fixture')
            cache = Path(directory) / 'cache'
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            with patch.object(bootstrap, 'SHA256', digest), \
                    patch.object(bootstrap.shutil, 'which', return_value='/ci/bin/npm'), \
                    patch.object(bootstrap.subprocess, 'run') as run, \
                    patch.object(bootstrap.subprocess, 'check_output', return_value='11.21.1\n') as version:
                bootstrap.install(archive, cache)
                command = run.call_args.args[0]
                self.assertEqual(command, ['/ci/bin/npm', 'install', '--global', '--ignore-scripts',
                                           '--no-audit', '--no-fund', '--offline', '--cache', str(cache), str(archive)])
                self.assertTrue(run.call_args.kwargs['check'])
                self.assertEqual(version.call_args.args[0], ['/ci/bin/npm', '--version'])

    def test_version_mismatch_and_install_failure_are_fatal(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'npm.tgz'
            archive.write_bytes(b'verified fixture')
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            with patch.object(bootstrap, 'SHA256', digest), \
                    patch.object(bootstrap.shutil, 'which', return_value='/ci/bin/npm'), \
                    patch.object(bootstrap.subprocess, 'run') as run, \
                    patch.object(bootstrap.subprocess, 'check_output', return_value='11.19.0\n') as version:
                with self.assertRaises(ValueError):
                    bootstrap.install(archive, Path(directory) / 'cache')
                version.reset_mock()
                run.side_effect = subprocess.CalledProcessError(1, 'npm')
                with self.assertRaises(subprocess.CalledProcessError):
                    bootstrap.install(archive, Path(directory) / 'cache')
                version.assert_not_called()

    def test_download_directory_removed_when_install_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(bootstrap, 'context', return_value=root), \
                    patch.object(bootstrap.urllib.request, 'urlopen') as download, \
                    patch.object(bootstrap, 'install', side_effect=ValueError('failed')):
                download.return_value.__enter__.return_value.read.return_value = b'archive'
                with self.assertRaises(ValueError):
                    bootstrap.main()
                download.assert_called_once_with(bootstrap.URL, timeout=60)
                self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
