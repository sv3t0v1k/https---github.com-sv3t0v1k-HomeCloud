#!/usr/bin/env python3
"""Real disposable PostgreSQL/files backup drill; never uses HomeCloud images."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
BACKUP_ID = '20261103_000000_1234abcd'
DB_USER = 'hc_dr'
DB_NAME = 'hc_dr'


def run(*args, input=None):
    result = subprocess.run(args, input=input, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('disposable drill command failed: ' + ' '.join(args[:3]) +
                           ': ' + result.stderr.decode(errors='replace')[-500:])
    return result.stdout


def postgres(name):
    run('docker', 'run', '-d', '--name', name, '--network', 'none', '--read-only',
        '--security-opt', 'no-new-privileges', '--memory', '512m', '--pids-limit', '128',
        '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=536870912',
        '--tmpfs', '/var/run/postgresql:rw,nosuid,size=16777216',
        '--tmpfs', '/tmp:rw,nosuid,size=16777216',
        '-e', 'POSTGRES_USER=' + DB_USER, '-e', 'POSTGRES_DB=' + DB_NAME,
        '-e', 'POSTGRES_PASSWORD=synthetic-fixture-only', IMAGE)
    for _ in range(30):
        result = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', DB_USER,
                                 '-d', DB_NAME], capture_output=True, timeout=5)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError('disposable PostgreSQL did not become ready')


def psql(name, sql):
    return run('docker', 'exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
               '-U', DB_USER, '-d', DB_NAME, '-c', sql).decode().strip()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    if sys.platform != 'linux':
        raise RuntimeError('Linux-only disposable host drill')
    spec = importlib.util.spec_from_file_location('phase3_installer', ROOT / 'deploy/linux/test-channel.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    name = 'homecloud-phase3-drill-' + str(subprocess.run(['id', '-u'], capture_output=True,
                                                          check=True).stdout.decode().strip()) + '-' + str(time.time_ns())
    with tempfile.TemporaryDirectory(prefix='homecloud-phase3-', dir='/root') as temp:
        directory = Path(temp)
        try:
            postgres(name)
            psql(name, "CREATE TABLE migrations(name text PRIMARY KEY); "
                       "INSERT INTO migrations VALUES ('InitialSynthetic'); "
                       "CREATE TABLE fixture(value text); INSERT INTO fixture VALUES ('original');")
            db_raw = run('docker', 'exec', name, 'pg_dump', '-U', DB_USER, '-d', DB_NAME,
                         '--clean', '--if-exists')
            db_bytes = gzip.compress(db_raw)
            db_name = 'homecloud_db_' + BACKUP_ID + '.sql.gz'
            db_path = directory / db_name
            db_path.write_bytes(db_bytes)
            db_path.chmod(0o600)
            with tarfile.open(directory / ('homecloud_storage_' + BACKUP_ID + '.tar.gz'), 'w:gz') as archive:
                for filename, content in (('one.txt', b'alpha\n'), ('nested/two.txt', b'beta\n')):
                    info = tarfile.TarInfo(filename)
                    info.size = len(content)
                    info.mode = 0o600
                    archive.addfile(info, io.BytesIO(content))
            storage_name = 'homecloud_storage_' + BACKUP_ID + '.tar.gz'
            storage_path = directory / storage_name
            storage_path.chmod(0o600)
            storage_bytes = storage_path.read_bytes()
            metadata = dict(format_version='1', backup_id=BACKUP_ID,
                            db_dump=db_name, db_dump_sha256=sha(db_bytes),
                            db_dump_size=len(db_bytes), storage_archive=storage_name,
                            storage_archive_sha256=sha(storage_bytes),
                            storage_archive_size=len(storage_bytes), storage_file_count=2,
                            migration_count=1)
            meta_path = directory / ('homecloud_' + BACKUP_ID + '.meta')
            meta_raw = (json.dumps(metadata, sort_keys=True) + '\n').encode()
            meta_path.write_bytes(meta_raw)
            meta_path.chmod(0o600)
            sidecar = Path(str(meta_path) + '.sha256')
            sidecar.write_text(sha(meta_raw) + '  ' + meta_path.name + '\n')
            sidecar.chmod(0o600)
            active = {'schema_migrations': [{'name': 'InitialSynthetic'}]}
            config = {'BACKUP_DIR': str(directory), 'DB_USER': DB_USER, 'DB_NAME': DB_NAME}
            with patch.object(installer, 'backup_configuration', return_value=config), \
                 patch.object(installer, 'compose', return_value=json.dumps(
                     {'services': {'db': {'image': IMAGE}}})):
                installer.verify_backup(BACKUP_ID, active)
                print('PASS: exact installer backup verifier and isolated PostgreSQL restore')
                psql(name, "UPDATE fixture SET value='mutated'")
                run('docker', 'exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                    '-U', DB_USER, '-d', DB_NAME, input=gzip.decompress(db_bytes))
                if psql(name, 'SELECT value FROM fixture') != 'original':
                    raise AssertionError('restored fixture differs')
                print('PASS: synthetic PostgreSQL rows restored')
                with tarfile.open(storage_path, 'r:gz') as archive:
                    restored = {member.name: archive.extractfile(member).read()
                                for member in archive if member.isfile()}
                if restored != {'one.txt': b'alpha\n', 'nested/two.txt': b'beta\n'}:
                    raise AssertionError('restored storage bytes differ')
                print('PASS: synthetic storage files restored byte-for-byte')
                storage_path.write_bytes(storage_bytes + b'corruption')
                try:
                    installer.verify_backup(BACKUP_ID, active)
                except installer.Stop:
                    print('PASS: corrupt storage archive refused')
                else:
                    raise AssertionError('corrupt archive accepted')
        finally:
            cleanup = subprocess.run(['docker', 'rm', '-f', '-v', name],
                                     capture_output=True, timeout=30)
            if cleanup.returncode:
                raise RuntimeError('disposable PostgreSQL cleanup failed')


if __name__ == '__main__':
    main()
