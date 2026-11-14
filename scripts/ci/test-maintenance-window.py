#!/usr/bin/env python3
"""Maintenance sequencing tests without real Docker or DB."""

import fcntl
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load(name, alias):
    spec = importlib.util.spec_from_file_location(
        alias, ROOT / "deploy/linux" / name
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


window = load(
    "maintenance-window.py", "hc_maintenance_window"
)
inhibitor = window.inhibitor
fencing = window.fencing


class MaintenanceWindowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(
            prefix="hc-maintenance-window-"
        )
        self.addCleanup(tmp.cleanup)

        base = Path(tmp.name).resolve()
        self.storage = base / "storage"
        self.state = base / "state"

        self.storage.mkdir(mode=0o700)
        self.state.mkdir(mode=0o711)
        self.state.chmod(0o711)

        self.uid = os.geteuid()
        self.events = []

    def marker_exists(self):
        return (
            self.state / inhibitor.MARKER
        ).exists()

    def enter(self, stop=None, verify=None):
        if stop is None:
            def stop():
                self.events.append("stop")
                return True

        if verify is None:
            def verify():
                self.events.append("verify")
                return True

        return window.maintenance_window(
            str(self.storage),
            str(self.state),
            expected_storage_uid=self.uid,
            expected_state_uid=self.uid,
            stop_writers=stop,
            verify_stopped=verify,
        )

    def test_correct_order_and_lock_held(self):
        with self.enter():
            self.events.append("critical")
            self.assertTrue(self.marker_exists())

            competing = os.open(
                self.storage,
                os.O_RDONLY | os.O_DIRECTORY
            )
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(
                        competing,
                        fcntl.LOCK_EX | fcntl.LOCK_NB
                    )
            finally:
                os.close(competing)

        self.assertEqual(
            self.events,
            ["stop", "verify", "critical"]
        )
        self.assertTrue(self.marker_exists())

    def test_writer_stop_refusal_retains_inhibit(self):
        def stop():
            self.events.append("stop-failed")
            return False

        with self.assertRaises(
            window.MaintenanceWindowError
        ):
            with self.enter(stop=stop):
                self.fail("Critical section ran")

        self.assertEqual(
            self.events, ["stop-failed"]
        )
        self.assertTrue(self.marker_exists())

    def test_busy_writer_retains_inhibit(self):
        competing = os.open(
            self.storage,
            os.O_RDONLY | os.O_DIRECTORY
        )
        fcntl.flock(
            competing, fcntl.LOCK_EX | fcntl.LOCK_NB
        )

        try:
            with self.assertRaises(
                fencing.StorageFenceBusy
            ):
                with self.enter():
                    self.fail("Busy lock bypassed")
        finally:
            os.close(competing)

        self.assertEqual(self.events, ["stop"])
        self.assertTrue(self.marker_exists())

    def test_verification_refusal_releases_lock(self):
        def verify():
            self.events.append("verification-failed")
            return False

        with self.assertRaises(
            window.MaintenanceWindowError
        ):
            with self.enter(verify=verify):
                self.fail("Critical section ran")

        fd = fencing.acquire_storage_root_fence(
            str(self.storage), self.uid
        )
        os.close(fd)

        self.assertTrue(self.marker_exists())

    def test_critical_failure_retains_inhibit(self):
        with self.assertRaisesRegex(
            RuntimeError, "simulated failure"
        ):
            with self.enter():
                raise RuntimeError("simulated failure")

        fd = fencing.acquire_storage_root_fence(
            str(self.storage), self.uid
        )
        os.close(fd)

        self.assertTrue(self.marker_exists())

    def test_existing_inhibit_prevents_shutdown(self):
        inhibitor.create_inhibit(
            str(self.state), self.uid
        )

        with self.assertRaises(
            inhibitor.MaintenanceInhibited
        ):
            with self.enter():
                self.fail("Duplicate maintenance allowed")

        self.assertEqual(self.events, [])

    def test_stop_exception_retains_inhibit(self):
        def stop():
            raise RuntimeError("shutdown failed")

        with self.assertRaisesRegex(
            RuntimeError, "shutdown failed"
        ):
            with self.enter(stop=stop):
                self.fail("Critical section ran")

        self.assertTrue(self.marker_exists())

    def test_invalid_callbacks_do_not_create_marker(self):
        with self.assertRaises(
            window.MaintenanceWindowError
        ):
            with self.enter(stop=None, verify=False):
                self.fail("Invalid callback accepted")

        self.assertFalse(self.marker_exists())


if __name__ == "__main__":
    unittest.main()
