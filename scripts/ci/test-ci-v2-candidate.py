#!/usr/bin/env python3
"""Negative HEAD/base/run binding cases for the v2 candidate check."""
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
        self.qualification = {'source_commit': self.head, 'status': 'PASS',
                              'coverage': 'COVERED', 'errors': [],
                              'ci': {'run_id': '10', 'attempt': '1'}}

    def check(self):
        return candidate.validate(self.event, self.live, self.head, self.qualification, '10', '1')

    def test_unchanged_candidate_passes(self):
        self.assertEqual(self.check(), {'head_sha': self.head, 'base_sha': self.base})

    def test_changed_head_or_base_blocks(self):
        for field in ('head', 'base'):
            with self.subTest(field=field):
                self.live[field]['sha'] = 'c'*40
                with self.assertRaisesRegex(ValueError, 'changed'):
                    self.check()
                self.live[field]['sha'] = self.head if field == 'head' else self.base

    def test_stale_source_or_wrong_run_blocks(self):
        for change in ({'source_commit': 'c'*40}, {'ci': {'run_id': '9', 'attempt': '1'}},
                       {'status': 'BLOCKED'}, {'coverage': 'INCOMPLETE'}):
            with self.subTest(change=change):
                proof = {**self.qualification, **change}
                with self.assertRaisesRegex(ValueError, 'qualification'):
                    candidate.validate(self.event, self.live, self.head, proof, '10', '1')

    def test_missing_qualification_blocks(self):
        with self.assertRaisesRegex(ValueError, 'qualification'):
            candidate.validate(self.event, self.live, self.head, {}, '10', '1')


if __name__ == '__main__':
    unittest.main()
