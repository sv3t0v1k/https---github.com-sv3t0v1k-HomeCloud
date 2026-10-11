#!/usr/bin/env python3
"""Offline verification of actual manual-run evidence; no server/device access."""
import hashlib
import json
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent
BASE=HERE.parent/'baseline.json'
if not BASE.exists(): BASE=HERE.parent/'r2-1b/baseline.json'
def load(name): return json.loads((HERE/name).read_text())
root=load('root-run-result.json');recovery=load('recovery-result.json')
post=load('post-run-readonly.json');cleanup=load('cleanup-readonly.json')
baseline=json.loads(BASE.read_text())['snapshot']
rows=[json.loads(x) for x in (HERE/'root-run-journal.ndjson').read_text().splitlines()]
checks=[]
def check(label,ok):
    checks.append(dict(check=label,status='PASS' if ok else 'FAIL'))
    if not ok: raise AssertionError(label)
def one(label):
    found=[r['result'] for r in rows if r['test']==label]
    check('single record '+label,len(found)==1)
    return found[0]
def pair(value):
    m=re.fullmatch(r'\s*([0-9]+)\s*:\s*([0-9]+)\s*',value)
    assert m is not None
    return tuple(int(x) for x in m.groups())
def valid_observation(o):
    h=o['handle'];return (isinstance(o['pid'],int) and o['pid']>0 and o['ino']>0 and o['unique_id']>0 and
                        h['length']>0 and len(bytes.fromhex(h['hex']))==h['length'] and isinstance(h['type'],int))

check('exact v2 source executed',root['source_sha256']=='5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49')
expected={'recover-owned-loop.py':'6d4dda1208c259c9ad22856dd362496ee8f975630091a03a9eed29e711bfb21c',
          'isolated-helper-v2.py':'5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49',
          'manual-launch-v2.sh':'bb3f9f351b9dbe0b57647592fd693b7edf7bd477efbc389b617b710489c28ca2'}
check('remote source unchanged since review',post['source_sha256']==expected)
check('child rc0, no research/parse error',root['child_rc']==0 and not root.get('parse_error') and not root.get('error') and not root['child_stderr'] and not any(r['test']=='research-error' for r in rows))
check('journal/parsed result/raw stdout identical',root['records']==rows==json.loads(root['child_stdout']) and root['journal_raw']==(HERE/'root-run-journal.ndjson').read_text())
check('gates BLOCKED despite successful run',root['R2_1B_GATE']==root['R2_1_GATE']==root['status']=='BLOCKED')
check('successful recorded research scope',one('research-status')=='COMPLETED_WITH_UNQUALIFIED_CONTAINER_ATTESTATION_REBOOT')
check('recovery detached only old own loop8',recovery['status']=='OWN_LOOP_DETACHED' and recovery['loop']=='/dev/loop8' and recovery['detach']['args']==['losetup','--detach','/dev/loop8'] and recovery['detach']['rc']==0)
check('old recorded image matches',recovery['image']==dict(dev=2081,ino=64225325,size=67108864))
raw=json.loads(recovery['loop_raw']['stdout'])['loopdevices'];again=json.loads(recovery['loop_recheck']['stdout'])['loopdevices']
check('root association stable before detach',len(raw)==1 and raw==again and raw[0]['name']=='/dev/loop8' and raw[0]['back-ino']==64225325 and pair(raw[0]['back-maj:min'])==(8,33) and raw[0]['offset']==raw[0]['sizelimit']==0)
check('actual padded string explains first false mismatch',raw[0]['back-maj:min']=='       8:33 ' and raw[0]['back-maj:min']!='8:33')
check('root recovery unused proof',recovery['unused_proof']['checked_processes']>0 and recovery['unused_proof']['old_namespace_absent'] and recovery['unused_proof']['own_loop_mounts_or_open_fds']==0)
check('root recovery kernel ENXIO',recovery['loop_after_kernel_errno']==6)
check('recovery host invariants',recovery['invariants']==dict(containers=True,mountinfo=True))
for phase in (recovery['initial'],recovery['final'],root['initial'],root['final'],post['snapshot']):
    check('26 unique running records snapshot '+str(len(checks)),len(phase['containers'])==26 and len({r.split('|')[0] for r in phase['containers']})==26 and all(r.split('|')[5]=='true' for r in phase['containers']))
    check('original container/mountinfo equality snapshot '+str(len(checks)),phase['containers']==baseline['containers'] and phase['mountinfo']==baseline['mountinfo'])
check('root five invariants',root['invariants']==dict(containers=True,mountinfo=True,boot_id=True,mount_ns=True,user_ns=True))
check('root/post original boot/namespaces',all(s[k]==baseline[k] for s in (root['initial'],root['final'],post['snapshot']) for k in ('boot_id','mount_ns','user_ns')))
check('original full mountinfo SHA',hashlib.sha256(post['snapshot']['mountinfo'].encode()).hexdigest()=='0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429')
check('all old R2.1 fixtures preserved',post['snapshot']['fixtures']==baseline['fixtures'] and len(baseline['fixtures'])==17)
ns=one('namespace-before-private');mounts=one('namespace-private-mountinfo').splitlines()
check('child mountns distinct, initial-userns same',ns['host']==baseline['mount_ns'] and ns['child']!=ns['host'] and ns['user']==baseline['user_ns'] and ns['pid']>0 and int(ns['starttime_ticks'])>0)
check('every child propagation private',len(mounts)>0 and all(not any(v.startswith(('shared:','master:','propagate_from:')) for v in m.split(' - ')[0].split()[6:]) for m in mounts))
check('private proof before mkfs/loop',rows.index(next(r for r in rows if r['test']=='namespace-private-mountinfo'))<rows.index(next(r for r in rows if r['test']=='ext4-fresh-image')))
identities=[r['result'] for r in rows if r['test']=='loop-identity-observed']
check('four raw identity guards',len(identities)==4 and all(i['raw']['name']=='/dev/loop8' and i['raw']['back-ino']==i['expected_backing_ino'] and pair(i['raw']['back-maj:min'])==(i['expected_major'],i['expected_minor'])==(8,33) and i['raw']['offset']==i['raw']['sizelimit']==0 for i in identities))
for fs,size,ino in [('ext4',67108864,64225329),('xfs',402653184,64225332)]:
    fresh=one(fs+'-fresh-image');mkfs=one(fs+'-mkfs')
    check(fs+' image provenance and budget',fresh['regular'] and fresh['uid']==0 and fresh['dev']==2081 and fresh['ino']==ino and fresh['size']==size and fresh['path']=='/mnt/1TB/homecloud-test/r2-1b-v2-20261011-01a12a22/'+fs+'.img')
    check(fs+' pinned-file mkfs',mkfs['rc']==0 and mkfs['args'][0]=='mkfs.'+fs and re.fullmatch(r'/proc/self/fd/[0-9]+',mkfs['args'][-1]) is not None)
    identity=one(fs+'-loop')
    check(fs+' loop current backing',identity['name']=='/dev/loop8' and identity['back-ino']==ino and pair(identity['back-maj:min'])==(8,33) and identity['offset']==identity['sizelimit']==0)
    copy=one(fs+'-copy-replacement');a=copy['a'];b=copy['b'];ma=copy['marker_a'];mb=copy['marker_b']
    check(fs+' observation handle payloads',all(valid_observation(o) for o in (a,b,ma,mb)))
    check(fs+' copied marker does not equal object identity',copy['marker_equal'] and a['handle']!=b['handle'] and ma['handle']!=mb['handle'] and a['dev']==b['dev'])
    proc=one(fs+'-new-process')
    check(fs+' new process continuity',valid_observation(proc) and proc['pid']!=a['pid'] and proc['handle']==a['handle'] and proc['unique_id']==a['unique_id'])
    nested=one(fs+'-nested')
    check(fs+' nested same object new mount instance',nested['observation']['handle']==a['handle'] and nested['observation']['unique_id']!=a['unique_id'])
    check(fs+' NO_XDEV rejects crossing',nested['crossing']['rc']==-1 and nested['crossing']['errno']==18)
    stack=one(fs+'-same-object-stack')
    check(fs+' stacked same object changes mount instance',stack['old']['handle']==stack['new']['handle']==a['handle'] and stack['old']['unique_id']!=stack['new']['unique_id'])
    live=one(fs+'-live-replacement')
    check(fs+' live replacement path vs retained FD',live['path']['handle']==b['handle'] and live['path']['handle']!=stack['old']['handle'] and live['retained_fd']==stack['old'])
    recycle=one(fs+'-recycle');before=recycle['observed']['before'];after=recycle['observed']['after']
    check(fs+' actual inode reuse changes opaque handle',recycle['status']=='PASS_OBSERVED_REUSE' and 0<recycle['observed']['iteration']<=recycle['attempt_limit']==500 and before['dev']==after['dev'] and before['ino']==after['ino'] and before['handle']!=after['handle'])
    flag=one(fs+'-flag-remount')
    check(fs+' flag remount preserves object and mount instance',flag['before']['handle']==flag['readonly']['handle']==flag['after']['handle']==a['handle'] and flag['before']['unique_id']==flag['readonly']['unique_id']==flag['after']['unique_id'])
    check(fs+' actual ro/rw flags',all('ro' in m.split(' - ')[0].split()[5].split(',') for m in flag['ro_mountinfo']) and all('rw' in m.split(' - ')[0].split()[5].split(',') for m in flag['rw_mountinfo']) and bool(flag['ro_mountinfo']) and bool(flag['rw_mountinfo']))
    remount=one(fs+'-clean-unmount-remount')
    check(fs+' clean unmount/remount preserves object/marker, new mount instance',remount['before']['handle']==remount['after']['handle']==a['handle'] and remount['before']['unique_id']!=remount['after']['unique_id'] and remount['marker_after']['handle']==ma['handle'])
    detached=one(fs+'-loop-detached');clean=one(fs+'-cleanup')
    check(fs+' kernel unbound proof',detached==dict(loop='/dev/loop8',proof=dict(kernel_errno=6,unbound=True)))
    check(fs+' complete recorded cleanup',clean['clean_tests'] and not clean['remaining_mounts'] and not clean['errors'] and clean['image_preserved']==fresh['path'])
check('new image FS stage sequential',next(i for i,r in enumerate(rows) if r['test']=='ext4-cleanup')<next(i for i,r in enumerate(rows) if r['test']=='xfs-fresh-image'))
check('post-run own loop no sysfs backing visible',cleanup['loops']['/dev/loop8']['block_rdev']==[7,8] and cleanup['loops']['/dev/loop8']['sysfs_backing_file_errno']==2)
check('exact child process lifetime ended',cleanup['child']['pid']==ns['pid'] and (cleanup['child'].get('stat_errno')==2 or cleanup['child'].get('same_lifetime') is False))
result=dict(status='PASS',count=len(checks),scope='offline verification of observed native root/disposable FS run; gate BLOCKED, ordinary-container FS continuity/attestation/reboot unqualified',checks=checks)
(HERE/'runtime-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='checks'}))
