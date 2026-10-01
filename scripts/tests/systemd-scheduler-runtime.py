#!/usr/bin/env python3
"""Run only inside explicitly disposable Linux/systemd container; no host install."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
if os.environ.get('HOMECLOUD_DISPOSABLE_SYSTEMD')!='1' or not Path('/run/systemd/system').is_dir() or not Path('/.dockerenv').exists():
    sys.exit('Explicit disposable systemd container required')
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixtures',root/'scripts/tests/test-scheduled-operations.py')
t=importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
t.Tests.setUpClass(); fixture=t.Tests('test_units'); fixture.setUp()
result={'boundary':'DISPOSABLE_LINUX_SYSTEMD_NOT_PRODUCTION_HOST','systemd_version':subprocess.check_output(['systemctl','--version'],text=True).splitlines()[0]}
def command(*args,fail=False):
    p=subprocess.run(args,text=True,capture_output=True)
    if p.returncode and not fail: raise RuntimeError('command failed: '+args[0]+' '+p.stdout+p.stderr)
    return dict(exit_code=p.returncode,stdout=p.stdout,stderr=p.stderr)
def show():
    return command('systemctl','show','homecloud-backup.service','-p','Result','-p','ExecMainStatus','-p','ExecMainStartTimestamp')
try:
    override=Path('/etc/systemd/system/homecloud-backup.timer.d/accelerated.conf')
    if override.exists(): override.unlink()
    # Inputs are synthetic test identities/paths, never production values.
    fixture.c['cert_args']={'state-dir':str(fixture.root/'tls'),'hostname':'test.invalid','container':'disposable-ingress','acme-dir':str(fixture.root/'acme'),'webroot':str(fixture.root/'webroot'),'cert-name':'test.invalid'}
    fixture.write_config()
    Path('/etc/homecloud').mkdir(mode=0o700,exist_ok=True)
    shutil.copyfile(fixture.conf,'/etc/homecloud/scheduler.json'); os.chmod('/etc/homecloud/scheduler.json',0o600)
    result['install']=command(sys.executable,str(root/'scripts/scheduler-install.py'),'--install')
    result['timers']=command('systemctl','list-timers','--all','homecloud-*','--no-pager')
    for job in ('backup','cert-renew','cert-check','freshness'):
        assert command('systemctl','is-active','homecloud-'+job+'.timer')['stdout'].strip()=='active'
    result['persistent']=command('systemctl','show','homecloud-backup.timer','-p','Persistent','-p','TimersCalendar')
    assert 'Persistent=yes' in result['persistent']['stdout']
    # Persistent activation may already have run. Clear delivered state for deterministic injection.
    command('systemctl','stop','homecloud-backup.service','homecloud-cert-renew.service','homecloud-cert-check.service','homecloud-freshness.service')
    for job in ('backup','cert-renew','cert-check','freshness'): command('systemctl','stop','homecloud-'+job+'.timer')
    for p in fixture.state.iterdir():
        if p.name!='scheduler.lock': p.unlink()
    fixture.server.received=[]
    result['manual_failure']=command('systemctl','start','homecloud-backup.service',fail=True)
    result['failed_result']=show()
    assert 'ExecMainStatus=14' in result['failed_result']['stdout'] and 'Result=exit-code' in result['failed_result']['stdout']
    assert len(fixture.server.received)==1
    command('systemctl','start','homecloud-backup.service',fail=True); assert len(fixture.server.received)==1
    result['dedup']=True
    fixture.success_wrapper(); command('systemctl','start','homecloud-backup.service')
    assert fixture.server.received[-1]['body']['event_type']=='recovery'
    result['manual_success']=show(); assert 'ExecMainStatus=0' in result['manual_success']['stdout']
    drop=Path('/etc/systemd/system/homecloud-backup.timer.d'); drop.mkdir(exist_ok=True)
    (drop/'accelerated.conf').write_text('[Timer]\nOnCalendar=\nOnActiveSec=2s\nAccuracySec=100ms\n')
    command('systemctl','daemon-reload'); before=show()['stdout']
    command('systemctl','start','homecloud-backup.timer')
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        time.sleep(.25)
        after=show()['stdout']
        if after!=before: break
    assert after!=before and 'ExecMainStatus=0' in after
    result['accelerated_timer']=dict(before=before,after=after,properties=command('systemctl','show','homecloud-backup.timer','-p','LastTriggerUSec'))
    command('systemctl','stop','homecloud-backup.timer')
    with (fixture.state/'scheduler.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        command('systemctl','start','homecloud-backup.service',fail=True)
        result['concurrent_block']=show(); assert 'ExecMainStatus=75' in result['concurrent_block']['stdout']
    fixture.wrapper.write_text('#!/bin/sh\nexit 14\n'); fixture.wrapper.chmod(0o700)
    fixture.server.reply=500
    command('systemctl','start','homecloud-backup.service',fail=True)
    result['delivery_failure']=show(); assert 'ExecMainStatus=70' in result['delivery_failure']['stdout']
    result['journal']=command('journalctl','-u','homecloud-backup.service','--no-pager','-o','cat')
    assert 'alert_attempt_failed' in result['journal']['stdout'] and 'secret-sentinel' not in result['journal']['stdout']
    result['receiver_requests']=fixture.server.received
    result['reboot_boundary']='Persistent=yes inspected; real host reboot/missed-run replay NOT_QUALIFIED'
    result['SYSTEMD_RUNTIME']='PASS'
finally:
    for job in ('backup','cert-renew','cert-check','freshness'):
        command('systemctl','stop','homecloud-'+job+'.timer','homecloud-'+job+'.service',fail=True)
    fixture.temp.cleanup(); t.Tests.tearDownClass()
Path('/tmp/scheduler-systemd-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'SYSTEMD_RUNTIME':result.get('SYSTEMD_RUNTIME'),'evidence':'/tmp/scheduler-systemd-result.json'}))
