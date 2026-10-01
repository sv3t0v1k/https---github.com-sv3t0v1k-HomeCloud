#!/usr/bin/env python3
"""Bounded single-node jobs and delivered alerts. External trusted JSON, no shell."""
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
JOBS = ('backup', 'cert-renew', 'cert-check', 'freshness')

def log(event, **fields):
    print(json.dumps(dict(event=event, **fields), sort_keys=True), flush=True)

def private(path, directory=False):
    p = Path(path)
    if not p.is_absolute() or any(x.is_symlink() for x in (p, *p.parents)):
        raise ValueError('unsafe path')
    if p.resolve() == ROOT or ROOT in p.resolve().parents:
        raise ValueError('external path required')
    s = p.stat()
    if not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)):
        raise ValueError('invalid file type')
    if s.st_mode & 0o7077 or s.st_uid != os.geteuid():
        raise ValueError('owner-only permissions required')
    return p

def config(path):
    p = private(path)
    if p.stat().st_size > 65536: raise ValueError('configuration too large')
    c = json.loads(p.read_text())
    allowed = {'state_dir','recovery_env','backup_wrapper','backup_marker','cert_args','webhook_url',
               'webhook_headers','allow_test_http','identity','cooldown_seconds','request_timeout',
               'attempts','retry_seconds','job_timeout','backup_max_age','cert_max_age'}
    if not isinstance(c, dict) or set(c) - allowed:
        raise ValueError('unknown configuration')
    private(c['state_dir'], True)
    for name, default, low, high in (('cooldown_seconds',21600,1,604800),('request_timeout',5,.05,60),
            ('attempts',3,1,5),('retry_seconds',1,0,60),('job_timeout',7200,.05,7200),
            ('backup_max_age',93600,1,604800),('cert_max_age',93600,1,604800)):
        v = c.setdefault(name, default)
        if isinstance(v, bool) or not isinstance(v, (int,float)) or not low <= v <= high:
            raise ValueError('invalid bound')
    if not isinstance(c['attempts'], int): raise ValueError('invalid attempts')
    identity = c.get('identity', 'homecloud')
    import re
    if not isinstance(identity,str) or not re.fullmatch('[A-Za-z0-9_.-]{1,64}',identity):
        raise ValueError('invalid identity')
    u = urllib.parse.urlsplit(c['webhook_url'])
    if u.username or u.password or u.fragment or not u.hostname:
        raise ValueError('invalid webhook')
    if u.scheme != 'https' and not (c.get('allow_test_http') is True and u.scheme == 'http' and u.hostname in ('127.0.0.1','::1')):
        raise ValueError('HTTPS required')
    headers = c.get('webhook_headers', {})
    if not isinstance(headers,dict) or any(not isinstance(k,str) or not isinstance(v,str) or '\n' in k+v or '\r' in k+v for k,v in headers.items()):
        raise ValueError('invalid headers')
    return c

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def deliver(c, payload):
    # Disable ambient proxies and redirects: never forward authorization to another host.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    body = json.dumps(payload,sort_keys=True).encode()
    for attempt in range(c['attempts']):
        try:
            headers = dict(c.get('webhook_headers',{})); headers['Content-Type']='application/json'
            request = urllib.request.Request(c['webhook_url'], data=body, headers=headers, method='POST')
            with opener.open(request,timeout=c['request_timeout']) as response:
                if not 200 <= response.status < 300: raise ValueError('status')
            log('alert_delivered', event_type=payload['event_type'], run_id=payload['run_id'], attempt=attempt+1)
            return
        except Exception:
            log('alert_attempt_failed', attempt=attempt+1, run_id=payload['run_id'])
            if attempt+1 < c['attempts']: time.sleep(c['retry_seconds'])
    raise RuntimeError('delivery failed')

def save(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(value,f,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        fd = os.open(path.parent,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def read_state(path):
    if not path.exists(): return {}
    private(path)
    if path.stat().st_size > 65536: raise ValueError('state too large')
    s = json.loads(path.read_text())
    if not isinstance(s,dict): raise ValueError('invalid state')
    for key,v in s.items():
        if key not in ('backup','backup-retention','cert-renew','cert-check','backup-stale','cert-check-stale') or not isinstance(v,dict):
            raise ValueError('invalid state')
        if set(v) != {'reason','sent_at'} or not isinstance(v['reason'],str) or not isinstance(v['sent_at'],(int,float)):
            raise ValueError('invalid state')
        if isinstance(v['sent_at'],bool) or not math.isfinite(v['sent_at']) or v['sent_at'] < 0 or v['sent_at'] > time.time()+60:
            raise ValueError('invalid state time')
    return s

def transition(c, state, key, reason, severity, now, run_id):
    old = state.get(key)
    if reason == 'ok' and not old: return
    if old and reason == old['reason'] and now-old['sent_at'] < c['cooldown_seconds']:
        log('alert_suppressed', service=key, run_id=run_id); return
    event = 'recovery' if reason == 'ok' else 'repeat' if old and old['reason']==reason else 'failure'
    payload = dict(event_type=event, severity='info' if reason=='ok' else severity,
                   timestamp=dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),
                   host=c.get('identity','homecloud'),service=key,reason=reason,run_id=run_id)
    deliver(c,payload)  # Commit dedup state only after confirmed 2xx.
    if reason == 'ok': state.pop(key,None)
    else: state[key] = dict(reason=reason,sent_at=now)
    save(Path(c['state_dir'])/'alerts.json',state)

def execute(argv, env, timeout):
    p = subprocess.Popen(argv, env=env, cwd='/', stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    captured = bytearray()
    def drain():
        while True:
            data = p.stdout.read(65536)
            if not data: break
            if len(captured) < 1048576:
                captured.extend(data[:1048576-len(captured)])
    reader = threading.Thread(target=drain, daemon=True); reader.start()
    try:
        code = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid,signal.SIGTERM)
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL); p.wait()
        code = 124
    finally:
        # A wrapper must not leave untracked descendants or pipe holders behind.
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        reader.join(timeout=5)
        p.stdout.close()
    events=[]
    for line in captured.splitlines():
        try:
            event=json.loads(line)
            if isinstance(event,dict): events.append(event)
        except (ValueError,UnicodeError): pass
    return code, events

def age(marker, now):
    try:
        private(marker)
        if Path(marker).stat().st_size > 65536: return float('inf')
        m = json.loads(Path(marker).read_text())
        timestamp = dt.datetime.fromisoformat(m['timestamp'].replace('Z','+00:00')).timestamp()
        if timestamp > now+60: return float('inf')
        return max(0, now-timestamp)
    except Exception: return float('inf')

def run(c, job):
    now=time.time(); run_id=uuid.uuid4().hex
    state_path=Path(c['state_dir'])/'alerts.json'
    state=read_state(state_path)
    if job=='freshness':
        failed=False
        for key, marker, threshold in (
                ('backup-stale',c['backup_marker'],c['backup_max_age']),
                ('cert-check-stale',str(Path(c['state_dir'])/'cert-check-heartbeat.json'),c['cert_max_age'])):
            stale=age(marker,now)>threshold
            if key=='backup-stale' and not stale:
                m=json.loads(Path(marker).read_text())
                stale=m.get('event')!='backup_production_completed' or m.get('offsite_verified') is not True
            transition(c,state,key,'stale' if stale else 'ok','critical',now,run_id)
            failed |= stale
        return 1 if failed else 0
    env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root'}
    if job=='backup':
        env['HOMECLOUD_ENV_FILE']=str(private(c['recovery_env']))
        wrapper=private(c['backup_wrapper'])
        if not os.access(wrapper,os.X_OK): raise ValueError('wrapper not executable')
        argv=[str(wrapper)]
    else:
        args=c['cert_args']
        if not isinstance(args,dict): raise ValueError('invalid cert arguments')
        allowed={'state-dir','hostname','ca-file','container','probe-host','probe-port','acme-dir','webroot','cert-name','warning-days','critical-days'}
        if set(args)-allowed or not all(isinstance(v,(str,int)) for v in args.values()): raise ValueError('invalid cert arguments')
        check={'state-dir','hostname','ca-file','warning-days','critical-days'}
        renew=allowed-{'warning-days','critical-days'}
        argv=[sys.executable,str(ROOT/'scripts/certificate-lifecycle.py'),'check' if job=='cert-check' else 'renew']
        for k,v in args.items():
            if k in (check if job=='cert-check' else renew): argv += ['--'+k,str(v)]
    code,events=execute(argv,env,c['job_timeout'])
    if job=='backup':
        completed=any(e.get('event')=='backup_production_completed' and e.get('offsite_verified') is True for e in events)
        # A lying/stale wrapper exit0 must not refresh successful backup state.
        completed=completed and age(c['backup_marker'],time.time()) <= time.time()-now+5
        if completed:
            marker=json.loads(Path(c['backup_marker']).read_text())
            completed=marker.get('event')=='backup_production_completed' and marker.get('offsite_verified') is True
        if code==0 and not completed: code=1
        reason={0:'ok',2:'backup_configuration_failed',10:'backup_legacy_failed',11:'backup_archive_failed',12:'backup_metadata_failed',13:'backup_encryption_failed',14:'backup_replication_failed',15:'backup_verification_failed',124:'timeout'}.get(code,'backup_failed')
    else:
        expected={0:'ok',1:'warning',2:'critical',3:'invalid'} if job=='cert-check' else {0:'installed',3:'failed'}
        statuses=[e.get('status') for e in events]
        valid=expected.get(code) in statuses or (job=='cert-renew' and code==0 and 'unchanged' in statuses)
        if not valid: code=3 if code!=124 else code
        reason=({0:'ok',1:'expiry_warning',2:'expiry_critical'}.get(code,'certificate_failed') if job=='cert-check' else 'ok' if code==0 else 'renewal_failed')
        if job=='cert-check' and valid and code in (0,1,2):
            save(Path(c['state_dir'])/'cert-check-heartbeat.json',dict(timestamp=dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat()))
    transition(c,state,job,reason,'warning' if reason=='expiry_warning' else 'critical',now,run_id)
    if job=='backup' and code==0:
        warning=any(e.get('event')=='retention_warning' for e in events)
        transition(c,state,'backup-retention','retention_warning' if warning else 'ok','warning',now,run_id)
    log('job_completed',service=job,exit_code=code,run_id=run_id)
    return code

def main():
    os.umask(0o077)
    if len(sys.argv)!=3 or sys.argv[2] not in (*JOBS, '--validate'): raise ValueError('invalid invocation')
    c=config(sys.argv[1]); state=Path(c['state_dir'])
    if sys.argv[2]=='--validate':
        private(c['recovery_env']); private(c['backup_wrapper'])
        if not os.access(c['backup_wrapper'],os.X_OK): raise ValueError('wrapper not executable')
        if not Path(c['backup_marker']).is_absolute(): raise ValueError('absolute marker required')
        if not isinstance(c['cert_args'],dict) or not {'state-dir','hostname','container','acme-dir','webroot','cert-name'} <= set(c['cert_args']):
            raise ValueError('cert inputs required')
        log('scheduler_config_valid'); return 0
    lock=state/'scheduler.lock'
    fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        private(lock)
        try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            log('job_busy'); return 75
        return run(c,sys.argv[2])

if __name__=='__main__':
    try: sys.exit(main())
    except Exception:
        log('scheduled_operation_failed',reason='configuration_state_job_or_delivery_failure')
        sys.exit(70)
