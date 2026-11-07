#!/usr/bin/env python3
"""Phase 1 ONLY: accept one TEST request, emit root-owned receipt; NEVER install."""
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timezone

INBOX = Path('/var/lib/homecloud-update/inbox')
STATE_DIR = Path('/var/lib/homecloud-update/status')
REQUEST = INBOX / 'request.json'
RECEIPT = STATE_DIR / 'current.json'
ARCHIVING = STATE_DIR / 'archiving.json'
SHA = re.compile(r'[a-f0-9]{64}\Z')
UID = 1001
GID = 65533


class Refusal(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Refusal(reason)


def validate_request(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 512, 'invalid request length')
    try:
        item = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as err:
        raise Refusal('invalid request json') from err
    require(type(item) is dict and set(item) == {'format', 'channel', 'manifestSha256'}, 'invalid request keys')
    require(item['format'] == 'homecloud-update-request-v1' and item['channel'] == 'test'
            and type(item['manifestSha256']) is str and SHA.fullmatch(item['manifestSha256']),
            'invalid TEST identity')
    return item


def validate_request_stat(info):
    require(stat.S_ISREG(info.st_mode) and info.st_uid == UID and info.st_gid == GID and
            stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 512 and
            1 <= info.st_nlink <= 2, 'unsafe request file')


def private_directory(path, mode, group):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and info.st_uid == 0 and info.st_gid == group
            and stat.S_IMODE(info.st_mode) == mode, 'unsafe host directory')


def read_request():
    fd = os.open(REQUEST, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        validate_request_stat(os.fstat(fd))
        raw = os.read(fd, 513)
        return validate_request(raw)
    finally:
        os.close(fd)


def receipt_exists():
    for path in (RECEIPT, ARCHIVING):
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        return True  # Even a symlink or corrupt transition blocks admission.
    return False


def emit_status(manifest_sha256):
    value = {'format': 'homecloud-update-status-v1', 'status': 'VALIDATION_REQUIRED',
             'manifestSha256': manifest_sha256, 'phase': None,
             'updatedAt': datetime.now(timezone.utc).isoformat()}
    fd, tmp = tempfile.mkstemp(prefix='.status-', dir=STATE_DIR)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, GID)
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        require(not receipt_exists(), 'existing receipt blocks admission')
        # This does not install anything; future worker must reverify upstream independently.
        os.link(tmp, RECEIPT)  # O_EXCL-like publication: never overwrite a prior receipt
        dir_fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    require(os.geteuid() == 0, 'requires root')
    private_directory(INBOX, 0o770, GID)
    private_directory(STATE_DIR, 0o750, GID)
    require(not receipt_exists(), 'previous job requires operator review')
    item = read_request()
    emit_status(item['manifestSha256'])
    # In this stage VALIDATION_REQUIRED is terminal. No install, Docker, SSH or systemd-run.
    # Remove the request after the root-owned receipt is durable.
    os.unlink(REQUEST)


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, TypeError):
        raise SystemExit('STOP: update request not accepted; operator inspection required')
