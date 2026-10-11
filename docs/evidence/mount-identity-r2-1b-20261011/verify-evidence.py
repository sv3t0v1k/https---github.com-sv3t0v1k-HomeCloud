#!/usr/bin/env python3
"""Offline assertions for the stopped preflight, not qualification tests."""
import hashlib
import json
from pathlib import Path

p = Path(__file__).resolve().parent
b = json.loads((p/'baseline.json').read_text())
f = json.loads((p/'final.json').read_text())
checks = {}
def check(name, ok):
    checks[name] = bool(ok)
    assert ok, name

for name, x in [('baseline', b), ('final', f)]:
    s = x['snapshot']
    check(name+'-26-containers', len(s['containers']) == 26)
    check(name+'-all-running', all(row.split('|')[5] == 'true' for row in s['containers']))
    check(name+'-mountinfo-hash', hashlib.sha256(s['mountinfo'].encode()).hexdigest() == s['mountinfo_sha256'])
    check(name+'-17-old-fixture-entries', len(s['fixtures']) == 17)
check('container-records-identical', b['snapshot']['containers'] == f['snapshot']['containers'])
check('host-mountinfo-byte-identical', b['snapshot']['mountinfo'] == f['snapshot']['mountinfo'])
check('boot-id-identical', b['snapshot']['boot_id'] == f['snapshot']['boot_id'])
check('host-mount-namespace-identical', b['snapshot']['mount_ns'] == f['snapshot']['mount_ns'])
check('old-fixtures-metadata-content-identical', b['snapshot']['fixtures'] == f['snapshot']['fixtures'])
probes = b['probes']
sudo = next(x for x in probes if x['args'] == ['sudo', '-n', 'true'])
check('sudo-root-entry-unavailable', sudo['rc'] == 1 and 'password is required' in sudo['stderr'])
child = next(x for x in probes if x['args'][:2] == ['unshare', '--user'])
check('userns-probe-success', child['rc'] == 0 and '0       1000          1' in child['stdout'])
check('child-mount-namespace-different', b['snapshot']['mount_ns'] not in child['stdout'])
plain = next(x for x in probes if x['args'][:2] == ['unshare', '--mount'])
check('initial-userns-mount-entry-denied', plain['rc'] == 1 and 'Operation not permitted' in plain['stderr'])
check('remote-stderr-empty', all((p/(x+'.stderr')).read_bytes() == b'' for x in ('baseline','final')))
out = dict(status='PASS', scope='preflight evidence consistency only; R2.1B_GATE=BLOCKED',
           count=len(checks), checks=checks)
(p/'evidence-verification.json').write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps(out, indent=2))
