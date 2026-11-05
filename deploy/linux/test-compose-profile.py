#!/usr/bin/python3 -IS
"""Select the exact optional TEST update overlay from root-only host state."""
import os
from pathlib import Path
import stat
import sys

ROOT = Path('/home/hs/homecloud-test')
RUNTIME = ROOT / '.runtime/runtime.env'
MARKER = Path('/etc/homecloud-test/update-install-enabled')
BASE = ('docker-compose.yml', 'docker-compose.production.yml', 'docker-compose.project-test.yml')
OVERLAY = 'docker-compose.project-test-updates.yml'


def private_bytes(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022):
            raise ValueError('unsafe TEST profile parent')
        if hasattr(os, 'listxattr') and any(name in os.listxattr(parent, follow_symlinks=False)
                for name in ('system.posix_acl_access', 'system.posix_acl_default')):
            raise ValueError('ACL on TEST profile parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                0 < info.st_size <= 65536):
            raise ValueError('unsafe TEST profile file')
        return os.read(fd, 65537)
    finally:
        os.close(fd)


def enabled():
    raw = private_bytes(RUNTIME)
    flags = []
    for line in raw.decode('utf-8').splitlines():
        if line.startswith('UPDATE_INSTALL_BRIDGE_ENABLED='):
            flags.append(line.partition('=')[2])
    if not flags:
        return False
    if len(flags) != 1 or flags[0] not in ('true', 'false'):
        raise ValueError('invalid TEST bridge selection')
    if flags[0] == 'false':
        return False
    if private_bytes(MARKER) != b'homecloud-test-install-v1\n':
        raise ValueError('missing TEST host authorization')
    return True


def files():
    return tuple(ROOT / name for name in BASE + ((OVERLAY,) if enabled() else ()))


if __name__ == '__main__':
    if len(sys.argv) != 1 or os.geteuid() != 0 or not sys.flags.isolated:
        raise SystemExit('STOP: TEST profile selector')
    try:
        print('updates' if enabled() else 'default')
    except (OSError, UnicodeError, ValueError):
        raise SystemExit('STOP: invalid TEST profile') from None
