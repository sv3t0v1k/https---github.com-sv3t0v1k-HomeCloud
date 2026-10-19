#!/usr/bin/env python3
"""Hosted-only synthetic filesystem and gated PostgreSQL runtime adapter.

Never call this adapter on a developer computer. The reviewed orchestrator must
obtain an in-process admission receipt BEFORE constructing it. Unit tests use a
mock command runner; they do not touch Docker, loop devices, or mounts.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess

REPO = "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud"
SOURCE = Path(__file__).resolve().parents[2] / "deploy/linux/startup-gate.sh"
LABEL = "io.homecloud.d513"
SAFE = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
IMAGE = re.compile(r"(?:sha256:[0-9a-f]{64}|[a-z0-9./:_-]+@sha256:[0-9a-f]{64})\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


@dataclass(frozen=True)
class Slot:
    name: str
    data: Path
    marker: Path
    hdd: Path
    gate: Path
    fresh: bool = False

    def __getitem__(self, key):
        return getattr(self, key)


class Fixture:
    def __init__(self, root, namespace, runner=None, admission=None):
        self.root = Path(root)
        self.namespace = namespace
        require(runner is not None, "reviewed journal command runner required")
        self.runner = runner
        self.admission = admission or {}
        self.mount = self.root / "volume"
        self.backing = self.root / "synthetic.ext4"
        self.dev = self.root / "dev"
        self.loop = None
        self.uuid = None
        self.root_identity = None
        self.created = False
        self.mounted = False
        self.slots = {}
        self.containers = {}
        self.ledger = dict(namespace=namespace, root=str(self.root), synthetic=True,
                           containers=[], volumes=[], networks=[], loop=None,
                           filesystem=None, cleanup="NOT_STARTED")
        self._guard()

    def _guard(self):
        env = os.environ
        require(env.get("GITHUB_ACTIONS") == "true" and
                env.get("RUNNER_ENVIRONMENT") == "github-hosted" and
                env.get("RUNNER_OS") == "Linux" and env.get("RUNNER_ARCH") == "X64" and
                (platform.system(), platform.machine()) == ("Linux", "x86_64"),
                "GitHub-hosted Linux/amd64 only")
        require(env.get("GITHUB_REPOSITORY") == REPO and
                env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
                env.get("GITHUB_RUN_ATTEMPT") == "1", "wrong repository/event/attempt")
        run_id, attempt = env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", "")
        require(run_id.isdigit(), "numeric run ID required")
        require(self.namespace == f"d513-{run_id}-{attempt}", "wrong resource namespace")
        temp = Path(env.get("RUNNER_TEMP", "/missing"))
        require(temp.is_absolute() and temp.resolve() == temp and
                self.root == temp / f"d513-runtime-{run_id}-{attempt}" and
                self.root.resolve() == self.root, "runtime root not bound to RUNNER_TEMP")
        require(re.fullmatch(r"[a-f0-9]{40}", env.get("APPROVED_SHA", "")),
                "approved source SHA required")
        receipt = self.admission
        require(receipt.get("status") == "PASS" and
                receipt.get("scope") == "D5.1.13-runtime" and receipt.get("gates") == "PASS" and
                receipt.get("source_sha") == env["APPROVED_SHA"] and
                str(receipt.get("run_id")) == run_id and
                str(receipt.get("run_attempt")) == attempt and
                receipt.get("repository") == REPO and
                receipt.get("event_name") == "workflow_dispatch" and
                receipt.get("runner_environment") == "github-hosted" and
                receipt.get("runner_os") == "Linux" and receipt.get("runner_arch") == "X64",
                "reviewed source/run-bound runtime admission required")
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST", "SSH_AUTH_SOCK",
                    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET",
                    "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG"):
            require(not env.get(key), "unexpected remote runtime or credential: " + key)

    def runcmd(self, argv, input=None, check=True, timeout=60):
        self._guard()
        require(isinstance(argv, list) and all(isinstance(a, str) for a in argv),
                "commands must use argv lists")
        return self.runner(argv, input=input, check=check, timeout=timeout)

    @staticmethod
    def _text(result):
        value = result.stdout
        return value.decode().strip() if isinstance(value, bytes) else value.strip()

    def _record(self):
        if self.root.exists():
            (self.root / "ledger.json").write_text(json.dumps(self.ledger, indent=2) + "\n")

    def create(self):
        self._guard()
        require(not self.created and not self.root.exists(), "exclusive runtime root required")
        self.root.mkdir(mode=0o700)  # no parents/exist_ok: never reuse old resources
        identity = self.root.stat()
        self.root_identity = (identity.st_dev, identity.st_ino)
        self.created = True
        self.mount.mkdir(mode=0o700)
        self.dev.mkdir(mode=0o700)
        (self.dev / "disk" / "by-uuid").mkdir(parents=True, mode=0o755)
        (self.root / "config").mkdir(mode=0o700)
        self._record()
        self.runcmd(["truncate", "-s", "1024M", str(self.backing)])
        self.runcmd(["mkfs.ext4", "-F", "-q", str(self.backing)])
        self.ledger["loop_intent"] = str(self.backing)
        self._record()
        self.loop = self._text(self.runcmd(["sudo", "losetup", "--find", "--show",
                                          "--nooverlap", str(self.backing)]))
        require(re.fullmatch(r"/dev/loop[0-9]+", self.loop), "unexpected loop device")
        self.ledger["loop"] = self.loop
        self._record()
        self._verify_loop()
        self.uuid = self._text(self.runcmd(["sudo", "blkid", "-s", "UUID", "-o", "value", self.loop]))
        require(re.fullmatch(r"[a-f0-9-]{36}", self.uuid), "invalid actual ext4 UUID")
        self.ledger["mount_intent"] = dict(source=self.loop, target=str(self.mount))
        self._record()
        self.runcmd(["sudo", "mount", "-t", "ext4", "-o", "rw,nosuid,nodev", self.loop, str(self.mount)])
        self.mounted = True
        self._verify_mount()
        # This is an unmodified snapshot of the actual host namespace, not a gate fixture.
        shutil.copyfile("/proc/self/mountinfo", self.root / "host-mountinfo")
        self.runcmd(["sudo", "chown", "0:0", str(self.root / "host-mountinfo")])
        self.runcmd(["sudo", "chmod", "0444", str(self.root / "host-mountinfo")])
        actual = os.stat(self.loop)
        require(stat.S_ISBLK(actual.st_mode), "loop identity is not a block device")
        major, minor = os.major(actual.st_rdev), os.minor(actual.st_rdev)
        node = self.dev / Path(self.loop).name
        # Only stat metadata is copied. No --device, privilege, or device cgroup rule
        # grants block I/O; Docker's default device policy continues to deny it.
        self.runcmd(["sudo", "mknod", "--mode=0444", str(node), "b", str(major), str(minor)])
        copied = os.stat(node)
        require(stat.S_ISBLK(copied.st_mode) and copied.st_rdev == actual.st_rdev,
                "copied block metadata differs from actual loop device")
        (self.dev / "disk" / "by-uuid" / self.uuid).symlink_to("../../" + node.name)
        self.runcmd(["sudo", "chmod", "0755", str(self.dev), str(self.dev / "disk"),
                     str(self.dev / "disk" / "by-uuid")])
        self.runcmd(["sudo", "mkdir", "--", str(self.mount / "slots")])
        self.ledger["filesystem"] = dict(uuid=self.uuid, major=major, minor=minor,
            source=self.loop, target=str(self.mount), fstype="ext4", metadata_only=True)
        self._record()
        return self

    def _verify_loop(self):
        require(self.loop is not None, "loop device not allocated")
        info = json.loads(self._text(self.runcmd(["sudo", "losetup", "--json", "--output",
                   "NAME,BACK-FILE", self.loop])))
        rows = info.get("loopdevices", [])
        require(len(rows) == 1 and rows[0].get("name") == self.loop and
                rows[0].get("back-file") == str(self.backing), "loop backing mismatch")
        require(self.backing.is_file() and not self.backing.is_symlink(), "unsafe backing file")

    def _verify_mount(self):
        self._verify_loop()
        result = json.loads(self._text(self.runcmd(["findmnt", "--json", "--mountpoint",
            str(self.mount), "--output", "SOURCE,TARGET,FSTYPE,OPTIONS"])))
        rows = result.get("filesystems", [])
        require(len(rows) == 1 and rows[0].get("source") == self.loop and
                rows[0].get("target") == str(self.mount) and rows[0].get("fstype") == "ext4" and
                "rw" in rows[0].get("options", "").split(","), "runtime mount identity mismatch")

    def slot(self, name, fresh=False):
        self._guard()
        require(self.mounted and SAFE.fullmatch(name), "safe mounted slot name required")
        if name in self.slots:
            require(not fresh, "fresh slot must not already exist")
            return self.slots[name]
        self._verify_mount()
        directory = self.mount / "slots" / name
        self.runcmd(["sudo", "mkdir", "--", str(directory)])
        data, hdd, marker = directory / "data", directory / "hdd", directory / ".homecloud-db"
        self.runcmd(["sudo", "mkdir", "--", str(data), str(hdd)])
        self.runcmd(["sudo", "tee", str(marker)], input=f"homecloud-v1 db {self.uuid}\n".encode())
        self.runcmd(["sudo", "chown", "70:70", str(data), str(hdd), str(marker)])
        self.runcmd(["sudo", "chmod", "0700", str(data), str(hdd)])
        self.runcmd(["sudo", "chmod", "0400", str(marker)])
        config = self.root / "config" / name
        config.mkdir(mode=0o700)
        gate = config / "startup.gate"
        gate.write_text(f"db {self.uuid} {self.mount} {data} 70 70 dedicated\n")
        self.runcmd(["sudo", "chown", "0:0", str(gate)])
        self.runcmd(["sudo", "chmod", "0644", str(gate)])
        slot = Slot(name, data, marker, hdd, gate, fresh)
        self.slots[name] = slot
        self.ledger.setdefault("slots", []).append(dict(name=name, data=str(data), hdd=str(hdd)))
        self._record()
        return slot

    def _slot(self, slot):
        require(isinstance(slot, Slot) and self.slots.get(slot.name) == slot, "unrecorded slot")
        return slot

    def data(self, slot):
        return self._slot(slot).data

    def hdd(self, slot):
        return self._slot(slot).hdd

    def container(self, name, image, slot, bootstrap="d513_owner", fault=None):
        self._guard()
        slot = self._slot(slot)
        require(fault in (None, "missing-marker", "missing-data-mount", "wrong-data-mount"),
                "unreviewed runtime fault")
        require(SAFE.fullmatch(name) and IMAGE.fullmatch(image), "safe container name and immutable image required")
        require(bootstrap in ("d513_owner", "d513_restore"), "only synthetic database identity allowed")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", image) and
                image in self.admission.get("allowed_images", []), "loaded image not admitted")
        full_name = self.namespace + "-" + name
        require(full_name not in self.containers, "container resource already recorded")
        self._verify_mount()
        for previous, resource in self.containers.items():
            if resource["slot"] == slot.name and self._inspect_owned(previous):
                state = json.loads(self._text(self.runcmd(["docker", "inspect", previous])))[0]
                require(state.get("State", {}).get("Running") is False,
                        "another writer may still own this synthetic slot")
        version = self.runcmd(["sudo", "cat", str(slot.data / "PG_VERSION")], check=False)
        if version.returncode == 0:
            require(self._text(version) == "16", "existing synthetic PGDATA version mismatch")
        else:
            require(slot.fresh and not any(resource["slot"] == slot.name
                                           for resource in self.containers.values()),
                    "initdb forbidden: fresh permission absent or already consumed")
            entries = self._text(self.runcmd(["sudo", "find", str(slot.data), "-mindepth", "1",
                                             "-maxdepth", "1", "-print", "-quit"]))
            require(not entries, "fresh synthetic PGDATA must be empty")
        mounts = [(slot.data, "/var/lib/postgresql/data", False),
                  (slot.marker, "/run/homecloud/volume-marker", True),
                  (slot.gate, "/run/homecloud/startup.gate", True),
                  (SOURCE, "/run/homecloud/startup-gate.sh", True),
                  (self.root / "host-mountinfo", "/run/homecloud/host-mountinfo", True),
                  (self.dev, "/run/homecloud/dev", True)]
        if fault == "missing-marker":
            mounts = [row for row in mounts if row[1] != "/run/homecloud/volume-marker"]
        elif fault == "missing-data-mount":
            mounts = [row for row in mounts if row[1] != "/var/lib/postgresql/data"]
        elif fault == "wrong-data-mount":
            wrong_data = self.root / ("wrong-data-" + name)
            wrong_data.mkdir(mode=0o700)
            self.runcmd(["sudo", "chown", "70:70", str(wrong_data)])
            mounts[0] = (wrong_data, "/var/lib/postgresql/data", False)
        argv = ["docker", "run", "--detach", "--pull=never", "--name", full_name,
                "--label", f"{LABEL}={self.namespace}", "--label", f"{LABEL}.slot={slot.name}",
                "--network", "none", "--restart=no", "--memory=512m", "--memory-swap=512m",
                "--cpus=1", "--pids-limit=128", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--user", "0:0",
                "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
                "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m",
                "--env", "POSTGRES_USER=" + bootstrap, "--env", "POSTGRES_DB=" + ("d513" if bootstrap == "d513_owner" else "postgres"),
                "--env", "POSTGRES_PASSWORD=d513-synthetic-only",
                "--env", "PGDATA=/var/lib/postgresql/data"]
        if fault == "missing-data-mount":
            # Override the image VOLUME with a known tmpfs; never create an
            # unrecorded anonymous Docker volume during a negative test.
            argv += ["--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=16m"]
        for capability in ("CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"):
            argv += ["--cap-add=" + capability]
        for source, target, readonly in mounts:
            require(source.is_absolute() and "," not in str(source) and not source.is_symlink(), "unsafe bind source")
            argv += ["--mount", f"type=bind,src={source},dst={target}" + (",readonly" if readonly else "")]
        argv += ["--entrypoint", "/bin/sh", image, "/run/homecloud/startup-gate.sh", "db", "postgres"]
        # Record intent before Docker: cleanup can identify a partially-created resource.
        self.containers[full_name] = dict(slot=slot.name, image=image,
            mounts={target: str(source) for source, target, _ in mounts}, fault=fault)
        self.ledger["containers"].append(full_name)
        self._record()
        self.runcmd(argv)
        return full_name

    def start(self, slot, image, bootstrap="d513_owner", fault=None):
        return self.container(slot.name, image, slot, bootstrap, fault)

    def exec(self, container, *args, input=None, check=True):
        require(container in self.containers, "unrecorded container")
        return self.runcmd(["docker", "exec", "--interactive", container, *args], input=input, check=check)

    def sql(self, container, statement, user="d513_owner", database="d513"):
        require(user == "d513_owner" and database == "d513", "synthetic database only")
        return self._text(self.exec(container, "psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
                                   "--username=" + user, "--dbname=" + database,
                                   "--tuples-only", "--no-align", input=statement.encode()))

    psql = sql

    def _inspect_owned(self, container):
        result = self.runcmd(["docker", "inspect", container], check=False)
        if result.returncode:
            # Distinguish genuine absence from daemon/permission failure.
            matches = self._text(self.runcmd(["docker", "ps", "--all", "--quiet", "--filter",
                                               "name=^/" + container + "$"]))
            require(not matches and "No such" in (result.stderr.decode() if isinstance(result.stderr, bytes) else result.stderr),
                    "cannot prove recorded container absent")
            return False
        data = json.loads(self._text(result))
        require(len(data) == 1 and data[0].get("Name") == "/" + container and
                data[0].get("Config", {}).get("Labels", {}).get(LABEL) == self.namespace and
                data[0].get("Config", {}).get("Labels", {}).get(LABEL + ".slot") == self.containers[container]["slot"] and
                data[0].get("Image") == self.containers[container]["image"],
                "container ownership mismatch")
        bindings = {row["Destination"]: row["Source"] for row in data[0].get("Mounts", [])
                    if row.get("Type") == "bind"}
        require(bindings == self.containers[container]["mounts"], "container bind identity mismatch")
        require(not any(row.get("Type") == "volume" for row in data[0].get("Mounts", [])),
                "unrecorded Docker volume")
        return True

    def stop(self, container):
        require(container in self.containers, "unrecorded container")
        if self._inspect_owned(container):
            self.runcmd(["docker", "stop", "--time", "20", container], timeout=35)

    def copy_tree(self, source, target):
        """Copy only synthetic trees; reject symlinks, special files and path escape."""
        self._verify_mount()
        source, target = Path(source), Path(target)
        require(source != target and not target.is_relative_to(source) and
                source.is_relative_to(self.mount) and
                target.is_relative_to(self.mount) and source.resolve() == source and
                target.resolve() == target and not target.exists(), "copy path escapes synthetic mount")
        # Host postgres data is not readable as runner. GNU find inspects structure as
        # root without following links; refusing links also refuses tablespace/WAL escape.
        unsafe = self._text(self.runcmd(["sudo", "find", str(source), "-xdev", "!", "-type", "d",
                                        "!", "-type", "f", "-print", "-quit"]))
        require(not unsafe, "non-regular object in synthetic copy source")
        self.runcmd(["sudo", "cp", "-a", "--", str(source), str(target)])

    def _root_mounts(self):
        """Observe the actual host namespace, independently of command results."""
        raw = self._text(self.runcmd(["cat", "/proc/self/mountinfo"]))
        rows = []
        saw_root = False
        for line in raw.splitlines():
            fields = line.split()
            require(len(fields) >= 10 and "-" in fields[6:], "unparseable host mountinfo")
            separator = fields.index("-", 6)
            require(len(fields) >= separator + 4, "truncated host mountinfo")
            target = fields[4]
            for escaped, character in ((r"\040", " "), (r"\011", "\t"),
                                       (r"\012", "\n"), (r"\134", "\\")):
                target = target.replace(escaped, character)
            saw_root = saw_root or target == "/"
            if target == str(self.root) or target.startswith(str(self.root) + "/"):
                rows.append(dict(target=target, source=fields[separator + 2],
                                 fstype=fields[separator + 1], root=fields[3],
                                 options=fields[5].split(",")))
        require(saw_root, "host mountinfo root record missing")
        return rows

    def _associated_loops(self):
        """Never enumerate unrelated loops: query only the exclusive backing file."""
        if not self.ledger.get("loop_intent"):
            require(self.loop is None, "unrecorded loop allocation")
            return []
        require(self.backing.is_file() and not self.backing.is_symlink(), "unsafe backing file")
        result = self.runcmd(["sudo", "losetup", "--list", "--json", "--associated",
                             str(self.backing), "--output", "NAME,BACK-FILE"])
        data = json.loads(self._text(result))
        rows = data.get("loopdevices")
        require(isinstance(rows, list) and len(rows) <= 1, "ambiguous backing associations")
        for row in rows:
            name = row.get("name", "")
            require(re.fullmatch(r"/dev/loop[0-9]+", name) and
                    row.get("back-file") == str(self.backing) and
                    (self.loop is None or name == self.loop), "loop backing mismatch")
        return rows

    def _cleanup_command(self, argv):
        # A timeout/nonzero exit may follow a successful side effect. Callers must
        # independently prove absence; this helper never treats it as success.
        try:
            self.runcmd(argv)
        except Exception as error:
            self.ledger.setdefault("cleanup_command_errors", []).append(
                dict(command=argv, error=type(error).__name__))

    def cleanup(self):
        self._guard()
        if not self.created:
            return
        try:
            identity = self.root.stat()
            require(not self.root.is_symlink() and
                    (identity.st_dev, identity.st_ino) == self.root_identity,
                    "runtime root ownership changed")
            self.ledger["cleanup"] = "IN_PROGRESS"
            self._record()
            for name in reversed(list(self.containers)):
                if self._inspect_owned(name):
                    self._cleanup_command(["docker", "rm", "--force", name])
                require(not self._inspect_owned(name), "recorded container removal not proven")
            associations = self._associated_loops()
            if associations:
                self.loop = associations[0]["name"]
                self.ledger["loop"] = self.loop
            else:
                self.loop = None
            mounts = self._root_mounts()
            if mounts:
                require(len(mounts) == 1 and mounts[0]["target"] == str(self.mount) and
                        mounts[0]["source"] == self.loop and mounts[0]["fstype"] == "ext4" and
                        mounts[0]["root"] == "/" and "rw" in mounts[0]["options"],
                        "unknown or foreign mount under runtime root")
                self._verify_mount()
                self._cleanup_command(["sudo", "umount", "--", str(self.mount)])
            require(not self._root_mounts(), "runtime unmount absence not proven")
            self.mounted = False
            if self.loop:
                self._verify_loop()
                self._cleanup_command(["sudo", "losetup", "--detach", self.loop])
            require(not self._associated_loops(), "runtime loop detach absence not proven")
            self.loop = None
            # Reobserve immediately before deletion, including unrecorded submounts.
            require(not self._root_mounts(), "mount appeared under runtime root")
            self.ledger["cleanup"] = "RESOURCES_ABSENT"
            self._record()
            self._cleanup_command(["sudo", "rm", "--one-file-system", "-r", "--", str(self.root)])
            require(not self.root.exists() and not self.root.is_symlink(),
                    "runtime directory deletion not proven")
            self.ledger["cleanup"] = "PASS"
            self.created = False
        except Exception:
            self.ledger["cleanup"] = "FAIL"
            # Keep evidence only if this is still the exclusive directory inode.
            if self.root.exists() and not self.root.is_symlink():
                identity = self.root.stat()
                if (identity.st_dev, identity.st_ino) == self.root_identity:
                    self._record()
            raise
