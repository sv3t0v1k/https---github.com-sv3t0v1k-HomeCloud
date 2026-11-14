#!/usr/bin/env python3
"""Resolve existing backend storage identity; never guess or create a volume.

Named volumes are inherited from a pinned existing backend container. Binds use
--mount (Docker fails if the source disappears) and require a locally visible
source directory. Each helper run re-resolves identity immediately before use.
"""
from contextlib import contextmanager
import errno
import fcntl
import importlib.util
import json
import os
import stat
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
from recovery_config import compose_command, load_config

class StorageError(ValueError):
    pass

def query(args, json_result=False):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise StorageError('Docker storage inspection unavailable') from None
    if result.returncode:
        raise StorageError('Docker storage inspection failed')
    if json_result:
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError):
            raise StorageError('Docker storage inspection returned invalid JSON') from None
    return result.stdout.strip()

def only(items, what):
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise StorageError('expected exactly one ' + what)
    return items[0]

def clean_path(path):
    if not isinstance(path, str) or not path.startswith('/') or path == '/' or '\\' in path or any(c in path for c in '\x00\n\r,:') or str(PurePosixPath(path)) != path or '..' in path.split('/'):
        raise StorageError('invalid storage mount path')
    return path

def resolve_storage():
    target = clean_path(os.environ.get('STORAGE_PATH', '/storage'))
    project = os.environ.get('COMPOSE_PROJECT_NAME')
    if not project:
        raise StorageError('COMPOSE_PROJECT_NAME is required')
    config = query([*compose_command(), 'config', '--format', 'json'], True)
    if not isinstance(config, dict) or config.get('name') != project:
        raise StorageError('Compose project identity mismatch')
    declared = only([m for m in config.get('services', {}).get('backend', {}).get('volumes', []) if isinstance(m, dict) and m.get('target') == target], 'declared backend storage mount')
    mount_type = declared.get('type')
    if mount_type not in ('bind', 'volume') or not declared.get('source') or declared.get('read_only', False):
        raise StorageError('backend storage must be an explicit writable bind or named volume')
    # Nested mount shadows make the selected root insufficient for an archive.
    for other in config.get('services', {}).get('backend', {}).get('volumes', []):
        if isinstance(other, dict) and str(other.get('target', '')).startswith(target + '/'):
            raise StorageError('nested storage mounts are unsupported')
    ids = query([*compose_command(), 'ps', '--all', '-q', 'backend']).splitlines()
    if len(ids) != 1 or not re.fullmatch(r'[0-9a-f]{12,64}', ids[0]):
        raise StorageError('exactly one existing backend container is required')
    container = only(query(['docker', 'inspect', ids[0]], True), 'backend container')
    cid = container.get('Id', '')
    labels = container.get('Config', {}).get('Labels') or {}
    if not re.fullmatch(r'[0-9a-f]{64}', cid) or not cid.startswith(ids[0]) or labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.service') != 'backend' or labels.get('com.docker.compose.oneoff', '').lower() != 'false':
        raise StorageError('backend container identity mismatch')
    hashes = query([*compose_command(), 'config', '--hash', 'backend']).split()
    if len(hashes) != 2 or hashes[0] != 'backend' or not hashes[1] or labels.get('com.docker.compose.config-hash') != hashes[1]:
        raise StorageError('backend container does not match current Compose configuration')
    backend_image = config.get('services', {}).get('backend', {}).get('image')
    if not backend_image:
        raise StorageError('explicit local backend image is required')
    image_info = only(query(['docker', 'image', 'inspect', backend_image], True), 'configured local backend image')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', container.get('Image', '')) or image_info.get('Id') != container['Image']:
        raise StorageError('configured backend image differs from pinned container image')
    mount = only([m for m in container.get('Mounts' , []) if isinstance(m, dict) and m.get('Destination') == target], 'actual backend storage mount')
    if any(str(m.get('Destination', '')).startswith(target + '/') for m in container.get('Mounts', [])):
        raise StorageError('actual nested storage mounts are unsupported')
    if mount.get('Type') != mount_type or mount.get('RW') is not True:
        raise StorageError('actual storage mount type/access mismatch')
    result = {'container_id': cid, 'image_id': container['Image'], 'project': project, 'config_hash': hashes[1], 'target': target, 'type': mount_type, 'source': mount.get('Source'), 'name': '', 'declared': declared}
    override = os.environ.get('STORAGE_VOLUME', '')
    if mount_type == 'volume':
        info = config.get('volumes', {}).get(declared['source'])
        if not isinstance(info, dict) or not info.get('name'):
            raise StorageError('resolved Compose volume name is required')
        name = info['name']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) or mount.get('Name') != name or (override and override != name):
            raise StorageError('actual storage volume identity mismatch')
        volume = only(query(['docker', 'volume', 'inspect', name], True), 'existing storage volume')
        if volume.get('Name') != name or not volume.get('Mountpoint') or volume.get('Mountpoint') != mount.get('Source') or volume.get('Driver') != mount.get('Driver'):
            raise StorageError('storage volume inspection identity mismatch')
        result.update(name=name, volume=volume)
    else:
        source = clean_path(declared['source'])
        if override or mount.get('Source') != source:
            raise StorageError('actual storage bind identity mismatch')
        try:
            path = Path(source)
            if path.is_symlink() or not path.is_dir() or str(path.resolve()) != source:
                raise StorageError('bind storage must be an existing canonical local directory')
            info = path.stat()
        except OSError:
            raise StorageError('bind storage source unavailable locally') from None
        result['bind_identity'] = [info.st_dev, info.st_ino]
    return result

def checked_storage(snapshot):
    if not isinstance(snapshot, dict) or resolve_storage() != snapshot:
        raise StorageError('backend storage identity changed after preflight')
    return snapshot

def storage_command(snapshot, mode, image, command, options=()):
    checked_storage(snapshot)
    if mode not in ('ro', 'rw') or not image or not command:
        raise StorageError('invalid storage helper invocation')
    if any(option not in ('--user', 'root', '-i', '--entrypoint', 'sh') for option in options):
        raise StorageError('unsupported storage helper option')
    # Pin an existing local helper image. Extra VOLUME declarations create
    # anonymous disks even when the selected storage itself is inherited.
    helper = only(query(['docker', 'image', 'inspect', image], True), 'local helper image')
    image_id = helper.get('Id', '')
    declared_volumes = helper.get('Config', {}).get('Volumes') or {}
    if image_id != snapshot['image_id'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) or not isinstance(declared_volumes, dict) or not set(declared_volumes).issubset({snapshot['target']}):
        raise StorageError('helper image identity or unmounted VOLUME declaration rejected')
    if snapshot['type'] == 'volume':
        mount = ['--volumes-from', snapshot['container_id'] + ':' + mode]
    else:
        spec = 'type=bind,src=' + snapshot['source'] + ',dst=' + snapshot['target']
        if mode == 'ro':
            spec += ',readonly'
        mount = ['--mount', spec]
    return ['docker', 'run', '--rm', '--network', 'none', '--pull=never', *options, *mount, image_id, *command]



# Backup requires the same storage identity and durable
# maintenance admission used by the application writer fence.
BACKUP_STORAGE_UID = 1001
BACKUP_STATE_UID = 0
BACKUP_STATE_GID = 0

TEST_MAINTENANCE_ROOT = (
    Path(__file__).resolve().parent.parent
    / ".runtime" / "maintenance"
)
RELEASE_MAINTENANCE_ROOT = Path("/etc/homecloud/maintenance")

MAINTENANCE_MARKER = "maintenance.inhibit"
MAINTENANCE_PAYLOAD = b"homecloud-maintenance-v1\n"


def backup_require(ok, message):
    if not ok:
        raise StorageError(message)


def backup_local_daemon():
    """Host inode fencing is valid only for the local Linux daemon."""
    backup_require(
        sys.platform == "linux" and os.geteuid() == 0,
        "Backup fence requires a root Linux host",
    )

    context = os.environ.get("DOCKER_CONTEXT", "")
    host = os.environ.get("DOCKER_HOST", "")

    backup_require(
        context in ("", "default"),
        "Non-default Docker context is not qualified",
    )

    backup_require(
        not host or host == "unix:///var/run/docker.sock",
        "Backup requires the qualified local Docker socket",
    )

    if not host or context == "default":
        host = query([
            "docker", "context", "inspect",
            "--format", "{{.Endpoints.docker.Host}}",
        ])

    backup_require(
        host == "unix:///var/run/docker.sock",
        "Backup requires the qualified local Docker socket",
    )


def inode_identity(info):
    return (info.st_dev, info.st_ino)


def qualified_state_path(path):
    """The maintenance root and all ancestors are trusted host paths."""
    backup_require(
        path.is_absolute()
        and str(path.resolve(strict=True)) == str(path),
        "Noncanonical maintenance path",
    )

    for ancestor in (path, *path.parents):
        info = ancestor.lstat()
        backup_require(
            stat.S_ISDIR(info.st_mode)
            and info.st_uid == 0
            and not (info.st_mode & 0o022),
            "Untrusted maintenance directory ancestry",
        )


def verify_backup_inhibitor(
    snapshot, backend, *, expected_identity=None, clear=False
):
    project = snapshot["project"]

    root = (
        TEST_MAINTENANCE_ROOT
        if project == "homecloud-test"
        else RELEASE_MAINTENANCE_ROOT
    )

    qualified_state_path(root)

    mounts = backend.get("Mounts", [])

    marker_mounts = [
        mount for mount in mounts
        if mount.get("Destination") ==
        "/run/homecloud/maintenance"
    ]

    mount = only(
        marker_mounts, "backend maintenance mount"
    )

    backup_require(
        mount.get("Type") == "bind"
        and mount.get("Source") == str(root)
        and mount.get("RW") is False,
        "Backend maintenance mount is not qualified",
    )

    before = root.lstat()

    backup_require(
        stat.S_ISDIR(before.st_mode)
        and before.st_uid == BACKUP_STATE_UID
        and before.st_gid == BACKUP_STATE_GID
        and stat.S_IMODE(before.st_mode) == 0o711,
        "Unsafe maintenance state directory",
    )

    directory = os.open(
        root,
        os.O_RDONLY | os.O_DIRECTORY
        | os.O_NOFOLLOW | os.O_CLOEXEC,
    )

    try:
        actual = os.fstat(directory)

        backup_require(
            inode_identity(actual) == inode_identity(before)
            and actual.st_uid == BACKUP_STATE_UID
            and actual.st_gid == BACKUP_STATE_GID
            and stat.S_IMODE(actual.st_mode) == 0o711,
            "Maintenance directory identity changed",
        )

        marker = os.open(
            MAINTENANCE_MARKER,
            os.O_RDONLY | os.O_NOFOLLOW
            | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=directory,
        )

        try:
            info = os.fstat(marker)

            backup_require(
                stat.S_ISREG(info.st_mode)
                and info.st_uid == BACKUP_STATE_UID
                and info.st_gid == BACKUP_STATE_GID
                and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600,
                "Invalid maintenance inhibitor identity",
            )

            payload = os.read(
                marker, len(MAINTENANCE_PAYLOAD) + 1
            )

            backup_require(
                payload == MAINTENANCE_PAYLOAD,
                "Invalid maintenance inhibitor payload",
            )

            visible = os.stat(
                MAINTENANCE_MARKER,
                dir_fd=directory,
                follow_symlinks=False,
            )

            backup_require(
                inode_identity(visible) ==
                inode_identity(info),
                "Maintenance inhibitor identity changed",
            )

            if expected_identity is not None:
                backup_require(
                    list(inode_identity(info)) == expected_identity,
                    "Maintenance marker belongs to another operation",
                )

            if clear:
                backup_require(expected_identity is not None,
                               "Maintenance marker identity required for clear")
                # The caller has already verified the backup,
                # journal, stopped writers and both kernel locks.
                os.unlink(
                    MAINTENANCE_MARKER,
                    dir_fd=directory,
                )
                os.fsync(directory)
        finally:
            os.close(marker)
    finally:
        os.close(directory)


def verify_backup_writers(snapshot):
    backend = only(
        query([
            "docker", "inspect",
            snapshot["container_id"],
        ], True),
        "installed backend",
    )

    backup_require(
        backend.get("Id") == snapshot["container_id"]
        and backend.get("Image") == snapshot["image_id"],
        "Installed backend identity changed",
    )

    state = backend.get("State", {})

    backup_require(
        state.get("Running") is False
        and state.get("Restarting") is False
        and state.get("Paused") is False
        and state.get("Status") in ("created", "exited"),
        "Backend must be fully stopped before backup",
    )

    verify_backup_inhibitor(snapshot, backend)

    # Inspect all running containers, not merely containers
    # with this project's backend label.
    root = Path(snapshot["source"])
    root_id = inode_identity(root.stat())
    root_ancestors = {
        inode_identity(path.stat())
        for path in (root, *root.parents)
    }

    ids = query([
        "docker", "ps", "-q", "--no-trunc",
    ]).splitlines()

    backup_require(
        all(re.fullmatch(r"[0-9a-f]{64}", cid) for cid in ids)
        and len(ids) == len(set(ids)),
        "Invalid running container inventory",
    )

    for cid in ids:
        item = only(
            query(["docker", "inspect", cid], True),
            "running container",
        )

        backup_require(
            item.get("Id") == cid,
            "Running container identity changed",
        )

        labels = item.get("Config", {}).get("Labels") or {}

        backup_require(
            not (
                labels.get("com.docker.compose.project") ==
                snapshot["project"]
                and labels.get("com.docker.compose.service") ==
                "backend"
            ),
            "A project backend writer is still running",
        )

        mounts = item.get("Mounts")

        backup_require(
            isinstance(mounts, list),
            "Invalid running container mount inventory",
        )

        for mount in mounts:
            mode = mount.get("RW")

            backup_require(
                type(mode) is bool,
                "Unknown running container mount access",
            )

            if not mode or mount.get("Type") == "tmpfs":
                continue

            backup_require(
                mount.get("Type") in ("bind", "volume"),
                "Unqualified writable mount type",
            )

            source = mount.get("Source")

            backup_require(
                isinstance(source, str)
                and os.path.isabs(source),
                "Unqualified writable mount source",
            )

            path = Path(source).resolve(strict=True)

            # Compare filesystem identities as well as paths.
            # A bind alias of the root or its parent must not
            # hide a writable storage mount.
            source_id = inode_identity(path.stat())
            source_ancestors = {
                inode_identity(parent.stat())
                for parent in (path, *path.parents)
            }

            overlap = (
                path == root
                or root in path.parents
                or path in root.parents
                or source_id in root_ancestors
                or root_id in source_ancestors
            )

            backup_require(
                not overlap,
                "Writable container storage mount remains active",
            )

    return backend


def backup_fence(snapshot, fd, acquire):
    """The Bash parent owns fd throughout staging and publication."""
    backup_local_daemon()
    checked_storage(snapshot)

    backup_require(
        snapshot.get("type") == "bind"
        and snapshot.get("target") == "/storage",
        "Backup fence requires qualified legacy bind storage",
    )

    root = Path(snapshot["source"])

    backup_require(
        root.is_absolute()
        and str(root.resolve(strict=True)) == str(root),
        "Invalid backup storage root",
    )

    visible = root.lstat()
    opened = os.fstat(fd)

    backup_require(
        stat.S_ISDIR(visible.st_mode)
        and stat.S_ISDIR(opened.st_mode)
        and visible.st_uid == BACKUP_STORAGE_UID
        and opened.st_uid == BACKUP_STORAGE_UID
        and stat.S_IMODE(visible.st_mode) == 0o700
        and stat.S_IMODE(opened.st_mode) == 0o700
        and inode_identity(visible) == inode_identity(opened)
        and list(inode_identity(opened)) ==
        snapshot.get("bind_identity"),
        "Backup fence descriptor does not match storage root",
    )

    verify_backup_writers(snapshot)

    if not acquire:
        # An independent open-file description must be blocked
        # by the existing exclusive lock. Never silently
        # reacquire a missing lock just before publication.
        contender = os.open(
            root,
            os.O_RDONLY | os.O_DIRECTORY
            | os.O_NOFOLLOW | os.O_CLOEXEC,
        )

        try:
            backup_require(
                inode_identity(os.fstat(contender)) ==
                inode_identity(opened),
                "Storage root changed during lock verification",
            )

            try:
                fcntl.flock(
                    contender, fcntl.LOCK_EX | fcntl.LOCK_NB
                )
            except OSError as error:
                if error.errno not in (
                    errno.EAGAIN, errno.EWOULDBLOCK
                ):
                    raise
            else:
                raise StorageError(
                    "Backup fence was not held continuously"
                )
        finally:
            os.close(contender)

    # On acquisition this obtains the lock. On recheck it
    # confirms the inherited description is the lock owner,
    # rather than a different process owning the root lock.
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    backup_require(
        inode_identity(root.lstat()) == inode_identity(opened),
        "Storage root changed after fence acquisition",
    )

    checked_storage(snapshot)
    verify_backup_writers(snapshot)




def verify_test_install_lock(fd):
    """Require the installer's actual inherited open-file description."""
    path = TEST_MAINTENANCE_ROOT.parent / "test-channel" / "install.lock"
    verify_inherited_operation_lock(path, fd)


def verify_inherited_operation_lock(path, fd):
    """A busy path alone is insufficient: caller must own the locked OFD."""

    qualified_state_path(path.parent)

    backup_require(
        type(fd) is int and fd >= 3,
        "Invalid inherited operation descriptor",
    )
    opened = os.fstat(fd)
    visible = path.lstat()
    backup_require(
        stat.S_ISREG(opened.st_mode)
        and stat.S_ISREG(visible.st_mode)
        and opened.st_uid == BACKUP_STATE_UID
        and opened.st_nlink == 1
        and stat.S_IMODE(opened.st_mode) == 0o600
        and inode_identity(opened) == inode_identity(visible),
        "Invalid inherited operation lock",
    )

    contender = os.open(
        path,
        os.O_RDWR | os.O_NOFOLLOW
        | os.O_NONBLOCK | os.O_CLOEXEC,
    )

    try:
        backup_require(
            inode_identity(os.fstat(contender)) ==
            inode_identity(opened),
            "Operation lock identity changed",
        )

        try:
            fcntl.flock(
                contender, fcntl.LOCK_EX | fcntl.LOCK_NB
            )
        except OSError as error:
            if error.errno not in (
                errno.EAGAIN, errno.EWOULDBLOCK
            ):
                raise
        else:
            raise StorageError("Operation lock is not held")
    finally:
        os.close(contender)

    # An unrelated process holding the lock is insufficient.
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def read_test_backup_checkpoint(backup_id, *, capturing=False):
    path = TEST_MAINTENANCE_ROOT.parent / "test-channel" / "pending.json"

    qualified_state_path(path.parent)

    backup_require(
        (capturing and backup_id is None)
        or (not capturing and isinstance(backup_id, str) and re.fullmatch(
            r"[0-9]{8}_[0-9]{6}_[a-f0-9]{8}", backup_id
        ) is not None),
        "Invalid TEST backup identity",
    )

    fd = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW
        | os.O_NONBLOCK | os.O_CLOEXEC,
    )

    with os.fdopen(fd, "r") as stream:
        info = os.fstat(stream.fileno())

        backup_require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == BACKUP_STATE_UID
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600
            and 0 < info.st_size <= 1024 * 1024,
            "Unsafe TEST backup checkpoint",
        )

        transaction = json.load(stream)

    marker_identity = transaction.get("backup_maintenance")

    backup_require(
        transaction.get("format") == "homecloud-test-transaction-v1"
        and transaction.get("phase") == "BACKUP"
        and (capturing or transaction.get("backup_id") == backup_id)
        and isinstance(marker_identity, list)
        and len(marker_identity) == 2
        and all(type(value) is int and value >= 0
                for value in marker_identity)
        and marker_identity[1] > 0,
        "Verified TEST backup checkpoint required",
    )

    return marker_identity


def verify_backup_capture(snapshot, operation_fd, marker_identity):
    """Capture belongs to this maintenance owner, never an existing restore."""
    backup_require(
        isinstance(marker_identity, list) and len(marker_identity) == 2
        and all(type(value) is int and value >= 0 for value in marker_identity)
        and marker_identity[1] > 0,
        "Invalid capture marker identity",
    )
    state = (TEST_MAINTENANCE_ROOT if snapshot["project"] == "homecloud-test"
             else RELEASE_MAINTENANCE_ROOT)
    lock = (state.parent / "test-channel" / "install.lock"
            if snapshot["project"] == "homecloud-test"
            else state / RELEASE_OPERATION_LOCK)
    verify_inherited_operation_lock(lock, operation_fd)
    qualified_state_path(state)
    backup_require(
        not any(name == "restore.pending.json" or name.startswith("restore-migration.")
                for name in os.listdir(state)),
        "Unfinished restore prevents backup capture",
    )
    if snapshot["project"] == "homecloud-test":
        backup_require(read_test_backup_checkpoint(None, capturing=True) == marker_identity,
                       "Capture differs from TEST backup checkpoint")
    backend = verify_backup_writers(snapshot)
    verify_backup_inhibitor(snapshot, backend, expected_identity=marker_identity)


def verify_backup_completion_data(snapshot, allow_retained_swap=False):
    """Recheck data admission while the storage root is fenced."""
    sql = Path(__file__).with_name("recovery-pending.sql")

    with sql.open("rb") as stream:
        result = subprocess.run(
            [
                *compose_command(), "exec", "-T", "db",
                "psql", "-X", "-v", "ON_ERROR_STOP=1",
                "-U", os.environ["DB_USER"],
                "-d", os.environ["DB_NAME"],
            ],
            stdin=stream,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )

    backup_require(
        result.returncode == 0,
        "Pending recovery state prevents maintenance completion",
    )

    command = storage_command(
        snapshot, "ro", snapshot["image_id"],
        [
            "sh", "-c",
            'for name in ' + (
                '.restore-staging' if allow_retained_swap
                else '.restore-staging .restore-swap'
            ) + '; do '
            'if [ -e "$1/$name" ] || [ -L "$1/$name" ]; then '
            'exit 1; fi; done',
            "recovery-storage", snapshot["target"],
        ],
    )

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )

    backup_require(
        result.returncode == 0,
        "Retained restore artifacts prevent maintenance completion",
    )


def finish_test_backup(snapshot, marker_identity):
    backup_require(
        snapshot.get("project") == "homecloud-test"
        and snapshot.get("type") == "bind",
        "Only qualified TEST backup may complete maintenance",
    )

    finish_backup_maintenance(snapshot, marker_identity)


def finish_backup_maintenance(snapshot, marker_identity):
    """Internal completion under the actual storage-root fence."""
    fd = os.open(
        snapshot["source"],
        os.O_RDONLY | os.O_DIRECTORY
        | os.O_NOFOLLOW | os.O_CLOEXEC,
    )

    try:
        # This is a new exclusive acquisition after backup.sh
        # has finished and independent artifact verification passed.
        backup_fence(snapshot, fd, acquire=True)

        verify_backup_completion_data(snapshot)

        backup_fence(snapshot, fd, acquire=False)

        backend = verify_backup_writers(snapshot)

        verify_backup_inhibitor(
            snapshot,
            backend,
            expected_identity=marker_identity,
            clear=True,
        )
    finally:
        os.close(fd)



RELEASE_PROJECT_ROOT = Path("/opt/homecloud")
RELEASE_OPERATION_LOCK = "release-operation.lock"


def acquire_release_operation_lock():
    """One persistent root-only lock for RELEASE operations."""
    root = RELEASE_MAINTENANCE_ROOT

    qualified_state_path(root)

    info = root.lstat()

    backup_require(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == BACKUP_STATE_UID
        and info.st_gid == BACKUP_STATE_GID
        and stat.S_IMODE(info.st_mode) == 0o711,
        "Unsafe RELEASE maintenance directory",
    )

    path = root / RELEASE_OPERATION_LOCK

    fd = os.open(
        path,
        os.O_CREAT | os.O_RDWR
        | os.O_NOFOLLOW | os.O_NONBLOCK
        | os.O_CLOEXEC,
        0o600,
    )

    try:
        opened = os.fstat(fd)
        visible = path.lstat()

        backup_require(
            stat.S_ISREG(opened.st_mode)
            and opened.st_uid == BACKUP_STATE_UID
            and opened.st_gid == BACKUP_STATE_GID
            and opened.st_nlink == 1
            and stat.S_IMODE(opened.st_mode) == 0o600
            and inode_identity(opened) ==
                inode_identity(visible),
            "Unsafe RELEASE operation lock",
        )

        fcntl.flock(
            fd, fcntl.LOCK_EX | fcntl.LOCK_NB
        )

        backup_require(
            inode_identity(path.lstat()) ==
            inode_identity(opened),
            "RELEASE operation lock identity changed",
        )

        return fd

    except BaseException:
        os.close(fd)
        raise


def create_release_inhibit():
    path = (
        RELEASE_PROJECT_ROOT
        / "deploy/linux/maintenance-inhibit.py"
    )

    qualified_state_path(path.parent)

    info = path.lstat()

    backup_require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and not (info.st_mode & 0o022)
        and path.resolve(strict=True) == path,
        "Untrusted RELEASE maintenance helper",
    )

    spec = importlib.util.spec_from_file_location(
        "release_maintenance_inhibitor", path
    )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.assert_operation_allowed(str(RELEASE_MAINTENANCE_ROOT))
    module.create_inhibit(
        str(RELEASE_MAINTENANCE_ROOT)
    )


def release_service_inventory(snapshot, require_ready=True):
    """Only an existing, healthy RELEASE service set is accepted."""
    result = {}

    for service in ("db", "backend", "frontend", "ingress"):
        ids = query([
            *compose_command(),
            "ps", "--all", "-q", service,
        ]).splitlines()

        backup_require(
            len(ids) == 1
            and re.fullmatch(
                r"[0-9a-f]{12,64}", ids[0]
            ) is not None,
            "Exactly one installed RELEASE service required",
        )

        item = only(
            query([
                "docker", "inspect", ids[0],
            ], True),
            "installed RELEASE service",
        )

        labels = (
            item.get("Config", {}).get("Labels") or {}
        )

        state = item.get("State", {})
        cid = item.get("Id", "")

        backup_require(
            re.fullmatch(r"[0-9a-f]{64}", cid)
            and cid.startswith(ids[0])
            and labels.get(
                "com.docker.compose.project"
            ) == snapshot["project"]
            and labels.get(
                "com.docker.compose.service"
            ) == service
            and labels.get(
                "com.docker.compose.oneoff", ""
            ).lower() == "false",
            "RELEASE service identity mismatch",
        )

        if require_ready:
            backup_require(
                state.get("Running") is True
                and state.get("Restarting") is False
                and state.get("Paused") is False
                and state.get("Status") == "running",
                "RELEASE backup requires running services",
            )

            health = state.get("Health")

            backup_require(
                health is None
                or health.get("Status") == "healthy",
                "RELEASE service is not healthy",
            )

        result[service] = item

    backend = result["backend"]

    backup_require(
        backend.get("Id") == snapshot["container_id"]
        and backend.get("Image") == snapshot["image_id"],
        "RELEASE backend identity mismatch",
    )

    return result


def release_compose(*args):
    result = subprocess.run(
        [*compose_command(), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=900,
    )

    backup_require(
        result.returncode == 0,
        "RELEASE Compose operation failed",
    )


def release_backend_admission(snapshot, backend):
    """Verify the actual installed gate before opening maintenance."""
    mounts = backend.get("Mounts", [])

    expected = {
        "/run/homecloud/maintenance":
            str(RELEASE_MAINTENANCE_ROOT),
        "/run/homecloud/startup-gate.sh":
            str(
                RELEASE_PROJECT_ROOT
                / "deploy/linux/startup-gate.sh"
            ),
    }

    for target, source in expected.items():
        mount = only(
            [
                item for item in mounts
                if item.get("Destination") == target
            ],
            "qualified RELEASE gate mount",
        )

        backup_require(
            mount.get("Type") == "bind"
            and mount.get("Source") == source
            and mount.get("RW") is False,
            "RELEASE gate mount mismatch",
        )

    backup_require(
        backend.get("Config", {}).get("Entrypoint") ==
        [
            "sh",
            "/run/homecloud/startup-gate.sh",
            "backend",
        ],
        "RELEASE backend must use the qualified startup gate",
    )


def release_service_identities(inventory):
    return {
        name: (item["Id"], item["Image"])
        for name, item in inventory.items()
    }


def wait_release_services(snapshot, before, timeout=180):
    """Wait for the original service set, never recreate containers."""
    import time

    deadline = time.monotonic() + timeout
    pending = {
        "RELEASE backup requires running services",
        "RELEASE service is not healthy",
    }

    while time.monotonic() < deadline:
        try:
            after = release_service_inventory(snapshot)
        except StorageError as error:
            if str(error) not in pending:
                raise
        else:
            backup_require(
                release_service_identities(before)
                == release_service_identities(after),
                "RELEASE containers changed during restart",
            )
            checked_storage(snapshot)
            backup_require(
                time.monotonic() < deadline,
                "RELEASE service readiness deadline exceeded",
            )
            return after

        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(2, remaining))

    raise StorageError(
        "RELEASE service readiness deadline exceeded"
    )


def restart_existing_services(snapshot, before=None):
    """Compatible with Compose versions without start --wait."""
    installed = release_service_inventory(snapshot, require_ready=False)
    if before is None:
        before = installed
    else:
        backup_require(
            release_service_identities(before) == release_service_identities(installed),
            "RELEASE containers changed before restart",
        )

    checked_storage(snapshot)

    release_compose(
        "start", "backend", "frontend", "ingress",
    )

    return wait_release_services(snapshot, before)


@contextmanager
def release_backup_window():
    """Capture one immutable backup; never clear another operation's marker."""
    backup_local_daemon()

    backup_require(
        Path(__file__).resolve().parent.parent
        == RELEASE_PROJECT_ROOT,
        "Wrong RELEASE checkout",
    )

    qualified_state_path(RELEASE_PROJECT_ROOT)

    operation_fd = acquire_release_operation_lock()

    try:
        snapshot = resolve_storage()

        backup_require(
            snapshot.get("project") != "homecloud-test"
            and snapshot.get("type") == "bind"
            and snapshot.get("target") == "/storage",
            "Qualified RELEASE legacy bind storage required",
        )

        root = Path(snapshot["source"])

        info = root.lstat()

        backup_require(
            root.resolve(strict=True) == root
            and stat.S_ISDIR(info.st_mode)
            and info.st_uid == BACKUP_STORAGE_UID
            and stat.S_IMODE(info.st_mode) == 0o700
            and list(inode_identity(info)) ==
                snapshot.get("bind_identity"),
            "Unsafe RELEASE storage identity",
        )

        before = release_service_inventory(snapshot)

        release_backend_admission(
            snapshot, before["backend"]
        )

        # O_EXCL: an existing, incomplete maintenance
        # operation must never be taken over.
        create_release_inhibit()

        marker = RELEASE_MAINTENANCE_ROOT / MAINTENANCE_MARKER
        marker_info = marker.lstat()

        marker_identity = list(
            inode_identity(marker_info)
        )

        verify_backup_inhibitor(
            snapshot, before["backend"]
        )

        # PostgreSQL remains running for pg_dump.
        release_compose(
            "stop", "--timeout", "60",
            "ingress", "frontend", "backend",
        )

        checked_storage(snapshot)
        verify_backup_writers(snapshot)

        # backup.sh owns the actual storage-root flock.
        # Do not take a second conflicting host flock here.
        yield {"operation_fd": operation_fd, "marker_identity": marker_identity}

        # Only the successful path reaches this completion.
        # It reacquires the root flock, verifies the journal,
        # checks writer absence, then clears this exact marker.
        finish_backup_maintenance(
            snapshot, marker_identity
        )

        # Start existing containers only, with explicit readiness.
        restart_existing_services(snapshot, before)

    finally:
        os.close(operation_fd)


def main():
    try:
        action = sys.argv[1] if len(sys.argv) > 1 else ''
        if action == 'resolve':
            snapshot = resolve_storage()
            values = {'RECOVERY_STORAGE_SNAPSHOT': json.dumps(snapshot, sort_keys=True), 'RECOVERY_STORAGE_CONTAINER': snapshot['container_id'], 'RECOVERY_STORAGE_TYPE': snapshot['type'], 'RECOVERY_STORAGE_SOURCE': snapshot['source'], 'RECOVERY_STORAGE_TARGET': snapshot['target'], 'STORAGE_VOLUME': snapshot['name']}
            for key, value in values.items():
                print('export %s=%s' % (key, shlex.quote(value)))
        elif action == 'restart-existing':
            snapshot = json.loads(
                os.environ['RECOVERY_STORAGE_SNAPSHOT']
            )
            restart_existing_services(snapshot)
        elif action == 'verify-offline-writers':
            backup_require(len(sys.argv) == 3, 'Invalid offline writer verification arguments')
            os.environ.update(load_config())
            backup_local_daemon()
            snapshot = resolve_storage()
            backup_require(
                snapshot['project'] == 'homecloud-test'
                and snapshot['type'] == 'bind'
                and snapshot['target'] == '/storage'
                and snapshot['image_id'] == sys.argv[2],
                'Unqualified offline recovery storage',
            )
            checked_storage(snapshot)
            backend = verify_backup_writers(snapshot)
            verify_backup_inhibitor(snapshot, backend)
            print('OFFLINE_WRITERS_VERIFIED')
        elif action == 'complete-test-backup':
            if len(sys.argv) != 4:
                raise StorageError('invalid TEST completion arguments')

            os.environ.update(load_config())

            backup_local_daemon()

            backup_require(
                Path(__file__).resolve().parent.parent ==
                Path('/home/hs/homecloud-test'),
                'wrong TEST maintenance checkout',
            )

            install_fd = int(sys.argv[2])
            backup_require(
                install_fd >= 3,
                'invalid inherited install descriptor',
            )

            verify_test_install_lock(install_fd)

            marker_identity = read_test_backup_checkpoint(
                sys.argv[3]
            )

            finish_test_backup(
                resolve_storage(),
                marker_identity,
            )

            print('BACKUP_MAINTENANCE_COMPLETE')
        elif action in (
            'backup-fence-acquire', 'backup-fence-check'
        ):
            if len(sys.argv) != 2:
                raise StorageError('invalid backup fence arguments')
            snapshot = json.loads(
                os.environ['RECOVERY_STORAGE_SNAPSHOT']
            )
            marker_identity = json.loads(os.environ['HOMECLOUD_BACKUP_MARKER_IDENTITY'])
            verify_backup_capture(snapshot, 8, marker_identity)
            backup_fence(
                snapshot, 9,
                acquire=(action == 'backup-fence-acquire'),
            )
            verify_backup_capture(snapshot, 8, marker_identity)
        elif action in ('check', 'run', 'image'):
            snapshot = json.loads(os.environ['RECOVERY_STORAGE_SNAPSHOT'])
            if action == 'check':
                checked_storage(snapshot)
            elif action == 'image':
                args = storage_command(snapshot, 'ro', sys.argv[2], ['true'])
                print(args[-2])
            else:
                # ro/rw OPTIONS -- IMAGE COMMAND...
                mode = sys.argv[2]
                separator = sys.argv.index('--', 3)
                args = storage_command(snapshot, mode, sys.argv[separator + 1], sys.argv[separator + 2:], sys.argv[3:separator])
                return subprocess.call(args)
        else:
            raise StorageError('unsupported storage helper action')
        return 0
    except (StorageError, ValueError, KeyError, IndexError, OSError):
        print('ERROR: recovery storage identity validation failed; no storage helper started', file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
