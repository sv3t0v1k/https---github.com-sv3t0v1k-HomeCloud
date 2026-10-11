#!/usr/bin/env python3
"""Collect only approved research files and read-only server state; no root entry."""
import ast
import json
from pathlib import Path
import shlex
import subprocess

ROOT=Path(__file__).resolve().parent
DEST=ROOT/'r2-1b-v2-run'
DEST.mkdir(mode=0o700)
tree=ast.parse((ROOT/'r2-1b/preflight.py').read_text())
defs=ast.unparse(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))],type_ignores=[]))
remote=defs+r'''
base=Path('/home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22')
files={}
for name in ('recovery-result.json','root-run-result.json','root-run-journal.ndjson'):
    fd=os.open(base/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    s=os.fstat(fd)
    assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and s.st_size<2*1024**2
    with os.fdopen(fd,'r') as f: files[name]=f.read(2*1024**2)
hashes={name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ('recover-owned-loop.py','isolated-helper-v2.py','manual-launch-v2.sh')}
print(json.dumps(dict(files=files,source_sha256=hashes,snapshot=snapshot())))
'''
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                  'hs@192.168.3.44','python3 -c '+shlex.quote(remote)],text=True,capture_output=True,timeout=60)
(DEST/'collection.stderr').write_text(p.stderr)
if p.returncode: raise RuntimeError(dict(rc=p.returncode,stderr=p.stderr))
d=json.loads(p.stdout)
for name,raw in d.pop('files').items(): (DEST/name).write_text(raw)
(DEST/'post-run-readonly.json').write_text(json.dumps(d,indent=2)+'\n')
root=json.loads((DEST/'root-run-result.json').read_text());rec=json.loads((DEST/'recovery-result.json').read_text())
print(json.dumps(dict(recovery_status=rec['status'],recovery_invariants=rec.get('invariants'),
                     child_rc=root['child_rc'],invariants=root.get('invariants'),
                     records=[dict(test=r['test'],status=r['result'].get('status') if isinstance(r['result'],dict) else None) for r in root.get('records',[])],
                     containers=len(d['snapshot']['containers']),mountinfo_sha256=d['snapshot']['mountinfo_sha256']),indent=2))
