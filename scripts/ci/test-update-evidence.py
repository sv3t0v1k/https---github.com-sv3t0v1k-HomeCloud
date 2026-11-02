#!/usr/bin/env python3
"""Offline tests with the real TEST manifest contract."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ci"))
sys.path.insert(0, str(ROOT / "deploy/linux"))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

contract = load("test_channel_contract",
                ROOT / "scripts/ci/test-channel.py")
evidence = load("update_evidence",
                ROOT / "deploy/linux/update_evidence.py")


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        repo = evidence.REPOSITORY
        sha = "b" * 40

        def image(role):
            return {
                "repository": f"ghcr.io/{repo}/{role}",
                "digest": "sha256:" + "1" * 64,
                "platform_digest": "sha256:" + "2" * 64,
                "statement_digest": "sha256:" + "3" * 64,
                "revision": sha,
                "version": "test-" + sha,
            }

        self.manifest = {
            "format": contract.FORMAT,
            "repository": repo,
            "commit": sha,
            "platform": "linux/amd64",
            "images": {
                "backend": image("backend"),
                "frontend": image("frontend"),
            },
            "schema_migrations": [{
                "name": "MigrationOne",
                "file": "123-MigrationOne.ts",
                "sha256": "4" * 64,
            }],
            "source_files": {
                name: "5" * 64 for name in contract.FILES
            },
            "ci": {
                "run_id": "123",
                "attempt": "1",
                "workflow": "ci-v2-fast.yml",
            },
        }
        self.manifest["manifest_sha256"] = contract.identity(
            self.manifest
        )
        self.request_hash = self.manifest["manifest_sha256"]
        self.branch = {
            "protected": True,
            "commit": {"sha": sha},
        }
        self.run = {
            "id": 123,
            "run_attempt": 1,
            "event": "push",
            "head_branch": "test",
            "head_sha": sha,
            "path": ".github/workflows/ci-v2-fast.yml",
            "status": "completed",
            "conclusion": "success",
        }
        self.artifact = {
            "id": 42,
            "expired": False,
            "name": "test-channel-1",
            "workflow_run": {
                "id": 123,
                "head_sha": sha,
            },
        }

    def check(self, **overrides):
        values = {
            "request_hash": self.request_hash,
            "branch": self.branch,
            "run": self.run,
            "artifact": self.artifact,
            "manifest": self.manifest,
        }
        values.update(overrides)
        return evidence.verify(
            values["request_hash"],
            values["branch"],
            values["run"],
            values["artifact"],
            values["manifest"],
            contract.shape,
        )

    def test_valid_evidence(self):
        self.assertEqual(self.check(), self.manifest)

    def test_invalid_request_identity(self):
        with self.assertRaises(evidence.EvidenceError):
            self.check(request_hash="f" * 64)

    def test_tampered_manifest(self):
        altered = copy.deepcopy(self.manifest)
        altered["schema_migrations"][0]["sha256"] = "6" * 64
        with self.assertRaises(ValueError):
            self.check(manifest=altered)

    def test_invalid_branch(self):
        for change in (
            {"protected": False},
            {"commit": {"sha": "c" * 40}},
        ):
            with self.subTest(change=change):
                with self.assertRaises(evidence.EvidenceError):
                    self.check(branch={**self.branch, **change})

    def test_invalid_ci(self):
        for change in (
            {"conclusion": "failure"},
            {"head_sha": "c" * 40},
            {"run_attempt": 2},
            {"event": "workflow_dispatch"},
        ):
            with self.subTest(change=change):
                with self.assertRaises(evidence.EvidenceError):
                    self.check(run={**self.run, **change})

    def test_invalid_artifact(self):
        for change in (
            {"expired": True},
            {"name": "test-channel-2"},
            {"workflow_run": {
                "id": 999,
                "head_sha": self.manifest["commit"],
            }},
        ):
            with self.subTest(change=change):
                with self.assertRaises(evidence.EvidenceError):
                    self.check(artifact={
                        **self.artifact, **change
                    })



class SourceTests(EvidenceTests):
    def source(self, branch_override=None, duplicate=False):
        import update_source

        owner = self

        class Client:
            def __init__(self):
                self.branch_reads = 0

            def api_json(self, path):
                if path == "/branches/test":
                    self.branch_reads += 1
                    if branch_override and self.branch_reads == 2:
                        return branch_override
                    return owner.branch
                if path.startswith("/actions/runs?"):
                    return {"workflow_runs": [owner.run]}
                if path.endswith("/artifacts?per_page=100"):
                    items = [owner.artifact]
                    if duplicate:
                        items.append(dict(owner.artifact))
                    return {"artifacts": items}
                raise AssertionError(path)

            def artifact_json(self, artifact_id):
                assert artifact_id == owner.artifact["id"]
                return owner.manifest

        return update_source.fetch_test_evidence(
            self.request_hash, contract.shape, Client()
        )

    def test_source_success(self):
        self.assertEqual(self.source(), self.manifest)

    def test_source_rejects_branch_move(self):
        import update_source
        with self.assertRaises(update_source.SourceError):
            self.source(branch_override={
                "protected": True,
                "commit": {"sha": "c" * 40},
            })

    def test_source_rejects_duplicate_artifacts(self):
        import update_source
        with self.assertRaises(update_source.SourceError):
            self.source(duplicate=True)

    def test_blob_redirect_host(self):
        import update_source
        good = "https://productionresultssa30.blob.core.windows.net/file"
        self.assertEqual(update_source.verify_blob_url(good), good)
        for bad in (
            "http://productionresultssa30.blob.core.windows.net/file",
            "https://productionresultssa30.blob.core.windows.net.evil.test/",
            "https://user@productionresultssa30.blob.core.windows.net/",
            "https://productionresultssa30.blob.core.windows.net:444/",
        ):
            with self.subTest(url=bad):
                with self.assertRaises(update_source.SourceError):
                    update_source.verify_blob_url(bad)


if __name__ == "__main__":
    unittest.main()
