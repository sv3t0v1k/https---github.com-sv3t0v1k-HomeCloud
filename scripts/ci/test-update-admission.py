#!/usr/bin/env python3
"""No Docker, SSH, systemd or host-root writes."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import stat
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/linux/update-admission.py'
spec = importlib.util.spec_from_file_location('hc_update_admission', SCRIPT)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AdmissionTests(unittest.TestCase):
    def test_valid_test_request(self):
        item = {'format': 'homecloud-update-request-v1', 'channel': 'test', 'manifestSha256': 'a' * 64}
        import json
        self.assertEqual(agent.validate_request(json.dumps(item).encode()), item)

    def test_rejects_unknown_keys_and_other_channels(self):
        import json
        for invalid in [
            {'format': 'homecloud-update-request-v1', 'channel': 'release', 'manifestSha256': 'a' * 64},
            {'format': 'homecloud-update-request-v1', 'channel': 'test', 'manifestSha256': 'a' * 64, 'command': 'docker'},
            {'format': 'homecloud-update-request-v1', 'channel': 'test', 'manifestSha256': '../' * 22},
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(agent.Refusal):
                agent.validate_request(json.dumps(invalid).encode())

    def test_rejects_oversized_request(self):
        with self.assertRaises(agent.Refusal):
            agent.validate_request(b'{' + b' ' * 513 + b'}')

    def test_requires_fixed_owner_mode_and_regular_file(self):
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1001, st_gid=65533,
                               st_size=130, st_nlink=1)
        agent.validate_request_stat(info)
        for bad in [dict(st_uid=0), dict(st_gid=0), dict(st_mode=stat.S_IFLNK | 0o600),
                    dict(st_mode=stat.S_IFREG | 0o666), dict(st_size=1024), dict(st_nlink=3)]:
            with self.subTest(bad=bad), self.assertRaises(agent.Refusal):
                agent.validate_request_stat(SimpleNamespace(**(vars(info) | bad)))


if __name__ == '__main__':
    unittest.main()
