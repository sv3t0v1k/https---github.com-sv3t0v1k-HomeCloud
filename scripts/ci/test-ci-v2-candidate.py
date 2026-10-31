#!/usr/bin/env python3
"""Negative HEAD/base binding cases for the PR candidate check."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ci_v2_candidate', Path(__file__).with_name('ci-v2-candidate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.head, self.base = 'a'*40, 'b'*40
        self.event = {'pull_request': {'head': {'sha': self.head}, 'base': {'sha': self.base}}}
        self.live = {'head': {'sha': self.head}, 'base': {'sha': self.base}}

    def check(self):
        return candidate.validate(self.event, self.live, self.head)

    def test_unchanged_candidate_passes(self):
        self.assertEqual(self.check(), {'head_sha': self.head, 'base_sha': self.base})

    def test_changed_head_or_base_blocks(self):
        for field in ('head', 'base'):
            with self.subTest(field=field):
                self.live[field]['sha'] = 'c'*40
                with self.assertRaisesRegex(ValueError, 'changed'):
                    self.check()
                self.live[field]['sha'] = self.head if field == 'head' else self.base

    def test_checkout_mismatch_blocks(self):
        with self.assertRaisesRegex(ValueError, 'changed'):
            candidate.validate(self.event, self.live, 'c'*40)

    def test_test_push_requires_live_head(self):
        event = {'ref': 'refs/heads/test', 'after': self.head}
        live = {'commit': {'sha': self.head}}
        self.assertEqual(candidate.validate_push(event, live, self.head, 'test')['head_sha'], self.head)
        live['commit']['sha'] = 'c'*40
        with self.assertRaisesRegex(ValueError, 'changed'):
            candidate.validate_push(event, live, self.head, 'test')
        live['commit']['sha'] = self.head
        with self.assertRaisesRegex(ValueError, 'branch'):
            candidate.validate_push(event, live, self.head, 'main')


if __name__ == '__main__':
    unittest.main()
