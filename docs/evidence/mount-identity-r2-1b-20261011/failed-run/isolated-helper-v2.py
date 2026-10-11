#!/usr/bin/env python3
"""Manual owner root entry. Research only. No Docker mutations or physical devices."""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import struct
import subprocess
import sys
import time

RUN = 'r2-1b-v2-20261011-01a12a22'
PROJECT = Path('/home/hs/homecloud-test') / RUN
DATA = Path('/mnt/1TB/homecloud-test') / RUN
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.name_to_handle_at.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.c_int]
LIBC.statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
RECORDS = []
JOURNAL = None

def command(args, timeout=20, pass_fds=(), check=True):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout,
                       pass_fds=pass_fds, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    r = dict(args=args, rc=p.returncode, stdout=p.stdout, stderr=p.stderr)
    if check and p.returncode:
        raise RuntimeError(r)
    return r

def emit(label, value):
    item=dict(test=label, result=value)
    RECORDS.append(item)
    if JOURNAL is not None:
        JOURNAL.write(json.dumps(item)+'\n'); JOURNAL.flush(); os.fsync(JOURNAL.fileno())

def require(ok, label):
    if not ok:
        raise RuntimeError(label)

def ns(kind):
    return os.readlink('/proc/self/ns/'+kind)

def snapshot():
    ids = command(['docker','ps','-aq'])['stdout'].split()
    fmt = '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    return dict(containers=sorted(command(['docker','inspect','--format',fmt]+ids)['stdout'].splitlines()),
                mountinfo=Path('/proc/self/mountinfo').read_text(),
                boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                mount_ns=ns('mnt'),user_ns=ns('user'),resources=command(['free','-m']))

def ancestors(path):
    for p in [path,*path.parents]:
        s = p.lstat()
        require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode), 'directory ancestor: '+str(p))

def parent_check(path):
    ancestors(path)
    s = path.stat()
    require(s.st_uid==1000 and stat.S_IMODE(s.st_mode)==0o700,'approved parent owner/mode')

def descriptor(path,directory=True):
    # All paths are inside our disposable FS. openat2 refuses magic/symlink ancestry.
    root = os.open('/',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
    how = struct.pack('QQQ',os.O_RDONLY|(os.O_DIRECTORY if directory else 0)|os.O_NOFOLLOW|os.O_CLOEXEC,0,0x08|0x04|0x02)
    buf = ctypes.create_string_buffer(how)
    fd = LIBC.syscall(ctypes.c_long(437),ctypes.c_int(root),ctypes.c_char_p(str(path)[1:].encode()),ctypes.byref(buf),ctypes.c_size_t(24))
    e = ctypes.get_errno()
    os.close(root)
    if fd<0:
        raise OSError(e,os.strerror(e))
    return fd

def observe_fd(fd):
    s = os.fstat(fd)
    h = ctypes.create_string_buffer(136)
    struct.pack_into('I',h,0,128)
    mid = ctypes.c_int(-1)
    ctypes.set_errno(0)
    rc = LIBC.name_to_handle_at(fd,b'',h,ctypes.byref(mid),0x1000)
    e = ctypes.get_errno() if rc<0 else 0
    length, typ = struct.unpack_from('Ii',h,0)
    require(rc==0 and length<=128,'name_to_handle_at unavailable: '+str(e))
    # Linux native AMD64 struct statx ABI: mask@0, stx_mnt_id@144, size256.
    sx = ctypes.create_string_buffer(256)
    sr = LIBC.statx(fd,b'',0x1000|0x100,0x4000,sx)
    mask = struct.unpack_from('I',sx,0)[0]
    require(sr==0 and mask&0x4000,'STATX_MNT_ID_UNIQUE unsupported')
    return dict(pid=os.getpid(),dev=s.st_dev,ino=s.st_ino,
                handle=dict(type=typ,length=length,hex=h.raw[8:8+length].hex()),
                mount_id=mid.value,unique_id=struct.unpack_from('Q',sx,144)[0])

def observe(path,directory=True):
    fd = descriptor(path,directory)
    try:
        return observe_fd(fd)
    finally:
        os.close(fd)

def no_xdev(fd,rel):
    how = ctypes.create_string_buffer(struct.pack('QQQ',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,0,0x08|0x04|0x02|0x01))
    ctypes.set_errno(0)
    out = LIBC.syscall(ctypes.c_long(437),ctypes.c_int(fd),ctypes.c_char_p(rel.encode()),ctypes.byref(how),ctypes.c_size_t(24))
    e = ctypes.get_errno() if out<0 else 0
    if out>=0:
        os.close(out)
    return dict(rc=out,errno=e)

def parse_backing_device(value):
    require(isinstance(value,str),'loop backing device unavailable')
    match=re.fullmatch(r'\s*([0-9]+)\s*:\s*([0-9]+)\s*',value)
    require(match is not None,'malformed loop backing device')
    return tuple(int(x) for x in match.groups())

def loop_identity(loop,st):
    require(re.fullmatch(r'/dev/loop[0-9]+',loop) is not None,'unexpected loop path')
    require(stat.S_ISBLK(os.stat(loop).st_mode),'loop not block device')
    j = json.loads(command(['losetup','--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT',loop])['stdout'])
    rows = j['loopdevices']
    require(len(rows)==1,'loop association count')
    r = rows[0]
    emit('loop-identity-observed',dict(raw=r,expected_backing_dev=st.st_dev,expected_backing_ino=st.st_ino,expected_major=os.major(st.st_dev),expected_minor=os.minor(st.st_dev)))
    require(r['name']==loop and int(r['back-ino'])==st.st_ino,'loop backing inode mismatch')
    require(parse_backing_device(r['back-maj:min'])==(os.major(st.st_dev),os.minor(st.st_dev)),'loop backing device mismatch')
    require(int(r['offset'])==0 and int(r['sizelimit'])==0,'unexpected loop slicing')
    return r

def prove_loop_unbound(loop):
    fd=os.open(loop,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        require(stat.S_ISBLK(st.st_mode) and os.major(st.st_rdev)==7 and os.minor(st.st_rdev)==int(loop[9:]),'loop node identity mismatch')
        try:
            fcntl.ioctl(fd,0x4c05,bytearray(232),True)
        except OSError as e:
            require(e.errno==errno.ENXIO,'unbound proof unavailable')
            return dict(kernel_errno=e.errno,unbound=True)
        raise RuntimeError('loop still associated after detach')
    finally: os.close(fd)

def stopped(signum,frame):
    raise RuntimeError('signal/timeout '+str(signum))

def filesystem(fs,size):
    image = DATA/(fs+'.img')
    target = DATA/(fs+'-mount')
    view = DATA/(fs+'-view')
    target.mkdir(mode=0o700)
    view.mkdir(mode=0o700)
    fd = os.open(image,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    st = os.fstat(fd)
    loop = None
    mounts = []
    clean = False
    def mounted_at(path):
        rows=[]
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            left,right=line.split(' - ',1)
            if left.split()[4]==str(path):
                require(right.split()[1]==loop,'mountpoint source no longer our loop')
                rows.append(line)
        return rows
    def mount(args,path):
        before=len(mounted_at(path))
        try:
            command(['mount']+args)
        finally:
            added=len(mounted_at(path))-before
            require(added in (0,1),'unexpected mount stack mutation')
            if added: mounts.append(path)
        require(added==1,'mount did not create expected instance')
    def unmount(path):
        require(mounts and mounts[-1]==path,'unmount ordering')
        require(mounted_at(path),'recorded mount disappeared')
        command(['umount',str(path)])
        mounts.pop()
    try:
        require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==0,'fresh image is not our regular file')
        os.ftruncate(fd,size)
        os.fsync(fd)
        emit(fs+'-fresh-image',dict(path=str(image),dev=st.st_dev,ino=st.st_ino,size=size,uid=st.st_uid,regular=True))
        pinned='/proc/self/fd/'+str(fd)
        # Formatter receives only an inherited FD to a proven fresh regular file.
        mkfs=['mkfs.ext4','-q','-F',pinned] if fs=='ext4' else ['mkfs.xfs','-f',pinned]
        emit(fs+'-mkfs',command(mkfs,timeout=30,pass_fds=(fd,)))
        # Know/journal the proposed loop before setup. EBUSY cannot replace an existing association.
        loop=command(['losetup','--find'])['stdout'].strip()
        require(re.fullmatch(r'/dev/loop[0-9]+',loop) is not None,'unexpected proposed loop')
        emit(fs+'-loop-proposed',dict(loop=loop,backing_dev=st.st_dev,backing_ino=st.st_ino))
        command(['losetup',loop,pinned],pass_fds=(fd,))
        emit(fs+'-loop',loop_identity(loop,st))
        mount(['-t',fs,'-o','nodev,nosuid,noexec',loop,str(target)],target)
        a=target/'a'; b=target/'b'
        a.mkdir(mode=0o700); b.mkdir(mode=0o700)
        (a/'marker').write_bytes(b'R2.1B disposable marker\n')
        (b/'marker').write_bytes((a/'marker').read_bytes())
        first=observe(a); copied=observe(b)
        marker_a=observe(a/'marker',False); marker_b=observe(b/'marker',False)
        require(first['handle']!=copied['handle'],'copied marker accepted replacement')
        require(marker_a['handle']!=marker_b['handle'],'copied marker same object handle')
        emit(fs+'-copy-replacement',dict(a=first,b=copied,marker_a=marker_a,marker_b=marker_b,marker_equal=True))
        # Separate process compares only identity; no retained descriptor crosses it.
        child_code="__name__='probe'\nSOURCE="+repr(SOURCE)+"\nexec(compile(SOURCE,'<verified-helper>','exec'))\nprint(json.dumps(observe(Path("+repr(str(a))+"))))\n"
        proc=json.loads(command(['/usr/bin/python3','-I','-c',child_code])['stdout'])
        require(first['handle']==proc['handle'] and first['pid']!=proc['pid'],'process identity')
        emit(fs+'-new-process',proc)
        (a/'nested').mkdir(mode=0o700)
        mount(['--bind',str(a),str(a/'nested')],a/'nested')
        nested=observe(a/'nested')
        basefd=descriptor(a)
        try:
            crossing=no_xdev(basefd,'nested')
        finally:
            os.close(basefd)
        require(nested['handle']==first['handle'] and nested['unique_id']!=first['unique_id'],'nested identity boundary')
        require(crossing['errno']==errno.EXDEV,'NO_XDEV did not reject nested mount')
        emit(fs+'-nested',dict(observation=nested,crossing=crossing))
        unmount(a/'nested')
        mount(['--bind',str(a),str(view)],view)
        retained=descriptor(view)
        try:
            old=observe_fd(retained)
            mount(['--bind',str(a),str(view)],view)
            same=observe(view)
            require(old['handle']==same['handle'] and old['unique_id']!=same['unique_id'],'same-object stack')
            emit(fs+'-same-object-stack',dict(old=old,new=same))
            unmount(view)
            mount(['--bind',str(b),str(view)],view)
            fresh=observe(view); pinned_old=observe_fd(retained)
            require(fresh['handle']!=old['handle'] and pinned_old==old,'live mutation retained FD')
            emit(fs+'-live-replacement',dict(path=fresh,retained_fd=pinned_old))
            unmount(view)
        finally:
            os.close(retained)
        unmount(view)
        recycle=target/'recycle'; recycle.mkdir(mode=0o700)
        initial=observe(recycle); recycle.rmdir()
        reused=None; deadline=time.monotonic()+15
        for i in range(500):
            if time.monotonic()>deadline: break
            recycle.mkdir(mode=0o700); now=observe(recycle); recycle.rmdir()
            if now['ino']==initial['ino']:
                require(now['handle']!=initial['handle'],'inode reused with same handle')
                reused=dict(iteration=i+1,before=initial,after=now); break
        emit(fs+'-recycle',dict(status='PASS_OBSERVED_REUSE' if reused else 'UNQUALIFIED_NO_REUSE',observed=reused,attempt_limit=500))
        command(['mount','-o','remount,ro',str(target)])
        ro=observe(a)
        require(ro['handle']==first['handle'],'rw-ro remount identity')
        ro_info=mounted_at(target)
        require('ro' in ro_info[-1].split(' - ')[0].split()[5].split(','),'remount ro flag absent')
        command(['mount','-o','remount,rw',str(target)])
        rw=observe(a); rw_info=mounted_at(target)
        require(rw['handle']==first['handle'] and 'rw' in rw_info[-1].split(' - ')[0].split()[5].split(','),'remount rw identity/flag')
        emit(fs+'-flag-remount',dict(before=first,readonly=ro,after=rw,ro_mountinfo=ro_info,rw_mountinfo=rw_info))
        # Durability preparation scoped to this disposable FS only; never global sync.
        for p in (a/'marker',b/'marker',a,b,target):
            syncfd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
            try: os.fsync(syncfd)
            finally: os.close(syncfd)
        before_unmount=observe(a)
        unmount(target)
        mount(['-t',fs,'-o','nodev,nosuid,noexec',loop,str(target)],target)
        after=observe(a)
        require(before_unmount['handle']==after['handle'] and before_unmount['unique_id']!=after['unique_id'],'clean unmount/remount identity')
        marker_after=observe(a/'marker',False)
        require(marker_after['handle']==marker_a['handle'],'marker handle after remount')
        emit(fs+'-clean-unmount-remount',dict(before=before_unmount,after=after,marker_after=marker_after))
        clean=True
    finally:
        cleanup_errors=[]
        while mounts:
            try: unmount(mounts[-1])
            except Exception as e:
                cleanup_errors.append(repr(e)); break
        if loop and not mounts:
            try:
                loop_identity(loop,st)
                command(['losetup','--detach',loop])
                emit(fs+'-loop-detached',dict(loop=loop,proof=prove_loop_unbound(loop)))
            except Exception as e: cleanup_errors.append(repr(e))
        os.close(fd)
        # Images and empty target directories remain for owner inspection/reproduction.
        emit(fs+'-cleanup',dict(clean_tests=clean,remaining_mounts=[str(x) for x in mounts],errors=cleanup_errors,image_preserved=str(image)))
        require(not cleanup_errors,'cleanup incomplete; preserve resources and STOP')

def child(host_mnt,host_user):
    global JOURNAL
    require(ns('mnt')!=host_mnt and ns('user')==host_user,'namespace isolation entry failed')
    jfd=os.open(PROJECT/'root-run-journal.ndjson',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    JOURNAL=os.fdopen(jfd,'w')
    emit('namespace-before-private',dict(host=host_mnt,child=ns('mnt'),user=ns('user'),pid=os.getpid(),starttime_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]))
    # First mount operation, already proven outside the invoking host namespace.
    command(['mount','--make-rprivate','/'])
    info=Path('/proc/self/mountinfo').read_text()
    require(all(not any(x.startswith(('shared:','master:','propagate_from:')) for x in row.split(' - ')[0].split()[6:]) for row in info.splitlines()),'propagation not private')
    emit('namespace-private-mountinfo',info)
    parent_check(DATA.parent)
    parent_mount=json.loads(command(['findmnt','--json','--target',str(DATA.parent),'--output','TARGET,FSTYPE'])['stdout'])['filesystems']
    require(len(parent_mount)==1 and parent_mount[0]['target']=='/mnt/1TB' and parent_mount[0]['fstype']=='ext4','approved ext4 test parent mapping changed')
    DATA.mkdir(mode=0o700)
    require(DATA.stat().st_uid==0 and stat.S_IMODE(DATA.stat().st_mode)==0o700,'own data root')
    require(os.statvfs(DATA).f_bavail*os.statvfs(DATA).f_frsize>1024**3,'insufficient disposable budget')
    signal.signal(signal.SIGTERM,stopped)
    signal.signal(signal.SIGALRM,stopped)
    signal.alarm(150)
    resource.setrlimit(resource.RLIMIT_AS,(256*1024**2,256*1024**2))
    os.nice(10)
    try:
        filesystem('ext4',64*1024**2)
        filesystem('xfs',384*1024**2)
        emit('research-status','COMPLETED_WITH_UNQUALIFIED_CONTAINER_ATTESTATION_REBOOT')
    except Exception as e:
        emit('research-error',repr(e))
        raise
    finally:
        signal.alarm(0)
        print(json.dumps(RECORDS,indent=2),flush=True)
        JOURNAL.close()

def main():
    require(os.geteuid()==0 and os.getuid()==0,'manual owner root entry required')
    require(os.uname().machine=='x86_64','only native AMD64 ABI qualified for this helper')
    require(ns('user')=='user:[4026531837]','initial Linux user namespace required')
    if globals().get('ENTRY')=='child':
        child(HOST_MNT,HOST_USER)
        return
    require(globals().get('ENTRY')=='parent','only verified in-memory parent/child dispatch')
    parent_check(PROJECT.parent)
    ancestors(PROJECT)
    require(PROJECT.stat().st_uid==1000 and stat.S_IMODE(PROJECT.stat().st_mode)==0o700,'project root owner/mode')
    require(not DATA.exists(),'exclusive disposable DATA already exists')
    before=snapshot()
    require(len(before['containers'])==26 and all(x.split('|')[5]=='true' for x in before['containers']),'26-container baseline mismatch')
    output=PROJECT/'root-run-result.json'
    outfd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
    # SOURCE is passed in memory; child never rereads a user-writable script.
    result=dict(source_sha256=hashlib.sha256(SOURCE.encode()).hexdigest(),initial=before,
                R2_1B_GATE='BLOCKED',R2_1_GATE='BLOCKED',status='BLOCKED',
                reason='container recreation/rprivate supplier mapping and trusted attestation/reboot remain unqualified')
    p=None
    try:
        child_code='SOURCE='+repr(SOURCE)+"\nENTRY='child'\nHOST_MNT="+repr(ns('mnt'))+'\nHOST_USER='+repr(ns('user'))+"\nexec(compile(SOURCE,'<verified-helper>','exec'))\n"
        p=subprocess.run(['unshare','--mount','--propagation','unchanged','/usr/bin/python3','-I','-c',child_code],
                         text=True,capture_output=True,env=env,timeout=240)
        result.update(child_rc=p.returncode,child_stdout=p.stdout,child_stderr=p.stderr)
        try: result['records']=json.loads(p.stdout) if p.stdout else []
        except Exception as e: result['parse_error']=repr(e)
    except subprocess.TimeoutExpired as e:
        def decoded(x): return x.decode(errors='replace') if isinstance(x,bytes) else x
        result.update(error=repr(e),child_stdout=decoded(e.stdout),child_stderr=decoded(e.stderr),cleanup='UNKNOWN; inspect own journal/backing identity; do not detach unverified loops')
    except Exception as e:
        result['error']=repr(e)
    finally:
        try:
            after=snapshot(); result['final']=after
            result['invariants']={key:before[key]==after[key] for key in ('containers','mountinfo','boot_id','mount_ns','user_ns')}
        except Exception as e: result['final_snapshot_error']=repr(e)
        journal=PROJECT/'root-run-journal.ndjson'
        if journal.exists():
            try: result['journal_raw']=journal.read_text()
            except Exception as e: result['journal_read_error']=repr(e)
        with os.fdopen(outfd,'w') as f:
            json.dump(result,f,indent=2)
            f.flush(); os.fsync(f.fileno())
    require(result.get('invariants') and all(result['invariants'].values()),'host final invariant unavailable/mismatch; STOP')
    require(p is not None and p.returncode==0 and 'parse_error' not in result,'child failed; see result and own journal')
    print('Research evidence: '+str(output)+'; gates remain BLOCKED')

# Verified launcher defines SOURCE before exec. Reject ordinary path execution to prevent reread races.
if __name__=='__main__':
    require('SOURCE' in globals(),'use the SHA256-verifying manual launcher')
    main()
