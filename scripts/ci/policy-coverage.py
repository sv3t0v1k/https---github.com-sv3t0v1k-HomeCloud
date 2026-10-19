#!/usr/bin/env python3
"""Require exact production/build artifact coverage and actual CI environments."""
import argparse
import os
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


policy = module('scan-policy')
evidence = module('scan-evidence')
environment = module('environment-evidence')
RUNTIME = ('backend', 'frontend', 'postgres', 'ingress')
STAGES = ('backend-deps', 'backend-builder', 'frontend-deps', 'frontend-builder')
ENVIRONMENTS = ('backend', 'frontend', 'configuration', 'image-build-backend', 'image-build-frontend',
                'provenance-pair', 'base-node', 'base-nginx', 'base-postgres', 'base-node-ci',
                'security-backend', 'security-frontend', 'secrets',
                'support-postgres', 'support-ingress', 'support-buildkit')
COMPONENTS = {'backend': 'backend', 'frontend': 'frontend',
              'security-backend': 'backend', 'security-frontend': 'frontend'}


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def one(root, name):
    paths = list(root.rglob(name))
    if len(paths) != 1:
        raise ValueError(f'Expected one {name}, found {len(paths)}')
    return paths[0]


def image(root, role, source, lock):
    binding_path = one(root, role+'.binding.json')
    binding = read(binding_path)
    if (binding.get('format') != 'homecloud-qualified-artifact-v1'
            or binding.get('role') != role or binding.get('source_commit') != source
            or binding.get('platform') != 'linux/amd64'
            or binding.get('binding') != 'ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED'):
        raise ValueError('Artifact/source binding missing: '+role)
    for key in ('archive_sha256', 'platform_digest', 'config_digest', 'scan_sha256'):
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', binding.get(key, '')):
            raise ValueError('Invalid bound digest: '+role)
    report_path = one(root, ('image-'+role+'.json') if role in ('backend', 'frontend') else role+'.scan.json')
    report = read(report_path)
    if binding['scan_sha256'] != 'sha256:'+sha(report_path) or report['Metadata']['ImageID'] != binding['config_digest']:
        raise ValueError('Retained scan changed or wrong config: '+role)
    sidecar = read(report_path.with_suffix('.evidence.json'))
    if sidecar.get('evidence_status') != 'PASS' or sidecar.get('source_kind') != 'archive':
        raise ValueError('Missing valid archive scan evidence: '+role)
    evidence.validate(report, sidecar['vulnerability_db'], sidecar['requested_reference'],
                      datetime.now(timezone.utc), source_kind='archive')
    if role == 'backend' or role in STAGES:
        packages = [package for result in report.get('Results', [])
                    if result.get('Class') == 'lang-pkgs' and result.get('Type') == 'node-pkg'
                    for package in result.get('Packages', [])]
        if not packages or not all(p.get('Name') and p.get('Version') for p in packages):
            raise ValueError('Missing installed Node package scan: '+role)
        if role in STAGES and not any(p.get('Name') == 'npm' for p in packages):
            raise ValueError('Missing build-stage global npm inventory: '+role)
    if role in ('postgres', 'ingress', 'buildkit') and binding['platform_digest'] != lock[role].split('@')[1]:
        raise ValueError('Locked image changed: '+role)
    if role in ('backend', 'frontend'):
        loaded = read(one(root, role+'.loaded.binding.json'))
        if (loaded.get('binding') != 'LOADED_EXACT_OCI_CONFIG_AND_FILESYSTEM'
                or any(loaded.get(k) != binding[k] for k in ('role', 'source_commit', 'platform_digest', 'config_digest'))):
            raise ValueError('Runtime smoke did not load exact OCI candidate: '+role)
    if role in STAGES:
        cache = read(one(root, role+'.cache.json'))
        if (cache.get('status') != 'CACHED_RUNTIME_BUILD_OPERATIONS' or cache.get('role') != role
                or cache.get('source_commit') != source):
            raise ValueError('Stage export not bound to runtime build cache: '+role)
        if (cache.get('progress_sha256') != sha(one(root, role+'.progress.jsonl'))
                or cache.get('metadata_sha256') != sha(one(root, role+'.build.json'))
                or cache.get('config_digest') != binding['config_digest']
                or cache.get('runtime_platform_digest') != read(one(root, role.split('-')[0]+'.binding.json'))['platform_digest']):
            raise ValueError('Stage cache proof/progress/runtime binding mismatch: '+role)
    return {**binding, 'findings': policy.evaluate(report)['findings'],
            'gate': policy.evaluate(report)['gate']}


def qualify(root, source):
    if not re.fullmatch(r'[a-f0-9]{40}', source):
        raise ValueError('Full source commit required')
    lock = read(Path(__file__).with_name('production-images.lock.json'))
    result = dict(format='homecloud-production-qualification-v1', source_commit=source, production='NO_GO',
                  policy='OWNER_APPROVED_NO_CVE_EXCEPTIONS', runtime={}, build={}, environments={},
                  raw_bases={}, errors=[], status='BLOCKED')

    def attempt(group, name, function):
        try:
            result[group][name] = function()
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            result['errors'].append(f'{group}/{name}: {error}')

    for role in RUNTIME:
        attempt('runtime', role, lambda role=role: image(root, role, source, lock))
    for role in (*STAGES, 'buildkit'):
        attempt('build', role, lambda role=role: image(root, role, source, lock))
    for name in ENVIRONMENTS:
        def check(name=name):
            paths = [p for p in root.rglob('environment.json') if read(p).get('environment_id') == name]
            if len(paths) != 1:
                raise ValueError('Missing or duplicated actual environment: '+name)
            path = paths[0]
            current = read(path)
            if current.get('source_commit') != source or current.get('evidence_status') != 'PASS':
                raise ValueError('Invalid actual environment/source: '+name)
            component = COMPONENTS.get(name, 'none')
            expected_target = str(Path(current['workspace'])/component/'node_modules') if component != 'none' else None
            if current.get('component') != component or current.get('component_target') != expected_target:
                raise ValueError('Required installed component coverage missing: '+name)
            if set(current['report_sha256']) != ({'rootfs', 'global-npm', 'component', 'tools'} if expected_target else {'rootfs', 'global-npm', 'tools'}):
                raise ValueError('Required environment report set missing: '+name)
            temp = Path(current['runner_temp'])
            required_tools = {'trivy': temp/'environment-trivy/trivy'}
            if name.startswith(('image-build-', 'base-', 'support-')):
                required_tools['image-trivy'] = temp/'homecloud-trivy/trivy'
            if name == 'configuration':
                required_tools['compose'] = temp/'homecloud-compose-bin/docker-compose'
            if name == 'secrets':
                required_tools['gitleaks'] = temp/'gitleaks'
            tools = current['executed_tools']
            if (len(tools) != len(required_tools)
                    or {tool['id']: tool['requested_path'] for tool in tools} != {key: str(value) for key, value in required_tools.items()}):
                raise ValueError('Required executed temporary tools missing or changed: '+name)
            reports = {role: read(path.with_name(role+'.json')) for role in current['report_sha256']}
            for role in reports:
                if sha(path.with_name(role+'.json')) != current['report_sha256'][role]:
                    raise ValueError('Environment report changed: '+name)
            environment.validate(current, reports, current['vulnerability_db'],
                                 datetime.now(timezone.utc), current.get('java_db'))
            summaries = {}
            for role, report in reports.items():
                if role == 'rootfs' and name != 'backend':
                    summaries[role] = policy.evaluate_host_platform(report, current)
                else:
                    summaries[role] = policy.evaluate_environment(report, component=role in ('component', 'global-npm', 'tools'))
            accepted = {'PASS', 'PLATFORM_ASSURANCE'}
            return dict(source_commit=source, scans=summaries,
                        runner_policy='GITHUB_HOSTED_PLATFORM_ASSURANCE' if name != 'backend' else 'PINNED_CONTAINER_STRICT',
                        gate='BLOCKED' if any(s['gate'] not in accepted for s in summaries.values()) else 'PASS')
        attempt('environments', name, check)
    for role in ('node', 'nginx', 'postgres', 'node-ci'):
        def check(role=role):
            path = one(root, 'image-base-'+role+'.json')
            report, sidecar = read(path), read(path.with_suffix('.evidence.json'))
            if sidecar.get('evidence_status') != 'PASS' or sidecar.get('source_kind') != 'remote':
                raise ValueError('Raw baseline scan missing valid evidence')
            raw_lock = read(Path(__file__).with_name('images.lock.json'))
            expected = ('node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd'
                        if role == 'node-ci' else raw_lock[role])
            if sidecar.get('requested_reference') != expected:
                raise ValueError('Raw baseline does not match pinned input: '+role)
            evidence.validate(report, sidecar['vulnerability_db'], sidecar['requested_reference'], datetime.now(timezone.utc))
            return policy.evaluate(report, diagnostic=True)
        attempt('raw_bases', role, check)
    if not result['errors'] and all(item['gate'] == 'PASS' for group in ('runtime', 'build', 'environments')
                                    for item in result[group].values()):
        result['status'] = 'PASS'
    result['coverage'] = 'COVERED' if not result['errors'] else 'INCOMPLETE'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = qualify(Path(args.directory), args.source)
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not run_id.isdigit() or not attempt.isdigit():
        result["errors"].append("Missing GitHub run identity")
        result["status"], result["coverage"] = "BLOCKED", "INCOMPLETE"
    result["ci"] = dict(run_id=run_id, attempt=attempt)
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
