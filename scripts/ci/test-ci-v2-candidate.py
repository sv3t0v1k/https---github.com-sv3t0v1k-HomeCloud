#!/usr/bin/env python3
"""Negative HEAD/base/run binding cases for the v2 candidate check."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
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
                              'coverage': 'COVERED', 'errors': [], 'qualification_profile': 'pull-request',
                              'ci': {'run_id': '10', 'attempt': '1'}}

    def check(self):
        return candidate.validate(self.event, self.live, self.head, self.qualification,
                                  '10', '1', self.base, 'pull-request')

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
                       {'ci': {'run_id': '10', 'attempt': '2'}}, {'status': 'BLOCKED'},
                       {'coverage': 'INCOMPLETE'}, {'qualification_profile': 'release'}):
            with self.subTest(change=change):
                proof = {**self.qualification, **change}
                with self.assertRaisesRegex(ValueError, 'qualification'):
                    candidate.validate(self.event, self.live, self.head, proof,
                                       '10', '1', self.base, 'pull-request')

    def test_missing_qualification_blocks(self):
        with self.assertRaisesRegex(ValueError, 'qualification'):
            candidate.validate(self.event, self.live, self.head, {},
                               '10', '1', self.base, 'pull-request')

    def test_wrong_expected_base_blocks(self):
        with self.assertRaisesRegex(ValueError, 'Expected base'):
            candidate.validate(self.event, self.live, self.head, self.qualification,
                               '10', '1', 'c'*40, 'pull-request')

    def test_stale_branch_is_rejected_by_real_git_ancestry(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], text=True,
                                               stderr=subprocess.DEVNULL).strip()
            git('init', '-q')
            git('config', 'user.name', 'CI Test')
            git('config', 'user.email', 'ci@example.invalid')
            (repo/'file').write_text('initial')
            git('add', 'file')
            git('commit', '-qm', 'начало')
            common = git('rev-parse', 'HEAD')
            branch = git('branch', '--show-current')
            git('checkout', '-qb', 'candidate')
            (repo/'file').write_text('candidate')
            git('commit', '-qam', 'кандидат')
            head = git('rev-parse', 'HEAD')
            git('checkout', '-q', branch)
            (repo/'file').write_text('new base')
            git('commit', '-qam', 'новая база')
            base = git('rev-parse', 'HEAD')
            candidate.require_base_ancestor(repo, common, head)
            with self.assertRaisesRegex(ValueError, 'not an ancestor'):
                candidate.require_base_ancestor(repo, base, head)


if __name__ == '__main__':
    unittest.main()
