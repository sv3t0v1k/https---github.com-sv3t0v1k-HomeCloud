#!/usr/bin/env python3
"""Fail-closed project-test installer; only invoked by the root-only wrapper."""
import fcntl
import gzip
import tarfile
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import time
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime'
CHANNEL = RUNTIME / 'test-channel'
ENV_FILE = RUNTIME / 'runtime.env'
RECOVERY = Path('/etc/homecloud-test/recovery.env')
SHA = re.compile(r'[a-f0-9]{40}\Z')
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}\Z')
TX_FORMAT = 'homecloud-test-transaction-v1'
MIGRATION_FILE = re.compile(r'[0-9]+-[A-Za-z0-9]+\.ts\Z')
PIN = re.compile(r'ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*/(?:backend|frontend)@sha256:[a-f0-9]{64}\Z')
LOCKED_FILES = ('docker-compose.yml', 'docker-compose.production.yml',
                'docker-compose.project-test.yml', 'docker-compose.project-test-updates.yml',
                'deploy/linux/project-test.sh', 'deploy/linux/test-compose-profile.py', 'deploy/linux/test-job.py',
                'deploy/linux/preflight.py', 'deploy/linux/test-channel.py',
                'scripts/ci/test-channel.py', 'scripts/backup.sh',
                'scripts/recovery_config.py', 'scripts/recovery_storage.py',
                'scripts/recovery-config.sh', 'scripts/recovery-storage.sh',
                'scripts/recovery-pending.sql', 'deploy/linux/root-boundary.py', 'deploy/linux/startup-gate.sh',
                'scripts/ci/provenance.py')

CI_ONLY_SCRIPT_CHANGES = frozenset({
    'scripts/ci/check-excluded-history.py',
    'scripts/ci/install-npm.py',
    'scripts/ci/install-oci-scanner.sh',
    'scripts/ci/install-trivy.sh',
    'scripts/ci/qualify-stages.sh',
    'scripts/ci/stage-cache-proof.py',
    'scripts/ci/test-check-excluded-history.py',
    'scripts/ci/test-install-npm.py',
    'scripts/ci/test-install-oci-scanner.py',
    'scripts/ci/test-stage-cache-proof.py',
    'scripts/ci/test-update-host-verify.py',
    'scripts/ci/test-test-channel.py',
})

boundary_spec = importlib.util.spec_from_file_location('root_boundary_installer', ROOT / 'deploy/linux/root-boundary.py')
boundary = importlib.util.module_from_spec(boundary_spec)
boundary_spec.loader.exec_module(boundary)
if __name__ == '__main__':
    if not sys.flags.isolated:
        raise SystemExit('STOP: use trusted launcher with isolated Python')
    boundary.validate_checkout(ROOT)

spec = importlib.util.spec_from_file_location('test_channel_contract', ROOT / 'scripts/ci/test-channel.py')
contract = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(ROOT / 'scripts/ci'))
spec.loader.exec_module(contract)
profile_spec = importlib.util.spec_from_file_location('test_compose_profile_installer', ROOT / 'deploy/linux/test-compose-profile.py')
profile = importlib.util.module_from_spec(profile_spec)
profile_spec.loader.exec_module(profile)


class Stop(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Stop(reason)


def run(*args, env=None, timeout=300, capture=True):
    if args[0] == 'git':
        args = ('git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', *args[1:])
    result = subprocess.run(args, cwd=ROOT, env=env if env is not None else boundary.clean_environment(), stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, timeout=timeout)
    require(result.returncode == 0, 'failed operation: ' + Path(args[0]).name)
    return result.stdout.strip() if capture else ''


def compose(*args, env=None, timeout=300):
    files = profile.files()
    return run('docker', '--host', 'unix:///var/run/docker.sock', 'compose',
               '--project-directory', str(ROOT), '--env-file', str(ENV_FILE),
               *(part for path in files for part in ('-f', str(path))),
               *args, env=env, timeout=timeout)


def private_file(path):
    boundary.trusted_path(path)
    require(path.is_absolute() and not path.is_symlink() and path.is_file(), 'missing private file')
    s = path.stat()
    require(s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o600, 'private file must be root:0600')
    return path


def private_dir(path):
    boundary.trusted_path(path, directory=True)
    require(path.is_dir() and not path.is_symlink(), 'missing private directory')
    s = path.stat()
    require(s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o700, 'private directory must be root:0700')


def acquire_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require(os.fstat(fd).st_uid == os.geteuid() and
                stat.S_IMODE(os.fstat(fd).st_mode) == 0o600, 'unsafe install lock')
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Stop('another TEST install is in progress') from None
        return fd
    except Exception:
        os.close(fd)
        raise


def acquire_readonly_lock(path):
    """Inspect an existing install lock without creating or modifying host state."""
    require(not path.is_symlink() and path.is_file(), 'install lock missing or unsafe')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
                'unsafe install lock')
        try: fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError: raise Stop('TEST install currently running') from None
        return fd
    except Exception:
        os.close(fd)
        raise


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.test-channel-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def guard_no_pending():
    path = CHANNEL / 'pending.json'
    require(not path.is_symlink() and not path.exists(),
            'incomplete TEST transaction; use read-only recovery-inspect and operator reconciliation')


def record_phase(transaction, phase):
    require(transaction.get('format') == TX_FORMAT, 'invalid TEST transaction')
    require(phase in ('CHECKOUT', 'VERIFY_IMAGES', 'PREBACKUP', 'STOP_SERVICES', 'BACKUP',
                      'WRITE_REFS', 'START_SERVICES', 'SMOKE', 'COMMIT_STATE',
                      'COMPLETE'), 'invalid transaction phase')
    transaction['phase'] = phase  # This phase MAY have started, not necessarily completed.
    transaction['updated_at'] = datetime.now(timezone.utc).isoformat()
    atomic_json(CHANNEL / 'pending.json', transaction)


def recovery_report(transaction, state, git_sha, configured_refs):
    """Read-only, conservative evidence; never infer a safe automatic rollback."""
    require(isinstance(transaction, dict) and transaction.get('format') == TX_FORMAT
            and isinstance(transaction.get('before'), dict)
            and isinstance(transaction.get('target'), dict), 'invalid TEST transaction evidence')
    before, target = transaction['before'], transaction['target']
    require(isinstance(before.get('git_sha'), str) and SHA.fullmatch(before['git_sha'])
            and isinstance(target.get('commit'), str) and SHA.fullmatch(target['commit'])
            and isinstance(before.get('images'), dict) and isinstance(target.get('refs'), dict)
            and set(before['images']) == {'backend', 'frontend'}
            and set(target['refs']) == {'backend', 'frontend'}, 'invalid transaction checkpoint')
    require(isinstance(configured_refs, dict) and set(configured_refs) == {'backend', 'frontend'},
            'invalid runtime image refs')
    old_refs = {role: before['images'][role]['ref'] for role in ('backend', 'frontend')}
    return {
        'status': 'MANUAL_RECOVERY_REQUIRED', 'read_only': True,
        'phase_may_have_started': transaction.get('phase', 'UNKNOWN'),
        'checkout_sha': git_sha,
        'checkout_matches_previous': git_sha == before['git_sha'],
        'checkout_matches_target': git_sha == target['commit'],
        'state_matches_previous': state['active']['images'] == before['images'],
        'configured_refs_match_previous': configured_refs == old_refs,
        'configured_refs_match_target': configured_refs == target['refs'],
        'automatic_rollback': False,
        'backup_id': transaction.get('backup_id'),
        'message': 'STOP: inspect live containers, applied migrations, backup integrity and disk mounts before any manual action',
    }


def inspect_recovery():
    """No writes or Docker commands; cannot be confused with a repair action."""
    require(os.geteuid() == 0 and str(ROOT) == '/home/hs/homecloud-test',
            'wrong host/project/privilege')
    private_dir(RUNTIME); private_dir(CHANNEL)
    fd = acquire_readonly_lock(CHANNEL / 'install.lock')
    try:
        transaction = json.loads(private_file(CHANNEL / 'pending.json').read_text())
        state = load_state()
        values = env_values()
        refs = {role: values.get('RELEASE_' + role.upper() + '_IMAGE')
                for role in ('backend', 'frontend')}
        report = recovery_report(transaction, state, run('git', 'rev-parse', 'HEAD'), refs)
        return report
    finally:
        os.close(fd)


def load_state():
    state = json.loads(private_file(CHANNEL / 'state.json').read_text())
    require(state.get('format') == 'homecloud-test-install-v1'
            and isinstance(state.get('active'), dict)
            and isinstance(state.get('history'), list), 'invalid install journal')
    active = state['active']
    require(set(active.get('images', {})) == {'backend', 'frontend'}
            and isinstance(active.get('schema_migrations'), list), 'incomplete installed checkpoint')
    for role in ('backend', 'frontend'):
        image = active['images'][role]
        require(isinstance(image, dict) and set(image) == {'ref', 'id', 'sha'}
                and isinstance(image['ref'], str) and image['ref']
                and IMAGE_ID.fullmatch(image['id']) and SHA.fullmatch(image['sha']),
                'invalid installed image checkpoint')
    return state


def migration_names(manifest):
    return sorted(item['name'] for item in manifest['schema_migrations'])


def plan(manifest, state, applied, actual, rollback=False):
    contract.shape(manifest)
    active = state['active']
    require(actual == active['images'], 'running images differ from installed checkpoint')
    require(isinstance(applied, list) and len(set(applied)) == len(applied)
            and all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9]+', x) for x in applied),
            'invalid applied migration inventory')
    require(active['schema_migrations'] == manifest['schema_migrations']
            and sorted(applied) == migration_names(manifest),
            'migration source/applied mismatch; automatic install blocked')
    if all(active['images'][role]['sha'] == manifest['commit'] and
           active['images'][role]['ref'] == image_ref(manifest, role)
           for role in ('backend', 'frontend')):
        return {'decision': 'ALREADY_INSTALLED', 'source_sha': manifest['commit']}
    if rollback:
        require(active.get('manifest') is not None, 'unqualified initial checkpoint cannot be rollback source')
        require(any((entry.get('manifest') or {}).get('manifest_sha256') == manifest['manifest_sha256']
                    for entry in state['history']), 'rollback target absent from journal')
        require(active['manifest']['schema_migrations'] == manifest['schema_migrations'],
                'rollback schema source differs')
    return {'decision': 'ROLLBACK' if rollback else 'INSTALL', 'source_sha': manifest['commit'],
            'backend_digest': manifest['images']['backend']['digest'],
            'frontend_digest': manifest['images']['frontend']['digest']}


def env_values():
    private_file(ENV_FILE)
    values = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        key, sep, val = line.partition('=')
        require(bool(sep) and re.fullmatch(r'[A-Z][A-Z0-9_]*', key)
                and key not in values, 'invalid runtime env structure')
        values[key] = val.strip('"\'')
    return values


def running_images(expected_refs):
    """Read actual container image refs/IDs, never borrow references from state.json."""
    actual = {}
    for role in ('backend', 'frontend'):
        cid = compose('ps', '--all', '-q', role)
        require(bool(re.fullmatch(r'[a-f0-9]{12,64}', cid)), 'missing installed container')
        container = json.loads(run('docker', '--host', 'unix:///var/run/docker.sock',
                                   'inspect', cid))
        require(isinstance(container, list) and len(container) == 1,
                'invalid installed container inspection')
        item = container[0]
        image_id = item.get('Image')
        image_ref_value = (item.get('Config') or {}).get('Image')
        require(image_ref_value == expected_refs[role] and
                isinstance(image_id, str) and IMAGE_ID.fullmatch(image_id),
                'running container image reference mismatch')
        info = json.loads(run('docker', '--host', 'unix:///var/run/docker.sock',
                              'image', 'inspect', image_id))
        require(isinstance(info, list) and len(info) == 1 and info[0].get('Id') == image_id,
                'image identity mismatch')
        labels = (info[0].get('Config') or {}).get('Labels') or {}
        actual[role] = {'ref': image_ref_value, 'id': image_id,
                        'sha': labels.get('org.opencontainers.image.revision')}
    return actual


def active_images(state):
    return running_images({role: state['active']['images'][role]['ref']
                           for role in ('backend', 'frontend')})


def verify_started_images(manifest, ids):
    """Compose must run the exact verified pair, not merely return success."""
    expected = {role: image_ref(manifest, role) for role in ('backend', 'frontend')}
    actual = running_images(expected)
    for role in ('backend', 'frontend'):
        require(actual[role] == {'ref': expected[role], 'id': ids[role],
                                 'sha': manifest['commit']},
                'started TEST image differs from verified digest')
    return actual



def committed_schema(commit):
    """Read migration content from the installed backend commit, never current HEAD."""
    require(isinstance(commit, str) and SHA.fullmatch(commit), 'invalid backend revision')
    paths = run('git', 'ls-tree', '-r', '--name-only', commit, '--',
                'backend/src/migrations').splitlines()
    require(bool(paths), 'backend source migrations unavailable')
    result = []
    for name in sorted(paths):
        filename = name.removeprefix('backend/src/migrations/')
        require(name.startswith('backend/src/migrations/') and
                MIGRATION_FILE.fullmatch(filename), 'unsupported installed migration file')
        source = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'show', commit + ':' + name], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=boundary.clean_environment())
        require(source.returncode == 0, 'installed migration source unavailable')
        try:
            classes = re.findall(r'export class ([A-Za-z0-9]+)', source.stdout.decode('utf-8'))
        except UnicodeDecodeError:
            raise Stop('invalid installed migration source') from None
        require(len(classes) == 1, 'invalid installed migration class')
        result.append({'name': classes[0], 'file': filename,
                       'sha256': hashlib.sha256(source.stdout).hexdigest()})
    require(len({item['name'] for item in result}) == len(result),
            'duplicate installed migration class')
    return result


def baseline_from_evidence(images, schema, applied):
    """Generate a read-only initial checkpoint proposal; NEVER install it."""
    require(isinstance(images, dict) and set(images) == {'backend', 'frontend'},
            'incomplete installed images')
    for role in ('backend', 'frontend'):
        item = images[role]
        require(isinstance(item, dict) and set(item) == {'ref', 'id', 'sha'}
                and isinstance(item['ref'], str) and bool(item['ref'])
                and not any(char.isspace() for char in item['ref'])
                and isinstance(item['id'], str) and IMAGE_ID.fullmatch(item['id'])
                and isinstance(item['sha'], str) and SHA.fullmatch(item['sha']),
                'invalid installed image evidence')
    require(isinstance(schema, list) and schema and
            all(isinstance(x, dict) and set(x) == {'name', 'file', 'sha256'} and
                isinstance(x['name'], str) and re.fullmatch(r'[A-Za-z0-9]+', x['name']) and
                isinstance(x['file'], str) and MIGRATION_FILE.fullmatch(x['file']) and
                isinstance(x['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', x['sha256'])
                for x in schema), 'invalid installed schema evidence')
    names = [x['name'] for x in schema]
    require(len(names) == len(set(names)) and isinstance(applied, list) and
            all(isinstance(x, str) for x in applied) and
            len(applied) == len(set(applied)) and sorted(applied) == sorted(names),
            'installed schema and database migration inventory differ')
    return {'format': 'homecloud-test-install-v1',
            'active': {'images': images, 'schema_migrations': schema, 'manifest': None},
            'history': []}


def inspect_baseline():
    """Read-only host audit. Operator must separately approve any state adoption."""
    require(os.geteuid() == 0 and str(ROOT) == '/home/hs/homecloud-test',
        'wrong host/project/privilege')
    private_dir(RUNTIME)
    private_dir(CHANNEL)
    require(not (CHANNEL / 'state.json').exists() and
        not (CHANNEL / 'state.json').is_symlink(),
        'initial state already exists; refuse baseline replacement')
    require(run('git', 'status', '--porcelain', '--untracked-files=no') == '',
            'dirty project checkout')
    run(str(ROOT / 'deploy/linux/project-test.sh'), 'preflight')
    values = env_values()
    images = {}
    for role in ('backend', 'frontend'):
        ref = values.get('RELEASE_' + role.upper() + '_IMAGE', '')
        require(bool(ref) and not any(x.isspace() for x in ref),
                'invalid installed runtime image reference')
        cid = compose('ps', '--all', '-q', role)
        require(bool(re.fullmatch(r'[a-f0-9]{12,64}', cid)),
                'missing installed container')
        image_id = run('docker', '--host', 'unix:///var/run/docker.sock', 'inspect',
                       '--format', '{{.Image}}', cid)
        require(bool(IMAGE_ID.fullmatch(image_id)), 'invalid installed image ID')
        info = json.loads(run('docker', '--host', 'unix:///var/run/docker.sock',
                              'image', 'inspect', image_id))[0]
        labels = info.get('Config', {}).get('Labels') or {}
        revision = labels.get('org.opencontainers.image.revision', '')
        require(info.get('Id') == image_id and info.get('Os') == 'linux' and
                info.get('Architecture') == 'amd64' and isinstance(revision, str) and
                SHA.fullmatch(revision), 'installed image identity is not verifiable')
        images[role] = {'ref': ref, 'id': image_id, 'sha': revision}
    schema = committed_schema(images['backend']['sha'])
    proposal = baseline_from_evidence(images, schema, applied_migrations())
    return {'status': 'READ_ONLY_PROPOSAL', 'written': False,
            'requires_operator_approval': True, 'state': proposal}


def applied_migrations():
    out = compose('exec', '-T', 'db', 'sh', '-c',
                  'psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM migrations ORDER BY name"')
    return out.splitlines()


def image_ref(manifest, role):
    item = manifest['images'][role]
    ref = item['repository'] + '@' + item['digest']
    require(bool(PIN.fullmatch(ref)), 'invalid TEST digest reference')
    return ref


def verify_pulled(manifest):
    ids = {}
    for role in ('backend', 'frontend'):
        ref = image_ref(manifest, role)
        run('docker', '--host', 'unix:///var/run/docker.sock', 'pull', '--platform', 'linux/amd64', ref, timeout=900)
        info = json.loads(run('docker', '--host', 'unix:///var/run/docker.sock', 'image', 'inspect', ref))[0]
        labels = info.get('Config', {}).get('Labels') or {}
        require(ref in info.get('RepoDigests', []) and info.get('Os') == 'linux'
                and info.get('Architecture') == 'amd64'
                and labels.get('org.opencontainers.image.revision') == manifest['commit']
                and labels.get('org.opencontainers.image.source') == 'https://github.com/' + manifest['repository']
                and labels.get('io.homecloud.role') == role
                and labels.get('io.homecloud.pair') == manifest['commit'],
                'pulled TEST image binding mismatch')
        ids[role] = info['Id']
    return ids


def verify_ci_only_blob(oid):
    """Verify actual SHA-1 Git blob bytes, not only tree metadata."""
    require(bool(re.fullmatch(r'[a-f0-9]{40}', oid)),
            'unsafe CI-only Git object')
    require(run('git', 'cat-file', '-t', oid) == 'blob',
            'unsafe CI-only Git object')
    size = int(run('git', 'cat-file', '-s', oid))
    require(0 <= size <= 16 * 1024 * 1024,
            'unsafe CI-only Git object')
    result = subprocess.run(
        ['git', '-c', 'core.hooksPath=/dev/null',
         '-c', 'core.fsmonitor=false',
         'cat-file', 'blob', oid],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=30, env=boundary.clean_environment())
    raw = result.stdout
    actual = hashlib.sha1(
        b'blob ' + str(len(raw)).encode('ascii') + b'\0' + raw
    ).hexdigest()
    require(result.returncode == 0 and len(raw) == size
            and actual == oid, 'unsafe CI-only Git object')


def precheck_source(manifest, rollback):
    """Complete all avoidable Git/source checks BEFORE creating pending.json."""
    require(run('git', 'status', '--porcelain', '--untracked-files=no') == '',
            'dirty project checkout')
    current = run('git', 'rev-parse', 'HEAD')
    require(bool(SHA.fullmatch(current)), 'invalid current source revision')
    origin = run('git', 'remote', 'get-url', 'origin')
    require(origin in ('https://github.com/' + manifest['repository'],
                       'https://github.com/' + manifest['repository'] + '.git'),
            'TEST repository origin mismatch')
    if rollback:
        run('git', 'cat-file', '-e', manifest['commit'] + '^{commit}')
    else:
        require_current_test_head(manifest)
        run('git', 'fetch', '--no-tags', 'origin', 'test', timeout=180)
        require(run('git', 'rev-parse', 'FETCH_HEAD') == manifest['commit'],
                'fetched test source mismatch')
    # Additional helper modules must not shadow imports after target checkout.
    require(
        run('git', 'rev-parse', current + ':deploy') ==
        run('git', 'rev-parse', manifest['commit'] + ':deploy'),
        'root helper tree changed; manual qualification required'
    )
    diff = run(
        'git', 'diff-tree', '-r', '-z', '--no-renames',
        '--name-only', current, manifest['commit'],
        '--', 'scripts'
    )
    changed = {path for path in diff.split(chr(0)) if path}
    require(
        changed <= CI_ONLY_SCRIPT_CHANGES,
        'root helper tree changed; manual qualification required'
    )
    for path in changed:
        entry = run(
            'git', 'ls-tree', manifest['commit'], '--', path
        ).split(chr(9))
        require(
            len(entry) == 2 and entry[1] == path and
            len(entry[0].split()) == 3 and
            entry[0].split()[:2] in
            (['100644', 'blob'], ['100755', 'blob']),
            'unsafe CI-only Git object'
        )
        verify_ci_only_blob(entry[0].split()[2])
    for name in LOCKED_FILES:
        source = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'show', manifest['commit'] + ':' + name], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=boundary.clean_environment())
        require(source.returncode == 0 and hashlib.sha256(source.stdout).digest() ==
                hashlib.sha256((ROOT / name).read_bytes()).digest(),
                'operational/Compose contract changed; manual qualification required')
    return current


def require_current_test_head(manifest):
    live = run('git', 'ls-remote', 'origin', 'refs/heads/test').split()
    require(len(live) == 2 and live[0] == manifest['commit'] and
            live[1] == 'refs/heads/test', 'test branch moved or unavailable')


def safe_checkout(manifest, rollback):
    require(run('git', 'status', '--porcelain', '--untracked-files=no') == '',
            'dirty project checkout')
    current = run('git', 'rev-parse', 'HEAD')
    if not rollback:
        # Race guard: a new push after precheck must fail closed before checkout.
        require_current_test_head(manifest)
    run('git', 'checkout', '--detach', manifest['commit'])
    boundary.validate_checkout(ROOT)
    contract.source_check(manifest)
    return current


def rewrite_refs(manifest):
    original = ENV_FILE.read_text()
    lines = original.splitlines(keepends=True)
    for role in ('backend', 'frontend'):
        key = 'RELEASE_' + role.upper() + '_IMAGE'
        hits = [i for i, line in enumerate(lines) if line.startswith(key + '=')]
        require(len(hits) == 1, 'missing or duplicate runtime image pin')
        lines[hits[0]] = key + '=' + image_ref(manifest, role) + '\n'
    fd, name = tempfile.mkstemp(prefix='.runtime-env-', dir=RUNTIME)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.writelines(lines); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, ENV_FILE)
        directory = os.open(RUNTIME, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def backup_configuration():
    current = env_values()
    values = boundary.validate_backup_configuration(RECOVERY, ROOT, current)
    # Configuration used by nested Compose must describe precisely this runtime.
    backup_only = {'BACKUP_DIR', 'STORAGE_PATH', 'STORAGE_VOLUME', 'BACKEND_IMAGE',
                   'RETENTION_DAYS', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'}
    for key, value in values.items():
        if key not in backup_only and not key.startswith('BACKUP_'):
            require(current.get(key) == value, 'recovery runtime configuration drift')
    return values


def sync_recovery_pins(before, after):
    """Move only the three image pins between verified journal checkpoints."""
    current = env_values()
    values = boundary.validate_backup_configuration(RECOVERY, ROOT, current)
    pins = {'RELEASE_BACKEND_IMAGE': 'backend', 'RELEASE_FRONTEND_IMAGE': 'frontend',
            'BACKEND_IMAGE': 'backend'}
    backup_only = {'BACKUP_DIR', 'STORAGE_PATH', 'STORAGE_VOLUME', 'RETENTION_DAYS',
                   'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'}
    for key, value in values.items():
        if key not in pins and key not in backup_only and not key.startswith('BACKUP_'):
            require(current.get(key) == value, 'recovery runtime configuration drift')
    for key, role in pins.items():
        require(bool(PIN.fullmatch(before['images'][role]['ref'])),
                'invalid previous recovery image pin')
        require(values.get(key) == before['images'][role]['ref'],
                'recovery image pin differs from verified checkpoint')
        require(bool(PIN.fullmatch(after['images'][role]['ref'])),
                'invalid target recovery image pin')
    original = private_file(RECOVERY).read_text()
    lines = original.splitlines(keepends=True)
    seen = set()
    for index, line in enumerate(lines):
        key, separator, value = line.rstrip('\n').partition('=')
        if key not in pins or not separator:
            continue
        require(key not in seen and value == before['images'][pins[key]]['ref'],
                'noncanonical recovery image pin')
        seen.add(key)
        lines[index] = key + '=' + after['images'][pins[key]]['ref'] + '\n'
    require(seen == set(pins), 'missing recovery image pin')
    if all(before['images'][role]['ref'] == after['images'][role]['ref'] for role in pins.values()):
        return
    fd, name = tempfile.mkstemp(prefix='.recovery-env-', dir=RECOVERY.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), 0, 0)
            stream.writelines(lines)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, RECOVERY)
        directory = os.open(RECOVERY.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def ensure_recovery_pins(state):
    active = state['active']
    recovery = boundary.validate_backup_configuration(RECOVERY, ROOT, env_values())
    pins = {'RELEASE_BACKEND_IMAGE': 'backend', 'RELEASE_FRONTEND_IMAGE': 'frontend',
            'BACKEND_IMAGE': 'backend'}
    if all(recovery.get(key) == active['images'][role]['ref'] for key, role in pins.items()):
        sync_recovery_pins(active, active)
    else:
        require(bool(state['history']), 'recovery image pins need operator review')
        sync_recovery_pins(state['history'][-1], active)


def backup(active):
    values = backup_configuration()
    current = env_values()
    environment = {'HOME': '/root', 'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                   'DOCKER_HOST': 'unix:///var/run/docker.sock',
                   'DOCKER_CONFIG': '/etc/homecloud-test/docker',
                   'HOMECLOUD_ENV_FILE': str(RECOVERY),
                   'RELEASE_BACKEND_IMAGE': active['images']['backend']['ref'],
                   'RELEASE_FRONTEND_IMAGE': active['images']['frontend']['ref'],
                   'BACKEND_IMAGE': active['images']['backend']['ref']}
    require(current.get('RELEASE_BACKEND_IMAGE') == environment['RELEASE_BACKEND_IMAGE']
            and current.get('RELEASE_FRONTEND_IMAGE') == environment['RELEASE_FRONTEND_IMAGE'],
            'runtime image refs differ from checkpoint')
    # The TEST admin ID is part of backend Compose config. Keep the backup
    # helper's config hash identical to the running, pinned backend container.
    if 'UPDATE_ADMIN_USER_ID' in current:
        admin_id = current['UPDATE_ADMIN_USER_ID']
        require(isinstance(admin_id, str) and
                re.fullmatch(r'(?:[1-9][0-9]{0,18})?', admin_id) is not None,
                'invalid TEST update admin ID')
        environment['UPDATE_ADMIN_USER_ID'] = admin_id
    output = run('bash', str(ROOT / 'scripts/backup.sh'), '--yes', env=environment, timeout=3600)
    completed = []
    for line in output.splitlines():
        if line.startswith('{'):
            try: item = json.loads(line)
            except json.JSONDecodeError: continue
            if item.get('event') == 'backup_completed': completed.append(item.get('backup_id'))
    require(len(completed) == 1 and isinstance(completed[0], str) and completed[0],
            'verified backup completion missing')
    verify_backup(completed[0], active)
    return completed[0]


def verify_backup(backup_id, active):
    """Independently verify published bytes; never treat an online copy as a snapshot."""
    require(bool(re.fullmatch(r'[0-9]{8}_[0-9]{6}_[a-f0-9]{8}', backup_id)), 'invalid backup identity')
    values = backup_configuration()
    directory = Path(values.get('BACKUP_DIR', str(ROOT / 'backups')))
    meta_path = private_file(directory / ('homecloud_' + backup_id + '.meta'))
    raw = meta_path.read_bytes()
    sidecar = private_file(Path(str(meta_path) + '.sha256')).read_text()
    require(sidecar == hashlib.sha256(raw).hexdigest() + '  ' + meta_path.name + '\n', 'backup metadata integrity failure')
    meta = json.loads(raw)
    require(meta.get('format_version') == '1' and meta.get('backup_id') == backup_id, 'backup metadata identity failure')
    artifacts = {}
    for key, name in (('db_dump', 'homecloud_db_' + backup_id + '.sql.gz'),
                      ('storage_archive', 'homecloud_storage_' + backup_id + '.tar.gz')):
        require(meta.get(key) == name, 'backup artifact name mismatch')
        path = private_file(directory / name)
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
            os.fsync(stream.fileno())
        require(path.stat().st_size > 0 and path.stat().st_size == meta.get(key + '_size')
                and digest.hexdigest() == meta.get(key + '_sha256'), 'backup artifact integrity failure')
        artifacts[key] = path
    structure = False
    with gzip.open(artifacts['db_dump'], 'rb') as stream:
        for line in stream:
            if line.startswith((b'CREATE TABLE ', b'CREATE EXTENSION ')): structure = True
    require(structure, 'backup SQL structure missing')
    count = 0
    with tarfile.open(artifacts['storage_archive'], 'r:gz') as archive:
        for member in archive:
            require(not member.name.startswith('/') and '..' not in Path(member.name).parts
                    and (member.isfile() or member.isdir()), 'unsafe backup storage member')
            if member.isfile():
                count += 1
                with archive.extractfile(member) as stream:
                    while stream.read(1024 * 1024): pass
    require(count == meta.get('storage_file_count'), 'backup storage inventory mismatch')
    require(meta.get('migration_count') == len(active['schema_migrations']), 'backup migration inventory mismatch')
    for path in (meta_path, Path(str(meta_path) + '.sha256')):
        with path.open('rb') as stream: os.fsync(stream.fileno())
    validate_backup_database(artifacts['db_dump'], values, active)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def validate_backup_database(path, values, active):
    """Restore only into a disposable, network-isolated, size-limited tmpfs DB."""
    user, database = values.get('DB_USER', ''), values.get('DB_NAME', '')
    require(all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', x) for x in (user, database)),
            'invalid backup database identity')
    config = json.loads(compose('config', '--format', 'json'))
    image = config['services']['db']['image']
    inspected = json.loads(run('docker', '--host', 'unix:///var/run/docker.sock', 'image', 'inspect', image))
    require(len(inspected) == 1 and IMAGE_ID.fullmatch(inspected[0].get('Id', '')), 'invalid validation image')
    volumes = (inspected[0].get('Config') or {}).get('Volumes') or {}
    require(set(volumes).issubset({'/var/lib/postgresql/data', '/var/run/postgresql', '/tmp'}),
            'validation image declares unsupported volumes')
    token = secrets.token_hex(16)
    name = 'homecloud-test-backup-validation-' + token
    docker = ('docker', '--host', 'unix:///var/run/docker.sock')
    try:
        run(*docker, 'create', '--name', name, '--network', 'none', '--read-only',
            '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m',
            '--cpus', '1', '--pids-limit', '128',
            '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1073741824',
            '--tmpfs', '/var/run/postgresql:rw,noexec,nosuid,size=16777216',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216',
            '-e', 'PGDATA=/var/lib/postgresql/data', '-e', 'POSTGRES_USER=' + user,
            '-e', 'POSTGRES_DB=' + database, '-e', 'POSTGRES_PASSWORD=' + token,
            inspected[0]['Id'], 'postgres', '-c', 'listen_addresses=127.0.0.1')
        run(*docker, 'start', name)
        stable = 0
        for _ in range(30):
            try:
                logs = subprocess.run([*docker, 'logs', name], cwd=ROOT,
                                      env=boundary.clean_environment(),
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, timeout=5)
                require(logs.returncode == 0, 'validation database logs unavailable')
                initialized = 'PostgreSQL init process complete' in logs.stdout + logs.stderr
                answer = run(*docker, 'exec', name, 'psql', '-X', '-A', '-t',
                             '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database,
                             '-c', 'SELECT 1', timeout=5)
                stable = stable + 1 if initialized and answer == '1' else 0
                if stable == 3:
                    break
            except Stop:
                stable = 0
            time.sleep(1)
        require(stable == 3, 'isolated validation database unavailable')
        # Stream compressed data directly; decompression happens in the disposable
        # container. No host temporary SQL, bind mount, production connection or volume.
        with path.open('rb') as stream:
            restored = subprocess.run([*docker, 'exec', '-i', name, 'sh', '-c',
                'set -o pipefail; gzip -dc | psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                cwd=ROOT, stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=300)
        require(restored.returncode == 0, 'backup rejected by isolated PostgreSQL restore')
        names = run(*docker, 'exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                    '-U', user, '-d', database, '-c', 'SELECT name FROM migrations ORDER BY name').splitlines()
        require(names == sorted(x['name'] for x in active['schema_migrations']),
                'isolated backup migration inventory mismatch')
    finally:
        # A cleanup failure is a validation failure, never permission to install.
        run(*docker, 'rm', '-f', '-v', name, timeout=30)


def smoke():
    origin = env_values().get('PUBLIC_ORIGIN', '')
    require(origin.startswith('https://') and '\n' not in origin and '\r' not in origin,
            'invalid HTTPS smoke origin')
    cert_dir = env_values().get('TLS_CERT_DIR', '')
    require(Path(cert_dir).is_absolute(), 'missing TLS certificate path')
    cert = Path(cert_dir) / 'current' / 'fullchain.pem'
    require(cert.is_file() and not cert.is_symlink(), 'missing TLS certificate')
    code = run('curl', '--fail', '--silent', '--show-error', '--max-time', '15',
               '--cacert', str(cert), '--output', '/dev/null', '--write-out', '%{http_code}', origin + '/')
    require(code == '200', 'public HTTPS smoke failed')
    # The public reverse proxy intentionally denies /api/v1/health/ready.
    # Run the application's existing bounded DB/storage readiness probe only
    # inside the backend container. Its exit status is fail-closed.
    compose('exec', '-T', 'backend', 'node', 'docker/healthcheck.cjs', timeout=15)


def require_checkpoint_refs(state):
    """Reject drift before STOP_SERVICES, while services can still be inspected."""
    values = env_values()
    for role in ('backend', 'frontend'):
        require(values.get('RELEASE_' + role.upper() + '_IMAGE') ==
                state['active']['images'][role]['ref'],
                'runtime image refs differ from checkpoint')


def recover_before_start(transaction, state, applied):
    """Only reverse preparation; target code may never have been started.

    Never restore data or recreate containers. A crash skips this handler and the
    durable pending receipt requires manual recovery. Retain it even on success.
    """
    safe_phases = ('CHECKOUT', 'VERIFY_IMAGES', 'PREBACKUP', 'STOP_SERVICES', 'BACKUP', 'WRITE_REFS')
    status = 'MANUAL_RECOVERY_REQUIRED'
    try:
        require(transaction.get('phase') in safe_phases, 'target may have started')
        require(load_state() == state, 'installed checkpoint changed')
        require(sorted(applied_migrations()) == sorted(applied), 'schema drift before recovery')
        # Existing stopped containers still carry the pre-install IDs and refs.
        require(active_images(state) == state['active']['images'], 'old containers changed')
        transaction['recovery_status'] = 'RECOVERING'
        atomic_json(CHANNEL / 'pending.json', transaction)
        run('git', 'checkout', '--detach', transaction['before']['git_sha'])
        boundary.validate_checkout(ROOT)
        rewrite_checkpoint_refs(state['active']['images'])
        run(str(ROOT / 'deploy/linux/project-test.sh'), 'preflight')
        compose('start', '--wait', 'backend', 'frontend', 'ingress', timeout=900)
        require(active_images(state) == state['active']['images'], 'restored container identity mismatch')
        require(sorted(applied_migrations()) == sorted(applied), 'schema drift after recovery')
        smoke()
        status = 'ROLLED_BACK'
    except Exception:
        # Failed recovery never clears pending and never authorizes a data restore.
        pass
    transaction['recovery_status'] = status
    atomic_json(CHANNEL / 'pending.json', transaction)
    return status


def rewrite_checkpoint_refs(images):
    original = ENV_FILE.read_text()
    for role in ('backend', 'frontend'):
        key = 'RELEASE_' + role.upper() + '_IMAGE'
        require(len(re.findall(r'^' + key + '=', original, flags=re.M)) == 1,
                'missing or duplicate previous runtime pin')
        ref = images[role]['ref']
        require(isinstance(ref, str) and ref and not any(c.isspace() for c in ref), 'invalid previous runtime pin')
        original = re.sub(r'^' + key + r'=.*$', lambda _: key + '=' + ref, original, flags=re.M)
    fd, name = tempfile.mkstemp(prefix='.runtime-env-', dir=RUNTIME)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(original); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, ENV_FILE)
        directory = os.open(RUNTIME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def deploy(manifest, rollback=False, dry_run=False):
    require(os.geteuid() == 0 and str(ROOT) == '/home/hs/homecloud-test', 'wrong host/project/privilege')
    private_dir(RUNTIME); private_dir(CHANNEL)
    lock = CHANNEL / 'install.lock'
    fd = acquire_readonly_lock(lock) if dry_run else acquire_lock(lock)
    transaction_started = False
    try:
        guard_no_pending()
        state = load_state()
        require_checkpoint_refs(state)
        run(str(ROOT / 'deploy/linux/project-test.sh'), 'preflight')
        actual = active_images(state)
        applied = applied_migrations()
        decision = plan(manifest, state, applied, actual, rollback)
        if not dry_run:
            require(not (CHANNEL / 'last-status.json').exists() or
                    json.loads(private_file(CHANNEL / 'last-status.json').read_text()).get('status') == 'INSTALLED',
                    'previous failed install needs operator review')
        if decision['decision'] == 'ALREADY_INSTALLED':
            print('SKIP: exact TEST source already installed')
            return
        if dry_run:
            print(json.dumps(dict(decision=decision, status='DRY_RUN_ONLY', deployment='NOT_RUN')))
            return
        # Validate remote source and immutable operational contract before pending.
        before_sha = precheck_source(manifest, rollback)
        # Durable preimage BEFORE any service/configuration mutation. After power loss,
        # pending.json blocks all automatic retries until operator reconciliation.
        transaction = {
            'format': TX_FORMAT,
            'before': {'git_sha': before_sha, 'images': state['active']['images']},
            'target': {'commit': manifest['commit'], 'manifest_sha256': manifest['manifest_sha256'],
                       'refs': {role: image_ref(manifest, role) for role in ('backend', 'frontend')}},
        }
        record_phase(transaction, 'CHECKOUT')
        transaction_started = True
        safe_checkout(manifest, rollback)
        record_phase(transaction, 'VERIFY_IMAGES')
        ids = verify_pulled(manifest)
        run(str(ROOT / 'deploy/linux/project-test.sh'), 'preflight')
        require(applied_migrations() == applied, 'migrations changed during preparation')
        record_phase(transaction, 'PREBACKUP')
        ensure_recovery_pins(state)
        transaction['prebackup_id'] = backup(state['active'])
        record_phase(transaction, 'PREBACKUP')
        record_phase(transaction, 'STOP_SERVICES')
        compose('stop', 'ingress', 'frontend', 'backend')
        record_phase(transaction, 'BACKUP')
        backup_id = backup(state['active'])
        # Retain the verified backup identity before mutating runtime references.
        # If power is lost later, recovery-inspect can direct the operator to it.
        transaction['backup_id'] = backup_id
        record_phase(transaction, 'BACKUP')  # Durable backup identity before WRITE_REFS.
        record_phase(transaction, 'WRITE_REFS')
        rewrite_refs(manifest)
        run(str(ROOT / 'deploy/linux/project-test.sh'), 'preflight')
        record_phase(transaction, 'START_SERVICES')
        compose('up', '-d', '--no-build', '--pull', 'never', '--wait', 'db', 'backend', 'frontend', 'ingress', timeout=900)
        require(sorted(applied_migrations()) == sorted(applied), 'unexpected migration after start')
        verify_started_images(manifest, ids)
        record_phase(transaction, 'SMOKE')
        smoke()
        next_active = {'images': {role: {'ref': image_ref(manifest, role), 'id': ids[role], 'sha': manifest['commit']}
                                  for role in ('backend', 'frontend')},
                       'schema_migrations': manifest['schema_migrations'], 'manifest': manifest}
        sync_recovery_pins(state['active'], next_active)
        state['history'].append(state['active'])
        state['active'] = next_active
        record_phase(transaction, 'COMMIT_STATE')
        atomic_json(CHANNEL / 'state.json', state)
        record_phase(transaction, 'COMPLETE')
        (CHANNEL / 'pending.json').unlink()
        directory = os.open(CHANNEL, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
        atomic_json(CHANNEL / 'last-status.json', {'status': 'INSTALLED', 'commit': manifest['commit'],
                    'backup_id': backup_id,
                    'manifest_sha256': manifest['manifest_sha256'], 'at': datetime.now(timezone.utc).isoformat()})
        print('INSTALLED: exact TEST pair and public HTTPS smoke passed')
    except Exception:
        # Preflight/validation failures before the durable transaction begins
        # must not poison the journal or require manual recovery of an install
        # that never started. A pending transaction always blocks retries.
        if transaction_started and not dry_run:
            atomic_json(CHANNEL / 'last-status.json', {'status': recover_before_start(transaction, state, applied),
                        'reason': 'installation failed; automatic retry prohibited',
                        'at': datetime.now(timezone.utc).isoformat()})
        raise
    finally:
        os.close(fd)


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    require(mode in ('baseline-inspect', 'recovery-inspect', 'dry-run', 'apply', 'rollback'),
            'invalid TEST install action')
    if mode == 'baseline-inspect':
        print(json.dumps(inspect_baseline(), sort_keys=True, ensure_ascii=False))
        return
    if mode == 'recovery-inspect':
        print(json.dumps(inspect_recovery(), sort_keys=True, ensure_ascii=False))
        return
    manifest = contract.shape(json.load(sys.stdin))
    deploy(manifest, rollback=mode == 'rollback', dry_run=mode == 'dry-run')


if __name__ == '__main__':
    try:
        main()
    except (Stop, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError,
            json.JSONDecodeError, TimeoutError):
        print('STOP: TEST install refused; inspect root-only status and operational evidence', file=sys.stderr)
        sys.exit(1)
