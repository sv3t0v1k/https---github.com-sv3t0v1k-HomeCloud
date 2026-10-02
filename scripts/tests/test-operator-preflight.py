#!/usr/bin/env python3
"""Synthetic external input checks; never network/Docker credential probes."""
import importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('preflight',ROOT/'scripts/operator-preflight.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
SECRET='SYNTHETIC_SECRET_SENTINEL_DO_NOT_PRINT'
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir='/private/tmp');self.p=Path(self.tmp.name);self.p.chmod(0o700)
  for n in ('tls/versions/generation','webroot','backup','offsite','acme','state'):(self.p/n).mkdir(parents=True,exist_ok=True);(self.p/n).chmod(0o700)
  for n in ('tls/versions/generation/fullchain.pem','tls/versions/generation/privkey.pem','recipients','wrapper'):self.write(n,SECRET)
  (self.p/'wrapper').chmod(0o700)
  (self.p/'tls').chmod(0o700);(self.p/'tls/versions').chmod(0o700)
  (self.p/'tls/current').symlink_to('versions/generation')
  self.e=dict(DB_NAME='fixture',DB_USER='fixture',DB_PASSWORD=SECRET,COMPOSE_FILE=str(ROOT/'docker-compose.production.yml'),COMPOSE_PROJECT_NAME='fixture',JWT_SECRET=SECRET,JWT_REFRESH_SECRET=SECRET,PUBLIC_HOST='cloud.example.com',TLS_CERT_DIR=str(self.p/'tls'),ACME_WEBROOT_DIR=str(self.p/'webroot'),BACKUP_PRODUCTION_DIR=str(self.p/'backup'),BACKUP_OFFSITE_DIR=str(self.p/'offsite'),BACKUP_AGE_RECIPIENTS_FILE=str(self.p/'recipients'))
  self.s=dict(state_dir=str(self.p/'state'),recovery_env=str(self.p/'env'),backup_wrapper=str(self.p/'wrapper'),backup_marker=str(self.p/'backup/last-backup-success.json'),webhook_url='https://alerts.example.com',webhook_headers={'Authorization':SECRET},cert_args={'hostname':'cloud.example.com','state-dir':str(self.p/'tls'),'webroot':str(self.p/'webroot'),'acme-dir':str(self.p/'acme'),'container':'fixture','cert-name':'cloud.example.com'})
  self.q={g:{k:dict(qualified=False,record='') for k in keys} for g,keys in (('external',h.EXTERNAL),('approvals',h.APPROVALS))}
  self.m=ROOT/'docs/evidence/registry-distribution/current-manifest.json'
 def tearDown(self):self.tmp.cleanup()
 def write(self,n,v):
  p=self.p/n;p.write_text(v);p.chmod(0o600);return p
 def run_gate(self,ambient=None):
  self.write('env','\n'.join(k+'='+v for k,v in self.e.items()))
  self.write('scheduler',json.dumps(self.s));self.write('policy',json.dumps(self.q))
  env=os.environ.copy();env.update(ambient or {})
  r=subprocess.run(['python3',str(ROOT/'scripts/operator-preflight.py'),'--env-file',str(self.p/'env'),'--manifest',str(self.m),'--scheduler',str(self.p/'scheduler'),'--qualification',str(self.p/'policy')],capture_output=True,text=True,env=env)
  self.assertNotIn(SECRET,r.stdout+r.stderr);self.assertEqual(r.stderr,'')
  return r.returncode,json.loads(r.stdout)
 def qualify(self,g):
  record=self.write('record','synthetic nonsensitive qualification')
  for e in self.q[g].values():e.update(qualified=True,record=str(record))
 def test_external_category(self):
  c,r=self.run_gate();self.assertEqual(c,3);self.assertTrue(all(x['status']=='PASS' for x in r['checks']));self.assertEqual(set(r['external_input_required']),set(h.EXTERNAL))
 def test_owner_category(self):
  self.qualify('external');c,r=self.run_gate();self.assertEqual(c,4);self.assertFalse(r['external_input_required'])
 def test_presence_success_no_go(self):
  self.qualify('external');self.qualify('approvals');c,r=self.run_gate();self.assertEqual(c,0);self.assertEqual(r['overall_production_readiness'],'NOT_READY')
 def test_missing_cannot_use_ambient(self):
  del self.e['JWT_SECRET'];c,r=self.run_gate({'JWT_SECRET':SECRET});self.assertEqual(c,2);self.assertEqual(r['checks'][0]['status'],'MISSING_OR_INVALID_LOCAL_CONFIG')
 def test_ambient_ignored(self):
  c,_=self.run_gate({'PUBLIC_HOST':'bad.invalid','BACKUP_AGE_IDENTITY_FILE':SECRET,'HOMECLOUD_CONFIG_MODE':'environment'});self.assertEqual(c,3)
 def test_writer_key_and_barrier_rejected(self):
  for key in ('BACKUP_AGE_IDENTITY_FILE','BACKUP_WRITE_BARRIER_CONFIRMED'):
   self.e[key]=SECRET;c,_=self.run_gate();self.assertEqual(c,2);del self.e[key]
 def test_scheduler_consistency(self):
  self.s['cert_args']['hostname']='bad.invalid';c,_=self.run_gate();self.assertEqual(c,2)
 def test_test_http_rejected(self):
  self.s.update(webhook_url='http://127.0.0.1',allow_test_http=True);c,_=self.run_gate();self.assertEqual(c,2)
 def test_manifest_tamper(self):
  m=json.loads(self.m.read_text());m['images']['backend']['digest']='sha256:'+'0'*64;self.m=self.write('manifest',json.dumps(m));c,_=self.run_gate();self.assertEqual(c,2)
 def test_malformed_policy(self):
  self.q['approvals']['rpo']['qualified']='true';c,_=self.run_gate();self.assertEqual(c,2)
 def test_permissions(self):
  (self.p/'recipients').chmod(0o644);c,_=self.run_gate();self.assertEqual(c,2)
 def test_tls_private_key_permissions(self):
  (self.p/'tls/versions/generation/privkey.pem').chmod(0o644);c,_=self.run_gate();self.assertEqual(c,2)
 def test_symlink(self):
  (self.p/'link').symlink_to(self.p/'recipients');self.e['BACKUP_AGE_RECIPIENTS_FILE']=str(self.p/'link');c,_=self.run_gate();self.assertEqual(c,2)
if __name__=='__main__':unittest.main()
