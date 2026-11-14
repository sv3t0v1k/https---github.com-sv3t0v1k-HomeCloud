#!/usr/bin/env python3
"""Persistent fail-closed maintenance admission marker.

Library only. No CLI, no automatic marker deletion or recovery.
The state directory must already exist and be private.
"""

import os
import stat


MARKER = "maintenance.inhibit"
PAYLOAD = b"homecloud-maintenance-v1\n"


class MaintenanceError(Exception):
    pass


class MaintenanceInhibited(MaintenanceError):
    pass


def open_state_dir(root, expected_uid=0):
    if (
        not isinstance(root, str)
        or not os.path.isabs(root)
        or os.path.normpath(root) != root
        or os.path.realpath(root) != root
        or not isinstance(expected_uid, int)
        or isinstance(expected_uid, bool)
        or expected_uid < 0
    ):
        raise MaintenanceError("Unsafe maintenance state path")

    if expected_uid == 0 and os.geteuid() != 0:
        raise MaintenanceError("Root operator required")

    try:
        before = os.lstat(root)

        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) != 0o711
        ):
            raise MaintenanceError("Unsafe state directory")

        fd = os.open(
            root,
            os.O_RDONLY
            | os.O_DIRECTORY
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
        )
    except OSError as error:
        raise MaintenanceError(
            "Cannot open maintenance state directory"
        ) from error

    try:
        actual = os.fstat(fd)

        if (
            actual.st_dev != before.st_dev
            or actual.st_ino != before.st_ino
            or actual.st_uid != expected_uid
            or stat.S_IMODE(actual.st_mode) != 0o711
        ):
            raise MaintenanceError(
                "Maintenance directory identity changed"
            )

        return fd
    except BaseException:
        os.close(fd)
        raise


def assert_start_allowed(root, expected_uid=0):
    """Any existing marker, including damaged/symlink, blocks startup."""
    directory = open_state_dir(root, expected_uid)

    try:
        try:
            os.stat(
                MARKER,
                dir_fd=directory,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return

        raise MaintenanceInhibited(
            "Maintenance requires operator reconciliation"
        )
    finally:
        os.close(directory)


def create_inhibit(root, expected_uid=0):
    """Persist inhibit BEFORE stopping writers.

    If any step after file creation fails, retain the marker.
    There is intentionally no automatic clear operation.
    """
    directory = open_state_dir(root, expected_uid)

    try:
        try:
            fd = os.open(
                MARKER,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | os.O_NOFOLLOW
                | os.O_CLOEXEC,
                0o600,
                dir_fd=directory,
            )
        except FileExistsError as error:
            raise MaintenanceInhibited(
                "Maintenance already active or uncertain"
            ) from error

        try:
            os.fchmod(fd, 0o600)

            remaining = PAYLOAD

            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    raise MaintenanceError(
                        "Incomplete maintenance marker write"
                    )
                remaining = remaining[written:]

            os.fsync(fd)
        finally:
            os.close(fd)

        os.fsync(directory)
    finally:
        os.close(directory)


def assert_no_recovery_receipts(directory):
    """Root operation admission, including READY without an inhibitor."""
    for name in os.listdir(directory):
        if name == "restore.pending.json" or name.startswith("restore-migration."):
            raise MaintenanceInhibited(
                "Unfinished restore requires operator reconciliation"
            )


def assert_operation_allowed(root, expected_uid=0):
    """Call under the shared operation lock before any new operation."""
    directory = open_state_dir(root, expected_uid)
    try:
        assert_no_recovery_receipts(directory)
    finally:
        os.close(directory)
    assert_start_allowed(root, expected_uid)


def assert_start_allowed_unprivileged(root, expected_uid=0):
    """Read-only admission for the unprivileged backend.

    A root-owned 0711 directory exposes only known-name lookup.
    The marker itself remains private (0600).
    This does not replace exact Docker mount verification.
    """
    if (
        not isinstance(root, str)
        or not os.path.isabs(root)
        or os.path.normpath(root) != root
        or os.path.realpath(root) != root
        or not isinstance(expected_uid, int)
        or isinstance(expected_uid, bool)
        or expected_uid < 0
    ):
        raise MaintenanceError("Unsafe startup gate path")

    try:
        info = os.lstat(root)
    except OSError as error:
        raise MaintenanceError(
            "Maintenance state directory unavailable"
        ) from error

    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
        or (expected_uid == 0 and info.st_gid != 0)
        or stat.S_IMODE(info.st_mode) != 0o711
    ):
        raise MaintenanceError(
            "Unsafe maintenance state directory"
        )

    try:
        os.stat(
            os.path.join(root, MARKER),
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return
    except OSError as error:
        raise MaintenanceError(
            "Maintenance marker cannot be inspected"
        ) from error

    raise MaintenanceInhibited(
        "Maintenance requires operator reconciliation"
    )
