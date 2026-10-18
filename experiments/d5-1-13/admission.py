#!/usr/bin/env python3
"""Runtime admission reuses existing mandatory gates; no input PASS receipt."""
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import preflight as pre

ROOT = pre.ROOT
TOOLS = {'skopeo': ['--version'], 'mkfs.ext4': ['-V'], 'losetup': ['--version'],
         'findmnt': ['--version'], 'mount': ['--version'], 'sudo': ['--version'],
         'cp': ['--version'], 'blkid': ['--version'], 'python3': ['--version']}


def module(name):
    sys.path.insert(0, str(ROOT / 'scripts/ci'))
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts/ci' / (name+'.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def capture_tools(out, runner):
    records = {}
    for name, version_args in TOOLS.items():
        path = Path(shutil.which(name) or '/missing').resolve(strict=True)
        version = runner([str(path), *version_args])
        records[name] = dict(path=str(path), sha256=pre.digest(path),
                             version=(version.stdout + version.stderr).decode()[:4000])
    pre.write(out, 'runtime-tools.json', records)


def qualify(out, download, runner):
    pre.hosted(os.environ, platform.system(), platform.machine())
    lock = json.loads((ROOT/'ops/postgres/qualification.lock.json').read_text())
    official = download/'official.oci.tar'
    pre.require(not official.exists(), 'new official archive required')
    ref = 'docker://docker.io/library/postgres@' + lock['base'].split('@')[1]
    runner(['skopeo', 'copy', '--preserve-digests', '--override-os', 'linux', '--override-arch',
            'amd64', ref, 'oci-archive:'+str(official)], timeout=120)
    binding = module('oci-scan-binding')
    manifest, data, config = binding.identity(official)
    metadata = json.loads((out/'official-metadata.json').read_text())
    pre.require(manifest == metadata['child']['digest'] and data['config']['digest'] ==
                metadata['manifest']['config']['digest'], 'official export identity mismatch')
    pre.write(out, 'official-archive.json', dict(manifest=manifest, config=data['config']['digest'],
                 archive_sha256=pre.digest(official), layers=len(data['layers'])))
    capture_tools(out, runner)
    failures = []
    for role, archive in [('exact', download/'candidate.oci.tar'), ('official', official)]:
        result = runner(['sh', str(ROOT/'scripts/ci/scan-image.sh'),
                         str(Path(os.environ['RUNNER_TEMP'])/'d513-trivy/trivy'), 'archive',
                         str(archive), str(out/(role+'-scan.json'))], check=False, timeout=240)
        if result.returncode:
            failures.append(role)
    pre.require(not failures, 'mandatory image gate failed: '+','.join(failures))


def validate_scope(context, environment, env, source):
    pre.require(context['source'] == source and str(context['run_id']) == env['GITHUB_RUN_ID'],
                'stale context source/run')
    pre.require(environment['source_commit'] == source and
                environment['github']['run_id'] == env['GITHUB_RUN_ID'] and
                environment['github']['run_attempt'] == env['GITHUB_RUN_ATTEMPT'] and
                environment['github']['job'] == env['GITHUB_JOB'] and
                environment['github']['sha'] == env['GITHUB_SHA'] and
                environment['github']['runner_environment'] == 'github-hosted',
                'environment not current actual job')


def admit(out, download, runner):
    pre.hosted(os.environ, platform.system(), platform.machine())
    source = runner(['git','rev-parse','HEAD']).stdout.decode().strip()
    pre.require(source == os.environ['APPROVED_SHA'], 'approved checkout mismatch')
    runner(['git','diff','--quiet','HEAD','--','experiments/d5-1-13','scripts/ci',
            'ops/postgres/prepare.py','ops/postgres/qualification.lock.json',
            'deploy/linux/startup-gate.sh','.github/workflows/pg-recovery-preflight.yml'])
    context = json.loads((out/'context.json').read_text())
    env_root = out/'environment'
    environment = json.loads((env_root/'environment.json').read_text())
    validate_scope(context, environment, os.environ, source)
    pre.require({record['id'] for record in environment['executed_tools']} == {'gh','docker','skopeo','trivy'},
                'missing executed Go tool scan coverage')
    db = Path(os.environ['RUNNER_TEMP'])/'d513-trivy/cache/db/metadata.json'
    # Execute original postscan validation again at admission, including tool hashes,
    # actual inventory completeness and freshness; a user-supplied PASS is insufficient.
    runner(['python3', str(ROOT/'scripts/ci/environment-evidence.py'), 'validate',
            str(env_root), str(db)])
    for report, flag in [('rootfs.json','--environment'), ('tools.json','--component')]:
        runner(['python3',str(ROOT/'scripts/ci/scan-policy.py'),str(env_root/report),flag])
    tools = json.loads((out/'runtime-tools.json').read_text())
    pre.require(set(tools) == set(TOOLS), 'missing runtime tool inventory')
    for name, record in tools.items():
        actual = Path(shutil.which(name) or '/missing').resolve(strict=True)
        pre.require(str(actual) == record['path'] and pre.digest(actual) == record['sha256'],
                    'runtime tool changed: '+name)
    binding, policy, freshness = (module(name) for name in ['oci-scan-binding','scan-policy','scan-evidence'])
    lock = json.loads((ROOT/'ops/postgres/qualification.lock.json').read_text())
    expected = {'exact':lock['manifest'], 'official':lock['base'].split('@')[1]}
    images = {}
    for role, archive in [('exact',download/'candidate.oci.tar'), ('official',download/'official.oci.tar')]:
        pre.require(archive.is_file() and not archive.is_symlink(), 'missing verified archive')
        if role == 'exact':
            pre.require(pre.digest(archive) == lock['archive_sha256'], 'exact tar changed')
        report = json.loads((out/(role+'-scan.json')).read_text())
        freshness.validate(report, json.loads(db.read_text()), str(archive)+'.scan-layout',
                           datetime.now(timezone.utc), 'archive')
        pre.require(policy.evaluate(report)['gate'] == 'PASS', 'mandatory runtime security gate failed')
        record = binding.bind(archive, report, 'postgres', source, expected[role])
        images[role] = dict(archive=str(archive), config=record['config_digest'], manifest=record['platform_digest'])
    pre.require(not runner(['docker','ps','-aq']).stdout.strip() and
                not runner(['docker','volume','ls','-q']).stdout.strip(), 'runner resources changed before admission')
    free_bytes=shutil.disk_usage(os.environ['RUNNER_TEMP']).free
    pre.require(free_bytes >= 4*1024**3, 'at least 4 GiB free required before image load and runtime fixture')
    receipt = dict(status='PASS', scope='D5.1.13-runtime', gates='PASS', source_sha=source,
        run_id=os.environ['GITHUB_RUN_ID'],run_attempt=os.environ['GITHUB_RUN_ATTEMPT'],
        repository=pre.REPO,event_name='workflow_dispatch',runner_environment='github-hosted',
        runner_os='Linux',runner_arch='X64',allowed_images=[v['config'] for v in images.values()])
    pre.write(out,'admission.json',dict(**receipt,images=images,medium_unknown_accepted=False,
                                     free_bytes_before_load=free_bytes,
                                     provenance='UNSIGNED',sbom='UNSIGNED',reproducibility='UNPROVEN'))
    return receipt, images
