#!/usr/bin/env python3
"""Portable Compose restart regression tests."""
import sys
import inspect
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_storage as storage


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {"project": "fixture"}
        self.before = {
            name: {
                "Id": str(index) * 64,
                "Image": "sha256:" + str(index) * 64,
            }
            for index, name in enumerate(
                ("db", "backend", "frontend", "ingress"), 1
            )
        }

    def test_identity_contract_returns_plain_dictionary(self):
        identities = storage.release_service_identities(self.before)
        self.assertIsInstance(identities, dict)
        self.assertEqual(
            identities,
            {name: (item["Id"], item["Image"])
             for name, item in self.before.items()},
        )

    def test_backup_window_is_a_context_manager(self):
        window = storage.release_backup_window()
        self.assertTrue(callable(window.__enter__))
        self.assertTrue(callable(window.__exit__))
        self.assertTrue(inspect.isgenerator(window.gen))
        window.gen.close()

    def test_plain_start_preserves_original_containers(self):
        with patch.object(storage, "release_compose") as compose:
            with patch.object(storage, "checked_storage"):
                with patch.object(
                    storage, "release_service_inventory",
                    return_value=self.before,
                ):
                    result = storage.restart_existing_services(
                        self.snapshot, self.before
                    )
        self.assertEqual(result, self.before)
        compose.assert_called_once_with(
            "start", "backend", "frontend", "ingress"
        )

    def test_restore_captures_existing_identity(self):
        with patch.object(storage, "release_compose"):
            with patch.object(storage, "checked_storage"):
                with patch.object(
                    storage, "release_service_inventory",
                    return_value=self.before,
                ) as inventory:
                    storage.restart_existing_services(self.snapshot)
        self.assertEqual(inventory.call_count, 2)
        inventory.assert_any_call(
            self.snapshot, require_ready=False
        )

    def test_waits_for_health(self):
        with patch.object(storage, "checked_storage"):
            with patch("time.sleep"):
                with patch.object(
                    storage, "release_service_inventory",
                    side_effect=[
                        storage.StorageError(
                            "RELEASE service is not healthy"
                        ),
                        self.before,
                    ],
                ) as inventory:
                    result = storage.wait_release_services(
                        self.snapshot, self.before
                    )
        self.assertEqual(result, self.before)
        self.assertEqual(inventory.call_count, 2)

    def test_identity_change_refused(self):
        for field in ("Id", "Image"):
            changed = {
                name: dict(item)
                for name, item in self.before.items()
            }
            changed["frontend"][field] = "unexpected"
            with self.subTest(field=field):
                with patch.object(
                    storage, "release_service_inventory",
                    return_value=changed,
                ):
                    with self.assertRaisesRegex(
                        storage.StorageError, "containers changed"
                    ):
                        storage.wait_release_services(
                            self.snapshot, self.before
                        )

    def test_inspection_failure_not_retried(self):
        with patch.object(
            storage, "release_service_inventory",
            side_effect=storage.StorageError(
                "RELEASE service identity mismatch"
            ),
        ) as inventory:
            with self.assertRaisesRegex(
                storage.StorageError, "identity mismatch"
            ):
                storage.wait_release_services(
                    self.snapshot, self.before
                )
        inventory.assert_called_once()

    def test_unhealthy_service_hits_deadline(self):
        with patch(
            "time.monotonic", side_effect=[0, 0, 2, 2]
        ):
            with patch.object(
                storage, "release_service_inventory",
                side_effect=storage.StorageError(
                    "RELEASE service is not healthy"
                ),
            ):
                with self.assertRaisesRegex(
                    storage.StorageError, "deadline exceeded"
                ):
                    storage.wait_release_services(
                        self.snapshot, self.before, timeout=1
                    )

    def test_failed_start_never_reports_success(self):
        with patch.object(storage, "checked_storage"), patch.object(
            storage, "release_service_inventory", return_value=self.before
        ):
            with patch.object(
                storage, "release_compose",
                side_effect=storage.StorageError("start failed"),
            ):
                with patch.object(
                    storage, "wait_release_services"
                ) as wait:
                    with self.assertRaisesRegex(
                        storage.StorageError, "start failed"
                    ):
                        storage.restart_existing_services(
                            self.snapshot, self.before
                        )
        wait.assert_not_called()

    def test_replaced_container_is_never_started(self):
        changed = {name: dict(item) for name, item in self.before.items()}
        changed["frontend"]["Id"] = "f" * 64
        with patch.object(storage, "release_service_inventory", return_value=changed):
            with patch.object(storage, "release_compose") as compose:
                with self.assertRaisesRegex(storage.StorageError, "changed before restart"):
                    storage.restart_existing_services(self.snapshot, self.before)
        compose.assert_not_called()


if __name__ == "__main__":
    unittest.main()
