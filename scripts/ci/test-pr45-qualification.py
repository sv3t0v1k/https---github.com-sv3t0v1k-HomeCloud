#!/usr/bin/env python3
"""Fail-closed qualification report/cleanup contracts; Docker is not invoked."""
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


qualification = load("run-pr45-qualification-local")
routing = load("test-routing")
context = load("restore-e2e-context")


class QualificationTests(unittest.TestCase):
    def setUp(self):
        # Synthetic gate fixtures must not print fake qualification PASS/counts.
        redirected = redirect_stdout(io.StringIO())
        redirected.__enter__()
        self.addCleanup(redirected.__exit__, None, None, None)

    def report(self, profile, pg_assertions=20):
        results = []
        for name in routing.routes()[profile]:
            count = pg_assertions if name.endswith(".postgres.spec.ts") else 1
            results.append({"name": "/app/" + name, "status": "passed",
                            "assertionResults": [{"status": "passed"} for _ in range(count)]})
            if name == "bench/copy-file-runner.spec.ts":
                results[-1]["assertionResults"][0]["fullName"] = qualification.NATIVE_COPY_ASSERTION
        return {"success": True, "testResults": results}

    def test_unit_report_maps_paths_without_mutating_evidence(self):
        report = self.report("unit")
        original = copy.deepcopy(report)
        result = qualification.verify_jest("unit", report)
        self.assertEqual(report, original)
        self.assertEqual(result["suites"], len(routing.routes()["unit"]))
        self.assertEqual(result["skip"], 0)

    def test_real_postgres_route_requires_all_suites_and_minimum_assertions(self):
        result = qualification.verify_jest("integration", self.report("integration"))
        self.assertGreaterEqual(result["postgres_assertions"], 318)
        self.assertGreater(result["postgres_suites"], 0)

    def test_skipped_assertion_is_never_qualified(self):
        report = self.report("integration")
        report["testResults"][0]["assertionResults"][0]["status"] = "pending"
        with self.assertRaisesRegex(ValueError, "skipped"):
            qualification.verify_jest("integration", report)

    def test_missing_suite_or_duplicate_is_refused(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                report = self.report("integration")
                if duplicate:
                    report["testResults"].append(copy.deepcopy(report["testResults"][0]))
                else:
                    report["testResults"].pop()
                with self.assertRaises(ValueError):
                    qualification.verify_jest("integration", report)

    def test_too_few_postgres_assertions_is_not_pass(self):
        with self.assertRaisesRegex(ValueError, "318"):
            qualification.verify_jest("integration", self.report("integration", pg_assertions=1))

    def test_actual_historical_split317_pg_plus_native_benchmark_is318(self):
        report = self.report("integration", pg_assertions=1)
        pg = [item for item in report["testResults"] if item["name"].endswith(".postgres.spec.ts")]
        pg[0]["assertionResults"] = [{"status": "passed"} for _ in range(317 - len(pg) + 1)]
        result = qualification.verify_jest("integration", report)
        self.assertEqual(result["postgres_assertions"], 317)
        self.assertEqual(result["previously_skipped_assertions"], 318)

    def test_pg_success_does_not_substitute_for_missing_native_benchmark(self):
        report = self.report("integration")
        bench = next(item for item in report["testResults"] if item["name"].endswith("bench/copy-file-runner.spec.ts"))
        bench["assertionResults"][0]["fullName"] = "unrelated passed benchmark"
        with self.assertRaisesRegex(ValueError, "native secure-copy"):
            qualification.verify_jest("integration", report)

    def test_unexpected_and_traversal_paths_are_refused(self):
        for name in ("/elsewhere/test.ts", "/app/../src/test.ts", "src/test.ts"):
            with self.subTest(name=name):
                report = self.report("unit")
                report["testResults"][0]["name"] = name
                with self.assertRaises(ValueError):
                    qualification.verify_jest("unit", report)

    def test_failed_or_empty_report_cannot_pass(self):
        for report in ({"success": False}, {"success": True, "testResults": []}):
            with self.assertRaises(ValueError):
                qualification.verify_jest("unit", report)

    def fake_runner(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        runner = qualification.Qualification.__new__(qualification.Qualification)
        runner.output = Path(temporary.name)
        runner.containers = ["owned-disposable-id"]
        runner.network = "owned-disposable-network"
        runner.report = {"checks": [{"name": name, "status": "PASS"} for name in qualification.STAGES], "source": {"snapshot": "same"}}
        return runner

    def test_cleanup_targets_only_owned_resources(self):
        runner = self.fake_runner()
        calls = []
        runner.command = lambda args, **kwargs: calls.append(args)
        with patch.object(qualification, "checkpoint", return_value=runner.report["source"]):
            runner.finish()
        self.assertEqual(calls, [["docker", "rm", "-f", "-v", "owned-disposable-id"],
                                 ["docker", "network", "rm", "owned-disposable-network"]])
        self.assertTrue(runner.report["complete"])

    def test_cleanup_failure_cannot_report_pass(self):
        runner = self.fake_runner()
        def failure(*args, **kwargs):
            raise RuntimeError("cleanup refused")
        runner.command = failure
        with patch.object(qualification, "checkpoint", return_value=runner.report["source"]):
            runner.finish()
        self.assertFalse(runner.report["complete"])
        self.assertEqual(len(runner.report["cleanup_errors"]), 2)

    def test_targeted_success_is_not_full_qualification(self):
        runner = self.fake_runner()
        runner.report.update(scope="scheduled-http-encrypted", checks=[{"name": "scheduled-http-encrypted", "status": "PASS"}])
        runner.command = lambda *args, **kwargs: None
        with patch.object(qualification, "checkpoint", return_value=runner.report["source"]):
            runner.finish()
        self.assertTrue(runner.report["scope_complete"])
        self.assertFalse(runner.report["complete"])

    def test_targeted_prepare_does_not_rebuild_backend_or_create_postgres(self):
        runner = self.fake_runner()
        calls = []
        runner.command = lambda args, **kwargs: calls.append(args) or '{}'
        with patch.object(runner, "prepare_tooling") as tooling:
            runner.prepare(scheduled_only=True)
        tooling.assert_called_once_with()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ["docker", "info"])
        self.assertFalse(hasattr(runner, "builder"))

    def test_runtime_architecture_cannot_borrow_image_metadata(self):
        runner = self.fake_runner()
        runner.platform = "linux/arm64"
        for result in ({"os": "linux", "arch": "x64", "nativeAddonLoaded": True},
                       {"os": "linux", "arch": "arm64", "nativeAddonLoaded": False}):
            runner.command = lambda *args, **kwargs: json.dumps(result)
            with patch.object(runner, "image", return_value="retained-id"):
                with self.assertRaisesRegex(ValueError, "Runtime executable"):
                    runner.node_image("retained-id")
        runner.command = lambda *args, **kwargs: json.dumps({"os": "linux", "arch": "arm64", "nativeAddonLoaded": True, "nativeBoundaryOperational": True})
        with patch.object(runner, "image", return_value="retained-id"):
            self.assertEqual(runner.node_image("retained-id"), "retained-id")

    def test_loaded_addon_with_failed_or_missing_operations_never_passes(self):
        runner = self.fake_runner()
        runner.platform = "linux/amd64"
        for operational in (None, False):
            result = {"os": "linux", "arch": "x64", "nativeAddonLoaded": True,
                      "error": {"code": "ENOSYS"}, "openat2": {"minimal_errno": 38}}
            if operational is not None:
                result["nativeBoundaryOperational"] = operational
            runner.command = lambda *args, **kwargs: json.dumps(result)
            with patch.object(runner, "image", return_value="retained-id"):
                with self.assertRaisesRegex(ValueError, "Native storage boundary unavailable"):
                    runner.node_image("retained-id")
            self.assertEqual(runner.report["execution_probes"]["retained-id"], result)

    def test_product_probes_refuse_source_changes_but_allow_harness_updates(self):
        previous = {"branch": "same", "head": "same", "code_manifest": [
            {"path": "backend/native/secure-fs.c", "sha256": "same"},
            {"path": "scripts/ci/harness.py", "sha256": "old"}]}
        current = copy.deepcopy(previous)
        current["code_manifest"][1]["sha256"] = "new"
        qualification.same_product_source(previous, current)
        current["code_manifest"][0]["sha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "backend source"):
            qualification.same_product_source(previous, current)
        current = copy.deepcopy(previous)
        current["head"] = "changed"
        with self.assertRaisesRegex(ValueError, "head"):
            qualification.same_product_source(previous, current)

    def test_tooling_uses_pinned_base_platform_independent_of_product(self):
        runner = self.fake_runner()
        runner.platform = "linux/arm64"
        runner.tools = "retained-tool-id"
        calls = []
        runner.command = lambda args, **kwargs: calls.append(args)
        runner.tooling(["-ec", "true"])
        self.assertEqual(calls[0][calls[0].index("--platform") + 1], "linux/amd64")
        self.assertNotIn("--privileged", calls[0])

    def product_probe_fixture(self):
        runner = self.fake_runner()
        runner.platform = "linux/arm64"
        runner.report["source"] = {"branch": "same", "head": "same", "code_snapshot_sha256": "fixture",
                                   "code_manifest": [{"path": "backend/native/secure-fs.c", "sha256": "same"}]}
        (runner.output / "qualification.json").write_text(json.dumps({"source": runner.report["source"], "platform": runner.platform}))
        for name, digit in (("builder", "a"), ("runner", "b"), ("tooling", "c")):
            (runner.output / (name + "-image.id")).write_text("sha256:" + digit * 64)
        return runner

    def test_obsolete_tool_image_is_not_a_product_architecture_prerequisite(self):
        runner = self.product_probe_fixture()
        calls = []
        def native(reference):
            calls.append(reference)
            runner.report.setdefault("execution_probes", {})[reference] = {"os": "linux", "arch": "arm64", "nativeAddonLoaded": True}
            return reference
        with patch.object(runner, "node_image", side_effect=native), patch.object(runner, "image", side_effect=RuntimeError("obsolete image absent")):
            result = runner.probe_existing([runner.output])
        self.assertEqual(calls, ["sha256:" + "a" * 64, "sha256:" + "b" * 64])
        self.assertEqual({item["role"] for item in result["images"]}, {"builder", "runner"})

    def test_both_product_roles_remain_required_for_architecture_evidence(self):
        runner = self.product_probe_fixture()
        (runner.output / "runner-image.id").unlink()
        reference = "sha256:" + "a" * 64
        runner.report["execution_probes"] = {reference: {"os": "linux", "arch": "arm64", "nativeAddonLoaded": True}}
        with patch.object(runner, "node_image", return_value=reference):
            with self.assertRaisesRegex(ValueError, "builder/runner probes missing"):
                runner.probe_existing([runner.output])

    def test_unknown_scope_never_passes(self):
        runner = self.fake_runner()
        runner.report.update(scope="unknown", checks=[])
        runner.command = lambda *args, **kwargs: None
        with patch.object(qualification, "checkpoint", return_value=runner.report["source"]):
            runner.finish()
        self.assertFalse(runner.report["scope_complete"])
        self.assertFalse(runner.report["complete"])

    def test_source_change_retains_reports_and_refuses_qualification(self):
        runner = self.fake_runner()
        runner.command = lambda *args, **kwargs: None
        with patch.object(qualification, "checkpoint", side_effect=ValueError("source changed")):
            runner.finish()
        report = json.loads((runner.output / "qualification.json").read_text())
        self.assertFalse(report["complete"])
        self.assertTrue(report["source_changed_during_run"])

    def test_context_extra_paths_cannot_escape_repository(self):
        for path in ("../private.key", "/etc/passwd"):
            with self.assertRaisesRegex(ValueError, "relative"):
                context.write_context(io.BytesIO(), ROOT, extra_paths=[path])

    def test_real_tooling_context_is_allowlisted_with_linux_metadata(self):
        extra = [path.relative_to(ROOT) for folder in ("scripts/ci", "scripts/tests")
                 for path in (ROOT / folder).iterdir() if path.suffix in (".py", ".sh", ".sql")]
        extra += [path.relative_to(ROOT) for path in (ROOT / "ops/systemd").iterdir()
                  if path.suffix in (".service", ".timer")]
        output = io.BytesIO()
        dockerfile = (ROOT / "scripts/ci/pr45-qualification-tools.Dockerfile").read_bytes()
        context.write_context(output, ROOT, extra_paths=extra, dockerfile=dockerfile)
        output.seek(0)
        with tarfile.open(fileobj=output) as archive:
            names = archive.getnames()
            for name in ("scripts/tests/test-backup-production.sh", "scripts/tests/create_fixtures.py",
                         "scripts/tests/test-scheduled-operations.py", "scripts/ci/test-restore-storage-linux.py"):
                self.assertIn(name, names)
            for job in ("backup", "cert-check", "cert-renew", "freshness"):
                for extension in ("service", "timer"):
                    self.assertIn("ops/systemd/homecloud-" + job + "." + extension, names)
            self.assertEqual(archive.extractfile("Dockerfile").read(), dockerfile)
            for item in archive:
                self.assertEqual((item.uid, item.gid), (0, 0))
                self.assertEqual(item.mode & 0o022, 0)
                self.assertTrue(item.isfile() or item.isdir())
                self.assertFalse(set(Path(item.name).parts) & {".git", "node_modules", ".env"})


if __name__ == "__main__":
    unittest.main()
