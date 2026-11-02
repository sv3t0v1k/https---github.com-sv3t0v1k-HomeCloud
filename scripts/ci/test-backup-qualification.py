#!/usr/bin/env python3
"""Disposable backup qualification command and refusal contracts; no Docker calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backup_qualification_installer', ROOT / 'deploy/linux/test-channel.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class BackupQualification(unittest.TestCase):
    def exercise(self, failure=None):
        commands = []
        state = {'schema_migrations': [{'name': 'Initial123'}]}

        def run(*args, **kwargs):
            commands.append((args, kwargs))
            if 'image' in args and 'inspect' in args:
                volumes = {'/evil': {}} if failure == 'volumes' else {'/var/lib/postgresql/data': {}}
                return json.dumps([{'Id': 'sha256:' + '1' * 64, 'Config': {'Volumes': volumes}}])
            if 'SELECT 1' in args and failure == 'ready':
                raise installer.Stop('not ready')
            if 'psql' in args:
                if 'SELECT 1' in args:
                    return '1'
                return 'Different123' if failure == 'migration' else 'Initial123'
            if 'rm' in args and failure == 'cleanup':
                raise installer.Stop('cleanup failed')
            return ''

        def restore(args, **kwargs):
            commands.append((tuple(args), kwargs))
            if 'logs' in args:
                return subprocess.CompletedProcess(args, 0,
                    stdout='PostgreSQL init process complete', stderr='')
            if failure == 'timeout':
                raise subprocess.TimeoutExpired(args, kwargs['timeout'])
            return subprocess.CompletedProcess(args, 1 if failure == 'restore' else 0)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'backup.sql.gz'
            path.write_bytes(b'fixture')
            with patch.object(installer, 'compose', return_value=json.dumps({'services': {'db': {'image': 'postgres:16-alpine'}}})), \
                 patch.object(installer, 'run', side_effect=run), \
                 patch.object(installer.subprocess, 'run', side_effect=restore), \
                 patch.object(installer.time, 'sleep'):
                if failure:
                    with self.assertRaises((installer.Stop, subprocess.TimeoutExpired)):
                        installer.validate_backup_database(path, {'DB_USER': 'homecloud', 'DB_NAME': 'homecloud'}, state)
                else:
                    installer.validate_backup_database(path, {'DB_USER': 'homecloud', 'DB_NAME': 'homecloud'}, state)
        return commands

    def test_success_uses_isolated_bounded_database_and_cleans_up(self):
        commands = self.exercise()
        create = next(args for args, _ in commands if 'create' in args)
        for option in ('--read-only', '--security-opt', '--memory', '--memory-swap', '--cpus', '--pids-limit'):
            self.assertIn(option, create)
        self.assertEqual(create[create.index('--network') + 1], 'none')
        self.assertNotIn('--volume', create)
        self.assertNotIn('-v', create)
        self.assertNotIn('--mount', create)
        self.assertEqual(create.count('--tmpfs'), 3)
        self.assertIn('no-new-privileges', create)
        restore, kwargs = next((args, kwargs) for args, kwargs in commands if 'exec' in args and '-i' in args)
        self.assertIn('ON_ERROR_STOP=1', restore[-1])
        self.assertEqual(kwargs['timeout'], 300)
        self.assertIsNotNone(kwargs['stdin'])
        self.assertIn('rm', commands[-1][0])
        self.assertIn('-v', commands[-1][0])
        self.assertEqual(commands[-1][1]['timeout'], 30)

    def test_restore_failure_cleanup_and_refusal(self):
        self.assertIn('rm', self.exercise('restore')[-1][0])

    def test_restore_timeout_cleanup_and_refusal(self):
        self.assertIn('rm', self.exercise('timeout')[-1][0])

    def test_migration_mismatch_cleanup_and_refusal(self):
        self.assertIn('rm', self.exercise('migration')[-1][0])

    def test_readiness_timeout_cleanup_and_refusal(self):
        commands = self.exercise('ready')
        self.assertEqual(sum('SELECT 1' in args for args, _ in commands), 30)
        self.assertIn('rm', commands[-1][0])

    def test_cleanup_failure_refuses_install(self):
        self.exercise('cleanup')

    def test_unsupported_image_volumes_refused_before_create(self):
        commands = self.exercise('volumes')
        self.assertFalse(any('create' in args for args, _ in commands))

    def test_backup_configuration_checked_before_privileged_script(self):
        with patch.object(installer, 'backup_configuration', side_effect=installer.Stop('unsafe backup root')), \
             patch.object(installer, 'run') as run:
            with self.assertRaises(installer.Stop):
                installer.backup({})
            run.assert_not_called()

    def test_backup_configuration_binds_all_runtime_values(self):
        with patch.object(installer.boundary, 'validate_backup_configuration', return_value={'JWT_SECRET': 'other'}), \
             patch.object(installer, 'env_values', return_value={'JWT_SECRET': 'original'}):
            with self.assertRaises(installer.Stop):
                installer.backup_configuration()

    def test_invalid_database_name_refused_before_docker(self):
        with patch.object(installer, 'compose') as compose:
            with self.assertRaises(installer.Stop):
                installer.validate_backup_database(Path('/unused'), {'DB_USER': 'x', 'DB_NAME': 'bad-name'}, {})
            compose.assert_not_called()


if __name__ == '__main__':
    unittest.main()
