#!/usr/bin/env python3
"""Regression checks for dynamic protected TEST discovery in the host drill."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/linux'))
sys.path.insert(0, str(ROOT / 'scripts/ci'))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


discovery = load('phase3_host_evidence', 'scripts/ci/phase3-host-evidence.py')
contract = load('phase3_test_contract', 'scripts/ci/test-channel.py')
source = load('phase3_update_source', 'deploy/linux/update_source.py')
evidence = load('phase3_update_evidence', 'deploy/linux/update_evidence.py')
MODULES = {'update_source': source, 'update_evidence': evidence,
           'test_contract': contract}


class Client:
    def __init__(self, commit, run_id, *, moved=False, protected=True, event='push'):
        self.commit, self.run_id = commit, run_id
        self.moved, self.protected, self.event = moved, protected, event
        self.branch_reads = 0
        repository = evidence.REPOSITORY
        proofs = {role: dict(index_digest='sha256:' + digit * 64,
                             platform_digest='sha256:' + ('3' if role == 'backend' else '4') * 64,
                             statement_digest='sha256:' + ('5' if role == 'backend' else '6') * 64,
                             commit=commit, repository='ghcr.io/' + repository + '/' + role,
                             version='test-' + commit, platform='linux/amd64',
                             verified='DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS',
                             signature='UNSIGNED')
                  for role, digit in (('backend', '1'), ('frontend', '2'))}
        self.manifest = contract.build(commit, repository, str(run_id), '1',
                                       {role: proof['index_digest'] for role, proof in proofs.items()},
                                       proofs)
        self.run = dict(id=run_id, run_attempt=1, event=event, head_branch='test',
                        head_sha=commit, path='.github/workflows/ci-v2-fast.yml',
                        status='completed', conclusion='success')
        self.artifact = dict(id=run_id + 100, expired=False, name='test-channel-1',
                             workflow_run=dict(id=run_id, head_sha=commit))

    def api_json(self, path):
        if path == '/branches/test':
            self.branch_reads += 1
            head = 'f' * 40 if self.moved and self.branch_reads == 3 else self.commit
            return dict(protected=self.protected, commit=dict(sha=head))
        if path.startswith('/actions/runs?'):
            assert 'head_sha=' + self.commit in path
            return {'workflow_runs': [self.run]}
        if path == f'/actions/runs/{self.run_id}/artifacts?per_page=100':
            return {'artifacts': [self.artifact]}
        raise AssertionError(path)

    def artifact_json(self, artifact_id):
        assert artifact_id == self.artifact['id']
        return self.manifest


class HostEvidenceTests(unittest.TestCase):
    def test_new_protected_head_selects_new_run_and_identity(self):
        first = Client('a' * 40, 101)
        second = Client('b' * 40, 102)
        for client in (first, second):
            self.assertEqual(discovery.fetch_current(MODULES, client), client.manifest)
            self.assertEqual(client.branch_reads, 3)
        self.assertNotEqual(first.manifest['manifest_sha256'],
                            second.manifest['manifest_sha256'])

    def test_unprotected_or_non_push_run_refused(self):
        for client in (Client('a' * 40, 101, protected=False),
                       Client('a' * 40, 101, event='pull_request')):
            with self.assertRaises(source.SourceError):
                discovery.fetch_current(MODULES, client)

    def test_branch_move_during_recheck_refused(self):
        with self.assertRaises(source.SourceError):
            discovery.fetch_current(MODULES, Client('a' * 40, 101, moved=True))

if __name__ == '__main__':
    unittest.main()
