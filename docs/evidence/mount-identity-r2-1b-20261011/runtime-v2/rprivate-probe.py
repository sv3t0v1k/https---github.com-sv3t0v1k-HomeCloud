#!/usr/bin/env python3
"""Non-root private supplier vs ordinary Docker source mapping, disposable only.

No loops/mkfs/physical mounts/root entry; tmpfs4MiB in verified new user/mount ns.
This tests namespace mapping, not ext4/XFS persistent identity or secure attestation.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

RUN='r2-1b-rprivate-20261011-01a12a22'
PROJECT=Path('/home/hs/homecloud-test')/RUN
DATA=Path('/mnt/1TB/homecloud-test')/RUN
SOURCE=DATA/'source'
PRIVATE=DATA/'private-fs'
IMAGE='sha256:c3ff13b395fdf1f251c33ff475318e1c2b8a683e268dcb25142e47d20efba90f'
LABEL='com.homecloud.research-run'

def require(ok,msg):
    if not ok: raise RuntimeError(msg)
def command(args,check=True):
    p=subprocess.run(args,text=True,capture_output=True,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    d=dict(args=args,rc=p.returncode,stdout=p.stdout,stderr=p.stderr)
    if check: require(p.returncode==0,d)
    return d
def write(name,data):
    part=PROJECT/(name+'.part')
    fd=os.open(part,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: json.dump(data,f,indent=2);f.flush();os.fsync(f.fileno())
    os.link(part,PROJECT/name,follow_symlinks=False);os.unlink(part)
    dfd=os.open(PROJECT,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
def ns(kind):return os.readlink('/proc/self/ns/'+kind)
def snapshot():
    ids=command(['docker','ps','-aq'])['stdout'].split()
    fmt='{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{with index .State "Health"}}{{.Status}}{{end}}'
    return dict(containers=sorted(command(['docker','inspect','--format',fmt]+ids)['stdout'].splitlines()),mountinfo=Path('/proc/self/mountinfo').read_text())
def observation(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        s=os.fstat(fd)
        return dict(marker=os.read(fd,128).decode(),dev=s.st_dev,ino=s.st_ino,mount_ns=ns('mnt'),user_ns=ns('user'))
    finally: os.close(fd)
def wait_file(name,child=None):
    deadline=time.monotonic()+15
    while not (PROJECT/name).exists():
        require(child is None or child.poll() is None,'supplier exited before '+name)
        require(time.monotonic()<deadline,'wait timeout '+name)
        time.sleep(0.05)
    return json.loads((PROJECT/name).read_text())

def supplier(host_mnt,host_user):
    result=dict(status='BLOCKED',cleanup_errors=[],mounts=[])
    try:
        require(os.getuid()==0 and ns('mnt')!=host_mnt and ns('user')!=host_user,'new mapped user/mount isolation required')
        require(Path('/proc/self/uid_map').read_text().split()==['0','1000','1'],'unexpected root UID mapping')
        status=Path('/proc/self/status').read_text()
        caps=int(re.search(r'^CapEff:\s*([0-9a-f]+)',status,re.M)[1],16)
        require(caps&(1<<21),'own-userns CAP_SYS_ADMIN missing')
        result['isolation']=dict(host_mnt=host_mnt,child_mnt=ns('mnt'),host_user=host_user,child_user=ns('user'),uid_map=Path('/proc/self/uid_map').read_text(),cap_eff=hex(caps))
        # Already verified outside host namespace; first mount mutation is child-only.
        command(['mount','--make-rprivate','/'])
        info=Path('/proc/self/mountinfo').read_text()
        require(all(not any(v.startswith(('shared:','master:','propagate_from:')) for v in m.split(' - ')[0].split()[6:]) for m in info.splitlines()),'propagation not private')
        result['private_mountinfo']=info
        write('supplier-private-proof.json',result)
        command(['mount','-t','tmpfs','-o','size=4m,nodev,nosuid,noexec,mode=0700','tmpfs',str(PRIVATE)])
        result['mounts'].append(str(PRIVATE))
        for sub,text in [('a','PRIVATE_A\n'),('b','PRIVATE_B\n')]:
            (PRIVATE/sub).mkdir(mode=0o700);(PRIVATE/sub/'marker').write_text(text)
        command(['mount','--bind',str(PRIVATE/'a'),str(SOURCE)])
        result['mounts'].append(str(SOURCE))
        a=observation(SOURCE/'marker');require(a['marker']=='PRIVATE_A\n','supplier a observation mismatch')
        result['a']=a;write('supplier-a.json',a)
        wait_file('replace.json')
        command(['mount','--bind',str(PRIVATE/'b'),str(SOURCE)])
        result['mounts'].append(str(SOURCE))
        b=observation(SOURCE/'marker');require(b['marker']=='PRIVATE_B\n' and b['ino']!=a['ino'],'supplier b observation mismatch')
        result['b']=b;write('supplier-b.json',b)
        wait_file('release.json')
        result['status']='OBSERVED_PRIVATE_SUPPLIER_REPLACEMENT'
    except Exception as e:result['error']=repr(e)
    finally:
        # Only own verified tmpfs/bind mount instances, inside this child namespace.
        while result['mounts']:
            target=result['mounts'][-1]
            try:
                matches=[m for m in Path('/proc/self/mountinfo').read_text().splitlines() if m.split(' - ')[0].split()[4]==target]
                require(matches and all(m.split(' - ')[1].split()[0]=='tmpfs' for m in matches),'own tmpfs mount identity absent; STOP cleanup')
                command(['umount',target]);result['mounts'].pop()
            except Exception as e:result['cleanup_errors'].append(repr(e));break
        write('supplier-result.json',result)
    require(result['status']=='OBSERVED_PRIVATE_SUPPLIER_REPLACEMENT' and not result['mounts'] and not result['cleanup_errors'],'supplier incomplete; see result')

PROBE_JS="""const fs=require('fs');let s=fs.statSync('/probe/marker');let p=fs.readFileSync('/proc/self/status','utf8');let f={};for(let k of ['CapEff','CapPrm','NoNewPrivs','Seccomp'])f[k]=p.match(new RegExp('^'+k+':\\\\s*(.*)$','m'))[1];console.log(JSON.stringify({marker:fs.readFileSync('/probe/marker','utf8'),dev:s.dev,ino:s.ino,mount_ns:fs.readlinkSync('/proc/self/ns/mnt'),profile:f,mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').filter(x=>x.split(' - ')[0].split(' ')[4]==='/probe')}));"""

def main():
    require(os.getuid()==1000 and os.geteuid()==1000,'non-root hs only')
    for parent in [PROJECT.parent,DATA.parent]:
        for path in [parent,*parent.parents]:
            st=path.lstat();require(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode),'ancestor is not directory')
        st=parent.stat();require(st.st_uid==1000 and stat.S_IMODE(st.st_mode)==0o700,'approved parent owner/mode')
    before=snapshot();require(len(before['containers'])==26 and all(x.split('|')[5]=='true' for x in before['containers']),'initial26 mismatch')
    require(hashlib.sha256(before['mountinfo'].encode()).hexdigest()=='0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429','original host mountinfo changed; STOP before writes')
    meta=command(['docker','image','inspect',IMAGE,'--format','{{.Id}}|{{.Architecture}}|{{json (index .Config "Volumes")}}'])
    require(meta['stdout'].strip()==IMAGE+'|amd64|null','cached image mismatch/anonymous volumes forbidden')
    PROJECT.mkdir(mode=0o700);DATA.mkdir(mode=0o700);SOURCE.mkdir(mode=0o700);PRIVATE.mkdir(mode=0o700)
    (SOURCE/'marker').write_text('HOST_SOURCE\n')
    host=observation(SOURCE/'marker');result=dict(status='BLOCKED',source_sha256=hashlib.sha256(SOURCE_CODE.encode()).hexdigest(),initial=before,host=host,image=meta,containers=[],cleanup_errors=[],gate='BLOCKED')
    owned=[];candidates=[];child=None
    original_ids={r.split('|')[0] for r in before['containers']}
    def own_config(cid):
        fmt='{{json .Mounts}}\n{{.HostConfig.Privileged}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}|{{.Config.User}}\n{{index .Config.Labels "'+LABEL+'"}}'
        d=command(['docker','inspect','--format',fmt,cid]);require(d['stdout'].splitlines()[-1]==RUN and cid not in original_ids,'container ownership label/baseline mismatch')
        m=json.loads(d['stdout'].splitlines()[0]);require(len(m)==1 and m[0]['Source']==str(SOURCE) and m[0]['Destination']=='/probe' and not m[0]['RW'] and m[0]['Propagation']=='rprivate','own container bind mismatch')
        return d
    def remove(cid):
        own_config(cid);command(['docker','rm',cid]);owned.remove(cid)
    def create(index):
        name='hc-r21b-rprivate-'+str(index)+'-01a12a22'
        candidates.append(name);write('container-plan-'+str(index)+'.json',dict(name=name,label=RUN,source=str(SOURCE),baseline_ids=sorted(original_ids)))
        d=command(['docker','create','--pull=never','--name',name,'--label',LABEL+'='+RUN,
                   '--cap-drop=ALL','--security-opt=no-new-privileges=true','--read-only','--network=none',
                   '--user=1000:1000','--memory=96m','--memory-swap=96m','--cpus=0.1','--pids-limit=16',
                   '--env','NODE_OPTIONS=','--entrypoint=node','--mount','type=bind,src='+str(SOURCE)+',dst=/probe,readonly',IMAGE,'-e',PROBE_JS])
        cid=d['stdout'].strip();require(re.fullmatch('[0-9a-f]{64}',cid) is not None,'unexpected container ID');owned.append(cid)
        return cid
    def consume(cid,phase):
        config=own_config(cid);started=command(['docker','start','-a',cid]);out=json.loads(started['stdout'])
        require(out['marker']=='HOST_SOURCE\n' and out['dev']==host['dev'] and out['ino']==host['ino'],'daemon source unexpectedly differs from host')
        require(out['profile']==dict(CapEff='0000000000000000',CapPrm='0000000000000000',NoNewPrivs='1',Seccomp='2'),'ordinary container profile mismatch')
        mounts=json.loads(config['stdout'].splitlines()[0]);require(len(mounts)==1 and mounts[0]['Source']==str(SOURCE) and mounts[0]['Destination']=='/probe' and not mounts[0]['RW'] and mounts[0]['Propagation']=='rprivate','bind configuration mismatch')
        result['containers'].append(dict(cid=cid,phase=phase,config=config,observation=out))
    try:
        code="SOURCE_CODE="+repr(SOURCE_CODE)+"\nENTRY='supplier'\nHOST_MNT="+repr(ns('mnt'))+"\nHOST_USER="+repr(ns('user'))+"\nexec(compile(SOURCE_CODE,'<verified-rprivate-probe>','exec'))"
        child=subprocess.Popen(['unshare','--user','--map-root-user','--mount','--propagation','unchanged','/usr/bin/python3','-I','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
        result['supplier_a']=wait_file('supplier-a.json',child)
        require(result['supplier_a']['marker']=='PRIVATE_A\n' and observation(SOURCE/'marker')==host,'private source leaks into host')
        first=create(1);consume(first,'create-under-private-A')
        write('replace.json',dict(request='replace-own-private-bind'))
        result['supplier_b']=wait_file('supplier-b.json',child)
        require(result['supplier_b']['marker']=='PRIVATE_B\n' and observation(SOURCE/'marker')==host,'replacement leaks into host')
        consume(first,'restart-under-private-B');remove(first)
        second=create(2);consume(second,'recreation-under-private-B');remove(second)
        result['status']='OBSERVED_DAEMON_SOURCE_DISTINCT_FROM_PRIVATE_SUPPLIER'
    except Exception as e:result['error']=repr(e)
    finally:
        if child:
            if not (PROJECT/'release.json').exists():write('release.json',dict(request='release-own-child'))
            try:
                out,err=child.communicate(timeout=20);result['child']=dict(rc=child.returncode,stdout=out,stderr=err)
            except subprocess.TimeoutExpired:
                child.terminate();out,err=child.communicate(timeout=10);result['child']=dict(rc=child.returncode,stdout=out,stderr=err);result['cleanup_errors'].append('supplier timeout; child terminated')
        # A create timeout can hide CID; only inspect recorded names with exact own label.
        for name in candidates:
            try:
                possible=command(['docker','ps','-aq','--no-trunc','--filter','label='+LABEL+'='+RUN,'--filter','name=^/'+name+'$'])['stdout'].split()
                require(len(possible)<=1,'ambiguous own candidate name')
                for cid in possible:
                    require(re.fullmatch('[0-9a-f]{64}',cid) is not None and cid not in original_ids,'candidate is not a new own container')
                    own_config(cid)
                    if cid not in owned:owned.append(cid)
            except Exception as e:result['cleanup_errors'].append(repr(e))
        for cid in list(owned):
            try:
                own_config(cid);command(['docker','stop','--time=2',cid],check=False);remove(cid)
            except Exception as e:result['cleanup_errors'].append(repr(e))
        result['remaining_owned_containers']=owned
        try:
            after=snapshot();result['final']=after;result['invariants']={k:before[k]==after[k] for k in ('containers','mountinfo')}
        except Exception as e:result['final_snapshot_error']=repr(e)
        if (PROJECT/'supplier-result.json').exists():result['supplier_result']=json.loads((PROJECT/'supplier-result.json').read_text())
        result['container_candidates']=candidates
        write('result.json',result)
    require(result['status']=='OBSERVED_DAEMON_SOURCE_DISTINCT_FROM_PRIVATE_SUPPLIER' and result.get('child',{}).get('rc')==0 and not result['cleanup_errors'] and not owned and result.get('invariants') and all(result['invariants'].values()),'probe incomplete; inspect own result; no broad cleanup')
    print(json.dumps(result))

if __name__=='__main__':
    require('SOURCE_CODE' in globals(),'verified in-memory source dispatch only')
    if globals().get('ENTRY')=='supplier':supplier(HOST_MNT,HOST_USER)
    else:main()
