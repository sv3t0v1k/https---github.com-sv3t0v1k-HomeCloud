#!/usr/bin/env python3
"""Source-only installation, no root/helper/recovery/device execution."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

local=Path(__file__).resolve().parent
expected={
    'recover-owned-loop.py':'6d4dda1208c259c9ad22856dd362496ee8f975630091a03a9eed29e711bfb21c',
    'isolated-helper-v2.py':'5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49',
    'manual-launch-v2.sh':'bb3f9f351b9dbe0b57647592fd693b7edf7bd477efbc389b617b710489c28ca2',
}
payload={name:(local/name).read_text() for name in expected}
assert all(hashlib.sha256(payload[n].encode()).hexdigest()==h for n,h in expected.items())
remote=r'''
import hashlib,json,os,stat,subprocess,sys
from pathlib import Path
p=Path('/home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22')
def state():
    ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
    fmt='{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    records=sorted(subprocess.check_output(['docker','inspect','--format',fmt]+ids,text=True).splitlines())
    return dict(containers=records,mountinfo_sha256=hashlib.sha256(Path('/proc/self/mountinfo').read_bytes()).hexdigest())
before=state()
assert os.getuid()==1000 and len(before['containers'])==26 and all(x.split('|')[5]=='true' for x in before['containers'])
assert before['mountinfo_sha256']=='0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429'
for a in [p.parent,*p.parent.parents]:
    s=a.lstat(); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
s=p.parent.stat(); assert s.st_uid==1000 and stat.S_IMODE(s.st_mode)==0o700
data=json.load(sys.stdin)
expected={
 'recover-owned-loop.py':'6d4dda1208c259c9ad22856dd362496ee8f975630091a03a9eed29e711bfb21c',
 'isolated-helper-v2.py':'5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49',
 'manual-launch-v2.sh':'bb3f9f351b9dbe0b57647592fd693b7edf7bd477efbc389b617b710489c28ca2',
}
assert set(data)==set(expected)
assert all(hashlib.sha256(data[n].encode()).hexdigest()==h for n,h in expected.items())
os.mkdir(p,0o700)
hashes={}
for name,contents in data.items():
    fd=os.open(p/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: f.write(contents); f.flush(); os.fsync(f.fileno())
    s=(p/name).lstat(); assert stat.S_ISREG(s.st_mode) and s.st_uid==1000 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
    hashes[name]=hashlib.sha256((p/name).read_bytes()).hexdigest()
assert hashes==expected
after=state(); assert before==after
print(json.dumps(dict(path=str(p),files=hashes,before=before,after=after,own_files=3,
                     helper_executed=False,recovery_executed=False,new_loop_allocations=0,
                     old_loop8_cleanup='PENDING_OWNER_MANUAL_ROOT'),indent=2))
'''
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                  'hs@192.168.3.44','python3 -c '+shlex.quote(remote)],
                 input=json.dumps(payload),text=True,capture_output=True,timeout=60)
if p.returncode: raise RuntimeError(dict(rc=p.returncode,stderr=p.stderr,stdout=p.stdout))
obj=json.loads(p.stdout)
with (local/'v2-upload.json').open('x') as f: f.write(p.stdout)
print(json.dumps({k:v for k,v in obj.items() if k not in ('before','after')},indent=2))
