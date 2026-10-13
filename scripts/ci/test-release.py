#!/usr/bin/env python3
"""Negative tests for release identity, dirty source and audit fail-closed policy."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('release', 'release.py')
a = load('audit', 'audit-gate.py')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        original = r.ROOT
        r.ROOT = self.root
        self.addCleanup(setattr, r, 'ROOT', original)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.root/'fixture').write_text('source')
        self.git('add', 'fixture')
        self.git('commit', '-qm', 'Тестовый исходник')
        self.commit = self.git('rev-parse', 'HEAD')
        self.git('tag', '-a', 'v0.9.1-beta.1', '-m', 'Тестовая аннотация')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True).strip()

    def test_approved_annotated_tag(self):
        r.verify_tag('v0.9.1-beta.1', self.commit)

    def test_lightweight_tag_blocked(self):
        self.git('tag', 'v0.9.1-beta.2')
        with self.assertRaises(ValueError):
            r.verify_tag('v0.9.1-beta.2', self.commit)

    def test_wrong_commit_blocked(self):
        with self.assertRaises(ValueError):
            r.verify_tag('v0.9.1-beta.1', 'a'*40)

    def test_dirty_checkout_blocked(self):
        (self.root/'fixture').write_text('changed')
        with self.assertRaises(ValueError):
            r.verify_tag('v0.9.1-beta.1', self.commit)

    def test_invalid_semver_and_shell_input_blocked(self):
        for tag in ('v1.0.0', 'v0.09.1-beta.1', 'v0.9.1-beta.0', 'v0.9.1-beta.1;false'):
            with self.assertRaises(ValueError):
                r.verify_tag(tag, self.commit)

    def manifest(self):
        value = dict(format='homecloud-ci-candidate-v1', repository='owner/homecloud',
                     tag='v0.9.1-beta.1', tag_object='c'*40, commit=self.commit,
                     ci=dict(status='success', run_id='1', attempt='1', url='https://github.com/owner/homecloud/actions/runs/1'),
                     schema_migrations=['Migration520'],
                     source_files={**{name:'b'*64 for name in r.SOURCE_PATHS}, 'backend/src/migrations/520-Fixture.ts':'b'*64},
                     base_images={role:'docker.io/library/'+role+':fixture@sha256:'+'a'*64 for role in ('node','nginx','postgres')},
                     deployment_status='NOT_DEPLOYED', images={role:dict(repository='ghcr.io/owner/homecloud/'+role,
                     digest='sha256:'+'a'*64, revision=self.commit, version='v0.9.1-beta.1', platform='linux/amd64')
                     for role in ('backend', 'frontend')})
        value['manifest_sha256'] = r.identity(value)
        return value

    def test_valid_candidate(self):
        r.shape(self.manifest())

    def test_broken_identity(self):
        value = self.manifest()
        value['tag'] = 'v0.9.1-beta.2'
        with self.assertRaises(ValueError):
            r.shape(value)

    def test_digest_pair_platform_ci_fail_closed(self):
        original = self.manifest()
        mutations = [lambda x:x['images'].pop('frontend'),
                     lambda x:x['images']['backend'].update(digest='latest'),
                     lambda x:x['images']['backend'].update(revision='b'*40),
                     lambda x:x['images']['frontend'].update(platform='linux/arm64'),
                     lambda x:x['ci'].update(status='skipped'),
                     lambda x:x.update(deployment_status='DEPLOYED'),
                     lambda x:x['base_images'].update(node='node:latest'),
                     lambda x:x['source_files'].pop('scripts/ci/images.lock.json'),
                     lambda x:x.pop('tag_object')]
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            value['manifest_sha256'] = r.identity(value)
            with self.assertRaises((ValueError, KeyError)):
                r.shape(value)

    def test_unknown_not_green(self):
        args = type('Args', (), dict(github_sha=self.commit, manifest=None, deployment=None))()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.reconcile(args), 2)

    def test_missing_digests_and_schema_drift(self):
        manifest = self.root/'manifest.json'
        manifest.write_text(json.dumps(self.manifest()))
        deployment = self.root/'deployment.json'
        deployment.write_text(json.dumps(dict(source_revision=self.commit, observed_at='2026-10-13', evidence='fixture', images={}, applied_migrations=['Wrong'])))
        args = type('Args', (), dict(github_sha=self.commit, manifest=str(manifest), deployment=str(deployment)))()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(r.reconcile(args), 2)
        self.assertIn('Deployment digests missing or differ', output.getvalue())
        self.assertIn('Applied migrations / release schema differs', output.getvalue())

    def test_registry_verification_rejects_bad_labels_or_platform(self):
        args = type('Args', (), dict(tag='v0.9.1-beta.1', commit=self.commit, repository='owner/homecloud',
                    backend='sha256:'+'a'*64, frontend='sha256:'+'b'*64, run_id='1', attempt='1', output=str(self.root/'lock.json')))()
        for error in ('revision', 'platform', 'digest', 'pair', 'role'):
            def inspect(*command):
                if command[:3] != ('docker', 'image', 'inspect'):
                    return r.git(*command[1:])
                ref = command[-1]
                role = ref.split('/')[-1].split('@')[0]
                labels = {'org.opencontainers.image.revision':self.commit, 'org.opencontainers.image.version':args.tag,
                          'org.opencontainers.image.source':'https://github.com/owner/homecloud',
                          'io.homecloud.role':role, 'io.homecloud.pair':self.commit}
                image = dict(RepoDigests=[ref], Os='linux', Architecture='amd64', Config=dict(Labels=labels))
                if error == 'platform': image['Architecture']='arm64'
                if error == 'digest': image['RepoDigests']=[]
                if error == 'revision': labels['org.opencontainers.image.revision']='b'*40
                if error == 'pair': labels['io.homecloud.pair']='c'*40
                if error == 'role': labels['io.homecloud.role']='wrong'
                return json.dumps([image])
            with patch.object(r, 'verify_tag'), patch.object(r, 'run', side_effect=inspect), patch.object(r.subprocess, 'run'):
                with self.assertRaises(ValueError):
                    r.create(args)

    def test_mac_root_selects_actual_checkout(self):
        args = type('Args', (), dict(github_sha=self.commit, manifest=None, deployment=None, mac_root=str(self.root)))()
        original = r.ROOT
        r.ROOT = self.root/'not-a-repository'
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                self.assertEqual(r.reconcile(args), 2)
        finally:
            r.ROOT = original
        result = json.loads(output.getvalue())
        self.assertEqual(result['mac_commit'], self.commit)
        self.assertEqual(result['mac_root'], str(self.root.resolve()))

    def test_nested_mac_root_blocked(self):
        nested = self.root/'nested'
        nested.mkdir()
        args = type('Args', (), dict(github_sha=self.commit, manifest=None, deployment=None, mac_root=str(nested)))()
        with self.assertRaisesRegex(ValueError, 'checkout root'):
            r.reconcile(args)

    def test_unfounded_snapshot_blocked(self):
        deployment = self.root/'deployment.json'
        args = type('Args', (), dict(github_sha=self.commit, manifest=None, deployment=str(deployment)))()
        for evidence, observed in [('', '2026-10-13'), ('   ', '2026-10-13'), ('fixture', ''),
                                   ('fixture', '2026-02-30'), ('fixture', '2026-10-13T12:00:00')]:
            deployment.write_text(json.dumps(dict(source_revision=self.commit, evidence=evidence, observed_at=observed)))
            with self.assertRaises(ValueError):
                r.reconcile(args)


class AuditTests(unittest.TestCase):
    def report(self, **updates):
        counts = dict(info=0, low=0, moderate=0, high=0, critical=0, total=0)
        counts.update(updates)
        return dict(metadata=dict(vulnerabilities=counts))

    def test_high_critical_block_and_moderate_visible(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(a.check(self.report(high=1, total=1)))
            self.assertFalse(a.check(self.report(critical=1, total=1)))
            self.assertTrue(a.check(self.report(moderate=1, total=1)))

    def test_invalid_response_blocked(self):
        for report in (self.report(total=1), self.report(high=-1, total=-1), dict(error='offline', **self.report())):
            with self.assertRaises(ValueError):
                a.check(report)


if __name__ == '__main__':
    unittest.main()
