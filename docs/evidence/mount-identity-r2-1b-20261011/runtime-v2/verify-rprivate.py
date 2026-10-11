#!/usr/bin/env python3
"""Offline native mapping evidence verification, no Docker/namespace/device access."""
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
def load(name):return json.loads((HERE/name).read_text())
r=load('rprivate-result.json');execution=load('rprivate-execution.json')
proof=load('rprivate-supplier-private-proof.json');supplier=load('rprivate-supplier-result.json')
final=load('final-readonly.json')
basepath=HERE.parent/'baseline.json'
if not basepath.exists():basepath=HERE.parent/'r2-1b/baseline.json'
baseline=json.loads(basepath.read_text())['snapshot']
checks=[]
def check(label,ok):
    checks.append(dict(check=label,status='PASS' if ok else 'FAIL'))
    if not ok:raise AssertionError(label)
expected='6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696'
check('frozen reviewed source executed',hashlib.sha256((HERE/'rprivate-probe.py').read_bytes()).hexdigest()==r['source_sha256']==execution['source_sha256']==expected)
check('execution successful and gate blocked',execution['exec_rc']==0 and execution['error'] is None and r['status']=='OBSERVED_DAEMON_SOURCE_DISTINCT_FROM_PRIVATE_SUPPLIER' and r['gate']=='BLOCKED')
check('cached native image without volumes',r['image']['rc']==0 and r['image']['stdout'].strip()=='sha256:c3ff13b395fdf1f251c33ff475318e1c2b8a683e268dcb25142e47d20efba90f|amd64|null')
isolation=proof['isolation']
check('new supplier user/mount namespace',isolation['host_mnt']==baseline['mount_ns'] and isolation['child_mnt']!=isolation['host_mnt'] and isolation['host_user']==baseline['user_ns'] and isolation['child_user']!=isolation['host_user'])
check('mapped userns root only host1000',isolation['uid_map'].split()==['0','1000','1'] and int(isolation['cap_eff'],16)&(1<<21)!=0)
check('private proof unchanged in final supplier result',isolation==supplier['isolation'] and proof['private_mountinfo']==supplier['private_mountinfo'])
check('all inherited supplier propagation private',all(not any(v.startswith(('shared:','master:','propagate_from:')) for v in m.split(' - ')[0].split()[6:]) for m in proof['private_mountinfo'].splitlines()) and bool(proof['private_mountinfo']))
check('separate host and supplier filesystem views',r['host']['marker']=='HOST_SOURCE\n' and r['supplier_a']['marker']=='PRIVATE_A\n' and r['supplier_b']['marker']=='PRIVATE_B\n' and r['host']['dev']!=r['supplier_a']['dev']==r['supplier_b']['dev'] and r['supplier_a']['ino']!=r['supplier_b']['ino'])
check('supplier A/B retained exact raw observations',load('rprivate-supplier-a.json')==r['supplier_a']==supplier['a'] and load('rprivate-supplier-b.json')==r['supplier_b']==supplier['b'])
cases=r['containers']
check('three lifecycle observations, two unique containers',len(cases)==3 and cases[0]['cid']==cases[1]['cid']!=cases[2]['cid'] and len({x['cid'] for x in cases})==2)
check('create/restart/recreate phases', [c['phase'] for c in cases]==['create-under-private-A','restart-under-private-B','recreation-under-private-B'])
expected_config='false|null|["ALL"]|["no-new-privileges=true"]|true|none|100663296|100000000|16|1000:1000'
for c in cases:
    phase=c['phase'];o=c['observation'];lines=c['config']['stdout'].splitlines();mounts=json.loads(lines[0])
    check(phase+' exact limited container configuration',c['config']['rc']==0 and lines[1]==expected_config and lines[-1]=='r2-1b-rprivate-20261011-01a12a22')
    check(phase+' effective unprivileged filter profile',o['profile']==dict(CapEff='0000000000000000',CapPrm='0000000000000000',NoNewPrivs='1',Seccomp='2'))
    check(phase+' expected daemon-host object',o['marker']==r['host']['marker'] and o['dev']==r['host']['dev'] and o['ino']==r['host']['ino'] and o['mount_ns']!=isolation['child_mnt'])
    check(phase+' readonly default rprivate bind',len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['Source']=='/mnt/1TB/homecloud-test/r2-1b-rprivate-20261011-01a12a22/source' and mounts[0]['Destination']=='/probe' and not mounts[0]['RW'] and mounts[0]['Propagation']=='rprivate')
    check(phase+' observed ext4 readonly mount',len(o['mountinfo'])==1 and o['mountinfo'][0].split(' - ')[1].split()[0]=='ext4' and 'ro' in o['mountinfo'][0].split(' - ')[0].split()[5].split(','))
check('supplier normal cleanup complete',supplier==r['supplier_result'] and supplier['status']=='OBSERVED_PRIVATE_SUPPLIER_REPLACEMENT' and not supplier['mounts'] and not supplier['cleanup_errors'] and not supplier.get('error') and r['child']==dict(rc=0,stdout='',stderr=''))
check('own cleanup complete',not r['remaining_owned_containers'] and not r['cleanup_errors'] and r['invariants']==dict(containers=True,mountinfo=True))
for s,label in [(r['initial'],'initial'),(r['final'],'final'),(final['snapshot'],'followup')]:
    check(label+' original26 and full host mountinfo',s['containers']==baseline['containers'] and s['mountinfo']==baseline['mountinfo'] and len(s['containers'])==26)
check('all old17 fixtures intact',final['snapshot']['fixtures']==baseline['fixtures'] and len(baseline['fixtures'])==17)
check('original boot and self namespaces',all(final['snapshot'][k]==baseline[k] for k in ('boot_id','mount_ns','user_ns')))
check('final exact own-label absence',final['own_containers']['rc']==0 and not final['own_containers']['stdout'].strip())
for i in (1,2):
    plan=load('rprivate-container-plan-'+str(i)+'.json')
    check('durable own container plan '+str(i),plan['name']=='hc-r21b-rprivate-'+str(i)+'-01a12a22' and plan['label']=='r2-1b-rprivate-20261011-01a12a22' and set(plan['baseline_ids'])=={x.split('|')[0] for x in baseline['containers']} and cases[i-1 if i==1 else 2]['cid'] not in plan['baseline_ids'])
result=dict(status='PASS',count=len(checks),scope='native private-supplier vs daemon-host source selection/lifecycle/cleanup; no live daemon-host remount or secure attestation qualification',checks=checks)
(HERE/'rprivate-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='checks'}))
