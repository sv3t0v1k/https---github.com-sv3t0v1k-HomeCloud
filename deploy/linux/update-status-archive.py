#!/usr/bin/python3 -IS
"""Archive only a fully verified TEST installation receipt. No recovery actions."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path('/home/hs/homecloud-test')
CHANNEL = ROOT / '.runtime/test-channel'
STATUS_DIR = Path('/var/lib/homecloud-update/status')
INBOX = Path('/var/lib/homecloud-update/inbox')
CURRENT = STATUS_DIR / 'current.json'
INSTALLED = STATUS_DIR / 'installed.json'
ARCHIVE = STATUS_DIR / 'archive'
MARKER = STATUS_DIR / 'archiving.json'
DOCKER_CONFIG = Path('/etc/homecloud-test/docker')
HASH = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
REF = re.compile(r'ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*/(?:backend|frontend)@sha256:[a-f0-9]{64}\Z')


class Refusal(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def directory(path, mode, gid):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode and
            (not hasattr(os, 'listxattr') or
             not os.listxattr(path, follow_symlinks=False)), 'unsafe directory')


def trusted_parents(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022 and
                (not hasattr(os, 'listxattr') or
                 not os.listxattr(parent, follow_symlinks=False)),
                'unsafe checkpoint parent')


def json_file(path, mode, gid, limit=65536, links=(1,)):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode and
                info.st_nlink in links and 0 < info.st_size <= limit,
                'unsafe checkpoint file')
        require(not hasattr(os, 'listxattr') or not os.listxattr(fd),
                'checkpoint has extended attributes')
        value = json.loads(os.read(fd, limit + 1))
        require(type(value) is dict, 'invalid checkpoint JSON')
        return value, info
    finally:
        os.close(fd)


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise Refusal('pending transaction or request blocks archival')


def docker(*args):
    trusted_parents(DOCKER_CONFIG)
    info = DOCKER_CONFIG.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            not info.st_mode & 0o022 and
            (not hasattr(os, 'listxattr') or
             not os.listxattr(DOCKER_CONFIG, follow_symlinks=False)) and
            not any(DOCKER_CONFIG.iterdir()), 'unsafe Docker client configuration')
    result = subprocess.run(['/usr/bin/docker', '--config', str(DOCKER_CONFIG),
                             '--host', 'unix:///var/run/docker.sock', *args],
                            env={'PATH': '/usr/bin:/bin', 'HOME': '/root',
                                 'DOCKER_CONFIG': str(DOCKER_CONFIG)},
                            capture_output=True, timeout=30, check=True)
    require(len(result.stdout) <= 65536, 'oversized Docker response')
    return result.stdout


def project_name():
    path = ROOT / '.runtime/runtime.env'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                0 < info.st_size <= 65536, 'unsafe TEST runtime configuration')
        lines = os.read(fd, 65537).decode().splitlines()
    finally:
        os.close(fd)
    matches = [line.partition('=')[2] for line in lines
               if line.startswith('COMPOSE_PROJECT_NAME=')]
    require(len(matches) == 1 and re.fullmatch('[a-z0-9][a-z0-9_-]*', matches[0]),
            'invalid TEST Compose project')
    return matches[0]


def verify_images(images, commit, project):
    for role in ('backend', 'frontend'):
        expected = images[role]
        require(type(expected) is dict and set(expected) == {'ref', 'id', 'sha'} and
                type(expected['ref']) is str and REF.fullmatch(expected['ref']) and
                type(expected['id']) is str and IMAGE.fullmatch(expected['id']) and
                expected['sha'] == commit, 'invalid image checkpoint')
        ids = docker('ps', '-aq', '--filter', f'label=com.docker.compose.project={project}',
                     '--filter', f'label=com.docker.compose.service={role}').decode().splitlines()
        require(len(ids) == 1 and re.fullmatch('[a-f0-9]{12,64}', ids[0]),
                'missing or duplicate TEST container')
        inspected = json.loads(docker('inspect', ids[0]))
        require(type(inspected) is list and len(inspected) == 1, 'invalid container inspection')
        item = inspected[0]
        labels = (item.get('Config') or {}).get('Labels') or {}
        require(labels.get('com.docker.compose.project') == project and
                labels.get('com.docker.compose.service') == role and
                (item.get('State') or {}).get('Running') is True and
                (item.get('State') or {}).get('Health', {}).get('Status') == 'healthy' and
                (item.get('Config') or {}).get('Image') == expected['ref'] and
                item.get('Image') == expected['id'], 'TEST container differs from checkpoint')
        image = json.loads(docker('image', 'inspect', expected['id']))
        require(type(image) is list and len(image) == 1 and
                image[0].get('Id') == expected['id'] and
                ((image[0].get('Config') or {}).get('Labels') or {}).get(
                    'org.opencontainers.image.revision') == commit,
                'installed image differs from checkpoint')


def verify_complete(receipt=None):
    """Return the identity only if independent durable and live evidence agrees."""
    directory(STATUS_DIR, 0o750, 65533)
    directory(INBOX, 0o770, 65533)
    trusted_parents(CHANNEL)
    directory(ROOT / '.runtime', 0o700, 0)
    directory(CHANNEL, 0o700, 0)
    absent(INBOX / 'request.json')
    absent(CHANNEL / 'pending.json')
    if receipt is None:
        receipt = CURRENT
    status, info = json_file(receipt, 0o640, 65533, 4096, (1, 2))
    require(set(status) == {'format', 'status', 'manifestSha256', 'phase', 'updatedAt'} and
            status['format'] == 'homecloud-update-status-v1' and
            status['status'] == 'INSTALLED' and status['phase'] == 'COMPLETE' and
            type(status['manifestSha256']) is str and HASH.fullmatch(status['manifestSha256']) and
            type(status['updatedAt']) is str and len(status['updatedAt']) <= 64,
            'receipt is not confirmed complete')
    identity = status['manifestSha256']
    last, _ = json_file(CHANNEL / 'last-status.json', 0o600, 0)
    # The installer appends each prior active manifest to history. A successful
    # second install already exceeds the generic 64 KiB checkpoint limit.
    state, _ = json_file(CHANNEL / 'state.json', 0o600, 0, 16 * 1024 * 1024)
    installed, _ = json_file(INSTALLED, 0o640, 65533, 4096)
    require(last.get('status') == 'INSTALLED' and last.get('manifest_sha256') == identity and
            type(last.get('commit')) is str and SHA.fullmatch(last['commit']),
            'installer result differs from receipt')
    commit = last['commit']
    active = state.get('active')
    require(state.get('format') == 'homecloud-test-install-v1' and type(active) is dict and
            type(state.get('history')) is list and type(active.get('manifest')) is dict and
            active['manifest'].get('manifest_sha256') == identity and
            active['manifest'].get('commit') == commit and
            type(active.get('images')) is dict and set(active['images']) == {'backend', 'frontend'} and
            type(active.get('schema_migrations')) is list,
            'installed state differs from receipt')
    names = [item.get('name') for item in active['schema_migrations']
             if type(item) is dict]
    require(len(names) == len(active['schema_migrations']) and names and
            all(type(name) is str and re.fullmatch('[A-Za-z0-9]+', name) for name in names) and
            len(set(names)) == len(names) and
            set(installed) == {'format', 'version', 'gitSha', 'schemaMigrations'} and
            installed['format'] == 'homecloud-installed-test-v1' and
            installed['gitSha'] == commit and installed['version'] == commit[:7] and
            installed['schemaMigrations'] == names,
            'installed metadata differs from state')
    verify_images(active['images'], commit, project_name())
    absent(INBOX / 'request.json')
    absent(CHANNEL / 'pending.json')
    return identity, info


def acquire_lock():
    fd = os.open(STATUS_DIR / 'install.lock',
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'unsafe installation lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except Exception:
        os.close(fd)
        raise


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_marker(identity):
    value = json.dumps({'manifestSha256': identity}, sort_keys=True).encode() + b'\n'
    fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                 os.O_CLOEXEC, 0o640)
    try:
        os.fchmod(fd, 0o640)
        os.fchown(fd, 0, 65533)
        os.write(fd, value)
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(STATUS_DIR)


def archive_complete():
    require(os.geteuid() == 0, 'requires root')
    directory(STATUS_DIR, 0o750, 65533)
    lock = acquire_lock()
    try:
        if not CURRENT.exists() and not CURRENT.is_symlink():
            if MARKER.exists() or MARKER.is_symlink():
                marker, _ = json_file(MARKER, 0o640, 65533, 4096)
                identity = marker.get('manifestSha256')
                require(set(marker) == {'manifestSha256'} and type(identity) is str and
                        HASH.fullmatch(identity), 'invalid archival marker')
                directory(ARCHIVE, 0o700, 0)
                complete, _ = verify_complete(ARCHIVE / (identity + '.json'))
                require(complete == identity, 'archived receipt differs from marker')
                # Persist the absent current while the durable blocker still exists.
                fsync_dir(STATUS_DIR)
                os.unlink(MARKER)
                fsync_dir(STATUS_DIR)
                return True
            return False
        identity, info = verify_complete()
        if MARKER.exists() or MARKER.is_symlink():
            marker, _ = json_file(MARKER, 0o640, 65533, 4096)
            require(marker == {'manifestSha256': identity}, 'conflicting archival marker')
        else:
            create_marker(identity)
        if not ARCHIVE.exists() and not ARCHIVE.is_symlink():
            ARCHIVE.mkdir(mode=0o700)
            fsync_dir(STATUS_DIR)
        directory(ARCHIVE, 0o700, 0)
        destination = ARCHIVE / (identity + '.json')
        if destination.exists() or destination.is_symlink():
            archived_value, archived = json_file(destination, 0o640, 65533, 4096, (2,))
            require((archived.st_dev, archived.st_ino) == (info.st_dev, info.st_ino) and
                    info.st_nlink == 2 and archived_value == json_file(
                        CURRENT, 0o640, 65533, 4096, (2,))[0],
                    'archive destination already occupied')
        else:
            require(info.st_nlink == 1, 'unaccounted hard link on receipt')
            os.link(CURRENT, destination, follow_symlinks=False)
            fsync_dir(ARCHIVE)
        os.unlink(CURRENT)
        fsync_dir(STATUS_DIR)
        os.unlink(MARKER)
        fsync_dir(STATUS_DIR)
        return True
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 1 and sys.flags.isolated and sys.flags.no_site,
                'requires isolated host invocation')
        anchor = Path('/usr/local/sbin/homecloud-update-archive')
        require(Path(__file__).absolute() == anchor, 'requires installed host script')
        trusted_parents(anchor)
        info = anchor.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o700 and info.st_nlink == 1,
                'unsafe installed archival script')
        archive_complete()
    except Exception:
        sys.exit('STOP: completed TEST update could not be archived; operator review required')
