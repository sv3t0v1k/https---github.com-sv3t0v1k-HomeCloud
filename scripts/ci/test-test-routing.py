#!/usr/bin/env python3
"""Prevent missing, duplicated and skipped Jest suites in either CI route."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("test_routing", Path(__file__).with_name("test-routing.py"))
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)


class RouteTests(unittest.TestCase):
    def report(self, profile):
        base = routing.FRONTEND if profile == "frontend" else routing.BACKEND
        return {"success": True, "testResults": [
            {"name": str(base / path), "status": "passed",
             "assertionResults": [{"status": "passed"}]}
            for path in routing.routes()[profile]]}

    def test_every_suite_is_in_one_route_and_critical_suites_exist(self):
        routes = routing.routes()
        self.assertFalse(set(routes["unit"]) & set(routes["integration"]))
        self.assertTrue(routing.CRITICAL <= set(routes["unit"] + routes["integration"]))

    def test_complete_results_pass(self):
        for profile in ("unit", "integration", "frontend"):
            with self.subTest(profile=profile):
                routing.verify(profile, self.report(profile))

    def test_missing_suite_fails(self):
        report = self.report("integration")
        report["testResults"].pop()
        with self.assertRaisesRegex(ValueError, "Suite mismatch"):
            routing.verify("integration", report)

    def test_skipped_assertion_fails(self):
        report = self.report("unit")
        report["testResults"][0]["assertionResults"][0]["status"] = "pending"
        with self.assertRaisesRegex(ValueError, "skipped"):
            routing.verify("unit", report)

    def test_duplicate_suite_fails(self):
        report = self.report("unit")
        report["testResults"].append(report["testResults"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            routing.verify("unit", report)


if __name__ == "__main__":
    unittest.main()
