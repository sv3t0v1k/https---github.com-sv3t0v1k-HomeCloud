"""Pure/mock tests: this file must never start Docker, sudo, mounts or loop devices."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runtime_fixture", Path(__file__).with_name("runtime_fixture.py"))
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
IMAGE = "sha256:" + "a" * 64


class Commands:
    """In-memory command responses and ordinary temp files; no subprocess calls."""
    def __init__(self):
        self.calls = []
        self.root = None
        self.loop = "/dev/loop9"
        self.backing = None
        self.mounted = False
        self.loop_attached = False
        self.lose_loop_result = False
        self.lose_mount_result = False
        self.lose_umount_result = False
        self.lose_detach_result = False
        self.fail_umount = False
        self.fail_detach = False
        self.foreign_mount = False
        self.containers = {}
        self.bad_backing = False
        self.bad_mount = False

    def __call__(self, argv, input=None, check=True, timeout=60):
        self.calls.append(argv)
        args = argv[1:] if argv[0] == "sudo" else argv
        output, error, code = b"", b"", 0
        if args[0] == "truncate":
            self.backing = Path(args[-1])
            self.backing.touch()
            self.root = self.backing.parent
        elif args[:2] == ["losetup", "--find"]:
            self.loop_attached = True
            if self.lose_loop_result:
                raise subprocess.TimeoutExpired(argv, timeout)
            output = self.loop.encode()
        elif args[:2] == ["losetup", "--list"]:
            rows = [{"name": self.loop, "back-file": "/elsewhere" if self.bad_backing else str(self.backing)}] if self.loop_attached else []
            output = json.dumps({"loopdevices": rows}).encode()
        elif args[:2] == ["losetup", "--detach"]:
            if self.fail_detach:
                raise subprocess.TimeoutExpired(argv, timeout)
            self.loop_attached = False
            if self.lose_detach_result:
                raise subprocess.TimeoutExpired(argv, timeout)
        elif args[:2] == ["losetup", "--json"]:
            output = json.dumps({"loopdevices": [{"name": self.loop,
                "back-file": "/elsewhere" if self.bad_backing else str(self.backing)}]}).encode()
        elif args[0] == "blkid":
            output = b"12345678-abcd-abcd-abcd-123456789abc\n"
        elif args[0] == "mount":
            self.mounted = True
            if self.lose_mount_result:
                raise subprocess.TimeoutExpired(argv, timeout)
        elif args[0] == "findmnt":
            output = json.dumps({"filesystems": [{"source": "/dev/loop8" if self.bad_mount else self.loop,
                "target": str(self.root / "volume"), "fstype": "ext4", "options": "rw,nosuid,nodev"}]}).encode()
        elif args[0] == "mkdir":
            for path in args[2:]:
                Path(path).mkdir()
        elif args[0] == "tee":
            Path(args[1]).write_bytes(input)
        elif args[0] == "mknod":
            Path(args[2]).touch()
        elif args == ["cat", "/proc/self/mountinfo"]:
            raw = "1 0 8:1 / / rw - ext4 /dev/root rw\n"
            if self.mounted:
                source = "/dev/loop8" if self.bad_mount else self.loop
                raw += f"2 1 7:9 / {self.root}/volume rw,nosuid,nodev - ext4 {source} rw\n"
            if self.foreign_mount:
                raw += f"3 1 8:2 / {self.root}/foreign rw - ext4 /dev/foreign rw\n"
            output = raw.encode()
        elif args[0] == "cat":
            path = Path(args[1])
            if path.is_file():
                output = path.read_bytes()
            else:
                code, error = 1, b"No such file"
        elif args[0] == "find":
            root = Path(args[1])
            paths = list(root.rglob("*"))
            if "-mindepth" in args:
                output = (str(paths[0]) if paths else "").encode()
            else:
                unsafe = [p for p in paths if p.is_symlink() or not (p.is_dir() or p.is_file())]
                output = (str(unsafe[0]) if unsafe else "").encode()
        elif args[0] == "cp":
            shutil.copytree(args[-2], args[-1], symlinks=True)
        elif args[:2] == ["docker", "run"]:
            name = args[args.index("--name") + 1]
            labels = dict(args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "--label")
            mounts = []
            for i, arg in enumerate(args):
                if arg == "--mount":
                    parts = dict(a.split("=", 1) for a in args[i + 1].split(",") if "=" in a)
                    mounts.append({"Type": "bind", "Source": parts["src"], "Destination": parts["dst"]})
            self.containers[name] = dict(Name="/" + name, Image=IMAGE,
                                         Config=dict(Labels=labels), Mounts=mounts, State=dict(Running=True))
            output = b"mock-id\n"
        elif args[:2] == ["docker", "inspect"]:
            if args[2] in self.containers:
                output = json.dumps([self.containers[args[2]]]).encode()
            else:
                code, error = 1, b"Error: No such object"
        elif args[:2] == ["docker", "exec"]:
            output = b"ok\n"
        elif args[:2] == ["docker", "stop"]:
            self.containers[args[-1]]["State"]["Running"] = False
        elif args[:2] == ["docker", "rm"]:
            del self.containers[args[-1]]
        elif args[0] == "umount":
            if self.fail_umount:
                raise subprocess.TimeoutExpired(argv, timeout)
            self.mounted = False
            if self.lose_umount_result:
                raise subprocess.TimeoutExpired(argv, timeout)
        elif args[0] == "rm":
            shutil.rmtree(args[-1])
        if code and check:
            raise subprocess.CalledProcessError(code, argv, output, error)
        return subprocess.CompletedProcess(argv, code, output, error)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.temp_path = str(Path(self.temp.name).resolve())
        self.env = dict(GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted",
            RUNNER_OS="Linux", RUNNER_ARCH="X64", GITHUB_REPOSITORY=runtime.REPO,
            GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="1",
            APPROVED_SHA="b" * 40, RUNNER_TEMP=self.temp_path)
        self.receipt = dict(status="PASS", scope="D5.1.13-runtime", gates="PASS", source_sha="b" * 40,
            run_id="123", run_attempt="1", repository=runtime.REPO, event_name="workflow_dispatch",
            runner_environment="github-hosted", runner_os="Linux", runner_arch="X64",
            allowed_images=[IMAGE])
        self.commands = Commands()
        self.patches = [patch.dict(os.environ, self.env, clear=True),
                        patch.object(runtime.platform, "system", return_value="Linux"),
                        patch.object(runtime.platform, "machine", return_value="x86_64")]
        for item in self.patches:
            item.start()
        self.root = Path(self.temp_path) / "d513-runtime-123-1"
        self.fixture = runtime.Fixture(self.root, "d513-123-1", self.commands, self.receipt)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def create(self):
        real_stat = os.stat
        def metadata(path, *args, **kwargs):
            if str(path) in (self.commands.loop, str(self.fixture.dev / "loop9")):
                return SimpleNamespace(st_mode=stat.S_IFBLK | 0o600, st_rdev=os.makedev(7, 9))
            return real_stat(path, *args, **kwargs)
        def mountinfo(source, destination):
            Path(destination).write_bytes(b"unmodified-real-mountinfo-test-double\n")
        with patch.object(runtime.os, "stat", side_effect=metadata), \
             patch.object(runtime.shutil, "copyfile", side_effect=mountinfo):
            self.fixture.create()
        return self.fixture

    def test_local_or_unadmitted_refuses_before_any_command(self):
        for changed in ({"RUNNER_ENVIRONMENT": "self-hosted"}, {"GITHUB_EVENT_NAME": "push"},
                        {"GITHUB_RUN_ATTEMPT": "2"}, {"DOCKER_HOST": "ssh://production"}):
            with patch.dict(os.environ, changed):
                with self.assertRaises(ValueError):
                    runtime.Fixture(self.root, "d513-123-1", self.commands, self.receipt)
        bad = dict(self.receipt, gates="FAIL")
        with self.assertRaises(ValueError):
            runtime.Fixture(self.root, "d513-123-1", self.commands, bad)
        self.assertEqual(self.commands.calls, [])
        self.assertFalse(self.root.exists())

    def test_run_and_source_receipt_cannot_be_reused(self):
        for field, value in (("run_id", "124"), ("source_sha", "c" * 40), ("status", "FAIL"),
                             ("repository", "other/repo"), ("runner_environment", "self-hosted")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime.Fixture(self.root, "d513-123-1", self.commands, dict(self.receipt, **{field: value}))

    def test_create_exclusive_actual_metadata_recorded(self):
        self.create()
        self.assertEqual(self.fixture.ledger["filesystem"]["major"], 7)
        self.assertEqual(self.fixture.ledger["filesystem"]["minor"], 9)
        self.assertEqual(os.readlink(self.fixture.dev / "disk/by-uuid" / self.fixture.uuid), "../../loop9")
        self.assertIn(["truncate", "-s", "1024M", str(self.fixture.backing)], self.commands.calls)
        self.assertIn(["sudo", "mknod", "--mode=0444", str(self.fixture.dev / "loop9"), "b", "7", "9"], self.commands.calls)
        before = len(self.commands.calls)
        with self.assertRaises(ValueError):
            self.fixture.create()
        self.assertEqual(len(self.commands.calls), before)

    def test_slot_identity_and_gate_use_real_loop_uuid(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        self.assertEqual(slot.data.parent, slot.marker.parent)
        self.assertEqual(slot.marker.read_text(), f"homecloud-v1 db {self.fixture.uuid}\n")
        self.assertEqual(slot.gate.read_text(), f"db {self.fixture.uuid} {self.fixture.mount} {slot.data} 70 70 dedicated\n")
        self.assertIn(["sudo", "chmod", "0400", str(slot.marker)], self.commands.calls)
        self.assertIn(["sudo", "chown", "70:70", str(slot.data), str(slot.hdd), str(slot.marker)], self.commands.calls)
        with self.assertRaises(ValueError):
            self.fixture.slot("../escape")
        with self.assertRaises(ValueError):
            self.fixture.slot("initial", fresh=True)

    def test_container_requires_loaded_image_and_explicit_fresh_permission(self):
        self.create()
        slot = self.fixture.slot("recovery")
        with self.assertRaisesRegex(ValueError, "initdb forbidden"):
            self.fixture.container("recover", IMAGE, slot)
        slot.data.joinpath("PG_VERSION").write_text("16\n")
        for image in ("postgres:16", "sha256:" + "c" * 64):
            with self.assertRaises(ValueError):
                self.fixture.container("recover", image, slot)
        name = self.fixture.container("recover", IMAGE, slot)
        self.assertEqual(name, "d513-123-1-recover")

    def test_real_gate_entrypoint_and_bounded_isolation_flags(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        self.fixture.start(slot, IMAGE)
        args = next(a for a in self.commands.calls if a[:2] == ["docker", "run"])
        self.assertEqual(args[-6:], ["--entrypoint", "/bin/sh", IMAGE, "/run/homecloud/startup-gate.sh", "db", "postgres"])
        for flag in ("--pull=never", "--restart=no", "--memory=512m", "--memory-swap=512m",
                     "--cpus=1", "--pids-limit=128", "--cap-drop=ALL", "--security-opt=no-new-privileges:true"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertFalse(any(a.startswith(("--privileged", "--device", "--publish")) for a in args))
        self.assertFalse(any("docker.sock" in a for a in args))
        self.assertIn(f"type=bind,src={self.fixture.dev},dst=/run/homecloud/dev,readonly", args)
        self.assertEqual(self.fixture.ledger["volumes"], [])
        self.assertEqual(self.fixture.ledger["networks"], [])

    def test_only_reviewed_fault_modes_and_no_anonymous_volume_path(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        (slot.data / "PG_VERSION").write_text("16\n")
        for i, fault in enumerate(("missing-marker", "missing-data-mount", "wrong-data-mount")):
            name = self.fixture.container("fault-" + str(i), IMAGE, slot, fault=fault)
            args = self.commands.calls[-1]
            self.fixture.stop(name)
            if fault == "missing-marker":
                self.assertFalse(any("dst=/run/homecloud/volume-marker" in a for a in args))
            elif fault == "missing-data-mount":
                self.assertIn("/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=16m", args)
                self.assertFalse(any("dst=/var/lib/postgresql/data" in a for a in args))
            else:
                self.assertIn(f"type=bind,src={self.root}/wrong-data-fault-2,dst=/var/lib/postgresql/data", args)
        with self.assertRaises(ValueError):
            self.fixture.container("fault-3", IMAGE, slot, fault="disable-gate")

    def test_restore_bootstrap_does_not_precreate_target_database(self):
        self.create()
        slot = self.fixture.slot("restored", fresh=True)
        self.fixture.start(slot, IMAGE, bootstrap="d513_restore")
        args = self.commands.calls[-1]
        self.assertIn("POSTGRES_USER=d513_restore", args)
        self.assertIn("POSTGRES_DB=postgres", args)
        self.assertNotIn("POSTGRES_DB=d513", args)

    def test_fresh_nonempty_or_wrong_version_refuses_before_docker(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        (slot.data / "unexpected").touch()
        with self.assertRaises(ValueError):
            self.fixture.start(slot, IMAGE)
        (slot.data / "PG_VERSION").write_text("15\n")
        with self.assertRaises(ValueError):
            self.fixture.start(slot, IMAGE)
        self.assertFalse(any(a[:2] == ["docker", "run"] for a in self.commands.calls))

    def test_single_writer_refuses_running_slot_and_allows_after_stop(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        first = self.fixture.container("first", IMAGE, slot)
        with self.assertRaisesRegex(ValueError, "another writer"):
            self.fixture.container("second", IMAGE, slot)
        self.fixture.stop(first)
        (slot.data / "PG_VERSION").write_text("16\n")
        second = self.fixture.container("second", IMAGE, slot)
        self.assertEqual(second, "d513-123-1-second")

    def test_fresh_initialization_permission_consumed_by_first_container_intent(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        first = self.fixture.container("first", IMAGE, slot)
        self.fixture.stop(first)
        # Fake Docker never populated PGDATA: this also models accidental deletion
        # of PG_VERSION and data after a previously initialized container stopped.
        self.assertEqual(list(slot.data.iterdir()), [])
        before = sum(a[:2] == ["docker", "run"] for a in self.commands.calls)
        with self.assertRaisesRegex(ValueError, "fresh permission absent or already consumed"):
            self.fixture.container("second", IMAGE, slot)
        after = sum(a[:2] == ["docker", "run"] for a in self.commands.calls)
        self.assertEqual(after, before)

    def test_failed_docker_attempt_also_consumes_fresh_permission(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        def lost_result(argv, **kwargs):
            if argv[:2] == ["docker", "run"]:
                self.commands.calls.append(argv)
                raise subprocess.TimeoutExpired(argv, 60)
            return self.commands(argv, **kwargs)
        self.fixture.runner = lost_result
        with self.assertRaises(subprocess.TimeoutExpired):
            self.fixture.container("failed", IMAGE, slot)
        self.fixture.runner = self.commands
        before = sum(a[:2] == ["docker", "run"] for a in self.commands.calls)
        with self.assertRaisesRegex(ValueError, "already consumed"):
            self.fixture.container("retry", IMAGE, slot)
        self.assertEqual(sum(a[:2] == ["docker", "run"] for a in self.commands.calls), before)

    def test_cleanup_refuses_foreign_container_bind_or_labels(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        name = self.fixture.start(slot, IMAGE)
        self.commands.containers[name]["Mounts"][0]["Source"] = "/foreign-data"
        with self.assertRaisesRegex(ValueError, "bind identity"):
            self.fixture.cleanup()
        self.assertFalse(any(a[:2] == ["docker", "rm"] for a in self.commands.calls))
        self.assertTrue(self.commands.mounted)

    def test_cleanup_refuses_foreign_loop_or_mount(self):
        self.create()
        self.commands.bad_backing = True
        with self.assertRaisesRegex(ValueError, "loop backing"):
            self.fixture.cleanup()
        self.assertFalse(any("--detach" in a and "losetup" in a for a in self.commands.calls))
        self.commands.bad_backing = False
        self.commands.bad_mount = True
        with self.assertRaisesRegex(ValueError, "foreign mount"):
            self.fixture.cleanup()
        self.assertTrue(self.commands.mounted)

    def test_cleanup_exact_resources_and_no_prune(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        name = self.fixture.start(slot, IMAGE)
        self.fixture.cleanup()
        self.assertFalse(self.root.exists())
        self.assertEqual(self.fixture.ledger["cleanup"], "PASS")
        self.assertIn(["docker", "rm", "--force", name], self.commands.calls)
        self.assertIn(["sudo", "umount", "--", str(self.fixture.mount)], self.commands.calls)
        self.assertIn(["sudo", "losetup", "--detach", "/dev/loop9"], self.commands.calls)
        self.assertFalse(any("prune" in a for a in self.commands.calls))

    def test_cleanup_recovers_loop_allocation_with_lost_stdout(self):
        self.commands.lose_loop_result = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.create()
        self.assertTrue(self.commands.loop_attached)
        self.assertIsNone(self.fixture.loop)
        self.assertEqual(self.fixture.ledger["loop_intent"], str(self.fixture.backing))
        self.fixture.cleanup()
        self.assertFalse(self.commands.loop_attached)
        self.assertFalse(self.root.exists())
        detach = self.commands.calls.index(["sudo", "losetup", "--detach", self.commands.loop])
        deletion = next(i for i, a in enumerate(self.commands.calls) if a[:2] == ["sudo", "rm"])
        self.assertLess(detach, deletion)
        self.assertEqual(self.fixture.ledger["cleanup"], "PASS")

    def test_cleanup_recovers_mount_sideeffect_with_lost_result(self):
        self.commands.lose_mount_result = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.create()
        self.assertTrue(self.commands.mounted)
        self.assertFalse(self.fixture.mounted)
        self.fixture.cleanup()
        self.assertFalse(self.commands.mounted)
        self.assertFalse(self.commands.loop_attached)
        unmount = self.commands.calls.index(["sudo", "umount", "--", str(self.fixture.mount)])
        detach = self.commands.calls.index(["sudo", "losetup", "--detach", self.commands.loop])
        deletion = next(i for i, a in enumerate(self.commands.calls) if a[:2] == ["sudo", "rm"])
        self.assertLess(unmount, detach)
        self.assertLess(detach, deletion)
        self.assertEqual(self.fixture.ledger["cleanup"], "PASS")

    def test_cleanup_observes_success_when_umount_and_detach_results_lost(self):
        self.create()
        self.commands.lose_umount_result = True
        self.commands.lose_detach_result = True
        self.fixture.cleanup()
        self.assertEqual(self.fixture.ledger["cleanup"], "PASS")
        self.assertEqual(len(self.fixture.ledger["cleanup_command_errors"]), 2)
        self.assertFalse(self.root.exists())

    def test_cleanup_retains_root_if_unmount_or_detach_not_proven(self):
        self.create()
        self.commands.fail_umount = True
        with self.assertRaisesRegex(ValueError, "unmount absence"):
            self.fixture.cleanup()
        self.assertEqual(self.fixture.ledger["cleanup"], "FAIL")
        self.assertTrue(self.root.exists())
        self.assertFalse(any(a[:2] == ["sudo", "rm"] for a in self.commands.calls))
        self.commands.fail_umount = False
        self.commands.fail_detach = True
        with self.assertRaisesRegex(ValueError, "detach absence"):
            self.fixture.cleanup()
        self.assertEqual(self.fixture.ledger["cleanup"], "FAIL")
        self.assertTrue(self.root.exists())
        self.assertFalse(any(a[:2] == ["sudo", "rm"] for a in self.commands.calls))

    def test_cleanup_refuses_unknown_submount_even_when_flags_false(self):
        self.create()
        self.fixture.mounted = False
        self.commands.foreign_mount = True
        with self.assertRaisesRegex(ValueError, "foreign mount"):
            self.fixture.cleanup()
        self.assertEqual(self.fixture.ledger["cleanup"], "FAIL")
        self.assertTrue(self.root.exists())
        self.assertFalse(any(a[:2] == ["sudo", "rm"] for a in self.commands.calls))
        self.assertTrue(self.commands.loop_attached)

    def test_copy_rejects_escape_symlink_and_existing_target(self):
        self.create()
        slot = self.fixture.slot("initial", fresh=True)
        with self.assertRaises(ValueError):
            self.fixture.copy_tree(slot.hdd, self.root / "escaped")
        with self.assertRaises(ValueError):
            self.fixture.copy_tree(slot.hdd, slot.data)
        with self.assertRaises(ValueError):
            self.fixture.copy_tree(slot.hdd, slot.hdd / "recursive")
        (slot.hdd / "escape").symlink_to("/etc")
        with self.assertRaisesRegex(ValueError, "non-regular"):
            self.fixture.copy_tree(slot.hdd, self.fixture.mount / "snapshot")
        (slot.hdd / "escape").unlink()
        (slot.hdd / "synthetic").write_text("synthetic\n")
        self.fixture.copy_tree(slot.hdd, self.fixture.mount / "snapshot")
        self.assertEqual((self.fixture.mount / "snapshot/synthetic").read_text(), "synthetic\n")

    def test_environment_revalidated_before_each_command(self):
        self.create()
        count = len(self.commands.calls)
        with patch.dict(os.environ, GITHUB_RUN_ID="124"):
            with self.assertRaises(ValueError):
                self.fixture.runcmd(["docker", "info"])
        self.assertEqual(len(self.commands.calls), count)


if __name__ == "__main__":
    unittest.main()
