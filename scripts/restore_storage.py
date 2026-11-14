#!/usr/bin/env python3
"""Restore qualified bind storage under an inherited Linux root fence.

The original storage root inode is never replaced.

Old bytes remain in .restore-swap until a separate, verified
restore completion. Errors preserve all recovery artifacts.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile

import recovery_storage as storage


STAGE = ".restore-staging"
SWAP = ".restore-swap"
TEMP = ".tmp"
IDENTITY_MARKER = ".homecloud-storage-identity"
LEGACY_IDENTITY_BYTES = (
    b'{"version":1,"storageLocationId":"f2f5c4b0-8d57-4c49-9f8c-0d095b344601",'
    b'"machineKey":"legacy-storage","mountKey":"legacy-storage"}\n'
)

RESTORE_UID = 1001
RESTORE_GID = 65533


def require(ok, message):
    if not ok:
        raise storage.StorageError(message)


def identity(info):
    return (info.st_dev, info.st_ino)


def digest(stream):
    stream.seek(0)
    h = hashlib.sha256()

    for block in iter(
        lambda: stream.read(1024 * 1024), b""
    ):
        h.update(block)

    stream.seek(0)
    return h.hexdigest()


def mount_path(value):
    """Decode the kernel's mountinfo path escaping."""
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def reject_nested_mounts(root, inventory=None):
    if inventory is None:
        inventory = Path(
            "/proc/self/mountinfo"
        ).read_text()

    for line in inventory.splitlines():
        fields = line.split(" ")

        require(
            len(fields) >= 10 and " - " in line,
            "Invalid host mount inventory",
        )

        mounted = Path(mount_path(fields[4]))

        require(
            root not in mounted.parents,
            "Nested host storage mount refused",
        )


def assert_root(snapshot, fd):
    # Actual kernel lock must already belong to this
    # inherited open-file description.
    storage.backup_fence(snapshot, fd, acquire=False)

    root = Path(snapshot["source"])
    opened = os.fstat(fd)
    visible = root.lstat()

    require(
        root.is_absolute()
        and root.resolve(strict=True) == root
        and stat.S_ISDIR(opened.st_mode)
        and stat.S_ISDIR(visible.st_mode)
        and identity(opened) == identity(visible)
        and opened.st_uid == RESTORE_UID
        and opened.st_gid == RESTORE_GID
        and stat.S_IMODE(opened.st_mode) == 0o700,
        "Invalid restore root identity or ownership",
    )

    reject_nested_mounts(root)

    temporary = root / TEMP
    info = temporary.lstat()

    require(
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == RESTORE_UID
        and info.st_gid == RESTORE_GID
        and stat.S_IMODE(info.st_mode) == 0o700
        and info.st_dev == opened.st_dev,
        "Unsafe existing upload temporary directory",
    )

    return root


def archive_parts(member):
    name = member.name

    require(
        isinstance(name, str)
        and "\x00" not in name
        and "\\" not in name
        and not name.startswith("/"),
        "Unsafe archive member path",
    )

    if name == ".":
        require(
            member.isdir(),
            "Archive root must be a directory",
        )
        return ()

    if name.startswith("./"):
        name = name[2:]

    if member.isdir():
        name = name.rstrip("/")

    parts = name.split("/")

    require(
        all(part not in ("", ".", "..") for part in parts),
        "Archive traversal or ambiguous path refused",
    )

    first = parts[0]

    if parts == [IDENTITY_MARKER]:
        require(member.isfile(), "Historical identity must be a regular file")
        return tuple(parts)

    require(
        first not in (
            TEMP,
            IDENTITY_MARKER,
        )
        and not first.startswith(".restore-")
        and not first.startswith(".hc-probe-"),
        "Reserved storage path in archive",
    )

    return tuple(parts)


def checked_archive_members(archive):
    """One archive contract for preflight, migration metadata and staging."""
    seen = set()
    for member in archive:
        require(member.isfile() or member.isdir(), "Nonregular archive member refused")
        parts = archive_parts(member)
        require(parts not in seen, "Duplicate archive member refused")
        seen.add(parts)
        historical = parts == (IDENTITY_MARKER,)
        if historical:
            require(
                member.size == len(LEGACY_IDENTITY_BYTES)
                and getattr(member, "sparse", None) is None
                and not any(key.startswith("GNU.sparse") for key in member.pax_headers),
                "Invalid historical identity metadata",
            )
            source = archive.extractfile(member)
            require(source is not None, "Historical identity content unavailable")
            with source:
                require(source.read(1025) == LEGACY_IDENTITY_BYTES,
                        "Unrecognized historical storage identity")
        yield member, parts, historical


def target_identity(root_fd):
    """Historical metadata never enrolls or replaces the current target."""
    fd = os.open(IDENTITY_MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                 dir_fd=root_fd)
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_dev == os.fstat(root_fd).st_dev
            and before.st_uid == os.fstat(root_fd).st_uid
            and not before.st_mode & 0o022
            and before.st_size == len(LEGACY_IDENTITY_BYTES),
            "Unsafe target storage identity",
        )
        require(os.read(fd, 1025) == LEGACY_IDENTITY_BYTES,
                "Unrecognized target storage identity")
        after = os.fstat(fd)
        def fingerprint(info):
            return [info.st_dev, info.st_ino, info.st_ctime_ns, info.st_mtime_ns,
                    info.st_size, info.st_mode, info.st_uid, info.st_gid, info.st_nlink]
        require(fingerprint(before) == fingerprint(after)
                and identity(os.stat(IDENTITY_MARKER, dir_fd=root_fd,
                                     follow_symlinks=False)) == identity(after),
                "Target storage identity changed")
        return fingerprint(after)
    finally:
        os.close(fd)


def extract_archive(stream, stage, expected_count):
    """Never call tar.extract or tar.extractall."""
    files = 0
    historical_count = 0

    with tarfile.open(
        fileobj=stream, mode="r:gz"
    ) as archive:

        for member, parts, historical in checked_archive_members(archive):

            if not parts:
                continue

            target = stage.joinpath(*parts)

            if member.isdir():
                target.mkdir(
                    mode=0o700,
                    parents=True,
                    exist_ok=True,
                )
                continue

            files += 1

            require(
                files <= expected_count,
                "Archive file count exceeds metadata",
            )

            if historical:
                historical_count += 1
                continue

            target.parent.mkdir(
                mode=0o700,
                parents=True,
                exist_ok=True,
            )

            source = archive.extractfile(member)

            require(
                source is not None,
                "Archive file content unavailable",
            )

            fd = os.open(
                target,
                os.O_WRONLY | os.O_CREAT
                | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )

            with source, os.fdopen(fd, "wb") as output:
                shutil.copyfileobj(
                    source, output, 1024 * 1024
                )

                output.flush()

                require(
                    os.fstat(output.fileno()).st_size
                    == member.size,
                    "Restored file size mismatch",
                )

                os.fchown(
                    output.fileno(),
                    RESTORE_UID,
                    RESTORE_GID,
                )

                os.fchmod(output.fileno(), 0o600)
                os.fsync(output.fileno())

    require(
        files == expected_count,
        "Archive file count differs from metadata",
    )

    # Staging itself remains private/root-owned.
    # Its restored children receive backend ownership.
    for directory, _, _ in os.walk(
        stage, topdown=False, followlinks=False
    ):
        path = Path(directory)

        fd = os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY
            | os.O_NOFOLLOW | os.O_CLOEXEC,
        )

        try:
            if path != stage:
                os.fchown(
                    fd, RESTORE_UID, RESTORE_GID
                )
                os.fchmod(fd, 0o700)

            os.fsync(fd)
        finally:
            os.close(fd)

    return {"archive_file_count": files,
            "historical_identity_count": historical_count,
            "historical_identity_sha256": (
                hashlib.sha256(LEGACY_IDENTITY_BYTES).hexdigest()
                if historical_count else None
            )}


def stage_storage(
    snapshot, root_fd, archive_path,
    expected_sha, expected_count,
):
    require(
        snapshot.get("type") == "bind"
        and snapshot.get("target") == "/storage",
        "Restore requires qualified bind storage",
    )

    require(
        isinstance(expected_sha, str)
        and re.fullmatch(
            r"[0-9a-f]{64}", expected_sha
        ) is not None
        and type(expected_count) is int
        and expected_count >= 0,
        "Invalid restore archive metadata",
    )

    root = assert_root(snapshot, root_fd)

    stage = root / STAGE
    swap = root / SWAP

    for name in (STAGE, SWAP):
        try:
            os.stat(
                name,
                dir_fd=root_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise storage.StorageError(
                "Retained restore artifacts require operator review"
            )

    archive_path = Path(archive_path)

    require(
        archive_path.is_absolute(),
        "Restore archive path must be absolute",
    )

    archive_fd = os.open(
        archive_path,
        os.O_RDONLY | os.O_NOFOLLOW
        | os.O_NONBLOCK | os.O_CLOEXEC,
    )

    with os.fdopen(archive_fd, "rb") as stream:
        original = os.fstat(stream.fileno())

        require(
            stat.S_ISREG(original.st_mode)
            and original.st_nlink == 1
            and not (original.st_mode & 0o022),
            "Unsafe restore archive identity",
        )

        require(
            digest(stream) == expected_sha,
            "Restore archive checksum mismatch",
        )

        # First storage mutation: only after the fence,
        # archive identity and checksum are verified.
        os.mkdir(STAGE, 0o700, dir_fd=root_fd)
        os.fsync(root_fd)

        inventory = extract_archive(
            stream, stage, expected_count
        )

        require(
            digest(stream) == expected_sha,
            "Restore archive changed during extraction",
        )

        observed = os.fstat(stream.fileno())

        require(
            identity(observed) == identity(original)
            and observed.st_size == original.st_size
            and observed.st_mtime_ns ==
                original.st_mtime_ns,
            "Restore archive identity changed",
        )

    assert_root(snapshot, root_fd)
    checkpoint = staged_inventory(snapshot, root_fd)
    checkpoint.update(inventory, archive_sha256=expected_sha)
    if inventory["historical_identity_count"]:
        checkpoint["target_identity"] = target_identity(root_fd)
    return checkpoint


def staged_inventory(snapshot, root_fd):
    """Pin the complete prepared tree, including bytes and inode identities."""
    assert_root(snapshot, root_fd)
    entries = []
    files = 0
    device = os.fstat(root_fd).st_dev

    def walk(parent_fd, name, parts):
        nonlocal files
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )
        try:
            info = os.fstat(fd)
            directory = stat.S_ISDIR(info.st_mode)
            require(directory or stat.S_ISREG(info.st_mode), "Unsafe staged entry")
            require(info.st_dev == device, "Staged device changed")
            if parts:
                require(
                    info.st_uid == RESTORE_UID and info.st_gid == RESTORE_GID
                    and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600),
                    "Unsafe staged ownership or mode",
                )
            else:
                require(
                    directory and info.st_uid == os.geteuid()
                    and stat.S_IMODE(info.st_mode) == 0o700,
                    "Unsafe staging root",
                )
            record = [list(parts), list(identity(info)), info.st_mode,
                      info.st_uid, info.st_gid]
            if directory:
                entries.append(record)
                for child in sorted(os.listdir(fd)):
                    walk(fd, child, (*parts, child))
            else:
                require(info.st_nlink == 1, "Staged hardlink refused")
                checksum = hashlib.sha256()
                while True:
                    block = os.read(fd, 1024 * 1024)
                    if not block:
                        break
                    checksum.update(block)
                observed = os.fstat(fd)
                require(
                    (observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns)
                    == (info.st_size, info.st_mtime_ns, info.st_ctime_ns),
                    "Staged file changed during verification",
                )
                record.extend([info.st_size, checksum.hexdigest()])
                entries.append(record)
                files += 1
            require(
                identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False))
                == identity(info), "Staged entry replaced",
            )
        finally:
            os.close(fd)

    walk(root_fd, STAGE, ())
    return {
        "stage_identity": list(identity(os.stat(
            STAGE, dir_fd=root_fd, follow_symlinks=False))),
        "tree_sha256": hashlib.sha256(
            json.dumps(entries, sort_keys=True).encode("utf8")).hexdigest(),
        "file_count": files,
    }


def verify_staged_storage(snapshot, root_fd, checkpoint):
    require(isinstance(checkpoint, dict), "Missing staged storage checkpoint")
    actual = staged_inventory(snapshot, root_fd)
    historical_count = checkpoint.get("historical_identity_count")
    require(type(historical_count) is int and historical_count in (0, 1)
            and type(checkpoint.get("archive_file_count")) is int
            and checkpoint["archive_file_count"] == actual["file_count"] + historical_count,
            "Prepared archive count changed")
    if historical_count:
        require(checkpoint.get("historical_identity_sha256") ==
                hashlib.sha256(LEGACY_IDENTITY_BYTES).hexdigest()
                and checkpoint.get("target_identity") == target_identity(root_fd),
                "Prepared target identity changed")
    require(
        all(checkpoint.get(key) == value for key, value in actual.items()),
        "Prepared storage identity or content changed",
    )
    return actual


def switch_staged_storage(snapshot, root_fd, checkpoint):
    """Only switch the already validated tree; never extract after SQL restore."""
    verify_staged_storage(snapshot, root_fd, checkpoint)
    assert_root(snapshot, root_fd)
    try:
        os.stat(SWAP, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise storage.StorageError("Retained restore swap requires operator review")

    os.mkdir(SWAP, 0o700, dir_fd=root_fd)
    os.fsync(root_fd)

    stage_fd = os.open(
        STAGE,
        os.O_RDONLY | os.O_DIRECTORY
        | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=root_fd,
    )

    try:
        swap_fd = os.open(
            SWAP,
            os.O_RDONLY | os.O_DIRECTORY
            | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=root_fd,
        )

        try:
            old_names = sorted(
                set(os.listdir(root_fd))
                - {STAGE, SWAP, TEMP, IDENTITY_MARKER}
            )

            new_names = sorted(os.listdir(stage_fd))

            # Regular files, directories and symlinks
            # are moved as entries, never followed.
            for name in old_names:
                os.rename(
                    name, name,
                    src_dir_fd=root_fd,
                    dst_dir_fd=swap_fd,
                )

                os.fsync(swap_fd)
                os.fsync(root_fd)

            for name in new_names:
                require(
                    name not in os.listdir(root_fd),
                    "Unexpected restore switch collision",
                )

                os.rename(
                    name, name,
                    src_dir_fd=stage_fd,
                    dst_dir_fd=root_fd,
                )

                os.fsync(stage_fd)
                os.fsync(root_fd)

            require(
                not os.listdir(stage_fd),
                "Restore staging not fully switched",
            )

            require(
                set(os.listdir(root_fd))
                - {STAGE, SWAP, TEMP, IDENTITY_MARKER}
                == set(new_names),
                "Restored root inventory mismatch",
            )

            os.rename(
                TEMP, TEMP,
                src_dir_fd=root_fd,
                dst_dir_fd=swap_fd,
            )

            os.fsync(swap_fd)
            os.fsync(root_fd)

            os.mkdir(TEMP, 0o700, dir_fd=root_fd)

            temporary_fd = os.open(
                TEMP,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=root_fd,
            )

            try:
                os.fchown(
                    temporary_fd, RESTORE_UID, RESTORE_GID
                )
                os.fchmod(temporary_fd, 0o700)
                os.fsync(temporary_fd)
            finally:
                os.close(temporary_fd)

            os.fsync(root_fd)

            require(
                set(os.listdir(swap_fd)) == set(old_names) | {TEMP},
                "Retained original storage inventory mismatch",
            )

        finally:
            os.close(swap_fd)
    finally:
        os.close(stage_fd)

    os.rmdir(STAGE, dir_fd=root_fd)
    os.fsync(root_fd)

    assert_root(snapshot, root_fd)

    # Deliberately retain SWAP. Only whole-restore
    # completion can authorize removal of old data.
    if checkpoint["historical_identity_count"]:
        require(checkpoint["target_identity"] == target_identity(root_fd),
                "Target identity changed during switch")
    return checkpoint["file_count"]


def restore_storage(snapshot, root_fd, archive_path, expected_sha, expected_count):
    """Compatibility wrapper for isolated filesystem regression fixtures."""
    checkpoint = stage_storage(
        snapshot, root_fd, archive_path, expected_sha, expected_count
    )
    return switch_staged_storage(snapshot, root_fd, checkpoint)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("scan-archive", "sparse-metadata"):
        raise SystemExit("Use the verified restore maintenance lifecycle")
    try:
        with tarfile.open(sys.argv[2], "r:gz") as archive:
            for member, parts, historical in checked_archive_members(archive):
                if sys.argv[1] == "sparse-metadata" and member.isfile() and not historical:
                    print(json.dumps({"name": member.name, "size": member.size}))
        if sys.argv[1] == "scan-archive":
            print("  storage archive security scan: OK")
    except (ValueError, OSError, tarfile.TarError) as error:
        print("ERROR: storage archive validation failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
