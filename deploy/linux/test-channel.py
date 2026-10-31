#!/usr/bin/env python3
"""Fail-closed project-test installer; only invoked by the root-only wrapper."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
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
                'docker-compose.project-test.yml', 'deploy/linux/project-test.sh',
                'deploy/linux/preflight.py', 'deploy/linux/test-channel.py',
                'scripts/ci/test-channel.py', 'scripts/backup.sh',
                'scripts/recovery_config.py', 'scripts/recovery_storage.py',
                'scripts/recovery-config.sh', 'scripts/recovery-storage.sh',
                'scripts/recovery-pending.sql')

spec = importlib.util.spec_from_file_location('test_channel_contract', ROOT / 'scripts/ci/test-channel.py')
contract = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(ROOT / 'scripts/ci'))
spec.loader.exec_module(contract)


class Stop(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Stop(reason)


def run(*args, env=None, timeout=300, capture=True):
    result = subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, timeout=timeout)
    require(result.returncode == 0, 'failed operation: ' + Path(args[0]).name)
    return result.stdout.strip() if capture else ''


def compose(*args, env=None, timeout=300):
    return run('docker', '--host', 'unix:///var/run/docker.sock', 'compose',
               '--project-directory', str(ROOT), '--env-file', str(ENV_FILE),
               '-f', str(ROOT / 'docker-compose.yml'),
               '-f', str(ROOT / 'docker-compose.production.yml'),
               '-f', str(ROOT / 'docker-compose.project-test.yml'), *args, env=env, timeout=timeout)


def private_file(path):
    require(path.is_absolute() and not path.is_symlink() and path.is_file(), 'missing private file')
    s = path.stat()
    require(s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o600, 'private file must be root:0600')
    return path


def private_dir(path):
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
    require(phase in ('CHECKOUT', 'VERIFY_IMAGES', 'STOP_SERVICES', 'BACKUP',
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
        source = subprocess.run(['git', 'show', commit + ':' + name], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
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


def precheck_source(manifest, rollback):
    """Complete all avoidable Git/source checks BEFORE creating pending.json."""
    require(run('git', 'status', '--porcelain', '--untracked-files=no') == '',
            'dirty project checkout')
    current = run('git', 'rev-parse', 'HEAD')
    require(bool(SHA.fullmatch(current)), 'invalid current source revision')
    if rollback:
        run('git', 'cat-file', '-e', manifest['commit'] + '^{commit}')
    else:
        require_current_test_head(manifest)
        run('git', 'fetch', '--no-tags', 'origin', 'test', timeout=180)
        require(run('git', 'rev-parse', 'FETCH_HEAD') == manifest['commit'],
                'fetched test source mismatch')
    for name in LOCKED_FILES:
        source = subprocess.run(['git', 'show', manifest['commit'] + ':' + name], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
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


def backup(active):
    private_file(RECOVERY)
    current = env_values()
    environment = {'HOME': '/root', 'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                   'DOCKER_HOST': 'unix:///var/run/docker.sock',
                   'HOMECLOUD_ENV_FILE': str(RECOVERY),
                   'RELEASE_BACKEND_IMAGE': active['images']['backend']['ref'],
                   'RELEASE_FRONTEND_IMAGE': active['images']['frontend']['ref'],
                   'BACKEND_IMAGE': active['images']['backend']['ref']}
    require(current.get('RELEASE_BACKEND_IMAGE') == environment['RELEASE_BACKEND_IMAGE']
            and current.get('RELEASE_FRONTEND_IMAGE') == environment['RELEASE_FRONTEND_IMAGE'],
            'runtime image refs differ from checkpoint')
    output = run('bash', str(ROOT / 'scripts/backup.sh'), '--yes', env=environment, timeout=3600)
    completed = []
    for line in output.splitlines():
        if line.startswith('{'):
            try: item = json.loads(line)
            except json.JSONDecodeError: continue
            if item.get('event') == 'backup_completed': completed.append(item.get('backup_id'))
    require(len(completed) == 1 and isinstance(completed[0], str) and completed[0],
            'verified backup completion missing')
    return completed[0]


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
                    json.loads(private_file(CHANNEL / 'last-status.json').read_text()).get('status') != 'STOP',
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
        state['history'].append(state['active'])
        state['active'] = next_active
        record_phase(transaction, 'COMMIT_STATE')
        atomic_json(CHANNEL / 'state.json', state)
        atomic_json(CHANNEL / 'last-status.json', {'status': 'INSTALLED', 'commit': manifest['commit'],
                    'backup_id': backup_id,
                    'manifest_sha256': manifest['manifest_sha256'], 'at': datetime.now(timezone.utc).isoformat()})
        record_phase(transaction, 'COMPLETE')
        (CHANNEL / 'pending.json').unlink()
        directory = os.open(CHANNEL, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
        print('INSTALLED: exact TEST pair and public HTTPS smoke passed')
    except Exception:
        # Preflight/validation failures before the durable transaction begins
        # must not poison the journal or require manual recovery of an install
        # that never started. A pending transaction always blocks retries.
        if transaction_started and not dry_run:
            atomic_json(CHANNEL / 'last-status.json', {'status': 'STOP', 'reason': 'operator review required',
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
