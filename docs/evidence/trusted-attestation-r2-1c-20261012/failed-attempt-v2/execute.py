#!/usr/bin/env python3
"""Exact reviewed source upload-in-memory, own remote evidence, no secret output."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

HERE = Path(__file__).resolve().parent
FILES = ['baseline-collector.py','identity-probe.c','observe-fd.c','bridge.cjs',
         'protocol-tests.cjs','consumer.cjs','run-host.cjs']
source = (HERE/'run-host.cjs').read_text()
EXPECTED = 'a32088634582e7a29cd5593fe9d1cc21979b6e79eb8250b514d27d3950533a00'
assert hashlib.sha256(source.encode()).hexdigest() == EXPECTED
assert EXPECTED in (HERE/'pre-execution-review.md').read_text()
expected=json.loads((HERE/'initial-inventory.json').read_text())['snapshot']
for item in expected['fixtures'].values(): item['mtime_ns']=str(item['mtime_ns'])
payload = dict(files={n:(HERE/n).read_text() for n in FILES},
               expected=expected)
(HERE/'executed-source-manifest.json').write_text(json.dumps(
    {n:hashlib.sha256(payload['files'][n].encode()).hexdigest() for n in FILES},indent=2)+'\n')
r = subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                    '-o','ConnectTimeout=8','hs@192.168.3.44',
                    '/usr/bin/node -e '+shlex.quote(source)],
                   input=json.dumps(payload),capture_output=True,text=True,timeout=180)
(HERE/'native.stderr').write_text(r.stderr)
if r.stdout:
    d=json.loads(r.stdout)
    (HERE/'native-result.json').write_text(json.dumps(d,indent=2)+'\n')
    print(json.dumps(dict(exit=r.returncode,status=d.get('status'),error=d.get('error'),
                        invariants=d.get('invariants'),remainingOwned=d.get('remainingOwned'),
                        cleanupErrors=d.get('cleanupErrors'),protocol=d.get('protocol',{}).get('count'))))
else:
    print(json.dumps(dict(exit=r.returncode,stderr=r.stderr)))
raise SystemExit(r.returncode)
