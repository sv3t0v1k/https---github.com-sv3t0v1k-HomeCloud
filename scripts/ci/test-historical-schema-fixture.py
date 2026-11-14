#!/usr/bin/env python3
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('historical_fixture', Path(__file__).with_name('test-historical-schema-e2e.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class HistoricalFixtureTests(unittest.TestCase):
    def test_archive_and_exact_metadata_hashes_preserve_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / 'original'
            original.mkdir()
            name = 'homecloud_20261114_010203_abcdef12.meta'
            meta = {'db_dump': 'homecloud_db_20261114_010203_abcdef12.sql.gz',
                    'storage_archive': 'homecloud_storage_20261114_010203_abcdef12.tar.gz'}
            content = json.dumps(meta).encode()
            (original / name).write_bytes(content)
            destination = root / 'historical'
            fixture.package_backup(original, destination, b'fixture SQL', {'migration_count': 18}, fixture.MARKER)
            self.assertEqual((original / name).read_bytes(), content)
            result = json.loads((destination / name).read_bytes())
            self.assertEqual(result['migration_count'], 18)
            self.assertEqual(result['storage_file_count'], 2)
            self.assertEqual(gzip.decompress((destination / meta['db_dump']).read_bytes()), b'fixture SQL')
            for member, key in ((meta['db_dump'], 'db_dump_sha256'), (meta['storage_archive'], 'storage_archive_sha256')):
                self.assertEqual(hashlib.sha256((destination / member).read_bytes()).hexdigest(), result[key])
            sidecar = (destination / (name + '.sha256')).read_text()
            self.assertEqual(sidecar, hashlib.sha256((destination / name).read_bytes()).hexdigest() + '  ' + name + '\n')
            with tarfile.open(destination / meta['storage_archive']) as archive:
                self.assertEqual(archive.extractfile('./historical/before-backup.txt').read(), fixture.PAYLOAD)
                self.assertEqual(archive.extractfile('./.homecloud-storage-identity').read(), fixture.MARKER)

    def test_wrong_historical_marker_refused_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'must-not-exist'
            with self.assertRaisesRegex(ValueError, 'storage identity'):
                fixture.package_backup(Path(temporary), destination, b'', {}, b'wrong marker')
            self.assertFalse(destination.exists())

    def test_fixture_cannot_use_host_docker(self):
        with patch.dict(fixture.os.environ, {'DOCKER_HOST': 'unix:///host/docker.sock'}), patch.object(fixture, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'isolated nested'):
                fixture.fixture_guard()
        run.assert_not_called()

    def test_generator_failure_removes_only_its_source_container(self):
        calls = []
        cid = 'a' * 64
        def command(args, **kwargs):
            calls.append(args)
            if args[:2] == ['docker', 'create']: return cid.encode()
            if args[:2] == ['docker', 'run']: raise ValueError('injected generator failure')
            if 'psql' in args: return b'16.15\n'
            return b''
        with patch.object(fixture, 'run', side_effect=command), \
             patch.object(fixture.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(ValueError, 'injected generator'):
                fixture.produce_database(7, 'backend-id', 'pg-id')
        self.assertEqual(calls[-1], ['docker', 'rm', '-fv', cid])
        create = calls[0]
        self.assertEqual(create[create.index('--network') + 1], 'none')
        self.assertNotIn('--mount', create)

    def test_child_failure_does_not_print_fixture_credentials(self):
        secret = 'must-stay-private'
        args = ['docker', 'run', '-e', 'HISTORY_DATABASE_URL=postgres://fixture:' + secret + '@127.0.0.1:5432/fixture']
        failure = subprocess.CalledProcessError(1, args, stderr=('postgres://fixture:' + secret + '@127.0.0.1:5432/fixture failed').encode())
        with patch.object(fixture.subprocess, 'run', side_effect=failure):
            with self.assertRaises(ValueError) as error:
                fixture.run(args)
        self.assertNotIn(secret, str(error.exception))


if __name__ == '__main__':
    unittest.main()
