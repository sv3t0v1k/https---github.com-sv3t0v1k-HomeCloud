#!/usr/bin/env python3
"""Read-only post-run loop visibility and exact child PID lifetime inspection."""
import json
from pathlib import Path
import shlex
import subprocess

HERE=Path(__file__).resolve().parent
records=json.loads((HERE/'root-run-result.json').read_text())['records']
namespace=next(r['result'] for r in records if r['test']=='namespace-before-private')
loops=sorted({r['result']['loop'] for r in records if r['test'].endswith('-loop-proposed')})
assert loops==['/dev/loop8']
remote=r'''
import errno,json,os,stat,subprocess,sys
from pathlib import Path
d=json.load(sys.stdin);out={'loops':{},'child':{}}
for loop in d['loops']:
    assert loop=='/dev/loop8'
    s=os.stat(loop);assert stat.S_ISBLK(s.st_mode) and os.major(s.st_rdev)==7 and os.minor(s.st_rdev)==8
    item=dict(block_rdev=[os.major(s.st_rdev),os.minor(s.st_rdev)])
    try: item['sysfs_backing_file']=Path('/sys/block/loop8/loop/backing_file').read_text()
    except OSError as e: item['sysfs_backing_file_errno']=e.errno
    p=subprocess.run(['losetup','--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT',loop],text=True,capture_output=True,timeout=10)
    item['listing']=dict(rc=p.returncode,stdout=p.stdout,stderr=p.stderr);out['loops'][loop]=item
pid=d['namespace']['pid'];assert isinstance(pid,int) and pid>0
try:
    now=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    out['child']=dict(pid=pid,current_starttime_ticks=now,same_lifetime=now==d['namespace']['starttime_ticks'])
except OSError as e: out['child']=dict(pid=pid,stat_errno=e.errno)
print(json.dumps(out,indent=2))
'''
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                  'hs@192.168.3.44','python3 -c '+shlex.quote(remote)],input=json.dumps(dict(namespace=namespace,loops=loops)),text=True,capture_output=True,timeout=30)
if p.returncode: raise RuntimeError(dict(rc=p.returncode,stderr=p.stderr))
(HERE/'cleanup-readonly.json').write_text(p.stdout)
print(p.stdout)
