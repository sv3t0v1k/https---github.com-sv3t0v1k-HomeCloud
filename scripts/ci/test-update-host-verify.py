#!/usr/bin/env python3
"""Adversarial host verifier checks; no live services or registry."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('host_verify', ROOT / 'deploy/linux/update-host-verify.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
modules = host.load_helpers(ROOT)
contract = modules['test_contract']


class Tests(unittest.TestCase):
    def setUp(self):
        self.source = host.GitSource(ROOT, modules['boundary'].clean_environment())
        commit = self.source.head().decode()
        read, entries = self.source.reader(commit)
        migrations = []
        for path in sorted(p for p in entries if p.startswith('backend/src/migrations/')):
            raw = read(path)
            migrations.append(dict(name=host.re.findall(r'export class ([A-Za-z0-9]+)', raw.decode())[0],
                                   file=Path(path).name, sha256=hashlib.sha256(raw).hexdigest()))
        def image(role):
            return dict(repository='ghcr.io/' + modules['update_evidence'].REPOSITORY + '/' + role,
                        digest='sha256:'+'1'*64, platform_digest='sha256:'+'2'*64,
                        statement_digest='sha256:'+'3'*64, revision=commit, version='test-'+commit)
        self.manifest = dict(format=contract.FORMAT, repository=modules['update_evidence'].REPOSITORY,
                             commit=commit, platform='linux/amd64',
                             images={role:image(role) for role in ('backend','frontend')},
                             schema_migrations=migrations,
                             source_files={p:hashlib.sha256(read(p)).hexdigest() for p in contract.FILES},
                             ci=dict(run_id='123', attempt='1', workflow='ci-v2-fast.yml'))
        self.rehash()
        self.branch = dict(protected=True, commit=dict(sha=commit))
        self.run = dict(id=123,run_attempt=1,event='push',head_branch='test',head_sha=commit,
                        path='.github/workflows/ci-v2-fast.yml',status='completed',conclusion='success')
        self.artifact = dict(id=42, expired=False, name='test-channel-1',
                             workflow_run=dict(id=123, head_sha=commit))
        self.reads = 0
        self.proofs = []

    def rehash(self):
        self.manifest['manifest_sha256'] = contract.identity(self.manifest)
        self.request = json.dumps(dict(format='homecloud-update-request-v1',channel='test',
                                      manifestSha256=self.manifest['manifest_sha256'])).encode()

    def api_json(self, path):
        if path == '/branches/test':
            self.reads += 1
            return self.branch
        if path.startswith('/actions/runs?'): return dict(workflow_runs=[self.run])
        return dict(artifacts=[self.artifact])

    def artifact_json(self, identifier):
        self.assertEqual(identifier,42)
        return copy.deepcopy(self.manifest)

    def proof(self, store, digest, role, commit, repo, version, source_reader):
        self.assertEqual(source_reader(role+'/Dockerfile'), self.source.reader(commit)[0](role+'/Dockerfile'))
        self.proofs.append(role)
        return dict(index_digest=digest,platform_digest='sha256:'+'2'*64,statement_digest='sha256:'+'3'*64)

    def check(self, trust=lambda:None):
        with patch.object(modules['provenance'],'verify',side_effect=self.proof):
            return host.verify_request(self.request,modules,self,self.source,trust)

    def test_success_checks_both_images_and_final_remote_head(self):
        self.assertEqual(self.check()['status'],'HOST_VERIFIED_READ_ONLY')
        self.assertEqual(self.proofs,['backend','frontend'])
        self.assertEqual(self.reads,4)

    def test_exact_request(self):
        for change in (dict(channel='release'),dict(extra=True),dict(manifestSha256='0'*64)):
            raw=json.loads(self.request); raw.update(change)
            self.request=json.dumps(raw).encode()
            with self.assertRaises(Exception): self.check()

    def test_changed_target_helper_requires_separate_qualification(self):
        original=self.source.reader
        def changed(commit):
            read,entries=original(commit)
            def replacement(path):
                return b'changed helper' if path=='deploy/linux/root-boundary.py' else read(path)
            return replacement,entries
        self.manifest['source_files']['deploy/linux/root-boundary.py']=hashlib.sha256(b'changed helper').hexdigest()
        self.rehash()
        with patch.object(self.source,'reader',side_effect=changed), self.assertRaisesRegex(ValueError,'qualification'):
            self.check()

    def test_added_target_helper_module_requires_qualification(self):
        original=self.source.git
        def changed(*args):
            if args[0]=='rev-parse' and args[-1].endswith(':deploy'):
                changed.calls+=1
                return b'first' if changed.calls==1 else b'second'
            return original(*args)
        changed.calls=0
        with patch.object(self.source,'git',side_effect=changed), self.assertRaisesRegex(ValueError,'helper tree changed'):
            self.check()


    def test_ci_only_script_changes_and_helpers(self):
        original = self.source.git

        for path, permitted in (
            ('scripts/ci/stage-cache-proof.py', True),
            ('scripts/ci/test-update-host-verify.py', True),
            ('scripts/ci/provenance.py', False),
            ('scripts/ci/test-channel.py', False),
            ('scripts/backup.sh', False),
            ('scripts/unexpected-helper.py', False),
        ):
            def fake_git(*args):
                if args[0] == 'diff-tree':
                    return path.encode() + bytes([0])
                return original(*args)

            with self.subTest(path=path):
                with patch.object(
                    self.source, 'git', side_effect=fake_git
                ):
                    if permitted:
                        self.assertEqual(
                            self.check()['status'],
                            'HOST_VERIFIED_READ_ONLY'
                        )
                    else:
                        with self.assertRaisesRegex(
                            ValueError, 'root helper tree changed'
                        ):
                            self.check()

    def test_ci_only_symlink_is_rejected(self):
        original_git = self.source.git
        original_reader = self.source.reader
        path = 'scripts/ci/stage-cache-proof.py'

        def fake_git(*args):
            if args[0] == 'diff-tree':
                return path.encode() + bytes([0])
            return original_git(*args)

        def fake_reader(commit):
            read, entries = original_reader(commit)
            entries = dict(entries)
            entry = list(entries[path])
            entry[0] = b'120000'
            entries[path] = entry
            return read, entries

        with patch.object(self.source, 'git',
                          side_effect=fake_git):
            with patch.object(self.source, 'reader',
                              side_effect=fake_reader):
                with self.assertRaisesRegex(
                    ValueError, 'unsafe CI-only Git object'
                ):
                    self.check()

    def test_manifest_substitution(self):
        self.manifest['ci']['attempt']='2'
        with self.assertRaises(ValueError): self.check()

    def test_source_and_migration_substitution_with_fresh_identity(self):
        original=copy.deepcopy(self.manifest)
        for field in ('source_files','schema_migrations'):
            self.manifest=copy.deepcopy(original)
            if field=='source_files': self.manifest[field]['backend/Dockerfile']='0'*64
            else: self.manifest[field][0]['sha256']='0'*64
            self.rehash()
            with self.assertRaisesRegex(ValueError,'target'): self.check()

    def test_digest_and_provenance_binding_substitution(self):
        for field in ('digest','platform_digest','statement_digest'):
            old=self.manifest['images']['frontend'][field]
            self.manifest['images']['frontend'][field]='sha256:'+'0'*64
            self.rehash()
            if field=='digest':
                def reject(*args,**kwargs): raise ValueError('registry content digest mismatch')
                with patch.object(self,'proof',side_effect=reject), self.assertRaises(ValueError): self.check()
            else:
                with self.assertRaisesRegex(ValueError,'binding'): self.check()
            self.manifest['images']['frontend'][field]=old

    def test_final_remote_head_move(self):
        original=self.proof
        def move(*args,**kwargs):
            result=original(*args,**kwargs)
            self.branch['commit']['sha']='0'*40
            return result
        with patch.object(self,'proof',side_effect=move), self.assertRaises(ValueError): self.check()

    def test_final_local_head_move(self):
        original=self.source.head()
        with patch.object(self.source,'head',side_effect=[original,original,b'changed']), self.assertRaisesRegex(ValueError,'HEAD changed'):
            self.check()

    def test_trust_rechecked_at_end(self):
        calls=[]
        def trust():
            calls.append(1)
            if len(calls)==2: raise ValueError('helper changed')
        with self.assertRaisesRegex(ValueError,'helper changed'): self.check(trust)
        self.assertEqual(len(calls),2)

    def test_no_network_fails_closed(self):
        with patch.object(self,'api_json',side_effect=OSError('offline')), self.assertRaises(OSError): self.check()

    def test_missing_target_object(self):
        self.manifest['commit']='0'*40
        with self.assertRaises(subprocess.SubprocessError): self.source.reader('0'*40)

    def test_git_reader_ignores_checkout_and_replacement_environment(self):
        read,_=self.source.reader(self.manifest['commit'])
        with patch.object(Path,'read_bytes',side_effect=AssertionError('checkout read')):
            self.assertTrue(read('backend/Dockerfile'))
        self.assertEqual(self.source.environment['GIT_NO_REPLACE_OBJECTS'],'1')
        self.assertNotIn('PYTHONPATH',self.source.environment)

    def test_helper_changes_fail_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for path,_ in host.QUALIFIED.values():
                dest=root/path; dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes((ROOT/path).read_bytes())
            (root/'deploy/linux/update_evidence.py').write_text('raise AssertionError("EXECUTED")')
            with self.assertRaisesRegex(ValueError,'unqualified host helper'): host.load_helpers(root)

    def test_untracked_shadow_module_never_loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for path,_ in host.QUALIFIED.values():
                dest=root/path; dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes((ROOT/path).read_bytes())
            (root/'deploy/linux/json.py').write_text('raise AssertionError("EXECUTED")')
            before=list(sys.path)
            loaded=host.load_helpers(root)
            self.assertEqual(sys.path,before)
            self.assertEqual(loaded['update_source'].verify.__code__.co_filename,
                             str(root/'deploy/linux/update_evidence.py'))

    def test_cli_failure_never_leaks_token(self):
        result=subprocess.run([sys.executable,'-I','-S',str(ROOT/'deploy/linux/update-host-verify.py')],
                              env={'GH_TOKEN':'sensitive-fixture'},capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('sensitive-fixture',result.stdout+result.stderr)
        self.assertNotIn('Traceback',result.stderr)


if __name__=='__main__': unittest.main()
