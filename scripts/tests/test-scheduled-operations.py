#!/usr/bin/env python3
"""Real loopback HTTP delivery; isolated jobs/cert fixture; never production recipient."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('scheduled',ROOT/'scripts/scheduled-operations.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        body=self.rfile.read(int(self.headers['Content-Length']))
        self.server.received.append(dict(body=json.loads(body),headers=dict(self.headers),status=self.server.reply))
        if self.server.delay: time.sleep(self.server.delay)
        try: self.send_response(self.server.reply); self.end_headers()
        except (BrokenPipeError,ConnectionResetError): pass

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.server.daemon_threads=True
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.evidence=[]
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()
        destination=os.environ.get('HC_SCHEDULER_EVIDENCE')
        if destination:
            Path(destination).write_text(json.dumps(dict(boundary='CONTROLLED_TEST_RECEIVER_NOT_PRODUCTION_HUMAN',scenarios=cls.evidence),indent=2)+'\n')
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='hc-scheduler-',dir=str(Path(tempfile.gettempdir()).resolve()))
        self.root=Path(self.temp.name); self.state=self.root/'state'; self.state.mkdir(mode=0o700)
        self.server.received=[]; self.server.reply=200; self.server.delay=0
        self.marker=self.root/'last-backup-success.json'
        self.env=self.root/'recovery.env'; self.env.write_text('DB_PASSWORD=secret-sentinel\n'); self.env.chmod(0o600)
        self.wrapper=self.root/'backup-wrapper'; self.wrapper.write_text('#!/bin/sh\necho secret-sentinel >&2\nexit 14\n'); self.wrapper.chmod(0o700)
        self.c=dict(state_dir=str(self.state),recovery_env=str(self.env),backup_wrapper=str(self.wrapper),backup_marker=str(self.marker),
                    webhook_url=f'http://127.0.0.1:{self.server.server_port}/alerts',allow_test_http=True,
                    attempts=3,retry_seconds=0,request_timeout=.1,cooldown_seconds=60,job_timeout=10,backup_max_age=93600,cert_max_age=93600)
        self.conf=self.root/'scheduler.json'; self.write_config()
    def tearDown(self):
        self.evidence.append(dict(scenario=self.id().split('.')[-1],requests=list(self.server.received)))
        self.temp.cleanup()
    def write_config(self):
        self.conf.write_text(json.dumps(self.c)); self.conf.chmod(0o600)
    def call(self,job='backup'):
        self.write_config()
        p=subprocess.run([sys.executable,str(ROOT/'scripts/scheduled-operations.py'),str(self.conf),job],cwd='/',capture_output=True,text=True)
        self.assertNotIn('secret-sentinel',p.stdout+p.stderr)
        self.assertNotIn('secret-sentinel',json.dumps(self.server.received))
        return p
    def marker_write(self,seconds=0,verified=True):
        self.marker.write_text(json.dumps(dict(event='backup_production_completed',offsite_verified=verified,timestamp=dt.datetime.fromtimestamp(time.time()-seconds,dt.timezone.utc).isoformat())))
        self.marker.chmod(0o600)
    def success_wrapper(self,warning=False):
        self.wrapper.write_text('#!'+sys.executable+'\nimport json,datetime\nfrom pathlib import Path\nm=dict(event="backup_production_completed",offsite_verified=True,timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat())\nPath('+repr(str(self.marker))+').write_text(json.dumps(m))\nprint(json.dumps(m))\n'+('print(json.dumps(dict(event="retention_warning",reason="cleanup_failed")))\n' if warning else ''))
        self.wrapper.chmod(0o700)
    def test_failure_dedup_repeat_recovery(self):
        self.assertEqual(self.call().returncode,14); self.assertEqual(len(self.server.received),1)
        self.assertEqual(self.call().returncode,14); self.assertEqual(len(self.server.received),1)
        path=self.state/'alerts.json'; data=json.loads(path.read_text()); data['backup']['sent_at']-=61; path.write_text(json.dumps(data))
        self.assertEqual(self.call().returncode,14); self.assertEqual(self.server.received[-1]['body']['event_type'],'repeat')
        self.success_wrapper(); self.assertEqual(self.call().returncode,0)
        self.assertEqual(self.server.received[-1]['body']['event_type'],'recovery')
        self.assertEqual(self.call().returncode,0); self.assertEqual(len(self.server.received),3)
    def test_stale_and_recovery(self):
        self.marker_write(100000); self.assertEqual(self.call('freshness').returncode,1)
        self.assertEqual({x['body']['service'] for x in self.server.received},{'backup-stale','cert-check-stale'})
        self.marker_write(); m.save(self.state/'cert-check-heartbeat.json',dict(timestamp=dt.datetime.now(dt.timezone.utc).isoformat()))
        self.assertEqual(self.call('freshness').returncode,0); self.assertEqual(len(self.server.received),4)
    def test_false_offsite_marker_stale(self):
        self.marker_write(verified=False); self.assertEqual(self.call('freshness').returncode,1)
        self.assertEqual(self.server.received[0]['body']['reason'],'stale')
    def test_receiver_500_retry_not_deduplicated(self):
        self.server.reply=500; self.assertEqual(self.call().returncode,70); self.assertEqual(len(self.server.received),3)
        self.assertFalse((self.state/'alerts.json').exists())
        self.server.reply=200; self.assertEqual(self.call().returncode,14); self.assertEqual(len(self.server.received),4)
    def test_unavailable_receiver(self):
        self.c['webhook_url']='http://127.0.0.1:1/alerts'; p=self.call()
        self.assertEqual(p.returncode,70); self.assertEqual(p.stdout.count('alert_attempt_failed'),3)
    def test_receiver_timeout(self):
        self.server.delay=.3; self.assertEqual(self.call().returncode,70)
        self.assertEqual(len(self.server.received),3)
    def test_missing_config_and_permissions(self):
        self.conf.unlink()
        p=subprocess.run([sys.executable,str(ROOT/'scripts/scheduled-operations.py'),str(self.conf),'backup'],capture_output=True)
        self.assertEqual(p.returncode,70)
        self.write_config(); self.conf.chmod(0o644)
        with self.assertRaises(ValueError): m.config(str(self.conf))
    def test_unknown_config_and_external_only(self):
        self.c['unknown']='secret-sentinel'; self.write_config()
        with self.assertRaises(ValueError): m.config(str(self.conf))
        with self.assertRaises(ValueError): m.private(str(ROOT/'AGENTS.md'))
    def test_job_timeout(self):
        self.wrapper.write_text('#!/bin/sh\nsleep 60\n'); self.wrapper.chmod(0o700); self.c['job_timeout']=.05
        self.assertEqual(self.call().returncode,124); self.assertEqual(self.server.received[0]['body']['reason'],'timeout')
    def test_concurrency(self):
        self.wrapper.write_text('#!/bin/sh\nsleep 1\nexit 14\n'); self.wrapper.chmod(0o700)
        self.write_config()
        first=subprocess.Popen([sys.executable,str(ROOT/'scripts/scheduled-operations.py'),str(self.conf),'backup'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            time.sleep(.2); second=self.call(); self.assertEqual(second.returncode,75)
            first.communicate(timeout=5); self.assertEqual(first.returncode,14)
        finally:
            if first.poll() is None: first.kill(); first.wait()
    def test_success_signal_required(self):
        self.wrapper.write_text('#!/bin/sh\nexit 0\n'); self.wrapper.chmod(0o700)
        self.assertNotEqual(self.call().returncode,0)
    def test_retention_warning_preserves_success(self):
        self.success_wrapper(True); self.assertEqual(self.call().returncode,0)
        self.assertEqual(self.server.received[0]['body']['reason'],'retention_warning')
        self.success_wrapper(); self.assertEqual(self.call().returncode,0)
        self.assertEqual(self.server.received[-1]['body']['event_type'],'recovery')
    def test_cert_real_expiry_mapping_and_recovery(self):
        tls=self.root/'tls'; tls.mkdir(mode=0o700); (tls/'current').mkdir(mode=0o700)
        cert=tls/'current/fullchain.pem'; key=tls/'current/privkey.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','45','-subj','/CN=test.invalid','-addext','subjectAltName=DNS:test.invalid'],check=True,capture_output=True); key.chmod(0o600)
        self.c['cert_args']={'state-dir':str(tls),'hostname':'test.invalid','ca-file':str(cert),'warning-days':60,'critical-days':7}
        self.assertEqual(self.call('cert-check').returncode,1); self.assertEqual(self.server.received[-1]['body']['severity'],'warning')
        self.c['cert_args'].update({'critical-days':50})
        self.assertEqual(self.call('cert-check').returncode,2); self.assertEqual(self.server.received[-1]['body']['severity'],'critical')
        self.c['cert_args'].update({'critical-days':7,'warning-days':30})
        self.assertEqual(self.call('cert-check').returncode,0); self.assertEqual(self.server.received[-1]['body']['event_type'],'recovery')
        key.unlink(); self.assertEqual(self.call('cert-check').returncode,3)
        self.assertEqual(self.server.received[-1]['body']['reason'],'certificate_failed')
        self.assertEqual(self.call('cert-renew').returncode,3)
        self.assertEqual(self.server.received[-1]['body']['reason'],'renewal_failed')
    def test_corrupt_state_machine_visible(self):
        (self.state/'alerts.json').write_text('{'); self.assertEqual(self.call().returncode,70)
        self.assertEqual(len(self.server.received),0)
    def test_bounded_stdout(self):
        argv=[sys.executable,'-c','import sys; sys.stdout.write("x"*3000000)']
        code,events=m.execute(argv,dict(os.environ),5)
        self.assertEqual(code,0); self.assertEqual(events,[])
    def test_marker_semantics_required(self):
        self.success_wrapper()
        s=self.wrapper.read_text().replace('offsite_verified=True','offsite_verified=False')
        self.wrapper.write_text(s)
        self.assertNotEqual(self.call().returncode,0)
    @unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'),'real age required; qualified in Linux container')
    def test_existing_encrypted_backup_wiring(self):
        project=self.root/'project'; scripts=project/'scripts'; scripts.mkdir(parents=True)
        for name in ('backup-production.sh','backup-production.py','recovery_config.py'):
            shutil.copyfile(ROOT/'scripts'/name,scripts/name)
        fixtures=self.root/'fixtures'
        subprocess.run([sys.executable,str(ROOT/'scripts/tests/create_fixtures.py'),str(fixtures)],check=True,capture_output=True)
        valid=fixtures/'valid'
        for item in list(valid.iterdir()): item.rename(valid/item.name.replace('20260101_000000','20260101_000000_12345678'))
        local=self.root/'encrypted'; remote=self.root/'offsite'; local.mkdir(mode=0o700); remote.mkdir(mode=0o700)
        fail=self.root/'inject-replication-failure'; fail.touch()
        (scripts/'backup.sh').write_text('#!/bin/sh\ncp '+str(valid)+'/* "$BACKUP_DIR/"\nif [ -f '+str(fail)+' ]; then rmdir '+str(remote)+'; touch '+str(remote)+'; fi\n')
        key=self.root/'key'; subprocess.run(['age-keygen','-o',str(key)],check=True,capture_output=True); key.chmod(0o600)
        recipients=self.root/'recipients'; recipients.write_text(subprocess.check_output(['age-keygen','-y',str(key)],text=True)); recipients.chmod(0o600)
        compose=self.root/'compose.yml'; compose.write_text('services: {}\n')
        values=dict(DB_NAME='hc_test',DB_USER='hc_test',DB_PASSWORD='secret-sentinel',COMPOSE_FILE=str(compose),COMPOSE_PROJECT_NAME='hc-scheduled-test',BACKUP_PRODUCTION_DIR=str(local),BACKUP_OFFSITE_DIR=str(remote),BACKUP_OFFSITE_CONFIRMED='1',BACKUP_AGE_RECIPIENTS_FILE=str(recipients))
        self.env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
        self.wrapper.write_text('#!/bin/sh\nexport BACKUP_WRITE_BARRIER_CONFIRMED=1\nexec /bin/bash '+str(scripts/'backup-production.sh')+'\n'); self.wrapper.chmod(0o700)
        self.c['backup_marker']=str(local/'last-backup-success.json')
        self.assertEqual(self.call().returncode,14)
        self.assertEqual(len(list(local.glob('hc_*'))),1)
        self.assertFalse(Path(self.c['backup_marker']).exists())
        fail.unlink(); remote.unlink(); remote.mkdir(mode=0o700)
        self.assertEqual(self.call().returncode,0)
        self.assertEqual(self.server.received[-1]['body']['event_type'],'recovery')
        self.assertTrue(json.loads(Path(self.c['backup_marker']).read_text())['offsite_verified'])
        identity=next(x for x in key.read_text().splitlines() if x.startswith('AGE-SECRET-KEY-'))
        self.assertNotIn(identity,json.dumps(self.server.received))
    def test_cert_renew_success_and_recovery_contract(self):
        self.c['cert_args']={'state-dir':'/external/tls','hostname':'test.invalid','container':'isolated-ingress','acme-dir':'/external/acme','webroot':'/external/webroot','cert-name':'test.invalid'}
        self.write_config(); c=m.config(str(self.conf))
        with patch.object(m,'execute',return_value=(3,[{'status':'failed'}])):
            self.assertEqual(m.run(c,'cert-renew'),3)
        with patch.object(m,'execute',return_value=(0,[{'status':'unchanged'}])) as child:
            self.assertEqual(m.run(c,'cert-renew'),0)
            self.assertIn('renew',child.call_args.args[0]); self.assertIn('--container',child.call_args.args[0])
        self.assertEqual(self.server.received[-1]['body']['event_type'],'recovery')
    def test_validate_does_not_require_heartbeat(self):
        self.c['cert_args']={'state-dir':'/external/tls','hostname':'test.invalid','container':'isolated-ingress','acme-dir':'/external/acme','webroot':'/external/webroot','cert-name':'test.invalid'}
        self.assertEqual(self.call('--validate').returncode,0)
        self.assertEqual(self.server.received,[])
    def test_units(self):
        for job in m.JOBS:
            timer=(ROOT/'ops/systemd'/('homecloud-'+job+'.timer')).read_text()
            service=(ROOT/'ops/systemd'/('homecloud-'+job+'.service')).read_text()
            self.assertIn('Persistent=true',timer); self.assertIn('WorkingDirectory=/',service)
            self.assertIn('/etc/homecloud/scheduler.json '+job,service)
            self.assertNotIn('restore',service)
    def test_redirect_rejected(self):
        self.server.reply=302; self.assertEqual(self.call().returncode,70)
        self.assertEqual(len(self.server.received),3)
    def test_insecure_nonloopback_rejected(self):
        self.c['webhook_url']='http://example.invalid/alerts'; self.write_config()
        with self.assertRaises(ValueError): m.config(str(self.conf))

if __name__=='__main__': unittest.main()
