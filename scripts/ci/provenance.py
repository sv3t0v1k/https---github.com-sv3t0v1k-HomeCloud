#!/usr/bin/env python3
"""Verify unsigned BuildKit OCI evidence, offline or read-only GHCR. No publish/tag."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MAX_METADATA = 16 * 1024 * 1024
BUILDKIT = 'https://mobyproject.org/buildkit@v1'
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        require(urllib.parse.urlparse(newurl).scheme == 'https', 'insecure registry redirect')
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        # GHCR blobs may redirect to storage; credentials must stay on the original endpoint.
        redirected.remove_header('Authorization')
        return redirected


HTTP = urllib.request.build_opener(SafeRedirect())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def checked(data, descriptor):
    require(DIGEST.fullmatch(descriptor['digest']), 'invalid descriptor digest')
    require(len(data) == descriptor['size'], 'descriptor size mismatch')
    require(digest(data) == descriptor['digest'], 'descriptor checksum mismatch')
    return json.loads(data)


class Archive:
    def __init__(self, path):
        self.tar = tarfile.open(path, 'r:*')

    def read(self, name):
        member = self.tar.getmember(name)
        require(member.isfile() and member.size <= MAX_METADATA, 'unsafe metadata member')
        return self.tar.extractfile(member).read(MAX_METADATA + 1)

    def get(self, descriptor, manifest=False):
        require(DIGEST.fullmatch(descriptor['digest']), 'invalid descriptor digest')
        return checked(self.read('blobs/sha256/' + descriptor['digest'][7:]), descriptor)

    def index(self, expected):
        outer = json.loads(self.read('index.json'))
        # OCI layout wraps the exported index in a descriptor on some BuildKit versions.
        if len(outer['manifests']) == 1 and 'index' in outer['manifests'][0]['mediaType']:
            descriptor = outer['manifests'][0]
            require(descriptor['digest'] == expected, 'export metadata/index mismatch')
            return self.get(descriptor)
        require(digest(self.read('index.json')) == expected, 'export metadata/index mismatch')
        return outer


class Registry:
    def __init__(self, repository):
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*/(backend|frontend)', repository), 'invalid GHCR repository')
        self.repository = repository
        self.token = None

    def read(self, kind, sha):
        require(DIGEST.fullmatch(sha), 'invalid registry digest')
        url = 'https://ghcr.io/v2/' + self.repository + '/' + kind + '/' + sha
        accept = ','.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
                           'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'])
        headers = {'Accept': accept}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        try:
            with HTTP.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
                data = response.read(MAX_METADATA + 1)
        except urllib.error.HTTPError as error:
            if error.code != 401 or self.token:
                raise ValueError('GHCR metadata read failed: HTTP ' + str(error.code)) from None
            # Fixed endpoint prevents credential forwarding to an untrusted challenge realm.
            params = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + self.repository + ':pull'})
            headers = {}
            if os.environ.get('GH_TOKEN'):
                credential = os.environ.get('GITHUB_ACTOR', 'homecloud') + ':' + os.environ['GH_TOKEN']
                headers['Authorization'] = 'Basic ' + base64.b64encode(credential.encode()).decode()
            with HTTP.open(urllib.request.Request('https://ghcr.io/token?' + params, headers=headers), timeout=60) as response:
                self.token = json.load(response)['token']
            return self.read(kind, sha)
        require(len(data) <= MAX_METADATA, 'registry metadata too large')
        require(digest(data) == sha, 'registry content digest mismatch')
        return data

    def get(self, descriptor, manifest=False):
        return checked(self.read('manifests' if manifest else 'blobs', descriptor['digest']), descriptor)

    def index(self, expected):
        return json.loads(self.read('manifests', expected))


def verify(store, index_digest, component, commit, repository, version):
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'full clean commit required')
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*', repository), 'invalid source repository')
    index = store.index(index_digest)
    descriptors = index['manifests']
    images = [d for d in descriptors if d.get('platform', {}).get('os') == 'linux'
              and d.get('platform', {}).get('architecture') == 'amd64']
    require(len(images) == 1, 'exactly one linux/amd64 manifest required')
    image = images[0]
    manifest = store.get(image, manifest=True)
    config = store.get(manifest['config'])
    require(config['os'] == 'linux' and config['architecture'] == 'amd64', 'config platform mismatch')
    labels = config.get('config', {}).get('Labels', {})
    source = 'https://github.com/' + repository
    for key, value in {'org.opencontainers.image.revision': commit, 'org.opencontainers.image.source': source,
                       'org.opencontainers.image.version': version, 'io.homecloud.role': component,
                       'io.homecloud.pair': commit}.items():
        require(labels.get(key) == value, 'OCI label mismatch: ' + key)
    statements = []
    for descriptor in descriptors:
        annotations = descriptor.get('annotations', {})
        if descriptor == image:
            continue
        attestation = store.get(descriptor, manifest=True)
        subject = attestation.get('subject', {}).get('digest')
        legacy = annotations.get('vnd.docker.reference.digest')
        if subject != image['digest'] and legacy != image['digest']:
            continue
        require(not subject or subject == image['digest'], 'artifact subject mismatch')
        require(not legacy or legacy == image['digest'], 'legacy subject mismatch')
        for layer in attestation['layers']:
            if layer['mediaType'] != 'application/vnd.in-toto+json':
                continue
            statement = store.get(layer)
            if statement.get('predicateType') == 'https://slsa.dev/provenance/v0.2':
                statements.append((layer['digest'], statement))
    require(len(statements) == 1, 'one SLSA v0.2 attestation required')
    statement_digest, statement = statements[0]
    require(statement.get('_type') in ('https://in-toto.io/Statement/v0.1', 'https://in-toto.io/Statement/v1'), 'invalid statement type')
    require(len(statement['subject']) == 1 and statement['subject'][0]['digest'] == {'sha256': image['digest'][7:]}, 'in-toto subject mismatch')
    predicate = statement['predicate']
    require(predicate['buildType'] == BUILDKIT, 'unexpected builder type')
    metadata = predicate['metadata'][BUILDKIT + '#metadata']
    vcs = metadata['vcs']
    require(vcs['revision'] == commit, 'provenance VCS revision missing/dirty/mismatch')
    require(vcs['source'].lower() in (source, source + '.git'), 'provenance VCS source mismatch')
    infos = metadata['source']['infos']
    dockerfiles = [i for i in infos if i.get('filename') == 'Dockerfile']
    expected = (ROOT / component / 'Dockerfile').read_bytes()
    require(len(dockerfiles) == 1 and base64.b64decode(dockerfiles[0]['data'], validate=True) == expected, 'mode=max Dockerfile mismatch')
    require(predicate.get('buildConfig', {}).get('llbDefinition'), 'mode=max build definition missing')
    args = predicate['invocation']['parameters']['args']
    lock = json.loads((ROOT / 'scripts/ci/images.lock.json').read_text())
    platforms = json.loads((ROOT / 'scripts/ci/images.platforms.json').read_text())
    roles = ('node',) if component == 'backend' else ('node', 'nginx')
    materials = predicate['materials']
    for role in roles:
        ref = lock[role]
        require(args.get('build-arg:' + role.upper() + '_IMAGE') == ref, 'pinned build arg mismatch: ' + role)
        # Material is generally the resolved platform digest, whereas lock pins its parent index.
        matches = [m for m in materials if m.get('uri', '').startswith('pkg:docker/' + role + '@')
                   or m.get('uri', '').startswith('pkg:docker/library/' + role + '@')
                   or m.get('uri', '').startswith('pkg:docker/docker.io/library/' + role + '@')]
        require(matches and all(re.fullmatch(r'[a-f0-9]{64}', m.get('digest', {}).get('sha256', '')) for m in matches), 'base materials missing: ' + role)
        mapping = platforms[role]
        require(mapping['index_digest'] == ref.split('@')[1], 'base mapping/lock mismatch: ' + role)
        # BuildKit v0.38 reports the pinned index for multi-platform base inputs;
        # older exporters can report its resolved platform manifest. Both are known digests.
        known = {mapping['index_digest'], mapping['amd64_digest']}
        require(all('sha256:' + m['digest']['sha256'] in known for m in matches), 'resolved base material mismatch: ' + role)
        require(all(urllib.parse.parse_qs(urllib.parse.urlparse(m['uri']).query).get('platform') == ['linux/amd64'] for m in matches), 'base material platform mismatch: ' + role)
    return dict(index_digest=index_digest, platform_digest=image['digest'], statement_digest=statement_digest,
                commit=commit, repository='ghcr.io/' + repository + '/' + component,
                version=version, platform='linux/amd64', dockerfile_sha256=hashlib.sha256(expected).hexdigest(),
                materials=materials, verified='DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS', signature='UNSIGNED',
                limitation='Local-context VCS metadata is a builder claim; not cryptographic source-content authentication.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['dry-run'])
    parser.add_argument('--archive', required=True)
    parser.add_argument('--metadata', required=True)
    parser.add_argument('--component', choices=['backend', 'frontend'], required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    metadata = json.loads(Path(args.metadata).read_text())
    result = verify(Archive(args.archive), metadata['containerimage.digest'], args.component, args.commit, args.repository, 'dry-run')
    result.update(format='homecloud-provenance-dry-run-v1', status='OFFLINE_OCI_VERIFIED',
                  tag_state='SYNTHETIC_VERSION_LABEL_ONLY_NO_GIT_TAG', ghcr_state='NOT_PUBLISHED_NOT_TESTED',
                  release_state='NOT_CREATED', production='NO_GO')
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print('PASS: offline OCI provenance; GHCR/tag/release NOT_RUN')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        raise SystemExit('BLOCKED: ' + str(error))
