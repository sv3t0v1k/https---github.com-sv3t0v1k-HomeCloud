#!/usr/bin/env python3
"""Deterministic validation and activation guard tests; no public CA proof."""
import importlib.util, pathlib, subprocess, tempfile, unittest, types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('lifecycle',pathlib.Path(__file__).parents[1]/'certificate-lifecycle.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class LifecycleTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.temp.name); self.state=self.root/'tls'; self.state.mkdir(mode=0o700)
  self.cert=self.root/'cert.pem'; self.key=self.root/'key.pem'
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(self.key),'-out',str(self.cert),'-days','45','-subj','/CN=test.invalid','-addext','subjectAltName=DNS:test.invalid'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  self.key.chmod(0o600)
  self.args=types.SimpleNamespace(state_dir=str(self.state),cert=str(self.cert),key=str(self.key),hostname='test.invalid',ca_file=str(self.cert),container=None,probe_host='localhost',probe_port=443,warning_days=30,critical_days=7)
 def tearDown(self): self.temp.cleanup()
 def test_validation_install_idempotent(self):
  m.install(self.args); before=(self.state/'current').readlink(); m.install(self.args)
  self.assertEqual(before,(self.state/'current').readlink()); self.assertEqual((self.state/'current/privkey.pem').stat().st_mode&0o777,0o600)
 def test_world_readable_key_rejected(self):
  self.key.chmod(0o644)
  with self.assertRaisesRegex(ValueError,'permissions'): m.install(self.args)
  self.assertFalse((self.state/'current').exists())
 def test_wrong_hostname_rejected(self):
  self.args.hostname='wrong.invalid'
  with self.assertRaises(Exception): m.install(self.args)
 def test_missing_key_rejected(self):
  self.key.unlink()
  with self.assertRaises(Exception): m.install(self.args)
 def test_mismatched_key_rejected(self):
  subprocess.run(['openssl','genrsa','-out',str(self.key),'2048'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  with self.assertRaisesRegex(ValueError,'mismatch'): m.install(self.args)
 def test_invalid_certificate_rejected(self):
  self.cert.write_text('invalid')
  with self.assertRaises(Exception): m.install(self.args)
 def test_system_trust_rejects_self_signed(self):
  self.args.ca_file=None
  with self.assertRaises(ValueError): m.install(self.args)
 def test_expiry_thresholds(self):
  m.install(self.args); self.assertEqual(m.check(self.args),0)
  self.args.warning_days=60; self.assertEqual(m.check(self.args),1)
  self.args.critical_days=60; self.assertEqual(m.check(self.args),2)
 def test_expired_certificate_rejected(self):
  csr=self.root/'expired.csr'; expired=self.root/'expired.pem'
  subprocess.run(['openssl','req','-new','-key',str(self.key),'-out',str(csr),'-subj','/CN=test.invalid'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  (self.root/'index').write_text(''); (self.root/'serial').write_text('01\n')
  config=self.root/'ca.conf'; config.write_text(f"[ca]\ndefault_ca=local\n[local]\ndatabase={self.root}/index\nserial={self.root}/serial\nnew_certs_dir={self.root}\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n")
  subprocess.run(['openssl','ca','-batch','-selfsign','-config',str(config),'-keyfile',str(self.key),'-in',str(csr),'-out',str(expired),'-startdate','20000101000000Z','-enddate','20010101000000Z'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  self.args.cert=str(expired)
  with self.assertRaises(ValueError): m.install(self.args)
 def test_config_failure_prevents_candidate_reload_rolls_back(self):
  m.install(self.args); old=(self.state/'current').readlink(); self.args.container='isolated-ingress'
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(self.key),'-out',str(self.cert),'-days','90','-subj','/CN=test.invalid','-addext','subjectAltName=DNS:test.invalid'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  self.key.chmod(0o600)
  original=m.run; calls=[]
  def fail(*args):
   if args[0]=='docker':
    calls.append(args)
    if len(calls)==1: raise ValueError('config invalid')
    return b''
   return original(*args)
  with patch.object(m,'run',side_effect=fail),patch.object(m,'probe'):
   with self.assertRaisesRegex(ValueError,'config invalid'): m.install(self.args)
  self.assertEqual((self.state/'current').readlink(),old)
  self.assertEqual(calls[0][-1],'-t'); self.assertEqual(calls[1][-1],'-t')
if __name__=='__main__': unittest.main()
