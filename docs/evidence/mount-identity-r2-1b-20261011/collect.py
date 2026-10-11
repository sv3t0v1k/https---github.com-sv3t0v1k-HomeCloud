#!/usr/bin/env python3
"""Local transport; writes evidence locally only, never server files."""
import json
from pathlib import Path
import shlex
import subprocess
import sys

root = Path(__file__).resolve().parent
name = sys.argv[1]
assert name in ('baseline', 'final')
remote = 'python3 -c ' + shlex.quote((root / 'preflight.py').read_text())
if name == 'baseline':
    remote += ' --probe'
p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'ConnectTimeout=8', 'hs@192.168.3.44', remote],
                   text=True, capture_output=True, timeout=100)
with (root / (name + '.stderr')).open('x') as f:
    f.write(p.stderr)
if p.returncode:
    raise RuntimeError(dict(rc=p.returncode, stderr=p.stderr))
data = json.loads(p.stdout)
with (root / (name + '.json')).open('x') as f:
    f.write(p.stdout)
print(json.dumps(dict(file=name + '.json', containers=len(data['snapshot']['containers']),
                     fixture_entries=len(data['snapshot']['fixtures']),
                     mountinfo_sha256=data['snapshot']['mountinfo_sha256'],
                     probes=[dict(args=x['args'], rc=x['rc'], stdout=x['stdout'], stderr=x['stderr'])
                             for x in data.get('probes', [])]), indent=2))
