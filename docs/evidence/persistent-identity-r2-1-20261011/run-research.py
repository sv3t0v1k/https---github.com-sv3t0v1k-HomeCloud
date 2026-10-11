#!/usr/bin/env python3
"""Standalone server research; writes only two exclusive owner-approved subdirs."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import time

RUN = 'r2-identity-20261011-01a12a10'
PROJECT = Path('/home/hs/homecloud-test') / RUN
DATA = Path('/mnt/1TB/homecloud-test') / RUN
IMAGE = 'sha256:8694a91c8306b7f43e6d5d93f693973ddb5d302010dee477d0e6fc7f83cb4e52'
records = []
containers = []

def command(args, timeout=30, check=True):
    r = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError({'args': args, 'rc': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr})
    return r

def snapshot():
    ids = command(['docker', 'ps', '-q']).stdout.split()
    fmt = '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    return sorted(command(['docker', 'inspect', '--format', fmt] + ids).stdout.splitlines())

def emit(label, result):
    item = {'test': label, 'result': result}
    records.append(item)
    print(json.dumps(item), flush=True)

def probe(label, root, key=None):
    args = [str(PROJECT/'identity-probe'), str(root)] + ([key] if key else [])
    r = command(args, check=False)
    obj = json.loads(r.stdout)
    obj['exit'] = r.returncode
    emit(label, obj)
    return obj

def identity(obj):
    h = obj['empty']
    if h['rc'] != 0:
        raise RuntimeError('handle unavailable: ' + json.dumps(obj))
    return h['type'], h['bytes'], h['hex']

def container(label, src, root='/qualified', key=None, extra=None, uid=1000, keep=False):
    name = RUN + '-' + label
    containers.append(name)
    args = ['docker','run','--name',name,'--pull','never','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--network','none','--memory','64m',
            '--memory-swap','64m','--cpus','0.25','--pids-limit','32','--user',str(uid)+':'+str(uid),
            '--label','homecloud.research=MS-3B-R2.1',
            '--mount',f'type=bind,src={PROJECT}/identity-probe,dst=/probe,readonly',
            '--mount',f'type=bind,src={src},dst=/qualified,readonly']
    if extra:
        args += ['--mount',extra]
    args += ['--entrypoint','/probe',IMAGE,root] + ([key] if key else [])
    r = command(args, timeout=45, check=False)
    obj = {'exit':r.returncode,'stderr':r.stderr,'probe':json.loads(r.stdout) if r.stdout else None}
    emit('container-'+label,obj)
    fmt = '{{.State.OOMKilled}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.CapDrop}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}'
    emit('container-config-'+label,command(['docker','inspect','--format',fmt,name]).stdout.strip())
    if not keep:
        command(['docker','rm',name])
        containers.remove(name)
    return obj['probe'], name

before = snapshot()
emit('baseline-containers',before)
emit('baseline-resources',command(['free','-m']).stdout)
emit('baseline-mountinfo',Path('/proc/self/mountinfo').read_text())
for parent in [PROJECT.parent,DATA.parent]:
    for p in [parent,*parent.parents]:
        if p.is_symlink(): raise RuntimeError('symlink ancestor: '+str(p))
    st=parent.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o777 != 0o700:
        raise RuntimeError('unsafe parent: '+str(parent))
if os.getuid()!=1000: raise RuntimeError('unexpected host UID')
os.mkdir(PROJECT,0o700)
os.mkdir(DATA,0o700)
try:
    # Source supplied through stdin JSON payload; no repo checkout modifications.
    import sys
    source=json.load(sys.stdin)['source']
    (PROJECT/'identity-probe.c').write_text(source)
    command(['cc','-std=c11','-O2','-Wall','-Wextra','-Werror','-static',str(PROJECT/'identity-probe.c'),'-o',str(PROJECT/'identity-probe')])
    emit('probe-sha256',hashlib.sha256((PROJECT/'identity-probe').read_bytes()).hexdigest())
    emit('probe-source-sha256',hashlib.sha256(source.encode()).hexdigest())
    a=DATA/'a'; b=DATA/'b'
    a.mkdir(mode=0o700); b.mkdir(mode=0o700); (a/'nested').mkdir(mode=0o700)
    marker=b'homecloud-r2-disposable-marker\n'
    (a/'marker').write_bytes(marker); (b/'marker').write_bytes(marker)
    first=probe('ext4-process-1',a)
    second=probe('ext4-process-2',a)
    assert identity(first)==identity(second)
    assert first['empty']==first['dot']
    emit('process-restart-comparison',{'equal':True,'pids':[first['pid'],second['pid']]})
    copied=probe('copied-marker-other-directory',b)
    assert identity(first)!=identity(copied)
    emit('copied-marker-comparison',{'same_marker_sha256':hashlib.sha256(marker).hexdigest(),'workspace_handles_equal':False})
    original_marker=probe('original-marker-handle',a,'marker')
    copied_marker=probe('copied-marker-handle',b,'marker')
    assert identity(original_marker)!=identity(copied_marker)
    # Rename same object, then recreate a path with copied marker and no original anchors.
    old=DATA/'original-renamed'
    a.rename(old)
    renamed=probe('rename-same-directory',old)
    assert identity(first)==identity(renamed)
    a.mkdir(mode=0o700); (a/'nested').mkdir(mode=0o700); (a/'marker').write_bytes(marker)
    replaced=probe('same-path-new-directory',a)
    assert identity(first)!=identity(replaced)
    emit('replacement-comparison',{'renamed_handle_equal':True,'replacement_handle_equal':False})
    # In-place content mutation demonstrates identity is not content integrity.
    (a/'marker').write_bytes(b'changed-in-place\n')
    same_object1=probe('marker-before-second-inplace-write',a,'marker')
    (a/'marker').write_bytes(marker)
    same_object2=probe('marker-after-second-inplace-write',a,'marker')
    assert identity(same_object1)==identity(same_object2)
    emit('inplace-mutation-comparison',{'handle_equal':True,'content_equal':False})
    cycle=DATA/'recycle'; cycle.mkdir(mode=0o700)
    prior=probe('recycle-original',cycle); target=prior['ino']; recycle=None
    for n in range(1,257):
        cycle.rmdir(); cycle.mkdir(mode=0o700)
        if cycle.stat().st_ino==target:
            recycled=probe('recycle-same-inode',cycle)
            recycle={'attempt':n,'ino':target,'handle_equal':identity(prior)==identity(recycled),'before':prior,'after':recycled}
            assert not recycle['handle_equal']
            break
    emit('inode-recycling',recycle or {'attempts':256,'same_inode_observed':False,'verdict':'UNQUALIFIED'})
    # XFS root metadata only. No directory traversal, creation, or content read.
    xfs1=probe('xfs-root-readonly-process-1','/mnt/data')
    xfs2=probe('xfs-root-readonly-process-2','/mnt/data')
    emit('xfs-readonly-comparison',{'equal':identity(xfs1)==identity(xfs2),'mutations':0})
    c1,name=container('restart',a,keep=True)
    assert identity(c1)==identity(replaced)
    r=command(['docker','start','--attach',name],timeout=45)
    cr=json.loads(r.stdout); emit('container-restart-same-id',cr)
    assert identity(cr)==identity(c1)
    command(['docker','rm',name]); containers.remove(name)
    c2,_=container('recreate',a)
    assert identity(c1)==identity(c2)
    emit('host-container-restart-comparison',{'all_handles_equal':True,'mount_ids':[replaced['mount_id'],c1['mount_id'],cr['mount_id'],c2['mount_id']]})
    cx,_=container('xfs-readonly','/mnt/data')
    assert identity(cx)==identity(xfs1)
    # Default-overlay backing root is metadata-only and expected unsupported.
    overlay,_=container('overlay',a,root='/')
    emit('overlay-capability',{'name_to_handle_errno':overlay['empty']['errno'],'fallback_used':False})
    # Docker creates disposable namespace binds; workload capabilities remain zero.
    nest=f'type=bind,src={a},dst=/qualified/nested,readonly'
    nested,_=container('nested-same-object',a,root='/qualified/nested',extra=nest)
    assert identity(nested)==identity(c2)
    blocked,_=container('nested-no-xdev',a,key='nested',extra=nest)
    assert blocked['child_open_errno']==18
    emit('nested-comparison',{'same_object_handle_equal':True,'openat2_NO_XDEV_errno':18})
    swapped,_=container('swap-source',b)
    assert identity(swapped)!=identity(c2)
    emit('disposable-bind-source-swap',{'handles_equal':False,'physical_remount_test':False})
    # UID1001 raw capability probe only; production ownership admission is not exercised.
    prod,_=container('uid1001',a,uid=1001)
    emit('uid1001-raw-capability',prod)
    emit('research-tests','PASS_WITH_UNQUALIFIED_SCENARIOS')
finally:
    for name in containers:
        command(['docker','rm','-f',name],check=False)
    after=snapshot()
    emit('final-containers',after)
    emit('existing-container-invariants',{'equal':before==after,'before_count':len(before),'after_count':len(after)})
    emit('final-resources',command(['free','-m']).stdout)
    emit('final-mountinfo',Path('/proc/self/mountinfo').read_text())
    emit('final-test-usage',command(['du','-sk',str(PROJECT),str(DATA)]).stdout)
    # Leave small owned evidence/fixtures for reproducibility; no broad cleanup.
    (PROJECT/'results.json').write_text(json.dumps(records,indent=2))
