#!/usr/bin/env python3
"""Offline evidence consistency and AST-extracted guard tests; never access devices."""
import ast
import errno
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
checks=[]
def check(name,ok):
    checks.append(dict(check=name,status='PASS' if ok else 'FAIL'))
    if not ok: raise AssertionError(name)
def load(name): return json.loads((HERE/name).read_text())

root=load('root-run-result.json')
post=load('post-failure-readonly.json')['snapshot']
upload=load('v2-upload.json')
journal=[json.loads(x) for x in (HERE/'root-run-journal.ndjson').read_text().splitlines()]
items={r['test']:r['result'] for r in journal}
check('original helper SHA',root['source_sha256']=='8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426')
check('child failed',root['child_rc']==1)
check('reported gates remain BLOCKED',root['R2_1B_GATE']==root['R2_1_GATE']=='BLOCKED')
check('parent all five invariants',set(root['invariants'])=={'containers','mountinfo','boot_id','mount_ns','user_ns'} and all(root['invariants'].values()))
check('initial 26 unique running',len(root['initial']['containers'])==26 and len({r.split('|')[0] for r in root['initial']['containers']})==26 and all(r.split('|')[5]=='true' for r in root['initial']['containers']))
check('root snapshots exact records',root['initial']['containers']==root['final']['containers'])
check('root snapshots full mountinfo',root['initial']['mountinfo']==root['final']['mountinfo'])
check('post-failure exact container records',post['containers']==root['initial']['containers'])
check('post-failure full mountinfo',post['mountinfo']==root['initial']['mountinfo'])
check('post-failure boot and namespaces',all(post[k]==root['initial'][k] for k in ('boot_id','mount_ns','user_ns')))
baseline_path=HERE.parent/'baseline.json'
if not baseline_path.exists(): baseline_path=HERE.parent/'r2-1b'/'baseline.json'
baseline=json.loads(baseline_path.read_text())['snapshot']
check('historical preflight records and mountinfo',baseline['containers']==post['containers'] and baseline['mountinfo']==post['mountinfo'])
check('old R2.1 fixture inventory metadata/content',baseline['fixtures']==post['fixtures'])
check('host mountinfo baseline SHA',hashlib.sha256(root['initial']['mountinfo'].encode()).hexdigest()=='0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429')
check('journal matches records',journal==root['records'] and (HERE/'root-run-journal.ndjson').read_text()==root['journal_raw'])
ns=items['namespace-before-private']
check('distinct mount namespace, same user namespace',ns['host']=='mnt:[4026531841]' and ns['child']=='mnt:[4026533239]' and ns['child']!=ns['host'] and ns['user']=='user:[4026531837]')
rows=items['namespace-private-mountinfo'].splitlines()
check('all child propagation private',len(rows)>0 and all(not any(v.startswith(('shared:','master:','propagate_from:')) for v in row.split(' - ')[0].split()[6:]) for row in rows))
image=items['ext4-fresh-image']
check('recorded own regular fresh ext4 image',image==dict(path='/mnt/1TB/homecloud-test/r2-1b-20261011-01a12a22/ext4.img',dev=2081,ino=64225325,size=67108864,uid=0,regular=True))
check('mkfs only inherited FD and succeeded',items['ext4-mkfs']['rc']==0 and items['ext4-mkfs']['args'][:3]==['mkfs.ext4','-q','-F'] and re.fullmatch(r'/proc/self/fd/[0-9]+',items['ext4-mkfs']['args'][3]) is not None)
check('own loop8 proposed',items['ext4-loop-proposed']['loop']=='/dev/loop8')
check('mount tests absent and XFS not begun',not any(k.startswith('xfs-') or k.endswith(('-nested','-copy-replacement','-clean-unmount-remount')) for k in items))
cleanup=items['ext4-cleanup']
check('cleanup failed with no recorded own mounts',cleanup['remaining_mounts']==[] and cleanup['errors']==["RuntimeError('loop backing device mismatch')"] and not cleanup['clean_tests'])
check('upload invariant and root not executed',upload['before']==upload['after'] and upload['own_files']==3 and not upload['helper_executed'] and not upload['recovery_executed'] and upload['new_loop_allocations']==0)
check('upload vs root original baseline',upload['before']['containers']==root['initial']['containers'] and upload['before']['mountinfo_sha256']==post['mountinfo_sha256'])
for name,digest in upload['files'].items():
    check('uploaded exact bytes '+name,hashlib.sha256((HERE/name).read_bytes()).hexdigest()==digest)

# Compile only named function definitions. No helper top-level statements or devices.
tree=ast.parse((HERE/'isolated-helper-v2.py').read_text())
selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('require','parse_backing_device','loop_identity','prove_loop_unbound')]
logs=[]; closed=[]; ioctls=[]; row={}; kernel_error=None
def major(dev):
    assert dev==2081 or dev==0x708
    return 8 if dev==2081 else 7
def minor(dev): return 33 if dev==2081 else 8
def ioctl(fd,request,buffer,mutate):
    ioctls.append((fd,request,len(buffer),mutate))
    if kernel_error is not None: raise OSError(kernel_error,'mock error')
def close(fd): closed.append(fd)
mock_os=SimpleNamespace(stat=lambda p:SimpleNamespace(st_mode=stat.S_IFBLK),major=major,minor=minor,
    open=lambda *a:17,fstat=lambda fd:SimpleNamespace(st_mode=stat.S_IFBLK,st_rdev=0x708),close=close,
    O_RDONLY=0,O_NONBLOCK=2048,O_NOFOLLOW=131072,O_CLOEXEC=524288)
env=dict(re=re,json=json,stat=stat,errno=errno,os=mock_os,fcntl=SimpleNamespace(ioctl=ioctl),
    emit=lambda label,value:logs.append((label,value)),
    command=lambda args:dict(stdout=json.dumps(dict(loopdevices=[row]))))
exec(compile(ast.Module(body=selected,type_ignores=[]),'<extracted-guards>','exec'),env)
base=dict(name='/dev/loop8',**{'back-ino':64225325,'back-maj:min':'       8:33 '},offset=0,sizelimit=0)
cases=[('padded',{},True),('compact',{'back-maj:min':'8:33'},True),('numeric-equivalent',{'back-maj:min':'08:033'},True),
       ('wrong-device',{'back-maj:min':'8:34'},False),('wrong-inode',{'back-ino':64225326},False),
       ('unavailable',{'back-maj:min':None},False),('malformed',{'back-maj:min':'8:33 extra'},False),
       ('negative',{'back-maj:min':'-8:33'},False),('offset',{'offset':4096},False),('sizelimit',{'sizelimit':4096},False)]
for name,change,expected in cases:
    row=dict(base,**change);logs.clear()
    try: env['loop_identity']('/dev/loop8',SimpleNamespace(st_dev=2081,st_ino=64225325));accepted=True
    except RuntimeError: accepted=False
    check('parser '+name,accepted==expected and len(logs)==1 and logs[0][1]['raw']==row)
for label,code,expected in [('ENXIO',errno.ENXIO,True),('EPERM',errno.EPERM,False),('EIO',errno.EIO,False),('bound',None,False)]:
    kernel_error=code;closed.clear();ioctls.clear()
    try: env['prove_loop_unbound']('/dev/loop8');accepted=True
    except RuntimeError: accepted=False
    check('kernel status '+label,accepted==expected and closed==[17] and ioctls==[(17,0x4c05,232,True)])

for name in ('recover-owned-loop.py','isolated-helper-v2.py','upload-v2.py'):
    ast.parse((HERE/name).read_text())
subprocess.run(['sh','-n',str(HERE/'manual-launch-v2.sh')],check=True)
launcher=(HERE/'manual-launch-v2.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0]
ast.parse(launcher)
check('source and launcher syntax',True)
result=dict(status='PASS',count=len(checks),scope='offline consistency/mocked guards; no runtime recovery or FS qualification',checks=checks)
(HERE/'followup-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='checks'}))
