#!/usr/bin/env python3
"""Read-only/mocked orchestration tests; no Docker or PostgreSQL."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]


def load(filename, name):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "deploy/linux" / filename
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load("recover-copy.py", "hc_recover_copy")
inhibitor = load("maintenance-inhibit.py", "hc_inhibitor")

OPERATION = "11111111-2222-3333-4444-555555555555"


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(
            prefix="hc-copy-recovery-"
        )
        self.addCleanup(temp.cleanup)

        self.root = Path(temp.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.state = self.runtime / "maintenance"
        self.state.mkdir(mode=0o711)
        self.state.chmod(0o711)

        self.channel = Mock()
        c = self.channel

        c.ROOT = self.root
        c.RUNTIME = self.runtime
        c.CHANNEL = self.runtime / "test-channel"

        sha = "a" * 40

        self.images = {
            "backend": {"id": "sha256:" + "b" * 64, "sha": sha},
            "frontend": {"id": "sha256:" + "c" * 64, "sha": sha},
        }

        c.load_state.return_value = {
            "active": {"images": self.images}
        }

        c.active_images.return_value = self.images
        c.env_values.return_value = {
            "COMPOSE_PROJECT_NAME": "homecloud-test"
        }

        def run(*args):
            if args[:3] == ("git", "rev-parse", "HEAD"):
                return sha
            return ""

        c.run.side_effect = run

        def acquire(_):
            return os.open(
                str(self.root), os.O_RDONLY | os.O_DIRECTORY
            )

        c.acquire_lock.side_effect = acquire

        self.events = []

        def compose(*args, **kwargs):
            self.events.append(args)

            self.assertTrue(
                (self.state / inhibitor.MARKER).exists()
            )

            if args[0] == "run":
                return "COPY_RECOVERY_RELEASED"

            return ""

        c.compose.side_effect = compose

        self.guard = Mock()

        def create(root):
            inhibitor.create_inhibit(
                root, os.geteuid()
            )

        self.guard.create_inhibit.side_effect = create
        self.guard.assert_operation_allowed = Mock(
            side_effect=lambda root: inhibitor.assert_operation_allowed(root, os.geteuid())
        )
        self.writers = patch.object(recovery, 'verify_storage_writers')
        self.verify_writers = self.writers.start()
        self.addCleanup(self.writers.stop)

    def execute(self, operation=OPERATION):
        with patch.object(
            recovery, "verify_backend_mount"
        ), patch.object(
            recovery, "verify_stopped"
        ) as stopped:
            recovery.perform_recovery(
                self.channel, self.guard, operation
            )
            self.assertEqual(stopped.call_count, 2)

    def test_success_retains_marker_and_never_restarts(self):
        self.execute()

        self.assertEqual(
            [args[0] for args in self.events],
            ["stop", "run"],
        )

        self.assertTrue(
            (self.state / inhibitor.MARKER).exists()
        )

        self.assertIn(
            "dist/files/file-copy-recovery-cli.js",
            self.events[1],
        )

        self.assertEqual(self.events[1][-1], OPERATION)

    def test_invalid_uuid_has_no_side_effects(self):
        with self.assertRaises(recovery.RecoveryError):
            self.execute("not-a-uuid")

        self.guard.create_inhibit.assert_not_called()
        self.channel.compose.assert_not_called()

    def test_foreign_writer_refuses_before_recovery_command(self):
        self.verify_writers.side_effect = recovery.RecoveryError('foreign writer')
        with self.assertRaisesRegex(recovery.RecoveryError, 'foreign writer'):
            self.execute()
        self.assertEqual([event[0] for event in self.events], ['stop'])
        self.assertTrue((self.state / inhibitor.MARKER).exists())

    def test_existing_marker_prevents_new_operation(self):
        inhibitor.create_inhibit(
            str(self.state), os.geteuid()
        )

        with self.assertRaises(inhibitor.MaintenanceInhibited):
            self.execute()

        self.channel.compose.assert_not_called()

    def test_checkpoint_mismatch_refuses_before_inhibit(self):
        self.channel.active_images.return_value = {}

        with self.assertRaises(recovery.RecoveryError):
            self.execute()

        self.guard.create_inhibit.assert_not_called()
        self.channel.compose.assert_not_called()

    def test_stop_failure_retains_marker(self):
        self.channel.compose.side_effect = RuntimeError(
            "stop failed"
        )

        with self.assertRaises(RuntimeError):
            self.execute()

        self.assertTrue(
            (self.state / inhibitor.MARKER).exists()
        )

        self.assertEqual(
            self.channel.compose.call_count, 1
        )

    def test_unconfirmed_recovery_retains_marker(self):
        self.channel.compose.side_effect = ["", ""]

        with self.assertRaises(recovery.RecoveryError):
            self.execute()

        self.assertTrue(
            (self.state / inhibitor.MARKER).exists()
        )

    def test_live_writer_refuses_recovery(self):
        with patch.object(
            recovery, "verify_backend_mount"
        ), patch.object(
            recovery, "verify_stopped",
            side_effect=recovery.RecoveryError("live writer"),
        ):
            with self.assertRaises(recovery.RecoveryError):
                recovery.perform_recovery(
                    self.channel, self.guard, OPERATION
                )

        self.assertEqual(
            [args[0] for args in self.events],
            ["stop"],
        )

        self.assertTrue(
            (self.state / inhibitor.MARKER).exists()
        )


if __name__ == "__main__":
    unittest.main()
