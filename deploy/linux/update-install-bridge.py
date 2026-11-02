#!/usr/bin/python3 -IS
"""Phase 3 host installer bridge. Deliberately unprovisioned until acceptance."""
import fcntl
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path('/home/hs/homecloud-test')
WORKER = Path('/usr/local/sbin/homecloud-update-install')
VERIFIER = Path('/usr/local/sbin/homecloud-update-verify')
INBOX = Path('/var/lib/homecloud-update/inbox')
STATUS_DIR = Path('/var/lib/homecloud-update/status')
STATUS = STATUS_DIR / 'current.json'
REQUEST = INBOX / 'request.json'
PENDING = ROOT / '.runtime/test-channel/pending.json'
LAST_STATUS = ROOT / '.runtime/test-channel/last-status.json'
GID = 65533
UID = 1001
HASH = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
FORMAT = 'homecloud-update-status-v1'
# A separate review, host provisioning and recovery drills are required to flip this.
PROVISIONED = False


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


def create_verifier_request(identity):
    """Recreate the admission identity; never trust a second backend submission."""
    directory(INBOX, 0o770, GID)
    body = json.dumps(dict(format='homecloud-update-request-v1', channel='test',
                           manifestSha256=identity), separators=(',', ':')).encode() + b'\n'
    fd = os.open(REQUEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(fd)
    token = (info.st_dev, info.st_ino, info.st_ctime_ns)
    try:
        os.fchown(fd, UID, GID)
        os.fchmod(fd, 0o600)
        require(os.write(fd, body) == len(body), 'short request write')
        os.fsync(fd)
        info = os.fstat(fd)
        token = (info.st_dev, info.st_ino, info.st_ctime_ns)
    except Exception:
        os.close(fd)
        try:
            cleanup_verifier_request(token)
        except Exception:
            pass  # RUNNING receipt still blocks re-admission; operator must inspect.
        raise
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    try:
        dirfd = os.open(INBOX, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except Exception:
        try:
            cleanup_verifier_request(token)
        except Exception:
            pass
        raise
    return token


def cleanup_verifier_request(token):
    """Quiesce group writers before comparing inode and removing our request."""
    require(type(token) is tuple and len(token) == 3, 'missing request identity')
    directory(INBOX, 0o770, GID)
    os.chmod(INBOX, 0o750)
    try:
        info = REQUEST.lstat()
        require(stat.S_ISREG(info.st_mode) and
                (info.st_dev, info.st_ino, info.st_ctime_ns) == token,
                'verifier request was replaced or modified; operator review required')
        os.unlink(REQUEST)
        dirfd = os.open(INBOX, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        os.chmod(INBOX, 0o770)
        dirfd = os.open(INBOX, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)


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
    boundary.trusted_path(VERIFIER)
    environment = boundary.clean_environment()
    environment['GH_TOKEN'] = os.environ.get('GH_TOKEN', '')
    result = subprocess.run(['/usr/bin/python3', '-I', '-S', str(VERIFIER)],
                            cwd=ROOT, env=environment, capture_output=True,
                            text=True, timeout=300)
    require(result.returncode == 0, 'host verifier refused')
    return verified_result(identity, result.stdout.strip())


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


def install(manifest, identity, boundary):
    boundary.validate_checkout(ROOT)
    no_pending()
    result = subprocess.run(
        ['/usr/bin/python3', '-I', '-S', str(ROOT / 'deploy/linux/test-channel.py'), 'apply'],
        cwd=ROOT, env=boundary.clean_environment(),
        input=json.dumps(manifest, sort_keys=True), capture_output=True,
        text=True, timeout=7200)
    require(result.returncode == 0 and
            result.stdout.strip() == 'INSTALLED: exact TEST pair and public HTTPS smoke passed',
            'installer refused or returned ambiguous result')
    installed_checkpoint(identity, boundary)


def execute(identity, write_status, make_request, cleanup_request, verify, fetch,
            run_install, check_pending):
    """One durable attempt. Any interrupted RUNNING state blocks a repeat."""
    write_status(identity, 'RUNNING', 'VERIFY_TRUST')
    installer_started = False
    request_token = None
    try:
        check_pending()
        request_token = make_request(identity)
        commit = verify(identity)
        cleanup_request(request_token)
        request_token = None
        write_status(identity, 'RUNNING', 'FETCH_MANIFEST')
        manifest = fetch(identity, commit)
        require(manifest['commit'] == commit and
                manifest['manifest_sha256'] == identity,
                'fresh manifest differs from verified identity')
        check_pending()
        write_status(identity, 'RUNNING', 'INSTALLER')
        installer_started = True
        run_install(manifest, identity)
        write_status(identity, 'INSTALLED', 'COMPLETE')
    except Exception:
        if request_token is not None:
            try:
                cleanup_request(request_token)
            except Exception:
                pass  # Mismatch is retained; any retry still sees a terminal status.
        # Once the installer was invoked, even a lost acknowledgement is
        # ambiguous. Its pending journal remains untouched for recovery.
        write_status(identity, 'MANUAL_RECOVERY_REQUIRED' if installer_started else 'STOP',
                     'INSTALLER' if installer_started else 'VERIFY_TRUST')
        raise


def main():
    require(PROVISIONED, 'bridge requires separate Phase 3 acceptance')
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
        execute(identity, publish, create_verifier_request,
                cleanup_verifier_request,
                lambda value: verify_host(value, boundary),
                lambda value, commit: fresh_manifest(value, commit, boundary),
                lambda manifest, value: install(manifest, value, boundary), no_pending)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('STOP: host installer bridge refused; operator review required')
