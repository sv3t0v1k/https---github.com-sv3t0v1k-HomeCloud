#!/usr/bin/env python3
"""Regression checks for fail-closed root-side TEST build discovery."""
import re
from pathlib import Path
from types import SimpleNamespace
import runpy
import unittest

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[2] /
                            'deploy/linux/update-host-discover.py'))
HEAD = 'a' * 40
IDENTITY = 'b' * 64


class FakeClient:
    def __init__(self):
        self.branch = {'protected': True, 'commit': {'sha': HEAD}}
        self.runs = {'workflow_runs': [dict(id=12, run_attempt=1, head_sha=HEAD,
            head_branch='test', event='push', path='.github/workflows/ci-v2-fast.yml',
            status='completed', conclusion='success')]}
        self.artifacts = {'artifacts': [dict(id=34, name='test-channel-1', expired=False,
            workflow_run={'id': 12, 'head_sha': HEAD})]}
        self.raw = {'manifest_sha256': IDENTITY}

    def api_json(self, path):
        if path == '/branches/test': return self.branch
        if path.startswith('/actions/runs?'): return self.runs
        if path == '/actions/runs/12': return self.runs['workflow_runs'][0]
        if path == '/actions/runs/12/artifacts?per_page=100': return self.artifacts
        raise AssertionError(path)

    def artifact_json(self, artifact_id):
        if artifact_id != 34: raise AssertionError(artifact_id)
        return self.raw


class HostDiscovery(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        def require(value, reason):
            if not value: raise ValueError(reason)
        self.source = SimpleNamespace(SHA=re.compile(r'[a-f0-9]{40}\Z'),
            require=require, fetch_test_evidence=lambda identity, shape, client:
            {'commit': HEAD, 'manifest_sha256': identity})
        self.modules = {'update_source': self.source,
            'test_contract': SimpleNamespace(shape=lambda _: None),
            'update_evidence': SimpleNamespace(verify=lambda identity, *_:
                {'manifest_sha256': identity})}

    def test_selects_only_exact_protected_successful_pair(self):
        branch, head = MODULE['protected_head'](self.client, self.source)
        self.assertEqual(head, HEAD)
        result, run_id, attempt, artifact_id = MODULE['fetch_current'](
            self.modules, self.client, branch, head)
        self.assertEqual(result['manifest_sha256'], IDENTITY)
        self.assertEqual((run_id, attempt, artifact_id), (12, 1, 34))

    def test_refuses_unprotected_ambiguous_and_expired_evidence(self):
        self.client.branch['protected'] = False
        with self.assertRaises(ValueError):
            MODULE['protected_head'](self.client, self.source)
        self.client.branch['protected'] = True
        branch, head = MODULE['protected_head'](self.client, self.source)
        self.client.runs['workflow_runs'].append(dict(self.client.runs['workflow_runs'][0]))
        with self.assertRaises(ValueError):
            MODULE['fetch_current'](self.modules, self.client, branch, head)
        self.client.runs['workflow_runs'].pop()
        self.client.artifacts['artifacts'][0]['expired'] = True
        with self.assertRaises(ValueError):
            MODULE['fetch_current'](self.modules, self.client, branch, head)

    def test_fetches_only_protected_target_and_preserves_checkout(self):
        calls = []
        class Git:
            def __init__(self): self.checkout = HEAD
            def git(self, *args):
                calls.append(args)
                if args[0] == 'rev-parse': return HEAD.encode() + b'\n'
                if args[0] == 'cat-file': return b'commit\n'
                return b''
            def head(self): return self.checkout.encode()
        source = Git()
        MODULE['fetch_protected_target'](source, HEAD, HEAD)
        self.assertEqual(calls[0][-4:], ('fetch', '--no-tags', 'origin', 'test'))
        source.checkout = 'c' * 40
        with self.assertRaises(ValueError):
            MODULE['fetch_protected_target'](source, HEAD, HEAD)

    def test_cache_refresh_rechecks_run_artifact_and_registry(self):
        indexes = []
        self.modules['provenance'] = SimpleNamespace(Registry=lambda repository:
            SimpleNamespace(index=lambda digest: indexes.append((repository, digest))))
        value = {'runId': 12, 'attempt': 1, 'artifactId': 34,
                 'backendDigest': 'sha256:' + 'c' * 64,
                 'frontendDigest': 'sha256:' + 'd' * 64}
        MODULE['recheck_cache'](value, self.modules, self.client, HEAD)
        self.assertEqual(len(indexes), 2)
        self.client.runs['workflow_runs'][0]['run_attempt'] = 2
        with self.assertRaises(ValueError):
            MODULE['recheck_cache'](value, self.modules, self.client, HEAD)


if __name__ == '__main__':
    unittest.main()
