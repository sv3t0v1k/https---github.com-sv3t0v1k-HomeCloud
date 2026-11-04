"""Offline guard tests for the disposable VM 120 data probe."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("vm120-data-check.py")
SPEC = importlib.util.spec_from_file_location("vm120_data_check", MODULE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class Vm120DataCheckTest(unittest.TestCase):
    def test_only_vm_ip_https_origin_on_18443(self):
        self.assertEqual(PROBE.origin_parts("https://192.168.3.117:18443"),
                         "192.168.3.117")
        for value in ("http://192.168.3.117:18443", "https://example.com:18443",
                      "https://192.168.3.117:443", "https://192.168.3.117",
                      "https://192.168.3.117:18443/path",
                      "https://user@192.168.3.117:18443"):
            with self.subTest(value=value), self.assertRaises(PROBE.Refused):
                PROBE.origin_parts(value)

    def test_tcp_peer_and_tls_san_are_pinned_to_vm_ip(self):
        context = mock.Mock()
        connection = PROBE.VmConnection(PROBE.VM_IP, PROBE.VM_PORT,
                                         timeout=7, context=context)
        with mock.patch.object(PROBE.socket, "create_connection") as create:
            connection.connect()
        create.assert_called_once_with((PROBE.VM_IP, PROBE.VM_PORT), 7)
        context.wrap_socket.assert_called_once_with(create.return_value,
                                                     server_hostname=PROBE.VM_IP)

    def test_private_state_excludes_project_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            path = PROBE.state_path(str(root / "checkpoint.json"))
            state = {"format": PROBE.FORMAT, "vm_ip": PROBE.VM_IP,
                     "origin": "https://192.168.3.117:18443", "stage": "registered",
                     "nonce": "a" * 20,
                     "email": "vm120-" + "a" * 20 + "@example.test", "user_id": 42}
            PROBE.save(path, state, create=True)
            self.assertEqual(PROBE.load(path), state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                PROBE.save(path, state, create=True)
            with self.assertRaises(PROBE.Refused):
                PROBE.state_path(str(Path(__file__).parent / "checkpoint.json"))

    def test_intermediate_symlink_cannot_redirect_state_into_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / "checkout"
            (checkout / "qa").mkdir(parents=True)
            (checkout / "qa" / "probe.py").touch()
            private = checkout / "private"
            private.mkdir(mode=0o700)
            alias = root / "alias"
            alias.symlink_to(private, target_is_directory=True)
            with mock.patch.object(PROBE, "__file__", str(checkout / "qa" / "probe.py")):
                with self.assertRaises(PROBE.Refused):
                    PROBE.state_path(str(alias / "checkpoint.json"))

    def test_modified_state_cannot_target_non_synthetic_account(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            path = PROBE.state_path(str(root / "checkpoint.json"))
            state = {"format": PROBE.FORMAT, "vm_ip": PROBE.VM_IP,
                     "origin": "https://192.168.3.117:18443", "stage": "registered",
                     "nonce": "b" * 20,
                     "email": "owner@example.com", "user_id": 42}
            PROBE.save(path, state, create=True)
            with self.assertRaises(PROBE.Refused):
                PROBE.load(path)
            state["email"] = "vm120-" + "b" * 20 + "@example.test"
            state["user_id"] = -1
            PROBE.save(path, state)
            with self.assertRaises(PROBE.Refused):
                PROBE.load(path)

    def test_upload_admission_binds_exact_whole_file_hash(self):
        calls = []

        def fake_request(_host, _context, method, route, body=None,
                         token=None, content_type=None):
            calls.append((method, route, body, token, content_type))
            if route == "/api/v1/uploads/session":
                return {"uploadId": "synthetic-upload-id"}
            if route.endswith("/complete"):
                return {"id": 123, "relativeObjectKey": "42/fixture.bin"}
            return {"status": "uploading"}

        with mock.patch.object(PROBE, "request", side_effect=fake_request):
            result = PROBE.upload(PROBE.VM_IP, object(), "secret-token",
                                  "fixture.bin", b"exact bytes", 77)
        self.assertEqual(calls[0][2]["expectedSha256"],
                         PROBE.hashlib.sha256(b"exact bytes").hexdigest())
        self.assertEqual(calls[0][2]["parentId"], 77)
        self.assertEqual(result["id"], 123)
        self.assertEqual(result["sha256"], calls[0][2]["expectedSha256"])
        self.assertEqual(len(calls), 3)

    def test_json_envelope_and_raw_download_contract(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = json.dumps({"success": True,
                                                  "data": {"id": 42}}).encode()
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch.object(PROBE, "VmConnection", return_value=connection):
            self.assertEqual(PROBE.request(PROBE.VM_IP, object(), "GET",
                                           "/api/v1/files/42"), {"id": 42})
            connection.request.assert_called_once()
            self.assertEqual(connection.request.call_args.args[:2],
                             ("GET", "/api/v1/files/42"))
            self.assertEqual(connection.request.call_args.kwargs["headers"]["Host"],
                             "192.168.3.117:18443")
            response.read.return_value = b"exact bytes"
            self.assertEqual(PROBE.request(PROBE.VM_IP, object(), "GET",
                                           "/api/v1/files/42/download"), b"exact bytes")
            response.status = 503
            with self.assertRaises(PROBE.Refused):
                PROBE.request(PROBE.VM_IP, object(), "GET", "/api/v1/files/42")


if __name__ == "__main__":
    unittest.main()
