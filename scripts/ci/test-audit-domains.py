#!/usr/bin/env python3
"""The split audit report must retain the existing full high/critical verdict."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit_domains", Path(__file__).with_name("audit-domains.py"))
domains = importlib.util.module_from_spec(spec)
spec.loader.exec_module(domains)


class AuditDomainsTests(unittest.TestCase):
    def counts(self, high=0, critical=0):
        return dict(info=0, low=0, moderate=0, high=high, critical=critical,
                    total=high + critical)

    def test_dev_findings_still_block(self):
        result = domains.summarize(self.counts(), self.counts(high=1))
        self.assertEqual(result["dev_additional"]["high"], 1)
        self.assertEqual(result["gate"], "BLOCKED")

    def test_runtime_findings_still_block(self):
        result = domains.summarize(self.counts(critical=1), self.counts(critical=1))
        self.assertEqual(result["runtime"]["critical"], 1)
        self.assertEqual(result["gate"], "BLOCKED")

    def test_inconsistent_reports_fail(self):
        with self.assertRaisesRegex(ValueError, "exceed"):
            domains.summarize(self.counts(high=1), self.counts())


if __name__ == "__main__":
    unittest.main()
