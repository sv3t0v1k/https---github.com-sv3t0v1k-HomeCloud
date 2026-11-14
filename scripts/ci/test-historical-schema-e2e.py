#!/usr/bin/env python3
"""Generate old-schema backup fixtures; actual restoration is driven by Bash.

Only inside the isolated nested E2E daemon. Source PG has private tmpfs/network;
the generator cannot address the target DB. No host source/data mounts.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tarfile
import time

SCHEMAS = (7, 8, 9, 10, 11, 13, 15)
PAYLOAD = b"HomeCloud backup restore proof\n"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from restore_storage import LEGACY_IDENTITY_BYTES as MARKER


def run(args, **kwargs):
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=180, **kwargs).stdout
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b'').decode(errors='replace')[-2000:]
        detail = re.sub(r'postgres(?:ql)?://\S+', '[redacted fixture DB URL]', detail)
        raise ValueError('Historical fixture child failed: ' + ' '.join(args[:2]) + ': ' + detail) from None
    except subprocess.TimeoutExpired:
        raise ValueError('Historical fixture child timed out: ' + ' '.join(args[:2])) from None


def fixture_guard():
    if (Path.cwd() != Path('/opt/homecloud') or not Path('/.dockerenv').is_file()
            or os.environ.get('DOCKER_HOST') != 'unix:///var/run/docker.sock'
            or os.environ.get('COMPOSE_PROJECT_NAME') != 'homecloud-restore-e2e'
            or os.environ.get('DB_NAME') != 'fixture' or os.environ.get('DB_USER') != 'fixture'):
        raise ValueError('Historical fixture producer requires the isolated nested E2E daemon')


def produce_database(count, backend, postgres):
    password = secrets.token_hex(24)
    cid = run(['docker', 'create', '--network', 'none', '--read-only',
               '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
               '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1073741824',
               '--tmpfs', '/var/run/postgresql:rw,noexec,nosuid,size=16777216',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216',
               '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture', '-e', 'POSTGRES_PASSWORD=' + password,
               postgres, 'postgres', '-c', 'listen_addresses=127.0.0.1']).decode().strip()
    if not re.fullmatch('[0-9a-f]{64}', cid):
        raise ValueError('Invalid source fixture container identity')
    try:
        run(['docker', 'start', cid])
        for _ in range(40):
            ready = subprocess.run(['docker', 'exec', cid, 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'fixture'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise ValueError('Historical source PostgreSQL did not become ready')
        version = run(['docker', 'exec', cid, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fixture', '-d', 'fixture', '-At', '-c', 'SHOW server_version']).decode().strip()
        if version != '16.15':
            raise ValueError('Historical source PostgreSQL must be16.15')
        script = Path('scripts/ci/historical-schema-producer.cjs').read_bytes()
        report = json.loads(run(['docker', 'run', '--rm', '-i', '--pull=never',
                                 '--network', 'container:' + cid, '--read-only', '--user', '1001:65533',
                                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                                 '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
                                 '--tmpfs', '/storage:rw,noexec,nosuid,size=67108864,uid=1001,gid=65533,mode=0700',
                                 '-e', 'STORAGE_PATH=/storage', '-e', 'HISTORY_DATABASE_URL=postgres://fixture:' + password + '@127.0.0.1:5432/fixture',
                                 '--entrypoint', 'node', backend, '-', str(count)], input=script))
        if report['table_count'] != count or len(report['tables']) != count:
            raise ValueError('Historical fixture schema count mismatch')
        if report['payload_sha256'] != hashlib.sha256(PAYLOAD).hexdigest():
            raise ValueError('Historical fixture payload mismatch')
        dump = run(['docker', 'exec', cid, 'pg_dump', '-U', 'fixture', '-d', 'fixture', '--no-owner', '--no-privileges'])
        return dump, report
    finally:
        # A failed cleanup fails qualification; never remove any unowned name.
        run(['docker', 'rm', '-fv', cid])


def package_backup(original, destination, dump, report, marker):
    if marker != MARKER:
        raise ValueError('Unexpected fixture storage identity')
    metadata_paths = list(original.glob('homecloud_*.meta'))
    if len(metadata_paths) != 1:
        raise ValueError('Exactly one baseline backup required')
    metadata_path = metadata_paths[0]
    meta = json.loads(metadata_path.read_bytes())
    for key in ('db_dump', 'storage_archive'):
        if Path(meta[key]).name != meta[key]:
            raise ValueError('Unexpected backup artifact path')
    destination.mkdir(mode=0o700)
    db = destination / meta['db_dump']
    db.write_bytes(gzip.compress(dump, mtime=0))
    archive = destination / meta['storage_archive']
    with tarfile.open(archive, 'w:gz') as target:
        directory = tarfile.TarInfo('./historical')
        directory.type, directory.mode, directory.uid, directory.gid = tarfile.DIRTYPE, 0o700, 1001, 65533
        target.addfile(directory)
        for name, content in (('./historical/before-backup.txt', PAYLOAD), ('./.homecloud-storage-identity', marker)):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.uid, entry.gid = len(content), 0o600, 1001, 65533
            target.addfile(entry, io.BytesIO(content))
    meta.update(db_dump_size=db.stat().st_size, db_dump_sha256=hashlib.sha256(db.read_bytes()).hexdigest(),
                storage_archive_size=archive.stat().st_size, storage_archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                storage_file_count=2, migration_count=report['migration_count'])
    metadata = json.dumps(meta, sort_keys=True, indent=2).encode() + b'\n'
    (destination / metadata_path.name).write_bytes(metadata)
    (destination / (metadata_path.name + '.sha256')).write_text(hashlib.sha256(metadata).hexdigest() + '  ' + metadata_path.name + '\n')
    for member in destination.iterdir():
        member.chmod(0o600)


def main():
    fixture_guard()
    count = int(sys.argv[1])
    if count not in SCHEMAS:
        raise ValueError('Unsupported historical fixture count')
    destination = Path(sys.argv[2])
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise ValueError('Fresh absolute fixture destination required')
    original = Path(os.environ['BACKUP_DIR'])
    work = original.parent
    if (not work.is_absolute() or work.resolve(strict=True) != work
            or work.parent != Path('/tmp') or not work.name.startswith('homecloud-e2e.')
            or destination.parent != work or destination.name != 'historical-schema-' + str(count)):
        raise ValueError('Historical fixture paths must remain in the owned private E2E directory')
    if Path('/proc/1/cgroup').read_text().strip() != '0::/homecloud-e2e-init':
        raise ValueError('Historical fixture requires the delegated private cgroup namespace')
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in original.iterdir() if p.is_file()}
    backend = run(['docker', 'image', 'inspect', '-f', '{{.Id}}', os.environ['BACKEND_IMAGE']]).decode().strip()
    postgres = run(['docker', 'image', 'inspect', '-f', '{{.Id}}', 'postgres:16-alpine']).decode().strip()
    for image, allowed in ((backend, set()), (postgres, {'/var/lib/postgresql/data', '/var/run/postgresql', '/tmp'})):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise ValueError('Invalid fixture image identity')
        volumes = json.loads(run(['docker', 'image', 'inspect', '-f', '{{json .Config.Volumes}}', image])) or {}
        if not isinstance(volumes, dict) or not set(volumes).issubset(allowed):
            raise ValueError('Unexpected implicit fixture image volume')
    dump, report = produce_database(count, backend, postgres)
    package_backup(original, destination, dump, report, Path('/mnt/hc-e2e/storage/.homecloud-storage-identity').read_bytes())
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in original.iterdir() if p.is_file()}
    print(json.dumps({'event': 'historical_schema_fixture_created', **report, 'baseline_unchanged': True, 'source_container_removed': True}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('STOP: historical fixture generation: ' + str(error), file=sys.stderr)
        sys.exit(1)
