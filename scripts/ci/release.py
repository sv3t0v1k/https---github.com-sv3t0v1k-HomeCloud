#!/usr/bin/env python3
"""D5.1 candidate provenance; separate from qualified homecloud-release-v1/D1."""
import argparse
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EXCLUDED = ':(exclude)scripts/tests/PHASE-5.3.1-TEST-AUDIT.md'
SHA = re.compile(r'^[a-f0-9]{40}$')
TAG = re.compile(r'^v0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.([1-9][0-9]*)$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
REPO = re.compile(r'^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*$')
SOURCE_PATHS = ('docker-compose.yml', 'docker-compose.production.yml', 'docker-compose.project-test.yml',
                'backend/Dockerfile', 'frontend/Dockerfile', 'backend/package-lock.json',
                'frontend/package-lock.json', 'scripts/ci/images.lock.json',
                '.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/ci/release.py')


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.PIPE).strip()


def git(*args):
    return run('git', *args)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_tag(tag, commit):
    require(bool(TAG.fullmatch(tag) and SHA.fullmatch(commit)), 'invalid beta tag or full commit')
    require(git('cat-file', '-t', 'refs/tags/'+tag) == 'tag', 'annotated tag required')
    require(git('rev-parse', 'refs/tags/'+tag+'^{commit}') == commit, 'tag/commit mismatch')
    require(git('rev-parse', 'HEAD') == commit, 'checkout/commit mismatch')
    require(not git('diff', '--name-only', 'HEAD', '--', '.', EXCLUDED), 'dirty tracked checkout')


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identity(value):
    body = {k: v for k, v in value.items() if k != 'manifest_sha256'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def shape(value):
    require(value.get('format') == 'homecloud-ci-candidate-v1', 'not a CI candidate')
    require(bool(TAG.fullmatch(value['tag']) and SHA.fullmatch(value['commit'])), 'invalid source')
    require(bool(SHA.fullmatch(value['tag_object'])), 'missing annotated tag identity')
    require(bool(REPO.fullmatch(value['repository'])), 'invalid repository')
    require(value['ci']['status'] == 'success', 'unsuccessful CI')
    require(str(value['ci']['run_id']).isdigit() and str(value['ci']['attempt']).isdigit(), 'invalid CI identity')
    require(value['ci']['url'] == 'https://github.com/'+value['repository']+'/actions/runs/'+value['ci']['run_id'], 'invalid CI URL')
    require(value['deployment_status'] == 'NOT_DEPLOYED', 'candidate is not deployment evidence')
    require(bool(value['schema_migrations']) and all(isinstance(x, str) for x in value['schema_migrations']), 'missing schema contract')
    require(bool(value['source_files']) and all(re.fullmatch(r'[a-f0-9]{64}', x) for x in value['source_files'].values()), 'invalid source hashes')
    require(set(SOURCE_PATHS).issubset(value['source_files']), 'incomplete source contract')
    require(any(x.startswith('backend/src/migrations/') for x in value['source_files']), 'missing migration source hashes')
    require(set(value['base_images']) == {'node', 'nginx', 'postgres'}, 'incomplete base lock')
    for role, ref in value['base_images'].items():
        require(bool(re.fullmatch(r'docker.io/library/'+role+r':[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}', ref)), 'unpinned base image')
    require(set(value['images']) == {'backend', 'frontend'}, 'full image pair required')
    for role, image in value['images'].items():
        require(image['repository'] == 'ghcr.io/'+value['repository']+'/'+role, 'unexpected registry')
        require(bool(DIGEST.fullmatch(image['digest'])), 'immutable digest required')
        require(image['revision'] == value['commit'] and image['version'] == value['tag'], 'image/source mismatch')
        require(image['platform'] == 'linux/amd64', 'wrong platform')
    require(value['manifest_sha256'] == identity(value), 'manifest checksum mismatch')


def create(args):
    verify_tag(args.tag, args.commit)
    require(bool(REPO.fullmatch(args.repository)), 'invalid repository')
    require(args.run_id.isdigit() and args.attempt.isdigit(), 'invalid run provenance')
    images = {}
    for role in ('backend', 'frontend'):
        digest = getattr(args, role)
        require(bool(DIGEST.fullmatch(digest)), 'invalid build output digest')
        repository = 'ghcr.io/'+args.repository+'/'+role
        ref = repository+'@'+digest
        # Only used on disposable GitHub runner; never invoked by reconciliation.
        subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', ref], check=True, stdout=subprocess.DEVNULL)
        found = json.loads(run('docker', 'image', 'inspect', ref))[0]
        labels = found['Config'].get('Labels') or {}
        require(ref in found.get('RepoDigests', []), 'registry digest mismatch')
        require(found['Os']+'/'+found['Architecture'] == 'linux/amd64', 'wrong image architecture')
        for key, expected in {'org.opencontainers.image.revision': args.commit,
                              'org.opencontainers.image.version': args.tag,
                              'org.opencontainers.image.source': 'https://github.com/'+args.repository,
                              'io.homecloud.role': role, 'io.homecloud.pair': args.commit}.items():
            require(labels.get(key) == expected, 'registry label mismatch: '+key)
        images[role] = dict(repository=repository, digest=digest, revision=args.commit,
                            version=args.tag, platform='linux/amd64')
    files = [ROOT/name for name in SOURCE_PATHS]
    files += sorted((ROOT/'backend/src/migrations').glob('*.ts'))
    migrations = [re.search(r'export class ([A-Za-z0-9]+)', p.read_text()).group(1)
                  for p in sorted((ROOT/'backend/src/migrations').glob('*.ts'))]
    manifest = dict(format='homecloud-ci-candidate-v1', repository=args.repository,
                    tag=args.tag, tag_object=git('rev-parse', 'refs/tags/'+args.tag), commit=args.commit, stage='D5.1', images=images,
                    base_images=json.loads((ROOT/'scripts/ci/images.lock.json').read_text()),
                    source_files={str(p.relative_to(ROOT)): file_hash(p) for p in files},
                    schema_migrations=migrations,
                    ci=dict(status='success', run_id=args.run_id, attempt=args.attempt,
                            url='https://github.com/'+args.repository+'/actions/runs/'+args.run_id),
                    provenance='BuildKit mode=max attached to registry index; unsigned',
                    deployment_status='NOT_DEPLOYED')
    manifest['manifest_sha256'] = identity(manifest)
    shape(manifest)
    Path(args.output).write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+'\n')
    print('PASS: remote digests, labels, platform and source contract')


def reconcile(args):
    # Snapshot supplied by operator only; no SSH, Docker API or live target access.
    mac = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=normal', '--', '.', EXCLUDED))
    refs = dict(mac_branch=git('branch', '--show-current'), mac_commit=mac, mac_dirty=dirty,
                github_commit=args.github_sha or 'UNKNOWN', release='UNKNOWN',
                deployment='UNKNOWN', evidence_mode='OFFLINE_SNAPSHOTS_NOT_LIVE_HEALTH', drift=[])
    if dirty:
        refs['drift'].append('Mac working tree contains changes')
    if args.github_sha:
        require(bool(SHA.fullmatch(args.github_sha)), 'invalid GitHub commit snapshot')
        if mac != args.github_sha:
            refs['drift'].append('Mac / GitHub commit differs')
    if args.manifest:
        candidate = json.loads(Path(args.manifest).read_text())
        shape(candidate)
        refs['release'] = dict(tag=candidate['tag'], commit=candidate['commit'], images=candidate['images'])
        if args.github_sha and candidate['commit'] != args.github_sha:
            refs['drift'].append('GitHub / release commit differs')
        if mac != candidate['commit']:
            refs['drift'].append('Mac / release commit differs')
    if args.deployment:
        deployment = json.loads(Path(args.deployment).read_text())
        require(bool(SHA.fullmatch(deployment['source_revision'])), 'invalid deployment source revision')
        require(isinstance(deployment['evidence'], str) and bool(deployment['evidence'].strip()), 'missing snapshot evidence')
        observed = deployment['observed_at']
        require(isinstance(observed, str), 'invalid observation date')
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', observed):
            date.fromisoformat(observed)  # Reported evidence may have day precision only.
        else:
            require(datetime.fromisoformat(observed.replace('Z', '+00:00')).tzinfo is not None, 'timestamp requires timezone')
        applied = deployment.get('applied_migrations')
        require(applied is None or (isinstance(applied, list) and all(isinstance(x, str) and x for x in applied)), 'invalid applied schema evidence')
        refs['deployment'] = deployment
        if args.manifest:
            if deployment['source_revision'] != candidate['commit']:
                refs['drift'].append('Release / deployment source differs')
            expected = {role: x['repository']+'@'+x['digest'] for role, x in candidate['images'].items()}
            if deployment.get('images') != expected:
                refs['drift'].append('Deployment digests missing or differ')
        if not deployment.get('applied_migrations'):
            refs['drift'].append('Applied migrations UNKNOWN')
        elif args.manifest and sorted(deployment['applied_migrations']) != sorted(candidate['schema_migrations']):
            refs['drift'].append('Applied migrations / release schema differs')
    print(json.dumps(refs, indent=2, ensure_ascii=False))
    return 2 if refs['drift'] or any(refs[x] == 'UNKNOWN' for x in ('github_commit', 'release', 'deployment')) else 0


def main():
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest='command', required=True)
    verify = subs.add_parser('verify-tag')
    verify.add_argument('--tag', required=True)
    verify.add_argument('--commit', required=True)
    make = subs.add_parser('create')
    for name in ('tag', 'commit', 'repository', 'backend', 'frontend', 'run-id', 'attempt', 'output'):
        make.add_argument('--'+name, required=True)
    drift = subs.add_parser('reconcile')
    for name in ('github-sha', 'manifest', 'deployment'):
        drift.add_argument('--'+name)
    args = parser.parse_args()
    if args.command == 'verify-tag':
        verify_tag(args.tag, args.commit)
        print('PASS: annotated tag / commit / checkout')
    elif args.command == 'create':
        create(args)
    else:
        return reconcile(args)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        # Do not print subprocess output, environments or credential material.
        print('BLOCKED: '+str(error) if isinstance(error, ValueError) else 'BLOCKED: invalid or unavailable evidence', file=sys.stderr)
        sys.exit(1)
