#!/usr/bin/env python3
"""Durable restore admission. Never automatically resume writers."""

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import subprocess
import tempfile

import recovery_storage as storage
import restore_storage as restore

ROOT = Path(__file__).resolve().parent.parent
TEST_ROOT = Path("/home/hs/homecloud-test")
RELEASE_ROOT = Path("/opt/homecloud")

RECEIPT = "restore.pending.json"
FORMAT = "homecloud-restore-transaction-v1"


def require(ok, message):
    if not ok:
        raise storage.StorageError(message)


def identity(info):
    return [info.st_dev, info.st_ino]


def missing(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def valid_token(token):
    return isinstance(token, str) and bool(
        re.fullmatch(r"[a-f0-9]{32}", token)
    )


def runtime(snapshot):
    storage.backup_local_daemon()

    require(
        snapshot.get("type") == "bind"
        and snapshot.get("target") == "/storage",
        "Restore requires qualified bind storage",
    )

    if snapshot.get("project") == "homecloud-test":
        require(ROOT == TEST_ROOT, "Wrong TEST checkout")

        state = ROOT / ".runtime/maintenance"
        channel = ROOT / ".runtime/test-channel"

        storage.qualified_state_path(channel)

        info = channel.lstat()

        require(
            stat.S_ISDIR(info.st_mode)
            and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o700,
            "Unsafe TEST channel directory",
        )

        lock = channel / "install.lock"

    else:
        require(ROOT == RELEASE_ROOT, "Wrong RELEASE checkout")

        state = storage.RELEASE_MAINTENANCE_ROOT
        lock = state / storage.RELEASE_OPERATION_LOCK

    storage.qualified_state_path(ROOT)
    storage.qualified_state_path(state)

    info = state.lstat()

    require(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == storage.BACKUP_STATE_UID
        and info.st_gid == storage.BACKUP_STATE_GID
        and stat.S_IMODE(info.st_mode) == 0o711,
        "Unsafe restore maintenance directory",
    )

    return state, lock


def inspect_lock(lock, fd):
    opened = os.fstat(fd)
    visible = lock.lstat()

    require(
        stat.S_ISREG(opened.st_mode)
        and stat.S_ISREG(visible.st_mode)
        and opened.st_uid == storage.BACKUP_STATE_UID
        and opened.st_nlink == 1
        and stat.S_IMODE(opened.st_mode) == 0o600
        and identity(opened) == identity(visible),
        "Unsafe restore operation lock",
    )


def prepare_lock(lock):
    fd = os.open(
        lock,
        os.O_CREAT | os.O_RDWR
        | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
        0o600,
    )

    try:
        inspect_lock(lock, fd)
    finally:
        os.close(fd)


def hold_operation(lock, fd, acquire=False):
    inspect_lock(lock, fd)

    if not acquire:
        contender = os.open(
            lock,
            os.O_RDONLY | os.O_NOFOLLOW
            | os.O_NONBLOCK | os.O_CLOEXEC,
        )

        try:
            inspect_lock(lock, contender)

            try:
                fcntl.flock(
                    contender,
                    fcntl.LOCK_EX | fcntl.LOCK_NB,
                )
            except BlockingIOError:
                pass
            else:
                raise storage.StorageError(
                    "Restore operation lock is not held"
                )
        finally:
            os.close(contender)

    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    inspect_lock(lock, fd)


def marker_identity(state):
    info = (state / storage.MAINTENANCE_MARKER).lstat()

    require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == storage.BACKUP_STATE_UID
        and info.st_gid == storage.BACKUP_STATE_GID
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o600,
        "Unsafe restore maintenance marker",
    )

    return identity(info)


def create_inhibit(state):
    path = ROOT / "deploy/linux/maintenance-inhibit.py"

    storage.qualified_state_path(path.parent)

    info = path.lstat()

    require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and not (info.st_mode & 0o022)
        and path.resolve(strict=True) == path,
        "Untrusted maintenance helper",
    )

    spec = importlib.util.spec_from_file_location(
        "restore_inhibitor", path
    )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.create_inhibit(str(state))


def sync_directory(path):
    fd = os.open(
        path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    )
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_receipt(state, receipt, first=False):
    path = state / RECEIPT

    if first:
        fd = os.open(
            path,
            os.O_WRONLY | os.O_CREAT
            | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        temporary = None
    else:
        fd, temporary = tempfile.mkstemp(
            prefix=".restore-checkpoint-", dir=state
        )

    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(receipt, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

        if temporary is not None:
            os.replace(temporary, path)

        sync_directory(state)

    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def read_receipt(state, snapshot, token, allow_ready=False):
    require(valid_token(token), "Invalid restore token")

    path = state / RECEIPT

    fd = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
    )

    with os.fdopen(fd, "r") as stream:
        info = os.fstat(stream.fileno())

        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == storage.BACKUP_STATE_UID
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600
            and 0 < info.st_size <= 1024 * 1024,
            "Unsafe restore checkpoint",
        )

        receipt = json.load(stream)

    marker_ok = (
        allow_ready
        and receipt.get("phase") == "READY"
        and missing(state / storage.MAINTENANCE_MARKER)
    )

    if not marker_ok:
        marker_ok = (
            receipt.get("marker_identity") == marker_identity(state)
        )

    require(
        receipt.get("format") == FORMAT
        and receipt.get("token") == token
        and receipt.get("snapshot") == snapshot
        and marker_ok,
        "Restore checkpoint identity mismatch",
    )

    return receipt


def validate_backend(snapshot, state):
    storage.checked_storage(snapshot)

    backend = storage.only(
        storage.query([
            "docker", "inspect", snapshot["container_id"],
        ], True),
        "restore backend",
    )

    require(
        backend.get("Id") == snapshot["container_id"]
        and backend.get("Image") == snapshot["image_id"],
        "Restore backend identity mismatch",
    )

    config = backend.get("Config", {})

    require(
        config.get("Entrypoint") == [
            "sh", "/run/homecloud/startup-gate.sh", "backend",
        ]
        and config.get("User") == "1001:65533",
        "Backend lacks qualified restore admission",
    )

    expected = {
        "/run/homecloud/maintenance": str(state),
        "/run/homecloud/startup-gate.sh":
            str(ROOT / "deploy/linux/startup-gate.sh"),
    }

    for target, source in expected.items():
        mount = storage.only(
            [
                item for item in backend.get("Mounts", [])
                if item.get("Destination") == target
            ],
            "restore gate mount",
        )

        require(
            mount.get("Type") == "bind"
            and mount.get("Source") == source
            and mount.get("RW") is False,
            "Unqualified restore gate mount",
        )

    env = config.get("Env", [])

    for key, value in (
        ("UPLOAD_SSD_ENABLED", "false"),
        ("UPLOAD_SSD_RECOVERY_MODE", "manual"),
    ):
        require(
            [
                item for item in env
                if item.startswith(key + "=")
            ] == [key + "=" + value],
            "SSD restore configuration is unsupported",
        )

    return backend


def begin(snapshot, state, lock, operation_fd, token):
    require(valid_token(token), "Invalid restore token")

    hold_operation(lock, operation_fd, acquire=True)

    if snapshot["project"] == "homecloud-test":
        require(
            missing(lock.parent / "pending.json"),
            "Pending TEST installation prevents restore",
        )

    require(
        missing(state / RECEIPT)
        and missing(state / storage.MAINTENANCE_MARKER)
        and not list(state.glob("restore-migration.*")),
        "Existing maintenance requires operator review",
    )

    backend = validate_backend(snapshot, state)
    services = {
        name: {"Id": item["Id"], "Image": item["Image"]}
        for name, item in storage.release_service_inventory(
            snapshot, require_ready=False
        ).items()
    }

    root = Path(snapshot["source"])
    info = root.lstat()

    require(
        root.resolve(strict=True) == root
        and stat.S_ISDIR(info.st_mode)
        and info.st_uid == restore.RESTORE_UID
        and info.st_gid == restore.RESTORE_GID
        and stat.S_IMODE(info.st_mode) == 0o700
        and identity(info) == snapshot["bind_identity"],
        "Unqualified restore storage root",
    )

    restore.reject_nested_mounts(root)

    require(
        missing(root / restore.STAGE)
        and missing(root / restore.SWAP),
        "Retained storage artifacts require operator review",
    )

    create_inhibit(state)

    receipt = {
        "format": FORMAT,
        "token": token,
        "phase": "INHIBITED",
        "snapshot": snapshot,
        "marker_identity": marker_identity(state),
        "services": services,
    }

    write_receipt(state, receipt, first=True)

    storage.verify_backup_inhibitor(snapshot, backend)

    storage.release_compose(
        "stop", "--timeout", "60",
        "ingress", "frontend", "backend",
    )

    storage.checked_storage(snapshot)
    storage.verify_backup_writers(snapshot)

    receipt["phase"] = "WRITERS_STOPPED"
    write_receipt(state, receipt)

    return receipt


def acquire_root(
    snapshot, state, lock, operation_fd, root_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "WRITERS_STOPPED",
        "Restore writer shutdown is not confirmed",
    )

    storage.backup_fence(snapshot, root_fd, acquire=True)
    restore.assert_root(snapshot, root_fd)

    receipt["phase"] = "ROOT_FENCED"
    write_receipt(state, receipt)

    return receipt


def check_root(snapshot, state, lock, operation_fd, root_fd, token):
    """Recheck this restore transaction before staging or SQL mutation.

    Backup capture deliberately refuses restore receipts. Restore admission
    instead binds both inherited fences to its own receipt/token/inhibitor.
    """
    hold_operation(lock, operation_fd)
    receipt = read_receipt(state, snapshot, token)
    require(receipt["phase"] == "ROOT_FENCED", "Unexpected restore root check phase")
    require(not list(state.glob("restore-migration.*")), "Unexpected restore migration permit")
    services = storage.release_service_inventory(snapshot, require_ready=False)
    require(
        storage.release_service_identities(services)
        == storage.release_service_identities(receipt["services"]),
        "Restore service identity changed before mutation",
    )
    restore.assert_root(snapshot, root_fd)
    backend = storage.verify_backup_writers(snapshot)
    storage.verify_backup_inhibitor(
        snapshot, backend, expected_identity=receipt["marker_identity"]
    )
    # Re-read the durable identity after the filesystem/Docker rechecks.
    require(read_receipt(state, snapshot, token) == receipt, "Restore checkpoint changed during root check")



def migration_permit(state, token):
    require(valid_token(token), "Invalid restore token")
    device, inode = marker_identity(state)
    return state / ("restore-migration.%s.%s.%s" % (token, device, inode))


def migration_container_name(token):
    require(valid_token(token), "Invalid restore token")
    return "homecloud-restore-migration-" + token


def assert_no_migration_container(token):
    for selector in (
        "label=homecloud.restore.migration=" + token,
        "name=^/" + migration_container_name(token) + "$",
    ):
        require(
            not storage.query([
                "docker", "ps", "-a", "-q",
                "--no-trunc", "--filter", selector,
            ]),
            "Restore migration container remains present",
        )


def mark_storage_switched(
    snapshot, state, lock, operation_fd, root_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "DB_RESTORED",
        "Unexpected storage switch phase",
    )

    root = restore.assert_root(snapshot, root_fd)
    # Use the pinned root, not any caller-supplied path.
    root = Path(snapshot["source"])

    require(
        missing(root / restore.STAGE),
        "Restore staging remains present",
    )

    swap = (root / restore.SWAP).lstat()

    require(
        stat.S_ISDIR(swap.st_mode)
        and swap.st_uid == storage.BACKUP_STATE_UID
        and stat.S_IMODE(swap.st_mode) == 0o700,
        "Missing or unsafe retained original storage",
    )

    receipt["swap_identity"] = identity(swap)
    receipt["phase"] = "STORAGE_SWITCHED"

    write_receipt(state, receipt)
    return receipt


def assert_retained_swap(snapshot, receipt):
    root = Path(snapshot["source"])

    require(
        missing(root / restore.STAGE),
        "Restore staging remains present",
    )

    swap = (root / restore.SWAP).lstat()

    require(
        stat.S_ISDIR(swap.st_mode)
        and swap.st_uid == storage.BACKUP_STATE_UID
        and stat.S_IMODE(swap.st_mode) == 0o700
        and identity(swap) == receipt.get("swap_identity"),
        "Retained original storage identity changed",
    )


def open_root_fenced(snapshot):
    fd = os.open(
        snapshot["source"],
        os.O_RDONLY | os.O_DIRECTORY
        | os.O_NOFOLLOW | os.O_CLOEXEC,
    )

    try:
        storage.backup_fence(snapshot, fd, acquire=True)
        restore.assert_root(snapshot, fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def create_migration_permit(state, token):
    permit = migration_permit(state, token)

    fd = os.open(
        permit,
        os.O_WRONLY | os.O_CREAT
        | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )

    try:
        info = os.fstat(fd)

        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == storage.BACKUP_STATE_UID
            and info.st_gid == storage.BACKUP_STATE_GID
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600,
            "Unsafe migration permit identity",
        )

        os.write(fd, b"homecloud-restore-migration-v1\n")
        os.fsync(fd)

        require(
            identity(permit.lstat()) == identity(info),
            "Migration permit identity changed",
        )

        sync_directory(state)
        return identity(info)

    finally:
        os.close(fd)


def revoke_migration_permit(state, token, expected):
    permit = migration_permit(state, token)
    info = permit.lstat()

    require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == storage.BACKUP_STATE_UID
        and info.st_gid == storage.BACKUP_STATE_GID
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o600
        and identity(info) == expected,
        "Migration permit identity changed",
    )

    permit.unlink()
    sync_directory(state)


def run_migration(snapshot, state, lock, operation_fd, token):
    """The host releases root flock only for the fenced migration."""
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "STORAGE_SWITCHED",
        "Storage switch checkpoint required",
    )

    assert_no_migration_container(token)

    # Refuse if the caller still holds an independent root lock.
    fd = open_root_fenced(snapshot)

    try:
        assert_retained_swap(snapshot, receipt)

        require(
            not list(state.glob("restore-migration.*")),
            "Existing migration authorization requires review",
        )

        receipt["permit_identity"] = create_migration_permit(
            state, token
        )

        receipt["phase"] = "MIGRATION_RUNNING"
        write_receipt(state, receipt)

    finally:
        os.close(fd)

    # The dedicated Node supervisor acquires the same inode flock.
    # A durable inhibitor and receipt survive a host-side crash.
    storage.release_compose(
        "run", "--rm", "--no-deps", "--pull", "never",
        "--name", migration_container_name(token),
        "--label", "homecloud.restore.migration=" + token,
        "-T", "backend",
        "node", "docker/copy-root-fence-supervisor.cjs",
        "--restore-migration", token,
    )

    # Success requires the migration container to be gone.
    assert_no_migration_container(token)

    fd = open_root_fenced(snapshot)

    try:
        receipt = read_receipt(state, snapshot, token)

        require(
            receipt["phase"] == "MIGRATION_RUNNING",
            "Unexpected migration checkpoint",
        )

        assert_retained_swap(snapshot, receipt)
        assert_no_migration_container(token)

        revoke_migration_permit(
            state, token, receipt["permit_identity"]
        )

        receipt["phase"] = "MIGRATED"
        write_receipt(state, receipt)

    finally:
        os.close(fd)

    return receipt


def acquire_after_migration(
    snapshot, state, lock, operation_fd, root_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "MIGRATED"
        and not list(state.glob("restore-migration.*")),
        "Migration completion not confirmed",
    )

    assert_no_migration_container(token)

    storage.backup_fence(snapshot, root_fd, acquire=True)
    restore.assert_root(snapshot, root_fd)

    assert_retained_swap(snapshot, receipt)
    assert_no_migration_container(token)

    receipt["phase"] = "POST_MIGRATION_FENCED"
    write_receipt(state, receipt)

    return receipt



def mark_database_restored(
    snapshot, state, lock, operation_fd, root_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "STORAGE_STAGED",
        "Unexpected database restore phase",
    )

    restore.assert_root(snapshot, root_fd)
    restore.verify_staged_storage(snapshot, root_fd, receipt.get("staged_storage"))

    receipt["phase"] = "DB_RESTORED"
    write_receipt(state, receipt)


def stage_storage(
    snapshot, state, lock, operation_fd, root_fd,
    token, archive, checksum, count,
):
    hold_operation(lock, operation_fd)
    receipt = read_receipt(state, snapshot, token)
    require(receipt["phase"] == "ROOT_FENCED", "Unexpected staging phase")
    receipt["staged_storage"] = restore.stage_storage(
        snapshot, root_fd, archive, checksum, count
    )
    receipt["phase"] = "STORAGE_STAGED"
    write_receipt(state, receipt)
    return receipt


def verify_staged(snapshot, state, lock, operation_fd, root_fd, token):
    hold_operation(lock, operation_fd)
    receipt = read_receipt(state, snapshot, token)
    require(receipt["phase"] == "STORAGE_STAGED", "Storage staging is not confirmed")
    restore.verify_staged_storage(snapshot, root_fd, receipt.get("staged_storage"))


def switch_storage(
    snapshot, state, lock, operation_fd, root_fd,
    token, archive, checksum, count,
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "DB_RESTORED",
        "Database restore checkpoint required",
    )

    prepared = receipt.get("staged_storage", {})
    require(
        prepared.get("archive_sha256") == checksum
        and prepared.get("archive_file_count") == count,
        "Prepared archive metadata changed",
    )
    restore.switch_staged_storage(snapshot, root_fd, prepared)

    return mark_storage_switched(
        snapshot, state, lock,
        operation_fd, root_fd, token,
    )


def verify_pending():
    with (ROOT / "scripts/recovery-pending.sql").open("rb") as sql:
        result = subprocess.run(
            [
                *storage.compose_command(),
                "exec", "-T", "db", "psql",
                "-X", "-v", "ON_ERROR_STOP=1",
                "-U", os.environ["DB_USER"],
                "-d", os.environ["DB_NAME"],
            ],
            stdin=sql,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )

    require(
        result.returncode == 0,
        "Pending recovery state prevents restore completion",
    )


def run_reconciliation(snapshot):
    require(
        os.environ.get("SKIP_RECONCILE") != "1",
        "Restore reconciliation cannot be skipped",
    )

    environment = {
        **os.environ,
        "RECOVERY_STORAGE_SNAPSHOT": json.dumps(snapshot),
    }

    result = subprocess.run(
        [
            sys.executable, "-B",
            str(ROOT / "scripts/reconcile.py"),
            "--db-user", os.environ["DB_USER"],
            "--db-name", os.environ["DB_NAME"],
            "--backend-image", snapshot["image_id"],
        ],
        env=environment,
        timeout=1800,
    )

    require(
        result.returncode == 0,
        "Restore reconciliation failed",
    )



def remove_tree_at(parent_fd, name, expected):
    """Descriptor-relative cleanup compatible with Python 3.9+."""
    visible = os.stat(
        name, dir_fd=parent_fd, follow_symlinks=False
    )

    require(
        stat.S_ISDIR(visible.st_mode)
        and identity(visible) == expected,
        "Cleanup directory identity changed",
    )

    fd = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY
        | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=parent_fd,
    )

    try:
        opened = os.fstat(fd)

        require(
            identity(opened) == expected
            and opened.st_dev == os.fstat(parent_fd).st_dev,
            "Cleanup directory identity or device changed",
        )

        for entry in os.listdir(fd):
            info = os.stat(
                entry, dir_fd=fd, follow_symlinks=False
            )

            if stat.S_ISDIR(info.st_mode):
                remove_tree_at(fd, entry, identity(info))
            elif (
                stat.S_ISREG(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
            ):
                # Remove the entry itself, never its symlink target.
                os.unlink(entry, dir_fd=fd)
            else:
                raise storage.StorageError(
                    "Unexpected special file in retained storage"
                )

        os.fsync(fd)

        require(
            identity(os.stat(
                name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )) == expected,
            "Cleanup directory replaced",
        )

        os.rmdir(name, dir_fd=parent_fd)
        os.fsync(parent_fd)

    finally:
        os.close(fd)


def complete_restore(
    snapshot, state, lock, operation_fd, root_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(state, snapshot, token)

    require(
        receipt["phase"] == "POST_MIGRATION_FENCED"
        and not list(state.glob("restore-migration.*")),
        "Restore migration completion not confirmed",
    )

    root = restore.assert_root(snapshot, root_fd)

    assert_no_migration_container(token)
    assert_retained_swap(snapshot, receipt)

    verify_pending()
    run_reconciliation(snapshot)
    storage.verify_backup_completion_data(snapshot, allow_retained_swap=True)

    # No deletion until all data checks have passed.
    root = restore.assert_root(snapshot, root_fd)

    assert_no_migration_container(token)
    assert_retained_swap(snapshot, receipt)
    backend = storage.verify_backup_writers(snapshot)
    storage.verify_backup_inhibitor(
        snapshot, backend, expected_identity=receipt["marker_identity"]
    )

    receipt["phase"] = "RECONCILED"
    write_receipt(state, receipt)

    # Remove only the verified swap through pinned descriptors.
    remove_tree_at(
        root_fd, restore.SWAP, receipt["swap_identity"]
    )

    require(
        missing(root / restore.SWAP)
        and missing(root / restore.STAGE),
        "Restore artifacts remain after cleanup",
    )

    restore.assert_root(snapshot, root_fd)

    assert_no_migration_container(token)

    backend = storage.verify_backup_writers(snapshot)

    # Durable verified checkpoint before releasing startup admission.
    receipt["phase"] = "READY"
    write_receipt(state, receipt)

    storage.verify_backup_inhibitor(
        snapshot, backend,
        expected_identity=receipt["marker_identity"],
        clear=True,
    )


def restart_restored_services(snapshot, state, lock, operation_fd, token):
    hold_operation(lock, operation_fd)
    receipt = read_receipt(state, snapshot, token, allow_ready=True)
    require(
        receipt["phase"] == "READY"
        and missing(state / storage.MAINTENANCE_MARKER),
        "Restore restart has no verified completion checkpoint",
    )
    storage.restart_existing_services(snapshot, receipt["services"])


def acknowledge_restart(
    snapshot, state, lock, operation_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(
        state, snapshot, token, allow_ready=True
    )

    require(
        receipt["phase"] == "READY"
        and missing(state / storage.MAINTENANCE_MARKER)
        and not list(state.glob("restore-migration.*")),
        "Restore restart has no verified completion checkpoint",
    )

    storage.checked_storage(snapshot)
    services = storage.release_service_inventory(snapshot)
    require(
        storage.release_service_identities(services)
        == storage.release_service_identities(receipt["services"]),
        "Restore containers changed before acknowledgement",
    )

    assert_no_migration_container(token)

    (state / RECEIPT).unlink()
    sync_directory(state)


def retain_after_failure(
    snapshot, state, lock, operation_fd, token
):
    hold_operation(lock, operation_fd)

    receipt = read_receipt(
        state, snapshot, token, allow_ready=True
    )

    marker = state / storage.MAINTENANCE_MARKER

    if missing(marker):
        require(
            receipt["phase"] == "READY",
            "Unexpected missing maintenance inhibitor",
        )

        create_inhibit(state)

        receipt["marker_identity"] = marker_identity(state)
        receipt["phase"] = "RESTART_FAILED"
        write_receipt(state, receipt)


def main():
    try:
        action = sys.argv[1]
        storage.backup_local_daemon()
        snapshot = storage.resolve_storage()
        state, lock = runtime(snapshot)

        if action == "prepare" and len(sys.argv) == 2:
            prepare_lock(lock)
            print(lock)

        elif action == "lock" and len(sys.argv) == 2:
            hold_operation(lock, 8, acquire=True)

        elif action == "begin" and len(sys.argv) == 3:
            begin(snapshot, state, lock, 8, sys.argv[2])
            print("RESTORE_WRITERS_STOPPED")

        elif action == "acquire-root" and len(sys.argv) == 3:
            acquire_root(
                snapshot, state, lock, 8, 9, sys.argv[2]
            )
            print("RESTORE_ROOT_FENCED")

        elif action == "check-root" and len(sys.argv) == 3:
            check_root(snapshot, state, lock, 8, 9, sys.argv[2])
            print("RESTORE_ROOT_VERIFIED")

        elif action == "db-restored" and len(sys.argv) == 3:
            mark_database_restored(
                snapshot, state, lock, 8, 9, sys.argv[2]
            )

        elif action == "stage" and len(sys.argv) == 6:
            stage_storage(
                snapshot, state, lock, 8, 9,
                sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]),
            )
            print("RESTORE_STORAGE_STAGED")

        elif action == "verify-staged" and len(sys.argv) == 3:
            verify_staged(snapshot, state, lock, 8, 9, sys.argv[2])

        elif action == "switch" and len(sys.argv) == 6:
            switch_storage(
                snapshot, state, lock, 8, 9,
                sys.argv[2], sys.argv[3],
                sys.argv[4], int(sys.argv[5]),
            )
            print("RESTORE_STORAGE_CHECKPOINTED")

        elif action == "migrate" and len(sys.argv) == 3:
            run_migration(
                snapshot, state, lock, 8, sys.argv[2]
            )
            print("RESTORE_MIGRATION_COMPLETE")

        elif action == "acquire-after-migration" and len(sys.argv) == 3:
            acquire_after_migration(
                snapshot, state, lock, 8, 9, sys.argv[2]
            )
            print("RESTORE_POST_MIGRATION_FENCED")

        elif action == "complete" and len(sys.argv) == 3:
            complete_restore(
                snapshot, state, lock, 8, 9, sys.argv[2]
            )
            print("RESTORE_DATA_VERIFIED")

        elif action == "ack" and len(sys.argv) == 3:
            acknowledge_restart(
                snapshot, state, lock, 8, sys.argv[2]
            )
            print("RESTORE_COMPLETE")

        elif action == "restart" and len(sys.argv) == 3:
            restart_restored_services(snapshot, state, lock, 8, sys.argv[2])

        elif action == "retain" and len(sys.argv) == 3:
            retain_after_failure(
                snapshot, state, lock, 8, sys.argv[2]
            )

        else:
            raise storage.StorageError("Invalid restore admission action")

        return 0

    except (
        storage.StorageError, OSError,
        ValueError, KeyError, IndexError,
    ):
        print(
            "STOP: restore admission refused; "
            "existing maintenance state retained",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
