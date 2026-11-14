#!/usr/bin/env python3
"""Durable maintenance marker contract; no Docker or server writes."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


SOURCE = (
    Path(__file__).resolve().parents[2]
    / "deploy/linux/maintenance-inhibit.py"
)

spec = importlib.util.spec_from_file_location(
    "maintenance_inhibit", SOURCE
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(
            prefix="hc-maintenance-test-"
        )
        self.addCleanup(scratch.cleanup)
        self.root = str(Path(scratch.name).resolve())
        self.uid = os.geteuid()
        os.chmod(self.root, 0o711)

    def allowed(self):
        guard.assert_start_allowed(self.root, self.uid)

    def inhibit(self):
        guard.create_inhibit(self.root, self.uid)

    def test_missing_marker_allows_start(self):
        self.allowed()

    def test_ready_receipt_or_stale_permit_blocks_new_operation(self):
        for name in ("restore.pending.json", "restore-migration." + "a" * 32):
            with self.subTest(name=name):
                path = Path(self.root) / name
                path.symlink_to(Path(self.root) / "missing")
                try:
                    # Normal API readiness is allowed at READY, new work isn't.
                    self.allowed()
                    with self.assertRaises(guard.MaintenanceInhibited):
                        guard.assert_operation_allowed(self.root, self.uid)
                    self.assertFalse((Path(self.root) / guard.MARKER).exists())
                finally:
                    path.unlink()

    def test_created_marker_blocks_start(self):
        self.inhibit()

        with self.assertRaises(guard.MaintenanceInhibited):
            self.allowed()

    def test_marker_persists_across_independent_checks(self):
        self.inhibit()

        for _ in range(3):
            with self.assertRaises(
                guard.MaintenanceInhibited
            ):
                self.allowed()

    def test_second_inhibit_is_refused(self):
        self.inhibit()

        with self.assertRaises(guard.MaintenanceInhibited):
            self.inhibit()

    def test_empty_marker_is_fail_closed(self):
        (Path(self.root) / guard.MARKER).touch()

        with self.assertRaises(guard.MaintenanceInhibited):
            self.allowed()

    def test_symlink_marker_is_fail_closed(self):
        (Path(self.root) / guard.MARKER).symlink_to(
            Path(self.root) / "missing"
        )

        with self.assertRaises(guard.MaintenanceInhibited):
            self.allowed()

        with self.assertRaises(guard.MaintenanceInhibited):
            self.inhibit()

    def test_wrong_state_directory_permissions(self):
        os.chmod(self.root, 0o777)

        with self.assertRaises(guard.MaintenanceError):
            self.allowed()

        with self.assertRaises(guard.MaintenanceError):
            self.inhibit()

    def test_wrong_owner_identity(self):
        with self.assertRaises(guard.MaintenanceError):
            guard.create_inhibit(
                self.root, self.uid + 1
            )

    def test_noncanonical_directory_is_refused(self):
        with self.assertRaises(guard.MaintenanceError):
            guard.assert_start_allowed(
                self.root + "/.", self.uid
            )

    def test_valid_marker_has_private_permissions(self):
        self.inhibit()
        marker = Path(self.root) / guard.MARKER

        self.assertEqual(
            marker.read_bytes(), guard.PAYLOAD
        )
        self.assertEqual(
            marker.stat().st_mode & 0o777, 0o600
        )



    def test_unprivileged_gate_allows_missing_marker(self):
        guard.assert_start_allowed_unprivileged(
            self.root, self.uid
        )

    def test_unprivileged_gate_blocks_existing_marker(self):
        self.inhibit()
        with self.assertRaises(guard.MaintenanceInhibited):
            guard.assert_start_allowed_unprivileged(
                self.root, self.uid
            )

    def test_unprivileged_gate_blocks_dangling_symlink(self):
        (Path(self.root) / guard.MARKER).symlink_to(
            Path(self.root) / "missing"
        )
        with self.assertRaises(guard.MaintenanceInhibited):
            guard.assert_start_allowed_unprivileged(
                self.root, self.uid
            )

    def test_unprivileged_gate_rejects_private_0700_dir(self):
        os.chmod(self.root, 0o700)
        with self.assertRaises(guard.MaintenanceError):
            guard.assert_start_allowed_unprivileged(
                self.root, self.uid
            )

if __name__ == "__main__":
    unittest.main()
