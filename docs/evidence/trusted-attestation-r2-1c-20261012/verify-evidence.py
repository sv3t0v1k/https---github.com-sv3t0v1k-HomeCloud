#!/usr/bin/env python3
"""Offline factual verification, never turns partial research into gate PASS."""
import hashlib
import json
import subprocess
from pathlib import Path

HERE=Path(__file__).resolve().parent
load=lambda n:json.loads((HERE/n).read_text())
d=load('native-result.json'); first=load('initial-inventory.json')['snapshot']
final=load('final-inventory.json'); checks=[]
def check(name,ok):
    checks.append(dict(name=name,status='PASS' if ok else 'FAIL'))
    if not ok: raise AssertionError(name)
def identity(o):
    h=o['empty'];return o['fs_type'],o['fsid'],h['type'],h['bytes'],h['hex']
for item in first['fixtures'].values():item['mtime_ns']=str(item['mtime_ns'])
check('native scoped run completed',d['status']=='OBSERVED_SCOPED_PROTOCOL_AND_READONLY_CONTINUITY')
check('gate remains blocked',d['gate']=='BLOCKED')
check('no owned containers',d['remainingOwned']=='')
check('no cleanup errors',d['cleanupErrors']==[])
check('all runtime invariants',all(d['invariants'].values()))
for k in ['containers','mountinfo','fixtures','boot_id','mount_ns','user_ns']:
    check('original precise baseline to final '+k,first[k]==final['snapshot'][k])
    check('original precise baseline to native initial '+k,first[k]==d['initial'][k])
    check('native initial to native final '+k,d['initial'][k]==d['final'][k])
check('26 original records',len(first['containers'])==26)
check('17 original fixtures',len(first['fixtures'])==17)
check('fixture nanoseconds exact decimal strings',all(isinstance(x['mtime_ns'],str) and x['mtime_ns'].isdigit() for x in d['final']['fixtures'].values()))
for label,r in final['own_labels'].items():check('followup empty exact label '+label,r['rc']==0 and not r['stdout'].strip())
check('build exit0 no OOM',d['build']['final']['ExitCode']==0 and not d['build']['final']['OOMKilled'])
check('native protocol model32',d['protocol']['count']==32 and all(c['status']=='PASS' for c in d['protocol']['checks']))
check('local protocol model32',load('local-protocol-tests.json')['count']==32)
sessions=[r for r in d['records'] if 'events' in r]
check('three lifetimes',len(sessions)==3)
observations=[];epochs=[]
for r in sessions:
    phase=r['phase'];q=[e for e in r['events'] if e['kind']=='challenge'][-1]
    o=q['challenge']['observation'];observations.append(o);epochs.append(q['challenge']['epoch'])
    check(phase+' runtime exit0',r['exit']==0 and not r['stderr'])
    check(phase+' native x64',q['arch']=='x64')
    check(phase+' effective cap0 NNP Seccomp2',q['profile']=={'CapPrm':'0000000000000000','CapEff':'0000000000000000','NoNewPrivs':'1','Seccomp':'2'})
    check(phase+' lease accepted',any(e['kind']=='accepted' for e in r['events']))
    check(phase+' marker only disposable A',next(e for e in r['events'] if e['kind']=='accepted')['marker']['hex']=='4252494447455f410a')
    for fs,magic in [('ext4',0xef53),('xfs',0x58465342)]:
        x=o[fs]
        check(phase+' '+fs+' FD handle success',x['empty']['rc']==0 and x['dot']['hex']==x['empty']['hex'])
        check(phase+' '+fs+' unique statx support',x['unique_supported'] and x['unique_rc']==0)
        check(phase+' '+fs+' filesystem profile',x['fs_type']==magic)
    if phase!='create':check(phase+' previous epoch denied',any(e['kind']=='old-epoch-result' and e['denied'] for e in r['events']))
check('new process verifier epochs',len(set(epochs))==3)
check('ext4 scoped handles stable',len({identity(o['ext4']) for o in observations})==1)
check('read-only XFS scoped handles stable',len({identity(o['xfs']) for o in observations})==1)
check('signed revoke denied next admission',any(e['kind']=='revoked' and e['denied'] and e['acceptedBeforeRevoke'] for e in sessions[0]['events']))
check('same lease replay denied',any(e['kind']=='replay-result' and e['denied'] for e in sessions[1]['events']))
check('real timer expiry denied next admission',any(e['kind']=='expired' and e['denied'] for e in sessions[2]['events']))
workloads=[r for r in d['records'] if 'workload' in r]
check('restart sameCID recreate differentCID',workloads[0]['workload']['cid']==workloads[1]['workload']['cid']!=workloads[2]['workload']['cid'])
check('three host process lifetime records',len({(r['workload']['pid'],r['workload']['startTicks']) for r in workloads})==3)
for r in workloads:
    phase=r['phase'];c=r['config'];h=c['HostConfig']
    check(phase+' capdrop no additions',h['CapDrop']==['ALL'] and not h['CapAdd'])
    check(phase+' unprivileged no host networking',not h['Privileged'] and h['NetworkMode']=='none')
    check(phase+' RO nonroot NNP',h['ReadonlyRootfs'] and c['Config']['User']=='1000:1000' and 'no-new-privileges=true' in h['SecurityOpt'])
    check(phase+' limited resources',h['Memory']==128*1024*1024 and h['MemorySwap']==h['Memory'] and h['NanoCpus']==250000000 and h['PidsLimit']==32)
    check(phase+' only three RO rprivate binds',len(c['Mounts'])==3 and all(m['Type']=='bind' and not m['RW'] and m['Propagation']=='rprivate' for m in c['Mounts']))
    check(phase+' no socket binds',not any('docker.sock' in m['Source'] for m in c['Mounts']))
replacement=next(r for r in d['records'] if r['phase']=='host-directory-replacement-not-remount')
check('directory replacement changes pathname object',identity(replacement['fresh'])!=identity(replacement['pinned']))
check('pinned FD original object',identity(replacement['pinned'])==identity(observations[0]['ext4']))
restored=next(r for r in d['records'] if r['phase']=='ABA-sampling-limitation')
check('ABA restores sampled identity',identity(restored['restored'])==identity(replacement['pinned']))
check('daemon namespace inaccessible retained blocker',d['daemonNamespace']=={'error':'EACCES'})
for name,sha in load('executed-source-manifest.json').items():check('exact executed source '+name,hashlib.sha256((HERE/name).read_bytes()).hexdigest()==sha)
envelopes=[r for r in d['records'] if r['phase'] in ['signed-envelope','signed-revoke-envelope']]
check('three lease and one revoke envelopes retained',len(envelopes)==4)
crypto_script="""const c=require('crypto'),fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(d.records.map(r=>({session:r.session,phase:r.phase,valid:c.verify(null,Buffer.from(r.envelope.body,'base64'),d.key,Buffer.from(r.envelope.signature,'base64'))}))));"""
verified=json.loads(subprocess.run(['node','-e',crypto_script],input=json.dumps(dict(records=envelopes,key=d['publicKey'])),text=True,capture_output=True,check=True).stdout)
for r in verified:check('offline signature '+r['phase']+' '+r['session'],r['valid'])
for r in envelopes:
    import base64
    t=json.loads(base64.b64decode(r['envelope']['body']))
    check('signed trusted context '+r['phase']+' '+r['session'],all(t[k]==d['context'][k] for k in ['boot','observer','deployment','enrollment','revision','expected','ttlMs']))
for name,sha in load('successful-v3/executed-source-manifest.json').items():check('preserved exact successful v3 '+name,hashlib.sha256((HERE/'successful-v3'/name).read_bytes()).hexdigest()==sha)
for folder in ['failed-attempt','failed-attempt-v2']:
    f=load(folder+'/native-result.json')
    check(folder+' honest execution failure',f['status']=='BLOCKED_EXECUTION' and bool(f['error']))
    check(folder+' own cleanup',f['remainingOwned']=='' and f['cleanupErrors']==[])
out=dict(scope='offline raw evidence consistency, not complete gate',count=len(checks),checks=checks,R2_1C_GATE='BLOCKED',R2_1_GATE='BLOCKED')
(HERE/'evidence-verification.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(count=len(checks),status='PASS',R2_1C_GATE='BLOCKED',R2_1_GATE='BLOCKED')))
