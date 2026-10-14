#!/usr/bin/env python3
"""Adversarial provenance fixtures; no Docker, registry or project Git refs."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).parent))
pair_spec = importlib.util.spec_from_file_location('provenance_pair', Path(__file__).with_name('provenance-pair.py'))
pair_module = importlib.util.module_from_spec(pair_spec)
pair_spec.loader.exec_module(pair_module)

spec = importlib.util.spec_from_file_location('provenance', Path(__file__).with_name('provenance.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Memory:
    def __init__(self, index, blobs):
        self.value, self.blobs = index, blobs

    def index(self, expected):
        p.require(expected == p.digest(self.value), 'index checksum mismatch')
        return json.loads(self.value)

    def get(self, descriptor, manifest=False):
        return p.checked(self.blobs[descriptor['digest']], descriptor)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        old = p.ROOT
        p.ROOT = Path(self.temp.name)
        self.addCleanup(setattr, p, 'ROOT', old)
        for component in ('backend', 'frontend'):
            (p.ROOT/component).mkdir()
            (p.ROOT/component/'Dockerfile').write_text('FROM pinned\n')
        (p.ROOT/'scripts/ci').mkdir(parents=True)
        lock = {role: 'docker.io/library/'+role+':fixture@sha256:'+'a'*64 for role in ('node','nginx','postgres')}
        (p.ROOT/'scripts/ci/images.lock.json').write_text(json.dumps(lock))
        (p.ROOT/'scripts/ci/images.platforms.json').write_text(json.dumps({role:dict(index_digest='sha256:'+'a'*64,amd64_digest='sha256:'+'b'*64) for role in lock}))
        self.commit = 'c'*40
        self.labels = {'org.opencontainers.image.revision':self.commit,
                       'org.opencontainers.image.source':'https://github.com/owner/homecloud',
                       'org.opencontainers.image.version':'dry-run',
                       'io.homecloud.role':'backend', 'io.homecloud.pair':self.commit}
        self.predicate = {'buildType':p.BUILDKIT, 'buildConfig':{'llbDefinition':[{'id':'fixture'}]},
            'invocation':{'parameters':{'args':{'build-arg:NODE_IMAGE':lock['node']}}},
            'materials':[{'uri':'pkg:docker/node@fixture?platform=linux%2Famd64','digest':{'sha256':'b'*64}}],
            'metadata':{p.BUILDKIT+'#metadata':{'vcs':{'source':'https://github.com/owner/homecloud.git','revision':self.commit},
                       'source':{'infos':[{'filename':'Dockerfile','data':base64.b64encode(b'FROM pinned\n').decode()}]}}}}

    def fixture(self, mutate=None, legacy=False, statement_mutate=None):
        blobs = {}
        def add(value, media='application/vnd.oci.image.manifest.v1+json'):
            data = json.dumps(value).encode()
            sha = p.digest(data)
            blobs[sha] = data
            return dict(digest=sha, size=len(data), mediaType=media)
        config = dict(os='linux',architecture='amd64',config={'Labels':copy.deepcopy(self.labels)})
        predicate = copy.deepcopy(self.predicate)
        if mutate:
            mutate(config, predicate)
        image = add({'config':add(config), 'layers':[]})
        image['platform'] = dict(os='linux',architecture='amd64')
        statement = dict(_type='https://in-toto.io/Statement/v1',predicateType='https://slsa.dev/provenance/v0.2',
                         predicate=predicate,subject=[dict(name='fixture',digest={'sha256':image['digest'][7:]})])
        if statement_mutate:
            statement_mutate(statement)
        layer = add(statement,'application/vnd.in-toto+json')
        att = {'layers':[layer]}
        if legacy:
            descriptor = add(att)
            descriptor['annotations'] = {'vnd.docker.reference.digest':image['digest'], 'vnd.docker.reference.type':'attestation-manifest'}
        else:
            att['subject'] = image
            att['artifactType'] = 'application/vnd.docker.attestation.manifest.v1+json'
            descriptor = add(att)
        index = json.dumps(dict(manifests=[image,descriptor])).encode()
        return Memory(index,blobs),p.digest(index)

    def check(self, store, sha):
        return p.verify(store,sha,'backend',self.commit,'owner/homecloud','dry-run')

    def test_artifact_and_legacy_storage(self):
        for legacy in (False,True):
            store,sha = self.fixture(legacy=legacy)
            self.assertEqual(self.check(store,sha)['commit'],self.commit)

    def test_corrupted_blob_rejected(self):
        store,sha = self.fixture()
        key = next(iter(store.blobs))
        store.blobs[key] += b' '
        with self.assertRaises(ValueError):
            self.check(store,sha)

    def test_index_substitution_rejected(self):
        store,_ = self.fixture()
        with self.assertRaises(ValueError):
            self.check(store,'sha256:'+'f'*64)

    def test_claim_mutations_rejected_even_with_fresh_checksums(self):
        mutations = [lambda c,v:c['config']['Labels'].update({'org.opencontainers.image.revision':'d'*40}),
                     lambda c,v:c['config']['Labels'].update({'io.homecloud.pair':'d'*40}),
                     lambda c,v:c['config']['Labels'].update({'io.homecloud.role':'frontend'}),
                     lambda c,v:c['config']['Labels'].update({'org.opencontainers.image.version':'latest'}),
                     lambda c,v:c.update(architecture='arm64'),
                     lambda c,v:v['metadata'][p.BUILDKIT+'#metadata']['vcs'].update(revision=self.commit+'-dirty'),
                     lambda c,v:v['metadata'][p.BUILDKIT+'#metadata']['vcs'].update(source='https://example.invalid/source'),
                     lambda c,v:v['metadata'][p.BUILDKIT+'#metadata']['source']['infos'][0].update(data=base64.b64encode(b'changed').decode()),
                     lambda c,v:v.update(buildConfig={}),
                     lambda c,v:v['invocation']['parameters']['args'].update({'build-arg:NODE_IMAGE':'node:latest'}),
                     lambda c,v:v.update(materials=[]),
                     lambda c,v:v['materials'][0]['digest'].update(sha256='d'*64)]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                store,sha = self.fixture(mutation)
                with self.assertRaises(ValueError):
                    self.check(store,sha)

    def test_attestation_subject_and_type_substitution_rejected(self):
        mutations = [lambda value:value['subject'][0]['digest'].update(sha256='d'*64),
                     lambda value:value.update(subject=[]),
                     lambda value:value.update(predicateType='https://example.invalid/provenance'),
                     lambda value:value.update(_type='https://example.invalid/statement')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                store, sha = self.fixture(statement_mutate=mutation)
                with self.assertRaises(ValueError):
                    self.check(store,sha)

    def test_registry_redirect_strips_credentials_and_rejects_http(self):
        from urllib.request import Request
        handler = p.SafeRedirect()
        request = Request('https://ghcr.io/v2/owner/homecloud/backend/blobs/sha256:fixture',
                          headers={'Authorization':'Bearer fixture'})
        redirected = handler.redirect_request(request,None,302,'Found',{},'https://storage.example.invalid/blob')
        self.assertFalse(redirected.has_header('Authorization'))
        with self.assertRaises(ValueError):
            handler.redirect_request(request,None,302,'Found',{},'http://storage.example.invalid/blob')

    def test_pair_rejects_source_drift_and_proof_mutations(self):
        r = pair_module.release
        for name in r.SOURCE_PATHS:
            destination = p.ROOT/name
            destination.parent.mkdir(parents=True,exist_ok=True)
            if not destination.exists():
                destination.write_text('fixture')
        (p.ROOT/'backend/src/migrations').mkdir(parents=True)
        def proof(role):
            return dict(format='homecloud-provenance-dry-run-v1',status='OFFLINE_OCI_VERIFIED',
                        commit=self.commit,repository='ghcr.io/owner/homecloud/'+role,
                        platform='linux/amd64',version='dry-run',
                        verified='DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS',signature='UNSIGNED',
                        ghcr_state='NOT_PUBLISHED_NOT_TESTED',
                        **{key:'sha256:'+'a'*64 for key in ('index_digest','platform_digest','statement_digest')})
        backend,frontend = proof('backend'),proof('frontend')
        def git(*args):
            return self.commit if args[0]=='rev-parse' else ''
        with patch.object(r,'ROOT',p.ROOT), patch.object(r,'git',side_effect=git):
            result = pair_module.pair(backend,frontend,self.commit,'owner/homecloud','1','1')
            self.assertEqual(result['tag_state'],'IN_MEMORY_ONLY_NO_OBJECT_OR_REF_CREATED')
            self.assertEqual(result['ghcr_state'],'NOT_PUBLISHED_NOT_TESTED')
            self.assertEqual(result['manifest_sha256'],r.identity(result))
            for changes in ({'commit':'d'*40},{'repository':'ghcr.io/owner/homecloud/backend'},
                            {'platform':'linux/arm64'},{'version':'v0.0.0-beta.1'},
                            {'status':'NOT_VERIFIED'},{'verified':'LABELS_ONLY'},
                            {'ghcr_state':'PUBLISHED'},{'signature':'SIGNED'},
                            {'index_digest':'latest'}):
                with self.subTest(changes=changes):
                    with self.assertRaises(ValueError):
                        pair_module.pair(backend,{**frontend,**changes},self.commit,'owner/homecloud','1','1')
        with patch.object(r,'ROOT',p.ROOT), patch.object(r,'git',return_value='d'*40):
            with self.assertRaisesRegex(ValueError,'checkout/source'):
                pair_module.pair(backend,frontend,self.commit,'owner/homecloud','1','1')
        with patch.object(r,'ROOT',p.ROOT), patch.object(r,'git',side_effect=[self.commit,'dirty-fixture']):
            with self.assertRaisesRegex(ValueError,'dirty tracked'):
                pair_module.pair(backend,frontend,self.commit,'owner/homecloud','1','1')


if __name__ == '__main__':
    unittest.main()
