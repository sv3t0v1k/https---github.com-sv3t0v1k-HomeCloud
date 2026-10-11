#!/usr/bin/env python3
"""Execute exact reviewed non-root probe in memory and collect own evidence."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

HERE=Path(__file__).resolve().parent
source=(HERE/'rprivate-probe.py').read_text()
EXPECTED='6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696'
assert hashlib.sha256(source.encode()).hexdigest()==EXPECTED
assert EXPECTED in (HERE/'rprivate-probe-review.md').read_text()
remote='SOURCE_CODE='+repr(source)+'\n'+r'''
import contextlib,hashlib,io,json,sys
from pathlib import Path
if hashlib.sha256(SOURCE_CODE.encode()).hexdigest()!='6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696':
    raise SystemExit('reviewed source mismatch')
ENTRY='parent'
capture=io.StringIO();error=None;rc=0
try:
    with contextlib.redirect_stdout(capture):exec(compile(SOURCE_CODE,'<reviewed-rprivate-probe>','exec'))
except Exception as e:error=repr(e);rc=1
base=Path('/home/hs/homecloud-test/r2-1b-rprivate-20261011-01a12a22')
names=['result.json','supplier-private-proof.json','supplier-a.json','supplier-b.json','supplier-result.json','container-plan-1.json','container-plan-2.json']
files={n:(base/n).read_text() for n in names if (base/n).exists()}
print(json.dumps(dict(exec_rc=rc,error=error,source_sha256=hashlib.sha256(SOURCE_CODE.encode()).hexdigest(),
                     execution_stdout_sha256=hashlib.sha256(capture.getvalue().encode()).hexdigest(),files=files)))
sys.exit(rc)
'''
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                  'hs@192.168.3.44','/usr/bin/python3 -I -c '+shlex.quote(remote)],text=True,capture_output=True,timeout=90)
(HERE/'rprivate-execution.stderr').write_text(p.stderr)
d=json.loads(p.stdout)
for name,raw in d.pop('files').items():(HERE/('rprivate-'+name)).write_text(raw)
(HERE/'rprivate-execution.json').write_text(json.dumps(d,indent=2)+'\n')
result=json.loads((HERE/'rprivate-result.json').read_text())
print(json.dumps(dict(exec_rc=d['exec_rc'],status=result['status'],error=result.get('error'),
                     child=result.get('child'),invariants=result.get('invariants'),
                     remaining_owned=result.get('remaining_owned_containers'),cleanup_errors=result.get('cleanup_errors'),
                     cases=[dict(phase=x['phase'],cid=x['cid'],marker=x['observation']['marker'],profile=x['observation']['profile']) for x in result['containers']]),indent=2))
if p.returncode:raise SystemExit(p.returncode)
