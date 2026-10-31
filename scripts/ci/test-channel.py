#!/usr/bin/env python3
"""Exact TEST pair contract. This is never a release-lock or an Updates API input."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import provenance

ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r'[a-f0-9]{40}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
REPOSITORY = re.compile(r'[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*\Z')
MIGRATION = re.compile(r'[0-9]+-[A-Za-z0-9]+\.ts\Z')
FORMAT = 'homecloud-test-channel-v1'
FILES = ('docker-compose.yml', 'docker-compose.production.yml', 'docker-compose.project-test.yml',
         'backend/Dockerfile', 'frontend/Dockerfile', 'backend/package-lock.json',
         'frontend/package-lock.json', 'scripts/ci/images.lock.json',
         'deploy/linux/project-test.sh', 'deploy/linux/preflight.py',
         'deploy/linux/test-channel.py', 'scripts/ci/test-channel.py',
         'scripts/backup.sh', 'scripts/recovery_config.py', 'scripts/recovery_storage.py',
         'scripts/recovery-config.sh', 'scripts/recovery-storage.sh', 'scripts/recovery-pending.sql')


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def identity(value):
    return hashlib.sha256(canonical({key: item for key, item in value.items()
                                     if key != 'manifest_sha256'})).hexdigest()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def schema(root):
    migrations = []
    for path in sorted((root / 'backend/src/migrations').glob('*.ts')):
        require(bool(MIGRATION.fullmatch(path.name)), 'unsupported migration file')
        matches = re.findall(r'export class ([A-Za-z0-9]+)', path.read_text())
        require(len(matches) == 1, 'invalid migration class')
        migrations.append(dict(name=matches[0], file=path.name, sha256=sha(path)))
    require(bool(migrations) and len({item['name'] for item in migrations}) == len(migrations),
            'missing or duplicate migrations')
    return migrations


def shape(value):
    require(isinstance(value, dict) and set(value) == {'format', 'repository', 'commit', 'platform',
            'images', 'schema_migrations', 'source_files', 'ci', 'manifest_sha256'}, 'invalid TEST manifest keys')
    require(value['format'] == FORMAT and value['platform'] == 'linux/amd64'
            and isinstance(value['commit'], str) and SHA.fullmatch(value['commit'])
            and isinstance(value['repository'], str) and REPOSITORY.fullmatch(value['repository']),
            'invalid TEST source identity')
    require(isinstance(value['ci'], dict) and set(value['ci']) == {'run_id', 'attempt', 'workflow'}
            and value['ci']['workflow'] == 'ci-v2-fast.yml'
            and all(isinstance(value['ci'][key], str) and value['ci'][key].isdigit()
                    for key in ('run_id', 'attempt')), 'invalid TEST CI identity')
    require(isinstance(value['source_files'], dict) and set(value['source_files']) == set(FILES)
            and all(isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x)
                    for x in value['source_files'].values()), 'invalid TEST source contract')
    migrations = value['schema_migrations']
    require(isinstance(migrations, list) and bool(migrations)
            and len({item.get('name') for item in migrations if isinstance(item, dict)}) == len(migrations),
            'invalid TEST migration set')
    for item in migrations:
        require(isinstance(item, dict) and set(item) == {'name', 'file', 'sha256'}
                and re.fullmatch(r'[A-Za-z0-9]+', item['name'])
                and MIGRATION.fullmatch(item['file'])
                and re.fullmatch(r'[a-f0-9]{64}', item['sha256']), 'invalid TEST migration')
    images = value['images']
    require(isinstance(images, dict) and set(images) == {'backend', 'frontend'}, 'incomplete TEST pair')
    for role in ('backend', 'frontend'):
        item = images[role]
        require(isinstance(item, dict) and set(item) == {'repository', 'digest', 'platform_digest',
                'statement_digest', 'revision', 'version'} and
                item['repository'] == 'ghcr.io/' + value['repository'] + '/' + role and
                isinstance(item['digest'], str) and DIGEST.fullmatch(item['digest']) and
                isinstance(item['platform_digest'], str) and DIGEST.fullmatch(item['platform_digest']) and
                isinstance(item['statement_digest'], str) and DIGEST.fullmatch(item['statement_digest']) and
                item['revision'] == value['commit'] and item['version'] == 'test-' + value['commit'],
                'invalid TEST image binding')
    require(isinstance(value['manifest_sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', value['manifest_sha256'])
            and identity(value) == value['manifest_sha256'], 'TEST manifest checksum mismatch')
    return value


def build(commit, repository, run_id, attempt, digests, proofs, root=ROOT):
    require(bool(SHA.fullmatch(commit) and REPOSITORY.fullmatch(repository)), 'invalid TEST source')
    require(run_id.isdigit() and attempt.isdigit(), 'invalid TEST run')
    images = {}
    for role in ('backend', 'frontend'):
        digest = digests[role]
        proof = proofs[role]
        require(bool(DIGEST.fullmatch(digest)) and proof['index_digest'] == digest
                and proof['commit'] == commit and proof['version'] == 'test-' + commit
                and proof['platform'] == 'linux/amd64'
                and proof['repository'] == 'ghcr.io/' + repository + '/' + role
                and proof['verified'] == 'DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS'
                and proof['signature'] == 'UNSIGNED', 'TEST provenance mismatch')
        images[role] = dict(repository=proof['repository'], digest=digest,
                            platform_digest=proof['platform_digest'],
                            statement_digest=proof['statement_digest'], revision=commit,
                            version='test-' + commit)
    value = dict(format=FORMAT, repository=repository, commit=commit, platform='linux/amd64',
                 images=images, schema_migrations=schema(root),
                 source_files={path: sha(root / path) for path in FILES},
                 ci=dict(run_id=run_id, attempt=attempt, workflow='ci-v2-fast.yml'))
    value['manifest_sha256'] = identity(value)
    return shape(value)


def source_check(value, root=ROOT):
    shape(value)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    require(actual == value['commit'], 'TEST checkout/source mismatch')
    require(value['source_files'] == {path: sha(root / path) for path in FILES},
            'TEST source files changed')
    require(value['schema_migrations'] == schema(root), 'TEST schema source changed')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('create', 'check'))
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--commit')
    parser.add_argument('--repository')
    parser.add_argument('--run-id')
    parser.add_argument('--attempt')
    parser.add_argument('--backend')
    parser.add_argument('--frontend')
    args = parser.parse_args()
    if args.mode == 'check':
        source_check(json.loads(Path(args.manifest).read_text()))
    else:
        require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
                == args.commit, 'TEST checkout/source mismatch')
        digests = {'backend': args.backend, 'frontend': args.frontend}
        proofs = {role: provenance.verify(provenance.Registry(args.repository + '/' + role),
                   digests[role], role, args.commit, args.repository, 'test-' + args.commit)
                  for role in ('backend', 'frontend')}
        value = build(args.commit, args.repository, args.run_id, args.attempt, digests, proofs)
        Path(args.manifest).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print('PASS: exact TEST pair/source/manifest')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print('BLOCKED: invalid or unavailable TEST evidence', file=sys.stderr)
        sys.exit(1)
