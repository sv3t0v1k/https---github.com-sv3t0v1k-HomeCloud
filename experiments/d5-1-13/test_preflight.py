"""Negative boundary tests. No Docker, network, original OCI or host changes."""
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("preflight.py"))
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.env = dict(GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted",
                        GITHUB_REPOSITORY=subject.REPO, GITHUB_EVENT_NAME="workflow_dispatch",
                        GITHUB_RUN_ATTEMPT="1", GITHUB_SHA="a" * 40)
        self.artifact = dict(id=subject.ARTIFACT, name="d5111-experimental-image-1",
                             expired=False, expires_at="2026-11-16T08:01:14Z",
                             digest="sha256:" + subject.ZIP_SHA, size_in_bytes=116311061,
                             workflow_run=dict(id=subject.RUN, head_sha=subject.BUILD_SHA,
                                               head_repository_id=1361208027))
        self.build = dict(id=subject.RUN, head_sha=subject.BUILD_SHA, event="push",
                          status="completed", run_attempt=1,
                          path=".github/workflows/pg-residual-experiment.yml")
        self.now = datetime(2026, 10, 18, tzinfo=timezone.utc)

    def test_developer_host_and_self_hosted_are_rejected(self):
        for system, machine in [("Darwin", "arm64"), ("Linux", "aarch64")]:
            with self.assertRaises(ValueError):
                subject.hosted(self.env, system, machine)
        self.env["RUNNER_ENVIRONMENT"] = "self-hosted"
        with self.assertRaises(ValueError):
            subject.hosted(self.env, "Linux", "x86_64")

    def test_reruns_remote_daemons_credentials_and_wrong_events_rejected(self):
        for key, value in [("GITHUB_RUN_ATTEMPT", "2"), ("DOCKER_HOST", "ssh://host"),
                           ("SSH_AUTH_SOCK", "/tmp/agent"), ("AWS_ACCESS_KEY_ID", "synthetic"),
                           ("GITHUB_EVENT_NAME", "push"), ("APPROVED_SHA", "main")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                subject.hosted(dict(self.env, **{key: value}), "Linux", "x86_64")

    def test_expired_changed_or_wrong_origin_artifact_rejected(self):
        subject.validate_origin(self.artifact, self.build, self.now)
        for field, value in [("expired", True), ("expires_at", "2026-10-17T00:00:00Z"),
                             ("digest", "sha256:" + "0" * 64), ("id", 1),
                             ("size_in_bytes", 1024 ** 3)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                subject.validate_origin(dict(self.artifact, **{field: value}), self.build, self.now)
        with self.assertRaises(ValueError):
            subject.validate_origin(self.artifact, dict(self.build, head_sha="b" * 40), self.now)

    def test_registry_bytes_must_match_requested_digest(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"schemaVersion":2}'
        with patch.object(subject.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(ValueError):
                subject.fetch_registry("manifests/sha256:" + "0" * 64, "public-token")

    def test_finish_never_promotes_runtime_or_invents_measurements(self):
        import json
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subject.write(root, "partial.json", {"status": "FAIL"})
            subject.finish(root)
            status = json.loads((root / "status.json").read_text())
            self.assertEqual(status["drill"], "NOT_RUN")
            self.assertIsNone(status["rpo"])
            self.assertIsNone(status["rto"])
            self.assertFalse(status["complete"])
            self.assertFalse(status["runtime_integration_ready"])
            self.assertIn("partial.json", json.loads((root / "hashes.json").read_text()))

    def test_finish_preserves_partial_runtime_after_interruption(self):
        import json,os
        with tempfile.TemporaryDirectory() as temp:
            temp=Path(temp).resolve()
            out=temp/'evidence';out.mkdir()
            runtime=temp/'d513-runtime-123-1';runtime.mkdir()
            (runtime/'ledger.json').write_text('{"cleanup":"IN_PROGRESS","containers":[]}')
            with patch.dict(os.environ,RUNNER_TEMP=str(temp),GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1'):
                subject.finish(out)
            status=json.loads((out/'status.json').read_text())
            self.assertEqual(status['status'],'INTERRUPTED_RUNTIME')
            self.assertEqual(status['drill'],'PARTIAL')
            self.assertIsNone(status['rpo'])
            self.assertEqual(json.loads((out/'resource-ledger.json').read_text())['cleanup'],'IN_PROGRESS')

    def test_official_accepts_pinned_child_and_selects_unique_amd64_from_index(self):
        import io
        lock = dict(base="postgres@sha256:" + "a" * 64, postgres_version="16.15")
        child = dict(digest="sha256:" + "b" * 64, platform=dict(os="linux", architecture="amd64"))
        manifest = dict(config=dict(digest="sha256:" + "c" * 64), layers=[])
        config = dict(os="linux", architecture="amd64", config=dict(Env=["PG_VERSION=16.15"]))
        for sequence, kind in [([manifest, config], "platform-manifest"),
                               ([dict(manifests=[child]), manifest, config], "multiarch-index")]:
            with patch.object(subject.urllib.request, "urlopen", return_value=io.StringIO('{"token":"public"}')):
                with patch.object(subject, "fetch_registry", side_effect=sequence):
                    self.assertEqual(subject.official(lock)["reference_kind"], kind)


if __name__ == "__main__":
    unittest.main()
