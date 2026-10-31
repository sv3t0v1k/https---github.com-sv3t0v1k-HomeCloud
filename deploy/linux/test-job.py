#!/usr/bin/env python3
"""Root-only, fail-closed TEST install handoff to systemd (not the SSH session)."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
CHANNEL = ROOT / '.runtime' / 'test-channel'
JOB = CHANNEL / 'ssh-job.json'
MANIFEST = CHANNEL / 'ssh-manifest.json'
MAX_INPUT = 1024 * 1024
ID = re.compile(r'[a-f0-9]{64}\Z')
JOB_FORMAT = 'homecloud-test-ssh-job-v1'
STATES = ('QUEUED', 'RUNNING', 'INSTALLED', 'STOP')

spec = importlib.util.spec_from_file_location('test_channel_job_installer', ROOT / 'deploy/linux/test-channel.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
contract = installer.contract


def require(condition, message):
    if not condition:
        raise installer.Stop(message)


def preflight():
    require(os.geteuid() == 0 and str(ROOT) == '/home/hs/homecloud-test', 'invalid host or privilege')
    installer.private_dir(ROOT / '.runtime')
    installer.private_dir(CHANNEL)


def read_job():
    if not JOB.exists() and not JOB.is_symlink():
        return None
    item = json.loads(installer.private_file(JOB).read_text())
    require(isinstance(item, dict) and set(item) == {'format', 'id', 'status', 'updated_at'},
            'invalid SSH job checkpoint')
    require(item['format'] == JOB_FORMAT and isinstance(item['id'], str) and ID.fullmatch(item['id'])
            and item['status'] in STATES and isinstance(item['updated_at'], str),
            'invalid SSH job checkpoint')
    return item


def write_job(job_id, status):
    require(ID.fullmatch(job_id) and status in STATES, 'invalid SSH job transition')
    installer.atomic_json(JOB, {'format': JOB_FORMAT, 'id': job_id, 'status': status,
                                'updated_at': datetime.now(timezone.utc).isoformat()})


def unit_name(job_id):
    require(bool(ID.fullmatch(job_id)), 'invalid SSH job ID')
    return 'homecloud-test-apply-' + job_id[:32] + '.service'


def display_status(job):
    if job is None:
        return {'status': 'NO_JOB', 'manifest_sha256': None}
    status = job['status']
    # A killed unit may leave the receipt at RUNNING. Never report false success.
    if status in ('QUEUED', 'RUNNING'):
        try:
            result = subprocess.run(['/usr/bin/systemctl', 'is-active', unit_name(job['id'])],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, timeout=10, check=False)
            service_state = result.stdout.strip()
            if service_state not in ('active', 'activating') or (result.returncode != 0 and service_state != 'activating'):
                status = 'UNKNOWN_REQUIRES_REVIEW'
                # Allow a short, bounded service-start race, not an unbounded queue.
                if job['status'] == 'QUEUED':
                    try:
                        queued_at = datetime.fromisoformat(job['updated_at'])
                        age = (datetime.now(timezone.utc) - queued_at).total_seconds()
                        if 0 <= age < 10:
                            status = 'QUEUED'
                    except (ValueError, TypeError):
                        pass
        except (OSError, subprocess.SubprocessError):
            status = 'UNKNOWN_REQUIRES_REVIEW'
    return {'status': status, 'manifest_sha256': job['id']}


def submit():
    preflight()
    # Bounded input; the child receives a private, durable copy, never SSH stdin.
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    require(len(raw) <= MAX_INPUT, 'TEST manifest too large')
    manifest = contract.shape(json.loads(raw))
    job_id = manifest['manifest_sha256']
    lock = installer.acquire_lock(CHANNEL / 'ssh-submit.lock')
    try:
        previous = read_job()
        if previous is not None and previous['id'] == job_id:
            print(json.dumps(display_status(previous), sort_keys=True))
            return
        require(previous is None or previous['status'] == 'INSTALLED',
                'existing SSH job requires operator review')
        # No new request may start while any transaction is pending or an install runs.
        installer.guard_no_pending()
        fd = installer.acquire_lock(CHANNEL / 'install.lock')
        os.close(fd)
        last = CHANNEL / 'last-status.json'
        if last.exists() or last.is_symlink():
            require(json.loads(installer.private_file(last).read_text()).get('status') != 'STOP',
                    'previous TEST failure needs operator review')
        # Put the complete input on disk before recording the queued job.
        installer.atomic_json(MANIFEST, manifest)
        write_job(job_id, 'QUEUED')
        command = ['/usr/bin/systemd-run', '--no-block', '--collect', '--service-type=exec',
                   '--unit=' + unit_name(job_id), '--property=UMask=0077',
                   '--property=RuntimeMaxSec=10200', '--property=Restart=no', '/usr/bin/python3',
                   str(ROOT / 'deploy/linux/test-job.py'), 'worker', job_id]
        try:
            started = subprocess.run(command, cwd=ROOT,
                                     env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                                          'HOME': '/root'},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     timeout=30, check=False)
            require(started.returncode == 0, 'systemd handoff failed')
        except (OSError, subprocess.SubprocessError, installer.Stop):
            # A lost systemd acknowledgement can be ambiguous. Never retry the install.
            write_job(job_id, 'STOP')
            raise installer.Stop('systemd handoff uncertain; manual inspection required') from None
        print(json.dumps({'status': 'ACCEPTED', 'manifest_sha256': job_id}, sort_keys=True))
    finally:
        os.close(lock)


def worker(job_id):
    preflight()
    require(bool(ID.fullmatch(job_id)), 'invalid SSH worker ID')
    current = read_job()
    require(current is not None and current['id'] == job_id and current['status'] == 'QUEUED',
            'SSH worker not queued')
    manifest = contract.shape(json.loads(installer.private_file(MANIFEST).read_text()))
    require(manifest['manifest_sha256'] == job_id, 'SSH job manifest mismatch')
    write_job(job_id, 'RUNNING')
    try:
        installer.deploy(manifest)
        installed = installer.load_state()['active']['images']
        require(all(installed[role]['ref'] == installer.image_ref(manifest, role)
                    and installed[role]['sha'] == manifest['commit']
                    for role in ('backend', 'frontend')),
                'TEST installed checkpoint differs from job')
        installer.guard_no_pending()
        write_job(job_id, 'INSTALLED')
    except Exception:
        write_job(job_id, 'STOP')
        raise


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    require(mode in ('submit', 'status', 'worker'), 'invalid SSH job mode')
    require((len(sys.argv) == 3) if mode == 'worker' else (len(sys.argv) == 2),
            'invalid SSH job arguments')
    if mode == 'submit':
        submit()
    elif mode == 'status':
        preflight()
        print(json.dumps(display_status(read_job()), sort_keys=True))
    else:
        worker(sys.argv[2])


if __name__ == '__main__':
    try:
        main()
    except (installer.Stop, ValueError, KeyError, TypeError, OSError,
            subprocess.SubprocessError, json.JSONDecodeError):
        print('STOP: TEST SSH job refused or failed; inspect root-only evidence', file=sys.stderr)
        sys.exit(1)
