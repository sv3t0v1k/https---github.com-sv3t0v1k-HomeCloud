#!/usr/bin/env python3
"""Read-only trust preflight inside the built disposable runtime image."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys

ROOT = Path("/opt/homecloud")
REQUIRED = (
    "deploy/linux/maintenance-inhibit.py",
    "deploy/linux/maintenance-window.py",
    "deploy/linux/storage-writer-fence.py",
    "deploy/linux/recover-copy.py",
    "deploy/linux/startup-gate.sh",
    "scripts/recovery_storage.py",
    "scripts/recovery_config.py",
    "scripts/restore_storage.py",
    "scripts/restore_maintenance.py",
    "scripts/backup.sh",
    "scripts/restore.sh",
    "scripts/reconcile.py",
    "scripts/recovery-pending.sql",
    "scripts/ci/test-restore-e2e-local.sh",
    "scripts/ci/restore-runtime-preflight.py",
    "scripts/ci/restore-e2e-cgroup.py",
    "scripts/ci/test-historical-schema-e2e.py",
    "scripts/ci/historical-schema-producer.cjs",
    "scripts/ci/test-restore-fault-e2e.py",
)

TOOL_BINARIES = {
    "node": "node", "python": sys.executable, "docker": "docker", "dockerd": "dockerd",
    "containerd": "containerd", "runc": "runc",
    "compose": "/usr/libexec/docker/cli-plugins/docker-compose",
}


def elf_architecture(path):
    with Path(path).open("rb") as stream:
        header = stream.read(64)
    if len(header) != 64 or header[:4] != b"\x7fELF" or header[4:6] != b"\x02\x01":
        raise ValueError("Expected little-endian ELF64 binary: " + str(path))
    machine = struct.unpack_from("<H", header, 18)[0]
    if machine not in (62, 183):
        raise ValueError("Unsupported executable architecture: " + str(path))
    return {62: "amd64", 183: "arm64"}[machine]


def inspect_toolchain(expected):
    if expected not in ("linux/arm64", "linux/amd64"):
        raise ValueError("Unsupported native E2E platform")
    records = []
    for role, binary in TOOL_BINARIES.items():
        path = shutil.which(binary)
        if not path:
            raise ValueError("Missing E2E tool: " + role)
        actual = "linux/" + elf_architecture(path)
        if actual != expected:
            raise ValueError("Emulated E2E tool refused: " + role + " " + actual + " != " + expected)
        records.append({"role": role, "path": str(Path(path).resolve()), "platform": actual})
    node = json.loads(subprocess.run(
        ["node", "-e", "console.log(JSON.stringify({os:process.platform,arch:process.arch}))"],
        check=True, capture_output=True, text=True, timeout=10,
    ).stdout)
    actual = node["os"] + "/" + {"x64": "amd64", "arm64": "arm64"}.get(node["arch"], "unknown")
    if actual != expected:
        raise ValueError("E2E executable architecture differs from native platform")
    version = subprocess.run(["docker", "compose", "version", "--short"],
                             check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if version != "5.6.0":
        raise ValueError("E2E Compose version differs from pinned 5.6.0")
    print(json.dumps({"expected_platform": expected, "node": node,
                      "compose_version": version, "executables": records}, sort_keys=True), flush=True)
    print("PASS: native E2E daemon/runtime/Compose executable architecture", flush=True)
    return records


def inspect_layout(root):
    root = Path(root)
    directories = {root, *root.parents}
    for relative in REQUIRED:
        directories.update((root / relative).parent.parents)
        directories.add((root / relative).parent)
    for path in sorted(directories):
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or info.st_gid != 0 or info.st_mode & 0o022
                or path.resolve(strict=True) != path):
            raise ValueError("Untrusted runtime directory: " + json.dumps({
                "path": str(path), "uid": info.st_uid, "gid": info.st_gid,
                "mode": oct(stat.S_IMODE(info.st_mode)), "nlink": info.st_nlink,
                "canonical": path.resolve(strict=True) == path,
            }, sort_keys=True))
    records = []
    for relative in REQUIRED:
        path = root / relative
        info = path.lstat()
        record = {"path": str(path), "uid": info.st_uid, "gid": info.st_gid,
                  "mode": oct(stat.S_IMODE(info.st_mode)), "nlink": info.st_nlink,
                  "regular": stat.S_ISREG(info.st_mode),
                  "canonical": path.resolve(strict=True) == path}
        print(json.dumps(record, sort_keys=True), flush=True)
        if (not record["regular"] or not record["canonical"]
                or info.st_uid != 0 or info.st_gid != 0
                or info.st_mode & 0o022 or info.st_nlink != 1):
            raise ValueError("Untrusted runtime helper: " + str(path))
        records.append(record)
    return records


def main():
    inspect_layout(ROOT)
    if os.environ.get("HOMECLOUD_E2E_PLATFORM"):
        inspect_toolchain(os.environ["HOMECLOUD_E2E_PLATFORM"])
    # Exercise the actual production ancestry guard without creating an
    # inhibitor, operation lock, daemon, mount or application container.
    sys.path.insert(0, str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location(
        "e2e_runtime_recovery_storage", ROOT / "scripts/recovery_storage.py"
    )
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)
    storage.qualified_state_path(ROOT)
    for relative in REQUIRED:
        storage.qualified_state_path((ROOT / relative).parent)
    print("PASS: runtime trusted helpers and production ancestry contract", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, ImportError, subprocess.SubprocessError) as error:
        print("STOP: runtime trust preflight: " + str(error), file=sys.stderr)
        raise SystemExit(1)
