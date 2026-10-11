#!/usr/bin/env python3
"""Owner root one-shot recovery: only recorded loop8; no mount or FS mutations."""
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess

PROJECT=Path('/home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22')
IMAGE=Path('/mnt/1TB/homecloud-test/r2-1b-20261011-01a12a22/ext4.img')
LOOP='/dev/loop8'
OLD_NS='mnt:[4026533239]'
EXPECTED_DEV=2081
EXPECTED_INO=64225325
EXPECTED_SIZE=67108864

def require(ok,msg):
    if not ok: raise RuntimeError(msg)

def command(args,check=True):
    p=subprocess.run(args,text=True,capture_output=True,timeout=20,
                     env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    x=dict(args=args,rc=p.returncode,stdout=p.stdout,stderr=p.stderr)
    if check: require(p.returncode==0,x)
    return x

def snapshot():
    ids=command(['docker','ps','-aq'])['stdout'].split()
    fmt='{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    return dict(containers=sorted(command(['docker','inspect','--format',fmt]+ids)['stdout'].splitlines()),
                mountinfo=Path('/proc/self/mountinfo').read_text())

def absent_process(e):
    return e.errno in (errno.ENOENT,errno.ESRCH)

def prove_unused(loop_rdev):
    # Examine only namespace IDs, mount dev numbers and open block-device FDs.
    # Do not retain unrelated process paths or command lines.
    checked=0
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit(): continue
        proc=Path(entry.path)
        try:
            require(os.readlink(proc/'ns/mnt')!=OLD_NS,'old namespace still alive: PID'+entry.name)
            for line in (proc/'mountinfo').read_text().splitlines():
                require(line.split()[2]!=f'{os.major(loop_rdev)}:{os.minor(loop_rdev)}','own loop still mounted: PID'+entry.name)
            for fd in os.scandir(proc/'fd'):
                try: s=os.stat(fd.path)
                except OSError as e:
                    if absent_process(e): continue
                    raise
                require(not(stat.S_ISBLK(s.st_mode) and s.st_rdev==loop_rdev),'own loop still opened: PID'+entry.name)
            checked+=1
        except OSError as e:
            if absent_process(e): continue
            raise
    return dict(checked_processes=checked,old_namespace_absent=True,own_loop_mounts_or_open_fds=0)

def recover():
    require(os.getuid()==0 and os.geteuid()==0,'manual owner root entry required')
    require(os.uname().machine=='x86_64' and os.readlink('/proc/self/ns/user')=='user:[4026531837]','native initial-userns root required')
    # No inode path changes allowed by trusted hs/root writers during recovery.
    for p in [IMAGE.parent,*IMAGE.parent.parents,PROJECT,*PROJECT.parents]:
        s=p.lstat(); require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode),'directory ancestor mismatch')
    fd=os.open(IMAGE,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        image=os.fstat(fd)
        require(stat.S_ISREG(image.st_mode) and image.st_uid==0 and image.st_nlink==1 and
                image.st_dev==EXPECTED_DEV and image.st_ino==EXPECTED_INO and image.st_size==EXPECTED_SIZE,'recorded image identity mismatch')
        output=PROJECT/'recovery-result.json'
        outfd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        result=dict(status='BLOCKED',image=dict(dev=image.st_dev,ino=image.st_ino,size=image.st_size),loop=LOOP)
        before=snapshot(); result['initial']=before
        try:
            require(len(before['containers'])==26 and all(x.split('|')[5]=='true' for x in before['containers']),'26-container baseline mismatch')
            require(stat.S_ISBLK(os.stat(LOOP).st_mode),'loop8 not block device')
            loop_rdev=os.stat(LOOP).st_rdev
            raw=command(['losetup','--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT',LOOP])
            result['loop_raw']=raw
            rows=json.loads(raw['stdout'])['loopdevices']
            require(len(rows)==1,'loop8 association absent/ambiguous; STOP without detach')
            row=rows[0]
            pair=re.fullmatch(r'\s*([0-9]+)\s*:\s*([0-9]+)\s*',str(row['back-maj:min']))
            require(pair is not None,'root loop backing device unavailable')
            require(row['name']==LOOP and int(row['back-ino'])==image.st_ino and
                    tuple(int(x) for x in pair.groups())==(os.major(image.st_dev),os.minor(image.st_dev)) and
                    int(row['offset'])==0 and int(row['sizelimit'])==0,'loop does not match recorded image; NO DETACH')
            result['unused_proof']=prove_unused(loop_rdev)
            # Save proof before the sole permitted mutation, including raw padded value.
            with os.fdopen(os.dup(outfd),'w') as f:
                json.dump(result,f,indent=2); f.flush(); os.fsync(f.fileno())
            # Repeat the exact backing identity immediately before detach.
            repeated=command(['losetup','--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT',LOOP])
            again=json.loads(repeated['stdout'])['loopdevices']
            result['loop_recheck']=repeated
            require(len(again)==1 and again[0]==row,'loop identity changed during unused proof; NO DETACH')
            result['detach']=command(['losetup','--detach',LOOP])
            # Explicit losetup table may retain a NAME/null row after detach.
            # Query the kernel instead; only ENXIO proves unbound, never null JSON.
            loopfd=os.open(LOOP,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                require(os.fstat(loopfd).st_rdev==loop_rdev,'loop node identity changed')
                try:
                    fcntl.ioctl(loopfd,0x4c05,bytearray(232),True)  # LOOP_GET_STATUS64, read only
                except OSError as e:
                    result['loop_after_kernel_errno']=e.errno
                    require(e.errno==errno.ENXIO,'association status unavailable; STOP')
                else: raise RuntimeError('loop still associated after detach; STOP')
            finally: os.close(loopfd)
            result['status']='OWN_LOOP_DETACHED'
        except Exception as e:
            result['error']=repr(e)
        finally:
            try:
                after=snapshot();result['final']=after
                result['invariants']=dict(containers=before['containers']==after['containers'],mountinfo=before['mountinfo']==after['mountinfo'])
            except Exception as e: result['final_snapshot_error']=repr(e)
            os.lseek(outfd,0,os.SEEK_SET);os.ftruncate(outfd,0)
            with os.fdopen(outfd,'w') as f:
                json.dump(result,f,indent=2);f.flush();os.fsync(f.fileno())
        require(result['status']=='OWN_LOOP_DETACHED' and result.get('invariants') and all(result['invariants'].values()),'recovery incomplete; STOP; see recovery-result.json')
        print('Verified own loop8 detached; recorded image preserved.')
    finally:
        os.close(fd)
