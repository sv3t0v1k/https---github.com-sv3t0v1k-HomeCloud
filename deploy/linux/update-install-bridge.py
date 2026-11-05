#!/usr/bin/python3 -IS
"""Phase 3 host installer bridge. Deliberately unprovisioned until acceptance."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path('/home/hs/homecloud-test')
WORKER = Path('/usr/local/sbin/homecloud-update-install')
VERIFIER = Path('/usr/local/sbin/homecloud-update-verify')
STATUS_DIR = Path('/var/lib/homecloud-update/status')
STATUS = STATUS_DIR / 'current.json'
INSTALLED = STATUS_DIR / 'installed.json'
PENDING = ROOT / '.runtime/test-channel/pending.json'
LAST_STATUS = ROOT / '.runtime/test-channel/last-status.json'
GID = 65533
HASH = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
FORMAT = 'homecloud-update-status-v1'
# A separate review, host provisioning and recovery drills are required to flip this.
PROVISIONED = False
ENABLE_MARKER = Path('/etc/homecloud-test/update-install-enabled')


class Stop(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Stop(reason)


def trusted_anchor_path(path):
    """Bootstrap only installed root-owned code, before any checkout import."""
    require(path.is_absolute() and '..' not in path.parts,
            'invalid installed anchor path')
    for node in reversed((path, *path.parents)):
        info = node.lstat()
        is_directory = node != path
        require(info.st_uid == 0 and not info.st_mode & 0o022 and
                (stat.S_ISDIR(info.st_mode) if is_directory else
                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                'unsafe installed anchor path')
        attrs = os.listxattr(node, follow_symlinks=False)
        require('system.posix_acl_access' not in attrs and
                'system.posix_acl_default' not in attrs,
                'ACL on installed anchor path')


def host_enabled():
    """A root-only host decision, never a checkout or container setting."""
    if not ENABLE_MARKER.exists() or ENABLE_MARKER.is_symlink():
        return False
    trusted_anchor_path(ENABLE_MARKER)
    info = ENABLE_MARKER.stat()
    require(info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and
            ENABLE_MARKER.read_bytes() == b'homecloud-test-install-v1\n',
            'invalid host installation authorization')
    return True


def directory(path, mode, group):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            info.st_gid == group and stat.S_IMODE(info.st_mode) == mode,
            'unsafe host directory')
    require(not os.listxattr(path, follow_symlinks=False),
            'host directory has extended attributes')


def read_receipt():
    directory(STATUS_DIR, 0o750, GID)
    fd = os.open(STATUS, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_gid == GID and stat.S_IMODE(info.st_mode) == 0o640 and
                info.st_nlink == 1 and 0 < info.st_size <= 4096,
                'unsafe host receipt')
        value = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    require(type(value) is dict and set(value) ==
            {'format', 'status', 'manifestSha256', 'phase', 'updatedAt'} and
            value['format'] == FORMAT and value['status'] == 'VALIDATION_REQUIRED' and
            value['phase'] is None and type(value['manifestSha256']) is str and
            HASH.fullmatch(value['manifestSha256']) and
            type(value['updatedAt']) is str and len(value['updatedAt']) <= 64,
            'receipt is not an admitted pending request')
    return value['manifestSha256']


def acquire_lock():
    path = STATUS_DIR / 'install.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'unsafe bridge lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except Exception:
        os.close(fd)
        raise


def publish(identity, status, phase):
    require(HASH.fullmatch(identity) and status in
            ('RUNNING', 'INSTALLED', 'STOP', 'MANUAL_RECOVERY_REQUIRED') and
            (phase is None or type(phase) is str and len(phase) <= 64),
            'invalid bridge status')
    value = dict(format=FORMAT, status=status, manifestSha256=identity,
                 phase=phase, updatedAt=datetime.now(timezone.utc).isoformat())
    fd, tmp = tempfile.mkstemp(prefix='.bridge-', dir=STATUS_DIR)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, GID)
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, STATUS)
        dirfd = os.open(STATUS_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def publish_installed(manifest):
    """Publish the installer-verified version for read-only UI discovery."""
    commit = manifest.get('commit')
    migrations = manifest.get('schema_migrations')
    require(type(commit) is str and COMMIT.fullmatch(commit) and
            type(migrations) is list and migrations and
            all(type(item) is dict and type(item.get('name')) is str and
                re.fullmatch('[A-Za-z0-9]+', item['name']) for item in migrations),
            'invalid installed metadata source')
    names = [item['name'] for item in migrations]
    require(len(names) == len(set(names)), 'duplicate installed migration')
    value = dict(format='homecloud-installed-test-v1', version=commit[:7],
                 gitSha=commit, schemaMigrations=names)
    fd, tmp = tempfile.mkstemp(prefix='.installed-', dir=STATUS_DIR)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, GID)
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, INSTALLED)
        dirfd = os.open(STATUS_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def no_pending():
    require(not PENDING.is_symlink() and not PENDING.exists(),
            'unfinished installer transaction requires operator review')


def verified_result(identity, output):
    require(type(output) is str and len(output) <= 4096, 'invalid verifier output')
    value = json.loads(output)
    require(type(value) is dict and set(value) ==
            {'status', 'manifestSha256', 'commit', 'installation_enabled',
             'provenance_signature'} and
            value['status'] == 'HOST_VERIFIED_READ_ONLY' and
            value['manifestSha256'] == identity and
            type(value['commit']) is str and COMMIT.fullmatch(value['commit']) and
            value['installation_enabled'] is False and
            value['provenance_signature'] == 'UNSIGNED',
            'host verification did not match admission')
    return value['commit']


def verify_host(identity, boundary):
    trusted_anchor_path(VERIFIER)
    anchor = runpy.run_path(str(VERIFIER))
    modules = anchor['load_helpers'](ROOT)
    def trust_check():
        trusted_anchor_path(VERIFIER)
        boundary.validate_checkout(ROOT)
        for path, expected in anchor['QUALIFIED'].values():
            require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected,
                    'host helper changed during verification')
    raw = json.dumps(dict(format='homecloud-update-request-v1', channel='test',
                          manifestSha256=identity)).encode()
    client = modules['update_source'].GitHubClient(os.environ.get('GH_TOKEN', ''))
    result = anchor['verify_request'](
        raw, modules, client, anchor['GitSource'](ROOT, boundary.clean_environment()),
        trust_check)
    return verified_result(identity, json.dumps(result))


def fresh_manifest(identity, commit, boundary):
    """Read exact TEST artifact again; no target code is imported or executed."""
    anchor = runpy.run_path(str(VERIFIER))
    modules = anchor['load_helpers'](ROOT)
    boundary.validate_checkout(ROOT)
    client = modules['update_source'].GitHubClient(os.environ.get('GH_TOKEN', ''))
    manifest = modules['update_source'].fetch_test_evidence(
        identity, modules['test_contract'].shape, client)
    require(manifest['commit'] == commit and manifest['manifest_sha256'] == identity,
            'TEST manifest changed after verification')
    anchor['target_sources'](
        manifest, modules['test_contract'],
        anchor['GitSource'](ROOT, boundary.clean_environment()))
    return manifest


def installed_checkpoint(identity, boundary):
    boundary.trusted_path(LAST_STATUS)
    fd = os.open(LAST_STATUS, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and
                stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                0 < info.st_size <= 4096, 'unsafe installer completion')
        value = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    no_pending()
    require(type(value) is dict and value.get('status') == 'INSTALLED' and
            value.get('manifest_sha256') == identity,
            'installer completion does not match request')


def installer_phase(identity):
    """Expose only a known phase from the root-owned transaction receipt."""
    try:
        fd = os.open(PENDING, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 8192,
                'unsafe installer journal')
        value = json.loads(os.read(fd, 8193))
    finally:
        os.close(fd)
    phases = {'CHECKOUT', 'VERIFY_IMAGES', 'PREBACKUP', 'STOP_SERVICES', 'BACKUP',
              'WRITE_REFS', 'START_SERVICES', 'SMOKE', 'COMMIT_STATE', 'COMPLETE'}
    require(type(value) is dict and type(value.get('target')) is dict and
            value['target'].get('manifest_sha256') == identity and
            value.get('phase') in phases, 'invalid installer journal phase')
    return value['phase']


def install(manifest, identity, boundary):
    boundary.validate_checkout(ROOT)
    no_pending()
    process = subprocess.Popen(
        ['/usr/bin/python3', '-I', '-S', str(ROOT / 'deploy/linux/test-channel.py'), 'apply'],
        cwd=ROOT, env=boundary.clean_environment(),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    last_phase = 'INSTALLER'
    deadline = time.monotonic() + 7200
    request = json.dumps(manifest, sort_keys=True)
    try:
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'installer timed out')
            try:
                output, _ = process.communicate(input=request, timeout=min(2, remaining))
                break
            except subprocess.TimeoutExpired:
                request = None
                phase = installer_phase(identity)
                if phase and phase != last_phase:
                    publish(identity, 'RUNNING', phase)
                    last_phase = phase
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    require(process.returncode == 0 and
            output.strip() == 'INSTALLED: exact TEST pair and public HTTPS smoke passed',
            'installer refused or returned ambiguous result')
    installed_checkpoint(identity, boundary)
    publish_installed(manifest)


def execute(identity, write_status, verify, fetch, run_install, check_pending):
    """One durable attempt. Any interrupted RUNNING state blocks a repeat."""
    write_status(identity, 'RUNNING', 'VERIFY_TRUST')
    current_phase = 'VERIFY_TRUST'
    installer_started = False
    try:
        check_pending()
        commit = verify(identity)
        write_status(identity, 'RUNNING', 'FETCH_MANIFEST')
        current_phase = 'FETCH_MANIFEST'
        manifest = fetch(identity, commit)
        require(manifest['commit'] == commit and
                manifest['manifest_sha256'] == identity,
                'fresh manifest differs from verified identity')
        check_pending()
        write_status(identity, 'RUNNING', 'INSTALLER')
        current_phase = 'INSTALLER'
        installer_started = True
        run_install(manifest, identity)
        write_status(identity, 'INSTALLED', 'COMPLETE')
    except Exception:
        # Once the installer was invoked, even a lost acknowledgement is
        # ambiguous. Its pending journal remains untouched for recovery.
        phase = current_phase
        if installer_started:
            try:
                phase = installer_phase(identity) or 'INSTALLER'
            except Exception:
                phase = 'INSTALLER'
        write_status(identity, 'MANUAL_RECOVERY_REQUIRED' if installer_started else 'STOP', phase)
        raise


def main():
    require(PROVISIONED or host_enabled(), 'bridge requires separate host acceptance')
    require(os.geteuid() == 0 and sys.flags.isolated and sys.flags.no_site and
            Path(__file__).absolute() == WORKER and len(sys.argv) == 1,
            'requires installed host-only root worker and python -I -S')
    trusted_anchor_path(WORKER)
    trusted_anchor_path(VERIFIER)
    anchor = runpy.run_path(str(VERIFIER))
    boundary = anchor['load_helpers'](ROOT)['boundary']
    boundary.validate_checkout(ROOT)
    directory(STATUS_DIR, 0o750, GID)
    lock = acquire_lock()
    try:
        identity = read_receipt()
        execute(identity, publish, lambda value: verify_host(value, boundary),
                lambda value, commit: fresh_manifest(value, commit, boundary),
                lambda manifest, value: install(manifest, value, boundary), no_pending)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('STOP: host installer bridge refused; operator review required')
