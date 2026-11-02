#!/usr/bin/env python3
"""Offline HTTP and ZIP security tests for TEST update source."""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/linux"))

from update_source import GitHubClient, SourceError, MAX_JSON


class Response:
    status = 200

    def __init__(self, body, headers=None):
        self.body = io.BytesIO(body)
        self.headers = headers or {}

    def read(self, count=-1):
        return self.body.read(count)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.body.close()


class Opener:
    def __init__(self, *results):
        self.results = list(results)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if not self.results:
            raise AssertionError("Unexpected network request")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def redirect(location):
    return urllib.error.HTTPError(
        "https://api.github.com/artifact", 302, "Found",
        {"Location": location}, io.BytesIO(b""),
    )


def make_zip(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in entries.items():
            archive.writestr(name, body)
    return output.getvalue()


BLOB = "https://productionresultssa30.blob.core.windows.net/file"


class SourceHttpTests(unittest.TestCase):
    def client(self, *results):
        client = GitHubClient("private-test-token")
        client.opener = Opener(*results)
        return client

    def test_api_authentication(self):
        client = self.client(Response(b'{"ok":true}'))
        self.assertEqual(client.api_json("/branches/test"), {"ok": True})
        self.assertEqual(
            client.opener.requests[0].get_header("Authorization"),
            "Bearer private-test-token",
        )

    def test_rejects_oversized_body_without_length(self):
        client = self.client(Response(b"x" * 20))
        with self.assertRaises(SourceError):
            client.read("https://api.github.com/test", 10, True)

    def test_rejects_oversized_content_length(self):
        client = self.client(Response(
            b"{}", {"Content-Length": "999999999"},
        ))
        with self.assertRaises(SourceError):
            client.read("https://api.github.com/test", 10, True)

    def test_rejects_api_redirect(self):
        client = self.client(redirect(BLOB))
        with self.assertRaises(SourceError):
            client.api_json("/branches/test")
        self.assertEqual(len(client.opener.requests), 1)

    def test_valid_zip_never_leaks_token(self):
        payload = {"format": "example"}
        archive = make_zip({
            "test-channel.json": json.dumps(payload).encode(),
        })
        client = self.client(redirect(BLOB), Response(archive))
        self.assertEqual(client.artifact_json(42), payload)

        first, second = client.opener.requests
        self.assertEqual(
            first.get_header("Authorization"),
            "Bearer private-test-token",
        )
        self.assertIsNone(second.get_header("Authorization"))
        self.assertEqual(second.full_url, BLOB)

    def test_rejects_untrusted_redirect(self):
        client = self.client(redirect("https://evil.example/file"))
        with self.assertRaises(SourceError):
            client.artifact_json(42)
        self.assertEqual(len(client.opener.requests), 1)

    def test_rejects_corrupt_zip(self):
        client = self.client(redirect(BLOB), Response(b"bad zip"))
        with self.assertRaises(SourceError):
            client.artifact_json(42)

    def test_rejects_multiple_zip_entries(self):
        archive = make_zip({
            "test-channel.json": b"{}",
            "extra.json": b"{}",
        })
        client = self.client(redirect(BLOB), Response(archive))
        with self.assertRaises(SourceError):
            client.artifact_json(42)

    def test_rejects_oversized_uncompressed_entry(self):
        archive = make_zip({
            "test-channel.json": b"x" * (MAX_JSON + 1),
        })
        client = self.client(redirect(BLOB), Response(archive))
        with self.assertRaises(SourceError):
            client.artifact_json(42)


if __name__ == "__main__":
    unittest.main()
