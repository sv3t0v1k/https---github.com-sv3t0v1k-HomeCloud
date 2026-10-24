#!/usr/bin/env python3
"""Check that both nginx layers stream the exact private ZIP download route."""

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIGS = (
    ROOT / "frontend/nginx.conf.template",
    ROOT / "deploy/ingress/default.conf.template",
)
ARCHIVE_ID = "a" * 32


class NativeArchiveNginxTest(unittest.TestCase):
    def test_streaming_location_at_each_proxy(self):
        for config in CONFIGS:
            with self.subTest(config=config.relative_to(ROOT)):
                source = config.read_text()
                locations = re.findall(r"location ~ (\S+) \{([^}]+)\}", source)
                matches = [(pattern.strip('"'), body) for pattern, body in locations
                           if re.fullmatch(pattern.strip('"'), f"/api/v1/native-download-archives/{ARCHIVE_ID}")]
                self.assertEqual(len(matches), 1)
                pattern, body = matches[0]
                self.assertIsNone(re.fullmatch(pattern, "/api/v1/native-download-archives/invalid"))
                self.assertIsNone(re.fullmatch(pattern, f"/api/v1/native-download-archives/{ARCHIVE_ID}/extra"))
                self.assertIn("proxy_buffering off;", body)
                self.assertIn("proxy_max_temp_file_size 0;", body)
                self.assertIn("proxy_http_version 1.1;", body)


if __name__ == "__main__":
    unittest.main()
