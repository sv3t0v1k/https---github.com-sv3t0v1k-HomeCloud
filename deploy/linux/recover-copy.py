#!/usr/bin/env python3
"""Explicit root-only TEST copy recovery.

No automatic restart, marker clearing, arbitrary command or SQL.
Requires the separately qualified maintenance-enabled TEST deployment.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys


ROOT = Path("/home/hs/homecloud-test")
UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)


class RecoveryError(Exception):
    pass


def require(ok, message):
    if not ok:
        raise RecoveryError(message)


def load_helper(path, name):
    spec = importlib.util.spec_from_file_location(
        name, path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_operation(operation):
    require(
        isinstance(operation, str) and UUID.fullmatch(operation),
        "Invalid copy operation UUID",
    )


def verify_backend_mount(channel, expected_image):
    cid = channel.compose("ps", "--all", "-q", "backend")

    require(
        re.fullmatch(r"[0-9a-f]{12,64}", cid),
        "Exactly one installed backend required",
    )

    containers = json.loads(channel.run(
        "docker", "--host", "unix:///var/run/docker.sock",
        "inspect", cid,
    ))

    require(
        isinstance(containers, list) and len(containers) == 1,
        "Invalid backend inspection",
    )

    item = containers[0]

    require(
        item.get("Image") == expected_image,
        "Backend image identity changed",
    )

    targets = [
        mount for mount in item.get("Mounts", [])
        if mount.get("Destination") == "/run/homecloud/maintenance"
    ]

    require(
        len(targets) == 1
        and targets[0].get("Type") == "bind"
        and targets[0].get("Source") == str(
            channel.RUNTIME / "maintenance"
        )
        and targets[0].get("RW") is False,
        "Installed backend has no qualified maintenance mount",
    )


def verify_stopped(channel, project):
    result = channel.run(
        "docker", "--host", "unix:///var/run/docker.sock",
        "ps", "-q",
        "--filter",
        "label=com.docker.compose.project=" + project,
        "--filter",
        "label=com.docker.compose.service=backend",
    )

    require(
        result == "",
        "Backend writer containers remain running",
    )


def verify_storage_writers(channel, active):
    """Reuse independent exact bind/config and all-container writer inventory."""
    result = subprocess.run(
        ['/usr/bin/python3', '-B', str(channel.ROOT / 'scripts/recovery_storage.py'),
         'verify-offline-writers', active['backend']['id']],
        cwd=channel.ROOT,
        env=channel.backup_environment({'images': active}),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120,
    )
    require(result.returncode == 0 and result.stdout.strip() == 'OFFLINE_WRITERS_VERIFIED',
            'Offline recovery storage writer verification refused')


def perform_recovery(channel, inhibitor, operation):
    validate_operation(operation)

    channel.private_dir(channel.RUNTIME)
    channel.private_dir(channel.CHANNEL)

    fd = channel.acquire_lock(
        channel.CHANNEL / "install.lock"
    )

    try:
        channel.guard_no_pending()
        state = channel.load_state()
        channel.require_checkpoint_refs(state)

        active = state["active"]["images"]

        require(
            channel.active_images(state) == active,
            "Installed image checkpoint mismatch",
        )

        revision = channel.run("git", "rev-parse", "HEAD")

        require(
            revision == active["backend"]["sha"]
            and revision == active["frontend"]["sha"],
            "Checkout differs from installed image checkpoint",
        )

        require(
            channel.run(
                "git", "status", "--porcelain",
                "--untracked-files=no",
            ) == "",
            "Dirty trusted checkout",
        )

        channel.run(
            str(channel.ROOT / "deploy/linux/project-test.sh"),
            "preflight",
        )

        verify_backend_mount(
            channel, active["backend"]["id"]
        )

        values = channel.env_values()
        project = values.get("COMPOSE_PROJECT_NAME", "")

        require(
            project == "homecloud-test",
            "Wrong TEST Compose project",
        )

        marker_root = channel.RUNTIME / "maintenance"

        channel.boundary.trusted_path(
            marker_root, directory=True
        )

        # Durable inhibit BEFORE requesting writer shutdown.
        inhibitor.assert_operation_allowed(str(marker_root))
        inhibitor.create_inhibit(str(marker_root))

        channel.compose(
            "stop", "ingress", "frontend", "backend"
        )

        verify_stopped(channel, project)
        verify_storage_writers(channel, active)

        # The recovery process owns the storage root flock.
        # The host does NOT take a second, conflicting flock.
        name = "homecloud-copy-recovery-" + secrets.token_hex(8)

        output = channel.compose(
            "run", "--rm", "--no-deps", "--pull", "never",
            "--name", name,
            "-T", "backend",
            "node", "dist/files/file-copy-recovery-cli.js",
            operation,
            timeout=120,
        )

        require(
            "COPY_RECOVERY_RELEASED" in output.splitlines(),
            "Recovery success was not confirmed",
        )

        verify_stopped(channel, project)

        # Do not clear the inhibitor. No implicit restart.
        print("COPY_RECOVERY_RELEASED")
        print("MAINTENANCE_RETAINED")
    finally:
        os.close(fd)


def main():
    require(
        os.geteuid() == 0
        and sys.flags.isolated
        and sys.flags.no_site
        and Path(__file__).resolve() ==
            ROOT / "deploy/linux/recover-copy.py",
        "Trusted isolated TEST root invocation required",
    )

    require(
        len(sys.argv) == 2,
        "Exactly one copy operation UUID is required",
    )

    validate_operation(sys.argv[1])

    os.chdir(ROOT)

    boundary = load_helper(
        ROOT / "deploy/linux/root-boundary.py",
        "copy_recovery_boundary",
    )
    boundary.validate_checkout(ROOT)

    channel = load_helper(
        ROOT / "deploy/linux/test-channel.py",
        "copy_recovery_test_channel",
    )

    inhibitor = load_helper(
        ROOT / "deploy/linux/maintenance-inhibit.py",
        "copy_recovery_inhibitor",
    )

    perform_recovery(channel, inhibitor, sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(
            "STOP: copy recovery refused; "
            "inspect maintenance state and copy journal",
            file=sys.stderr,
        )
        sys.exit(1)
