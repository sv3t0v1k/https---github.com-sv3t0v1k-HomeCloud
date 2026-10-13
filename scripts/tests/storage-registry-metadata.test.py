"""Registry metadata is never a user file or a reconciliation orphan."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("ms2_reconcile", scripts / "reconcile.py")
reconcile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reconcile)

class RegistryMetadataTests(unittest.TestCase):
    def test_inventory_keeps_user_file_and_excludes_marker_and_deferred_probe(self):
        output = "15 /storage/1/object.bin\n148 /storage/.homecloud-storage-identity\n15 /storage/.hc-probe-retired\n8 /storage/.tmp/session/0\n"
        with patch.object(reconcile, "storage_command", return_value=["fixture-read-only-inventory"]), patch.object(reconcile.subprocess, "run", return_value=SimpleNamespace(stdout=output, returncode=0)):
            self.assertEqual(reconcile.list_storage_files({"target":"/storage"}, "unused"), {"1/object.bin": 15})

    def test_metadata_paths_are_not_valid_db_file_placements(self):
        for key in [".homecloud-storage-identity", ".hc-probe-old", ".tmp/session/0"]:
            self.assertIsNone(reconcile.sanitize_storage_path(key))
        self.assertEqual(reconcile.sanitize_storage_path("1/object.bin"), "1/object.bin")

if __name__ == "__main__":
    unittest.main()
