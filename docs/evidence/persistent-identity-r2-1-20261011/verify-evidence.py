#!/usr/bin/env python3
"""Offline checks of recorded research. No server operations or runtime integration."""
import hashlib
import json
from pathlib import Path

p=Path(__file__).resolve().parent
d={x['test']:x['result'] for x in map(json.loads,(p/'research.ndjson').read_text().splitlines())}
checks=[]
def check(name,condition):
    assert condition,name
    checks.append(name)
def identity(x):
    h=x['empty']
    assert h['rc']==0
    return h['type'],h['bytes'],h['hex']
def cp(name): return d['container-'+name]['probe']
check('original source hash',hashlib.sha256((p/'identity-probe.c').read_bytes()).hexdigest()==d['probe-source-sha256'])
check('process restart',identity(d['ext4-process-1'])==identity(d['ext4-process-2']))
check('copied directory marker',identity(d['ext4-process-1'])!=identity(d['copied-marker-other-directory']))
check('copied marker object',identity(d['original-marker-handle'])!=identity(d['copied-marker-handle']))
check('directory rename',identity(d['ext4-process-1'])==identity(d['rename-same-directory']))
check('path replacement',identity(d['ext4-process-1'])!=identity(d['same-path-new-directory']))
recycle=d['inode-recycling']
check('actual inode reuse',recycle['before']['ino']==recycle['after']['ino'])
check('recycled inode changed handle',identity(recycle['before'])!=identity(recycle['after']))
check('in-place write preserves handle',identity(d['marker-before-second-inplace-write'])==identity(d['marker-after-second-inplace-write']))
check('host/container identity',identity(d['same-path-new-directory'])==identity(cp('restart')))
check('container restart',identity(cp('restart'))==identity(d['container-restart-same-id']))
check('container recreation',identity(cp('restart'))==identity(cp('recreate')))
check('ordinary mount ID reused',cp('restart')['mount_id']==d['container-restart-same-id']['mount_id'])
check('unique mount ID changes',cp('restart')['unique_id']!=d['container-restart-same-id']['unique_id'])
check('nested same-object equality',identity(cp('nested-same-object'))==identity(cp('recreate')))
check('NO_XDEV blocks nested crossing',cp('nested-no-xdev')['child_open_errno']==18)
check('source swap differs',identity(cp('swap-source'))!=identity(cp('recreate')))
check('overlay unsupported observed',cp('overlay')['empty']['errno']==95)
check('XFS host process equality',identity(d['xfs-root-readonly-process-1'])==identity(d['xfs-root-readonly-process-2']))
check('XFS host/container root equality',identity(d['xfs-root-readonly-process-1'])==identity(cp('xfs-readonly')))
check('UID1001 raw handle only',cp('uid1001')['uid']==1001 and cp('uid1001')['owner']==1000 and cp('uid1001')['empty']['rc']==0 and cp('uid1001')['dot']['errno']==13)
for name in ['restart','recreate','xfs-readonly','overlay','nested-same-object','swap-source','uid1001']:
    security=cp(name)['process_security']
    check('capabilities/seccomp '+name,all(security[k]=='0000000000000000' for k in ['CapEff','CapPrm','CapBnd','CapAmb','CapInh']) and security['NoNewPrivs']=='1' and security['Seccomp']=='2')
check('existing 26 containers unchanged',d['baseline-containers']==d['final-containers'] and len(d['baseline-containers'])==26)
check('host mount namespace unchanged',d['baseline-mountinfo']==d['final-mountinfo'])
for x in map(json.loads,(p/'readonly-fd.ndjson').read_text().splitlines()):
    if x['test']=='readonly-probe-sha256':
        source=(p/'identity-probe.c').read_text().replace('O_PATH','O_RDONLY')
        check('O_RDONLY source derivation',hashlib.sha256(source.encode()).hexdigest()==x['source'])
    else:
        check(x['test'],identity(x['host'])==identity(x['container']) and x['O_PATH_comparison_equal'] and x['OOMKilled'] is False)
check('empty SSH stderr',(p/'research.stderr').stat().st_size==0 and (p/'readonly-fd.stderr').stat().st_size==0)
final=json.loads((p/'final-integrity.json').read_text())
check('final invariants after O_RDONLY',final['containers_equal_after_followup'] and final['container_count']==26 and final['mountinfo_equal_after_followup'] and not final['research_containers_remaining'])
print(json.dumps({'evidence_checks':len(checks),'result':'PASS','checks':checks,'R2.1_GATE':'BLOCKED'},indent=2,ensure_ascii=False))
