#!/usr/bin/env python3
"""Prepare only the disposable runner's private cgroup v2 namespace for DinD.

Use the upstream moby/hack/dind topology: runner processes in a leaf,
controllers delegated at the empty namespace root. Never disable limits or
change cgroup.type to threaded. This is fixture setup, not a host installer.
"""
import errno
import json
import os
from pathlib import Path
import sys

ROOT = Path("/sys/fs/cgroup")
REQUIRED = {"cpu", "memory", "pids"}
LEAF = "homecloud-e2e-init"


def require_disposable_namespace():
    if sys.platform != "linux" or os.geteuid() != 0 or not Path("/.dockerenv").is_file():
        raise ValueError("Run only inside the disposable root Docker runner")
    for path in ("/proc/1/cgroup", "/proc/self/cgroup"):
        if Path(path).read_text().strip() != "0::/":
            raise ValueError("Fresh private cgroup v2 namespace required: " + path)
    # The launcher explicitly requests --cgroupns=private; never bind host
    # /sys/fs/cgroup or use --cgroupns=host to make this check pass.
    if not any(line.split()[4] == str(ROOT) and " - cgroup2 " in line
               and "rw" in line.split()[5].split(",")
               for line in Path("/proc/self/mountinfo").read_text().splitlines()):
        raise ValueError("Writable private cgroup2 mount required")


def prepare(root):
    root = Path(root)
    controllers = set((root / "cgroup.controllers").read_text().split())
    if not REQUIRED.issubset(controllers):
        raise ValueError("Missing required resource controllers: " + str(sorted(REQUIRED - controllers)))
    if (root / "cgroup.type").read_text().strip() not in ("domain", "domain threaded"):
        raise ValueError("Unsupported cgroup namespace root topology")
    leaf = root / LEAF
    leaf.mkdir(exist_ok=False)
    for attempt in range(8):
        for pid in (root / "cgroup.procs").read_text().split():
            if not pid.isascii() or not pid.isdigit() or int(pid) <= 0:
                raise ValueError("Invalid cgroup process identity")
            try:
                (leaf / "cgroup.procs").write_text(pid + "\n")
            except OSError as error:
                # Only the kernel's vanished-process race is harmless.
                if error.errno != errno.ESRCH:
                    raise
        try:
            (root / "cgroup.subtree_control").write_text(
                " ".join("+" + name for name in sorted(controllers)) + "\n"
            )
        except OSError as error:
            if error.errno == errno.EBUSY:
                continue
            raise
        if (root / "cgroup.procs").read_text().strip():
            continue
        enabled = set((root / "cgroup.subtree_control").read_text().split())
        if not controllers.issubset(enabled) or (root / "cgroup.type").read_text().strip() != "domain":
            raise ValueError("Domain controller delegation did not take effect")
        return {"root": str(root), "runner_leaf": LEAF, "controllers": sorted(enabled),
                "type": "domain", "root_processes": 0}
    raise ValueError("Could not evacuate runner processes and delegate controllers")


def main():
    require_disposable_namespace()
    result = prepare(ROOT)
    if Path("/proc/1/cgroup").read_text().strip() != "0::/" + LEAF:
        raise ValueError("Runner PID1 was not moved into the private leaf")
    print(json.dumps(result, sort_keys=True), flush=True)
    print("PASS: private cgroup v2 controllers delegated for nested Docker", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print("STOP: disposable cgroup setup: " + str(error), file=sys.stderr)
        raise SystemExit(1)
