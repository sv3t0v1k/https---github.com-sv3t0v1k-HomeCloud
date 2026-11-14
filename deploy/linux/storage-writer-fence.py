#!/usr/bin/env python3
"""Nonblocking kernel fence for an already-provisioned storage root.

This is a library, not an operator CLI. The caller owns the returned
file descriptor and must keep it open for its entire critical section.
"""

import errno
import fcntl
import os
import stat


class StorageFenceError(Exception):
    pass


class StorageFenceBusy(StorageFenceError):
    pass


def acquire_storage_root_fence(root, expected_uid):
    if (
        not isinstance(root, str)
        or not os.path.isabs(root)
        or os.path.normpath(root) != root
        or os.path.realpath(root) != root
        or not isinstance(expected_uid, int)
        or isinstance(expected_uid, bool)
        or expected_uid < 0
    ):
        raise StorageFenceError("Invalid canonical storage root")

    try:
        initial = os.lstat(root)
        if (
            not stat.S_ISDIR(initial.st_mode)
            or initial.st_uid != expected_uid
            or stat.S_IMODE(initial.st_mode) != 0o700
        ):
            raise StorageFenceError("Unsafe storage root identity")

        flags = (
            os.O_RDONLY
            | os.O_DIRECTORY
            | os.O_NOFOLLOW
            | os.O_CLOEXEC
        )

        fd = os.open(root, flags)
    except OSError as error:
        raise StorageFenceError(
            "Storage root cannot be opened safely"
        ) from error

    try:
        opened = os.fstat(fd)

        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_dev != initial.st_dev
            or opened.st_ino != initial.st_ino
            or opened.st_uid != expected_uid
            or stat.S_IMODE(opened.st_mode) != 0o700
        ):
            raise StorageFenceError(
                "Storage root changed during acquisition"
            )

        try:
            fcntl.flock(
                fd,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
        except OSError as error:
            if error.errno in (
                errno.EWOULDBLOCK,
                errno.EAGAIN,
            ):
                raise StorageFenceBusy(
                    "Storage writer lock is occupied"
                ) from error
            raise

        visible = os.lstat(root)

        if (
            not stat.S_ISDIR(visible.st_mode)
            or visible.st_dev != opened.st_dev
            or visible.st_ino != opened.st_ino
            or visible.st_uid != expected_uid
            or stat.S_IMODE(visible.st_mode) != 0o700
        ):
            raise StorageFenceError(
                "Storage root changed after locking"
            )

        return fd
    except BaseException:
        os.close(fd)
        raise
