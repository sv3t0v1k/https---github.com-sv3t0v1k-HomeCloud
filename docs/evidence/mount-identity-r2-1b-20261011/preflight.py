#!/usr/bin/env python3
"""Read-only remote preflight: no files, mounts or containers are created."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

def run(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=20)
    return dict(args=args, rc=p.returncode, stdout=p.stdout, stderr=p.stderr)

def link(path):
    try:
        return os.readlink(path)
    except OSError as e:
        return dict(errno=e.errno)

def snapshot():
    ids = run(['docker', 'ps', '-aq'])
    if ids['rc']:
        raise RuntimeError(ids)
    fmt = '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    containers = run(['docker', 'inspect', '--format', fmt] + ids['stdout'].split())
    if containers['rc']:
        raise RuntimeError(containers)
    fixtures = {}
    roots = ['/home/hs/homecloud-test/r2-identity-20261011-01a12a10',
             '/mnt/1TB/homecloud-test/r2-identity-20261011-01a12a10']
    for root in roots:
        for p in [Path(root)] + sorted(Path(root).rglob('*')):
            s = p.lstat()
            item = dict(mode=oct(stat.S_IMODE(s.st_mode)), uid=s.st_uid, gid=s.st_gid,
                        size=s.st_size, ino=s.st_ino, dev=s.st_dev, mtime_ns=s.st_mtime_ns)
            if stat.S_ISREG(s.st_mode):
                item['sha256'] = hashlib.sha256(p.read_bytes()).hexdigest()
            elif stat.S_ISLNK(s.st_mode):
                item['symlink'] = os.readlink(p)
            fixtures[str(p)] = item
    mounts = Path('/proc/self/mountinfo').read_text()
    return dict(time_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                containers=sorted(containers['stdout'].splitlines()),
                mountinfo=mounts, mountinfo_sha256=hashlib.sha256(mounts.encode()).hexdigest(),
                mount_ns=link('/proc/self/ns/mnt'), user_ns=link('/proc/self/ns/user'),
                pid1_mount_ns=link('/proc/1/ns/mnt'),
                boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                fixtures=fixtures, resources=run(['free', '-m']))

result = {'snapshot': snapshot()}
if '--probe' in sys.argv:
    result['probes'] = [run(args) for args in [
        ['id'], ['uname', '-a'], ['sudo', '-n', 'true'], ['sudo', '-n', '-l'],
        ['unshare', '--user', '--map-root-user', '--mount', '--propagation', 'unchanged',
         'sh', '-c', 'id; readlink /proc/self/ns/user; readlink /proc/self/ns/mnt; cat /proc/self/uid_map; awk "/^CapEff:/ {print}" /proc/self/status'],
        ['unshare', '--mount', '--propagation', 'unchanged', '/bin/true'],
        ['findmnt', '-T', '/mnt/1TB/homecloud-test', '-o', 'TARGET,SOURCE,FSTYPE,PROPAGATION,OPTIONS'],
        ['findmnt', '-T', '/mnt/data', '-o', 'TARGET,SOURCE,FSTYPE,PROPAGATION,OPTIONS'],
        ['stat', '-c', '%F %U %G %a %n', '/home/hs/homecloud-test', '/mnt/1TB/homecloud-test', '/mnt/data'],
        ['df', '-h', '/home/hs/homecloud-test', '/mnt/1TB/homecloud-test', '/mnt/data'],
    ]]
print(json.dumps(result, indent=2))
