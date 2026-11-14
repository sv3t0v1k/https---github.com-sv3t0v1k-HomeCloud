#!/usr/bin/env python3
"""Portable cgroup topology/race regressions; not Linux kernel qualification."""
import errno
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "e2e_cgroup", Path(__file__).with_name("restore-e2e-cgroup.py")
)
cgroup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cgroup)


class CgroupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="hc-cgroup-contract-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in {
            "cgroup.controllers": "cpu io memory pids\n",
            "cgroup.subtree_control": "\n",
            "cgroup.procs": "1\n12\n34\n",
            "cgroup.type": "domain threaded\n",
        }.items():
            (self.root / name).write_text(value)
        self.real_write = Path.write_text
        self.moves = []
        self.enable_calls = 0
        self.busy_once = False
        self.vanished = None
        self.move_error = None
        self.write_error = None
        self.ignore_delegation = False

    def write(self, path, value, *args, **kwargs):
        # Model kernel side effects and errors explicitly. Real cgroup files
        # and resource enforcement are exercised by the image smoke test.
        if path == self.root / cgroup.LEAF / "cgroup.procs":
            pid = value.strip()
            if self.move_error:
                raise OSError(self.move_error, "injected move error")
            self.moves.append(pid)
            pids = (self.root / "cgroup.procs").read_text().split()
            self.real_write(self.root / "cgroup.procs", "\n".join(p for p in pids if p != pid))
            if not (self.root / "cgroup.procs").read_text().strip():
                self.real_write(self.root / "cgroup.type", "domain\n")
            if pid == self.vanished:
                raise ProcessLookupError(errno.ESRCH, "injected vanished process")
            return self.real_write(path, value)
        if path == self.root / "cgroup.subtree_control":
            self.enable_calls += 1
            if self.busy_once and self.enable_calls == 1:
                self.real_write(self.root / "cgroup.procs", "45\n")
                raise OSError(errno.EBUSY, "injected late runner process")
            if self.write_error:
                raise OSError(self.write_error, "injected delegation error")
            self.assertFalse((self.root / "cgroup.procs").read_text().strip())
            if self.ignore_delegation:
                return 0
            return self.real_write(path, value.replace("+", ""))
        return self.real_write(path, value, *args, **kwargs)

    def prepare(self):
        with patch.object(Path, "write_text", lambda path, value: self.write(path, value)):
            return cgroup.prepare(self.root)

    def test_evacuates_all_runner_processes_before_enabling_domain_controllers(self):
        result = self.prepare()
        self.assertEqual(self.moves, ["1", "12", "34"])
        self.assertEqual(result["root_processes"], 0)
        self.assertEqual(result["type"], "domain")
        self.assertTrue(cgroup.REQUIRED.issubset(result["controllers"]))

    def test_retries_busy_race_and_moves_late_process(self):
        self.busy_once = True
        self.prepare()
        self.assertEqual(self.enable_calls, 2)
        self.assertEqual(self.moves[-1], "45")

    def test_only_vanished_process_error_is_ignored(self):
        self.vanished = "12"
        self.prepare()
        self.assertIn("34", self.moves)

    def test_move_permission_failure_stops_before_delegation(self):
        self.move_error = errno.EPERM
        with self.assertRaises(PermissionError):
            self.prepare()
        self.assertEqual(self.enable_calls, 0)

    def test_missing_required_controller_stops_before_mutation(self):
        (self.root / "cgroup.controllers").write_text("cpu pids\n")
        with self.assertRaisesRegex(ValueError, "Missing required"):
            self.prepare()
        self.assertFalse((self.root / cgroup.LEAF).exists())
        self.assertEqual(self.moves, [])

    def test_invalid_threaded_topology_is_refused(self):
        (self.root / "cgroup.type").write_text("threaded\n")
        with self.assertRaisesRegex(ValueError, "topology"):
            self.prepare()
        self.assertFalse((self.root / cgroup.LEAF).exists())

    def test_existing_leaf_is_not_adopted(self):
        (self.root / cgroup.LEAF).mkdir()
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_delegation_errors_and_unbounded_busy_do_not_pass(self):
        self.write_error = errno.EBUSY
        with self.assertRaisesRegex(ValueError, "Could not evacuate"):
            self.prepare()
        self.assertEqual(self.enable_calls, 8)

    def test_read_only_delegation_is_not_ignored(self):
        self.write_error = errno.EROFS
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(self.enable_calls, 1)

    def test_successful_write_without_delegation_is_not_pass(self):
        self.ignore_delegation = True
        with self.assertRaisesRegex(ValueError, "did not take effect"):
            self.prepare()

    def test_host_or_non_private_namespace_refused_before_mutation(self):
        with patch.object(cgroup.sys, "platform", "linux"), patch.object(cgroup.os, "geteuid", return_value=0):
            with patch.object(Path, "is_file", return_value=False):
                with self.assertRaisesRegex(ValueError, "disposable"):
                    cgroup.require_disposable_namespace()
            with patch.object(Path, "is_file", return_value=True), patch.object(Path, "read_text", return_value="0::/host/path\n"):
                with self.assertRaisesRegex(ValueError, "private"):
                    cgroup.require_disposable_namespace()

    def test_launcher_and_pre_daemon_preflight_keep_real_resource_limits(self):
        folder = Path(__file__).parent
        launcher = (folder / "run-restore-e2e-local.sh").read_text()
        entry = (folder / "test-restore-e2e-local.sh").read_text()
        self.assertIn("--privileged --cgroupns=private --network none", launcher)
        self.assertLess(entry.index("python3 -B scripts/ci/restore-e2e-cgroup.py"), entry.index("dockerd \\\n"))
        self.assertLess(entry.index("=== NESTED RESOURCE LIMIT PREFLIGHT ==="), entry.index("=== EXT4 FIXTURE ==="))
        self.assertIn("--memory 512m --cpus 1 --pids-limit 128", entry)
        for name in ("memory.max", "cpu.max", "pids.max"):
            self.assertIn(name, entry)


if __name__ == "__main__":
    unittest.main()
