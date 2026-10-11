#!/usr/bin/env python3
"""Upload only reviewed source + owner launcher to an exclusive hs-owned test dir."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

local=Path(__file__).resolve().parent
payload={name:(local/name).read_text() for name in ('isolated-helper.py','manual-launch.sh')}
remote=r'''
import hashlib,json,os,stat,subprocess,sys
from pathlib import Path
p=Path('/home/hs/homecloud-test/r2-1b-20261011-01a12a22')
def state():
    ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
    fmt='{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    records=sorted(subprocess.check_output(['docker','inspect','--format',fmt]+ids,text=True).splitlines())
    return dict(containers=records,mountinfo_sha256=hashlib.sha256(Path('/proc/self/mountinfo').read_bytes()).hexdigest())
before=state()
assert os.getuid()==1000 and len(before['containers'])==26
assert before['mountinfo_sha256']=='0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429'
for a in [p.parent,*p.parent.parents]:
    s=a.lstat(); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
s=p.parent.stat(); assert s.st_uid==1000 and stat.S_IMODE(s.st_mode)==0o700
data=json.load(sys.stdin); assert set(data)=={'isolated-helper.py','manual-launch.sh'}
assert hashlib.sha256(data['isolated-helper.py'].encode()).hexdigest()=='8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426'
os.mkdir(p,0o700)
hashes={}
for name,contents in data.items():
    fd=os.open(p/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: f.write(contents); f.flush(); os.fsync(f.fileno())
    hashes[name]=hashlib.sha256((p/name).read_bytes()).hexdigest()
after=state()
assert before==after
print(json.dumps(dict(path=str(p),files=hashes,before=before,after=after,own_files=2,own_FS_mounts=0,own_loop_allocations=0,helper_executed=False),indent=2))
'''
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                  'hs@192.168.3.44','python3 -c '+shlex.quote(remote)],
                 input=json.dumps(payload),text=True,capture_output=True,timeout=60)
if p.returncode: raise RuntimeError(dict(rc=p.returncode,stderr=p.stderr,stdout=p.stdout))
obj=json.loads(p.stdout)
with (local/'helper-upload.json').open('x') as f: f.write(p.stdout)
print(json.dumps({k:v for k,v in obj.items() if k not in ('before','after')},indent=2))
