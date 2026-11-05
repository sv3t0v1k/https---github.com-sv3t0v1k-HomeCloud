#!/usr/bin/python3 -IS
"""Root-only TEST discovery; fetch trusted Git objects and publish a UI hint."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import tempfile
import time

ROOT = Path('/home/hs/homecloud-test')
ANCHOR = Path('/usr/local/sbin/homecloud-update-discover')
VERIFIER = Path('/usr/local/sbin/homecloud-update-verify')
STATUS_DIR = Path('/var/lib/homecloud-update/status')
CANDIDATE = STATUS_DIR / 'available.json'
FORMAT = 'homecloud-host-test-candidate-v1'
SHA = re.compile(r'[a-f0-9]{40}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
GID = 65533
STATUS_READY = False


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def trusted_anchor_path(path):
    """Validate the root-owned installed anchor before executing its bytes."""
    require(path.is_absolute() and '..' not in path.parts, 'invalid installed anchor path')
    for node in reversed((path, *path.parents)):
        info = node.lstat()
        directory = node != path
        require(info.st_uid == 0 and not info.st_mode & 0o022 and
                (stat.S_ISDIR(info.st_mode) if directory else
                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                'unsafe installed anchor path')
        attrs = os.listxattr(node, follow_symlinks=False)
        require('system.posix_acl_access' not in attrs and
                'system.posix_acl_default' not in attrs,
                'ACL on installed anchor path')


def read_cache(path=CANDIDATE):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_gid == GID and stat.S_IMODE(info.st_mode) == 0o640 and
                info.st_nlink == 1 and 0 < info.st_size <= 4096, 'unsafe discovery cache')
        value = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    require(type(value) is dict and set(value) ==
            {'format', 'checkedAt', 'verifiedAt', 'sourceGitSha', 'commit',
             'manifestSha256', 'backendDigest', 'frontendDigest', 'schemaMigrations',
             'runId', 'attempt', 'artifactId'} and
            value['format'] == FORMAT and type(value['checkedAt']) is int and
            type(value['verifiedAt']) is int and 0 < value['verifiedAt'] <= value['checkedAt'] and
            all(type(value[key]) is str and SHA.fullmatch(value[key])
                for key in ('sourceGitSha', 'commit')) and
            type(value['manifestSha256']) is str and HASH.fullmatch(value['manifestSha256']) and
            all(type(value[key]) is str and DIGEST.fullmatch(value[key])
                for key in ('backendDigest', 'frontendDigest')) and
            type(value['schemaMigrations']) is list and len(value['schemaMigrations']) > 0 and
            all(type(name) is str and re.fullmatch(r'[A-Za-z0-9]+', name)
                for name in value['schemaMigrations']) and
            len(set(value['schemaMigrations'])) == len(value['schemaMigrations']),
            'invalid discovery cache')
    require(all(type(value[key]) is int and value[key] > 0 for key in
                ('runId', 'attempt', 'artifactId')),
            'invalid discovery run identity')
    return value


def publish(value, path=CANDIDATE):
    payload = json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n'
    require(len(payload.encode()) <= 4096, 'oversized discovery result')
    fd, name = tempfile.mkstemp(prefix='.candidate-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, GID)
            stream.write(payload)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def protected_head(client, source):
    branch = client.api_json('/branches/test')
    source.require(type(branch) is dict and branch.get('protected') is True and
                   type(branch.get('commit')) is dict and
                   type(branch['commit'].get('sha')) is str and
                   source.SHA.fullmatch(branch['commit']['sha']),
                   'invalid protected TEST head')
    return branch, branch['commit']['sha']


def fetch_current(modules, client, branch, head):
    source, contract = modules['update_source'], modules['test_contract']
    runs = client.api_json(
        f'/actions/runs?branch=test&event=push&head_sha={head}&per_page=10')
    source.require(type(runs) is dict and type(runs.get('workflow_runs')) is list,
                   'invalid TEST run inventory')
    selected = [item for item in runs['workflow_runs'] if type(item) is dict and
                item.get('head_sha') == head and item.get('head_branch') == 'test' and
                item.get('event') == 'push' and
                item.get('path') == '.github/workflows/ci-v2-fast.yml' and
                item.get('status') == 'completed' and item.get('conclusion') == 'success' and
                type(item.get('id')) is int and item['id'] > 0 and
                type(item.get('run_attempt')) is int and item['run_attempt'] > 0]
    source.require(len(selected) == 1, 'missing or ambiguous successful TEST run')
    run = selected[0]
    inventory = client.api_json(f"/actions/runs/{run['id']}/artifacts?per_page=100")
    source.require(type(inventory) is dict and type(inventory.get('artifacts')) is list,
                   'invalid TEST artifact inventory')
    artifacts = [item for item in inventory['artifacts'] if type(item) is dict and
                 item.get('name') == f"test-channel-{run['run_attempt']}" and
                 item.get('expired') is False and
                 type(item.get('workflow_run')) is dict and
                 item['workflow_run'].get('id') == run['id'] and
                 item['workflow_run'].get('head_sha') == head and
                 type(item.get('id')) is int and item['id'] > 0]
    source.require(len(artifacts) == 1, 'missing or ambiguous TEST artifact')
    artifact = artifacts[0]
    raw = client.artifact_json(artifact['id'])
    source.require(type(raw) is dict, 'invalid TEST manifest')
    validated = modules['update_evidence'].verify(
        raw.get('manifest_sha256'), branch, run, artifact, raw, contract.shape)
    manifest = source.fetch_test_evidence(validated['manifest_sha256'], contract.shape, client)
    return manifest, run['id'], run['run_attempt'], artifact['id']


def recheck_cache(value, modules, client, head):
    """Refresh UI freshness only while the original run, artifact and digests exist."""
    source = modules['update_source']
    run = client.api_json(f"/actions/runs/{value['runId']}")
    source.require(type(run) is dict and run.get('id') == value['runId'] and
                   run.get('run_attempt') == value['attempt'] and
                   run.get('head_sha') == head and run.get('head_branch') == 'test' and
                   run.get('event') == 'push' and
                   run.get('path') == '.github/workflows/ci-v2-fast.yml' and
                   run.get('status') == 'completed' and run.get('conclusion') == 'success',
                   'verified TEST run no longer current')
    inventory = client.api_json(f"/actions/runs/{value['runId']}/artifacts?per_page=100")
    source.require(type(inventory) is dict and type(inventory.get('artifacts')) is list,
                   'verified artifact inventory unavailable')
    matches = [item for item in inventory['artifacts'] if type(item) is dict and
               item.get('id') == value['artifactId'] and
               item.get('name') == f"test-channel-{value['attempt']}" and
               item.get('expired') is False and
               type(item.get('workflow_run')) is dict and
               item['workflow_run'].get('id') == value['runId'] and
               item['workflow_run'].get('head_sha') == head]
    source.require(len(matches) == 1, 'verified TEST artifact expired or removed')
    provenance = modules['provenance']
    repository = 'sv3t0v1k/https---github.com-sv3t0v1k-homecloud'
    for role in ('backend', 'frontend'):
        provenance.Registry(repository + '/' + role).index(value[role + 'Digest'])


def fetch_protected_target(source, current, head):
    """Fetch only origin/test objects; leave the working tree and HEAD intact."""
    source.git('-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
               'fetch', '--no-tags', 'origin', 'test')
    require(source.git('rev-parse', 'refs/remotes/origin/test').strip() == head.encode() and
            source.git('cat-file', '-t', head).strip() == b'commit' and
            source.head().decode('ascii') == current,
            'protected target object unavailable or checkout changed')


def main():
    global STATUS_READY
    require(os.geteuid() == 0 and sys.flags.isolated and sys.flags.no_site and
            Path(__file__).absolute() == ANCHOR and len(sys.argv) == 1,
            'requires installed isolated root discovery')
    trusted_anchor_path(ANCHOR)
    trusted_anchor_path(VERIFIER)
    anchor = runpy.run_path(str(VERIFIER))
    modules = anchor['load_helpers'](ROOT)
    boundary = modules['boundary']
    boundary.trusted_path(ANCHOR)
    boundary.trusted_path(VERIFIER)
    boundary.validate_checkout(ROOT)
    for path, expected in anchor['QUALIFIED'].values():
        require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected,
                'unqualified host helper')
    boundary.trusted_path(STATUS_DIR, directory=True)
    info = STATUS_DIR.stat()
    require(info.st_uid == 0 and info.st_gid == GID and
            stat.S_IMODE(info.st_mode) == 0o750, 'unsafe status directory')
    STATUS_READY = True
    source = anchor['GitSource'](ROOT, boundary.clean_environment())
    current = source.head().decode('ascii')
    client = modules['update_source'].GitHubClient(os.environ.get('GH_TOKEN', ''))
    branch, head = protected_head(client, modules['update_source'])
    # Host-only Git fetch makes the protected target object available to the
    # pinned verifier without changing the checked-out application revision.
    fetch_protected_target(source, current, head)
    now = int(time.time())
    cached = read_cache()
    if (cached and cached['commit'] == head and cached['sourceGitSha'] == current and
            0 <= now - cached['verifiedAt'] < 43200):
        recheck_cache(cached, modules, client, head)
        _, final_head = protected_head(client, modules['update_source'])
        require(final_head == head, 'protected TEST head changed during cache refresh')
        cached['checkedAt'] = now
        publish(cached)
        return
    manifest, run_id, attempt, artifact_id = fetch_current(modules, client, branch, head)
    require(manifest['commit'] == head, 'TEST head changed')
    raw = json.dumps(dict(format='homecloud-update-request-v1', channel='test',
                          manifestSha256=manifest['manifest_sha256'])).encode()
    def trust_check():
        boundary.trusted_path(ANCHOR)
        boundary.trusted_path(VERIFIER)
        boundary.validate_checkout(ROOT)
        for path, expected in anchor['QUALIFIED'].values():
            require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected,
                    'host helper changed during discovery')
    result = anchor['verify_request'](raw, modules, client, source, trust_check)
    require(result['status'] == 'HOST_VERIFIED_READ_ONLY' and
            result['manifestSha256'] == manifest['manifest_sha256'] and
            result['commit'] == head and source.head().decode('ascii') == current,
            'host verification changed')
    require(current == head or source.git('merge-base', '--is-ancestor', current, head) == b'',
            'target is not descendant of installed source')
    value = dict(format=FORMAT, checkedAt=now, verifiedAt=now,
                 sourceGitSha=current, commit=head,
                 manifestSha256=manifest['manifest_sha256'],
                 backendDigest=manifest['images']['backend']['digest'],
                 frontendDigest=manifest['images']['frontend']['digest'],
                 schemaMigrations=[item['name'] for item in manifest['schema_migrations']],
                 runId=run_id, attempt=attempt, artifactId=artifact_id)
    _, final_head = protected_head(client, modules['update_source'])
    require(final_head == head, 'protected TEST head changed during discovery')
    publish(value)


def invalidate():
    if not STATUS_READY:
        return
    try:
        CANDIDATE.unlink(missing_ok=True)
        directory = os.open(STATUS_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    except OSError:
        pass


if __name__ == '__main__':
    try:
        main()
    except Exception:
        invalidate()
        sys.exit('STOP: TEST discovery unavailable; no candidate published')
