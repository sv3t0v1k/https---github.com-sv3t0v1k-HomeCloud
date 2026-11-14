#!/usr/bin/env python3
"""TEST restart identity and bounded health checks, no Docker mutation."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "test_restart_installer", ROOT / "deploy/linux/test-channel.py"
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.inventory = {
            role: {
                "Id": str(index) * 64,
                "Image": "sha256:" + str(index) * 64,
                "Config": {"Labels": {
                    "com.docker.compose.project": "homecloud-test",
                    "com.docker.compose.service": role,
                    "com.docker.compose.oneoff": "False",
                }},
                "Mounts": [{"Source": "/fixture", "Destination": "/storage"}],
                "State": {"Running": True, "Restarting": False, "Paused": False,
                          "Status": "running", "Health": {"Status": "healthy"}},
            } for index, role in enumerate(("db", "backend", "frontend", "ingress"), 1)
        }

    def test_plain_start_then_original_service_readiness(self):
        with patch.object(installer, "restart_inventory", return_value=self.inventory):
            with patch.object(installer, "guard_no_maintenance"):
                with patch.object(installer, "compose") as compose:
                    installer.restart_existing_services()
        compose.assert_called_once_with("start", "backend", "frontend", "ingress", timeout=900)

    def test_replacement_and_mount_changes_refused(self):
        for role in self.inventory:
            for field in ("Id", "Image", "Mounts"):
                after = copy.deepcopy(self.inventory)
                after[role][field] = "replaced"
                with self.subTest(role=role, field=field):
                    with patch.object(installer, "restart_inventory", side_effect=[self.inventory, after]):
                        with patch.object(installer, "guard_no_maintenance"), patch.object(installer, "compose"):
                            with self.assertRaisesRegex(installer.Stop, "changed"):
                                installer.restart_existing_services()

    def test_start_failure_never_checks_ready(self):
        with patch.object(installer, "restart_inventory", return_value=self.inventory) as inventory:
            with patch.object(installer, "compose", side_effect=installer.Stop("start failed")):
                with self.assertRaisesRegex(installer.Stop, "start failed"):
                    installer.restart_existing_services()
        self.assertEqual(inventory.call_count, 1)

    def test_unhealthy_waits_then_passes(self):
        after = copy.deepcopy(self.inventory)
        after["db"]["State"]["Health"]["Status"] = "starting"
        with patch.object(installer, "restart_inventory", side_effect=[self.inventory, after, self.inventory]):
            with patch.object(installer, "guard_no_maintenance"), patch.object(installer, "compose"):
                with patch.object(installer.time, "sleep") as sleep:
                    installer.restart_existing_services()
        sleep.assert_called_once()

    def test_timeout_refuses_unready(self):
        with patch.object(installer, "restart_inventory", return_value=self.inventory):
            with patch.object(installer, "compose"):
                with patch.object(installer.time, "monotonic", side_effect=[0, 2]):
                    with self.assertRaisesRegex(installer.Stop, "timeout"):
                        installer.restart_existing_services(timeout=1)

    def test_inspection_failure_is_fatal(self):
        with patch.object(installer, "restart_inventory", side_effect=[self.inventory, installer.Stop("inspect failed")]):
            with patch.object(installer, "guard_no_maintenance"), patch.object(installer, "compose"):
                with self.assertRaisesRegex(installer.Stop, "inspect failed"):
                    installer.restart_existing_services()

    def test_real_inspection_contract(self):
        for corrupt in (None, "project", "service", "oneoff", "image", "id", "multiple", "missing"):
            item = copy.deepcopy(self.inventory["db"])
            if corrupt in ("project", "service", "oneoff"):
                item["Config"]["Labels"]["com.docker.compose." + corrupt] = "wrong"
            elif corrupt == "image":
                item["Image"] = "mutable:tag"
            elif corrupt == "id":
                item["Id"] = "f" * 64
            inspected = [item, item] if corrupt == "multiple" else [item]
            with self.subTest(corrupt=corrupt):
                with patch.object(installer, "compose", return_value="" if corrupt == "missing" else "1" * 64):
                    with patch.object(installer, "run", return_value=json.dumps(inspected)):
                        # Every later service would have the wrong service label too.
                        if corrupt is None:
                            with self.assertRaisesRegex(installer.Stop, "identity mismatch"):
                                installer.restart_inventory()
                        else:
                            with self.assertRaises(installer.Stop):
                                installer.restart_inventory()


if __name__ == "__main__":
    unittest.main()
