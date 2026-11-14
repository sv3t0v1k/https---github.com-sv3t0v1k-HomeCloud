#!/usr/bin/env python3
"""Actual Restore failures inside the disposable native DinD fixture only.

Test instrumentation wraps unchanged production helper bytes in this runtime
copy. No production environment switch, gate bypass or host file mutation.
Each case gets an entirely fresh outer environment from the host batch driver.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import re
import signal
import stat
import subprocess
import sys
import time

CASES = {'partial-stop': 'INHIBITED', 'staged': 'STORAGE_STAGED',
         'db-restored': 'DB_RESTORED', 'reconciled': 'RECONCILED',
         'ready-before-clear': 'READY', 'ready-after-clear': 'READY',
         'foreign-writer': 'INHIBITED'}


def instrument(original, case, barrier):
    if case not in CASES:
        raise ValueError('Unknown restore fault case')
    # __file__ remains the real qualified path, so every original ROOT/trust
    # check and every original function body executes unchanged.
    return '''import base64,json,os,signal,sys,types
from pathlib import Path
m=types.ModuleType("homecloud_fault_original")
m.__file__=__file__
exec(compile(base64.b64decode(%r),__file__,"exec"),m.__dict__)
CASE=%r
BARRIER=Path(%r)
def record(point):
    temporary=BARRIER.with_suffix(".publishing")
    with temporary.open("x") as stream:
        json.dump({"case":CASE,"point":point,"pid":os.getpid()},stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary,BARRIER)
def pause(point):
    record(point)
    os.kill(os.getpid(),signal.SIGSTOP)
write=m.write_receipt
def checkpoint(state,receipt,first=False):
    write(state,receipt,first)
    expected={"staged":"STORAGE_STAGED","db-restored":"DB_RESTORED","reconciled":"RECONCILED","ready-before-clear":"READY"}
    if receipt["phase"]==expected.get(CASE): pause(receipt["phase"])
m.write_receipt=checkpoint
verify=m.storage.verify_backup_inhibitor
def inhibitor(*args,**kwargs):
    result=verify(*args,**kwargs)
    if CASE=="ready-after-clear" and kwargs.get("clear"): pause("READY_AFTER_CLEAR")
    return result
m.storage.verify_backup_inhibitor=inhibitor
stop=m.storage.release_compose
def compose(*args):
    if CASE=="partial-stop" and args==("stop","--timeout","60","ingress","frontend","backend"):
        stop("stop","--timeout","60","ingress","frontend")
        record("PARTIAL_STOPPED")
        raise m.storage.StorageError("Injected partial stop acknowledgement failure")
    return stop(*args)
m.storage.release_compose=compose
writers=m.storage.verify_backup_writers
def inventory(*args,**kwargs):
    try: return writers(*args,**kwargs)
    except m.storage.StorageError:
        if CASE=="foreign-writer" and sys.argv[1]=="begin": record("FOREIGN_WRITER_REFUSED")
        raise
m.storage.verify_backup_writers=inventory
sys.exit(m.main())
''' % (base64.b64encode(original).decode(), case, str(barrier))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def command(args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if check and result.returncode:
        raise ValueError('Fault fixture command failed: ' + ' '.join(args[:2]) + ': ' + result.stderr[-1000:])
    return result


def file_map(root):
    result = {}
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        first = relative.parts[0]
        if first in ('.tmp', '.homecloud-storage-identity') or first.startswith(('.restore-', '.hc-probe-')):
            continue
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        require(stat.S_ISREG(info.st_mode), 'Unexpected persistent fixture entry')
        result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def database_query(sql):
    return command(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                    '-U', 'fixture', '-d', 'fixture', '-At', '-c', sql]).stdout.strip()


def database_rows():
    sql = '''SELECT coalesce(json_agg(t ORDER BY t.id),'[]'::json) FROM
    (SELECT id,name,"storagePath",size::text,checksum,"isFolder","isDeleted","userId" FROM files) t'''
    return json.loads(database_query(sql))


def verify_database_consistency():
    sql = '''SELECT count(*) FROM users u WHERE email='restore-fixture@example.invalid'
      AND "storageQuota"=104857600
      AND "storageUsed"=(SELECT COALESCE(sum(size),0) FROM files f WHERE f."userId"=u.id AND NOT f."isFolder")
      AND NOT EXISTS(SELECT 1 FROM file_copy_operations WHERE state NOT IN ('committed','released'))'''
    require(database_query(sql) == '1', 'Database quota/copy journal is inconsistent at the fault checkpoint')


def guard(case, work):
    require(case in CASES, 'Unknown restore fault case')
    require(Path.cwd() == Path('/opt/homecloud') and Path('/.dockerenv').is_file() and os.geteuid() == 0,
            'Fault controller requires the disposable root runtime')
    require(os.environ.get('DOCKER_HOST') == 'unix:///var/run/docker.sock'
            and os.environ.get('COMPOSE_PROJECT_NAME') == 'homecloud-restore-e2e'
            and Path('/proc/1/cgroup').read_text().strip() == '0::/homecloud-e2e-init',
            'Fault controller requires the delegated private E2E daemon')
    require(work.resolve(strict=True) == work and work.parent == Path('/tmp')
            and work.name.startswith('homecloud-e2e.'), 'Unqualified fault fixture directory')


def run_restore(case, work, barrier):
    log = work / 'restore-fault.log'
    process = None
    try:
        with log.open('w') as stream:
            process = subprocess.Popen(['bash', 'scripts/restore.sh', '--yes'], stdout=stream,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            if case in ('partial-stop', 'foreign-writer'):
                require(process.wait(timeout=300) != 0, 'Restore unexpectedly succeeded despite fault')
            else:
                deadline = time.monotonic() + 300
                while not barrier.exists():
                    require(process.poll() is None, 'Restore exited before the selected fault point')
                    require(time.monotonic() < deadline, 'Restore never reached the selected fault point')
                    time.sleep(0.05)
                point = json.loads(barrier.read_text())
                require(point['case'] == case and os.getpgid(point['pid']) == process.pid,
                        'Fault barrier does not belong to the owned restore session')
                while not re.search(r'^State:\s+T\b', Path('/proc/%s/status' % point['pid']).read_text(), re.M):
                    require(process.poll() is None and time.monotonic() < deadline,
                            'Restore helper did not enter the kernel stopped state')
                    time.sleep(0.01)
                os.killpg(process.pid, signal.SIGKILL)
                require(process.wait(timeout=30) == -signal.SIGKILL, 'Owned Restore was not killed as expected')
        require(barrier.is_file(), 'Expected fault was never actually injected/observed')
        point = json.loads(barrier.read_text())
        expected = {'partial-stop': 'PARTIAL_STOPPED', 'foreign-writer': 'FOREIGN_WRITER_REFUSED',
                    'ready-after-clear': 'READY_AFTER_CLEAR'}.get(case, CASES[case])
        require(point['case'] == case and point['point'] == expected, 'Wrong actual fault point')
        require('RESTORE_COMPLETE' not in log.read_text(), 'Failed Restore falsely acknowledged success')
        return process.returncode
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=30)
        if log.exists():
            print(log.read_text(), flush=True)


def verify_inhibited_start(cid):
    before = json.loads(command(['docker', 'inspect', cid]).stdout)[0]['State']['StartedAt']
    # Compose may itself return nonzero when the process immediately exits.
    # Require an actual new process attempt, not an unrelated CLI failure.
    command(['docker', 'compose', 'start', 'backend'], check=False)
    deadline = time.monotonic() + 30
    while True:
        state = json.loads(command(['docker', 'inspect', cid]).stdout)[0]['State']
        if not state['Running']:
            require(state['StartedAt'] != before, 'No new backend process attempted inhibited startup')
            require(state['Status'] == 'exited' and state['ExitCode'] != 0,
                    'Ordinary inhibited backend startup did not fail closed')
            return
        require(time.monotonic() < deadline, 'Ordinary backend remained running under the inhibitor')
        time.sleep(0.1)


def main():
    case, work = sys.argv[1], Path(sys.argv[2])
    guard(case, work)
    sys.path.insert(0, str(Path.cwd() / 'scripts'))
    import recovery_storage as storage
    import restore_storage as restore
    import restore_maintenance as maintenance

    root = Path('/mnt/hc-e2e/storage')
    root_identity = (root.stat().st_dev, root.stat().st_ino)
    marker = root / '.homecloud-storage-identity'
    storage_identity = (marker.stat().st_dev, marker.stat().st_ino, marker.read_bytes())
    old_files, old_rows = file_map(root), database_rows()
    require(sorted(row['name'] for row in old_rows) == ['after-backup.txt', 'before-backup.txt'],
            'Fault fixture must start with both real API files')
    before = [row for row in old_rows if row['name'] == 'before-backup.txt']
    key = PurePosixPath(before[0]['storagePath']).relative_to('/storage').as_posix()
    restored_files = {key: old_files[key]}
    helper = Path('scripts/restore_maintenance.py')
    original = helper.read_bytes()
    barrier = work / 'fault-point.json'
    actor = None
    try:
        if case == 'foreign-writer':
            candidate = command(['docker', 'run', '-d', '--pull=never', '--network', 'none', '--read-only',
                             '--mount', 'type=bind,src=' + str(root) + ',dst=/foreign',
                             '--entrypoint', 'sh', os.environ['HOMECLOUD_E2E_STUB_IMAGE'], '-c',
                             "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done"]).stdout.strip()
            require(bool(re.fullmatch('[0-9a-f]{64}', candidate)), 'Invalid owned foreign fixture CID')
            actor = candidate
        helper.write_text(instrument(original, case, barrier))
        command(['python3', '-B', 'scripts/ci/restore-runtime-preflight.py'])
        exit_code = run_restore(case, work, barrier)
        receipt_path = Path('/etc/homecloud/maintenance') / maintenance.RECEIPT
        raw = json.loads(receipt_path.read_text())
        snapshot, token = raw['snapshot'], raw['token']
        state, lock = maintenance.runtime(snapshot)
        receipt = maintenance.read_receipt(state, snapshot, token, allow_ready=True)
        require(receipt['phase'] == CASES[case], 'Unexpected retained production checkpoint')
        require((root.stat().st_dev, root.stat().st_ino) == root_identity
                and (marker.stat().st_dev, marker.stat().st_ino, marker.read_bytes()) == storage_identity,
                'Storage root/identity changed during failure')
        current_rows, current_files = database_rows(), file_map(root)
        verify_database_consistency()
        early = case in ('partial-stop', 'foreign-writer', 'staged')
        require(current_rows == (old_rows if early else before), 'Wrong DB state at retained checkpoint')
        require(current_files == (old_files if early or case == 'db-restored' else restored_files),
                'Wrong persistent storage state at retained checkpoint')
        if actor:
            require(command(['docker', 'inspect', '-f', '{{.State.Running}}', actor]).stdout.strip() == 'true',
                    'Foreign writer disappeared before the refusal was verified')
            # The installed offline CLI is TEST-only. Exercise its actual
            # shared inventory without spoofing project/checkout admission.
            try:
                storage.verify_backup_writers(snapshot)
            except storage.StorageError as error:
                require('Writable container storage mount remains active' in str(error),
                        'Foreign-writer refusal came from an unrelated check')
            else:
                raise ValueError('Shared writer gate accepted foreign writable mount')
            command(['docker', 'rm', '-fv', actor])
            actor = None
            storage.verify_backup_writers(snapshot)
        op_fd = os.open(lock, os.O_RDONLY)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            maintenance.hold_operation(lock, op_fd, acquire=True)
            fcntl.flock(root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if case in ('staged', 'db-restored'):
                restore.verify_staged_storage(snapshot, root_fd, receipt['staged_storage'])
            if case == 'reconciled':
                maintenance.assert_retained_swap(snapshot, receipt)
                require(file_map(root / restore.SWAP) == old_files, 'Verified old swap bytes were lost')
            if case.startswith('ready-'):
                require(not (root / restore.SWAP).exists(), 'Swap survived verified READY cleanup')
            try:
                maintenance.begin(snapshot, state, lock, op_fd, secrets.token_hex(16))
            except storage.StorageError as error:
                require('Existing maintenance' in str(error), 'Readmission failed for an unrelated reason')
            else:
                raise ValueError('Conflicting operation adopted the retained checkpoint')
            if case == 'ready-after-clear':
                require(not (state / storage.MAINTENANCE_MARKER).exists(), 'Clear-window fault was not reached')
                maintenance.retain_after_failure(snapshot, state, lock, op_fd, token)
                require(maintenance.read_receipt(state, snapshot, token)['phase'] == 'RESTART_FAILED',
                        'Actual retain did not recreate the durable inhibitor')
            storage.verify_backup_writers(snapshot)
            retained_phase = maintenance.read_receipt(state, snapshot, token)['phase']
        finally:
            os.close(root_fd)
            os.close(op_fd)
        verify_inhibited_start(snapshot['container_id'])
        storage.verify_backup_writers(snapshot)
        require(database_rows() == current_rows and file_map(root) == current_files,
                'Inhibited startup changed database/storage')
        verify_database_consistency()
        require(sorted(command(['docker', 'compose', 'ps', '--all', '-q']).stdout.splitlines())
                == sorted((work / 'original-containers').read_text().splitlines()), 'Failure recovery replaced a container')
        report = {'event': 'real_restore_fault_verified', 'case': case, 'phase': CASES[case],
                          'restore_exit': exit_code, 'source_helper_sha256': hashlib.sha256(original).hexdigest(),
                          'retained_phase': retained_phase,
                          'db_files': len(current_rows), 'storage_files': len(current_files),
                          'db_quota_journal_consistent': True,
                  'readmission_refused': True, 'ordinary_backend_start_refused': True}
    finally:
        helper.write_bytes(original)
        require(helper.read_bytes() == original, 'Original fixture helper was not restored')
        if actor:
            command(['docker', 'rm', '-fv', actor])
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('STOP: real Restore fault qualification: ' + str(error), file=sys.stderr)
        sys.exit(1)
