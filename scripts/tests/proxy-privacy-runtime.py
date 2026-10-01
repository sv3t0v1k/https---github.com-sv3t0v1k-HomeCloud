#!/usr/bin/env python3
"""Disposable success/upstream-error privacy regression for both nginx configs.
Requires Docker, curl and openssl. This does not qualify production topology.
Only uniquely named resources created here are removed.
"""
import pathlib, subprocess, tempfile, uuid, json, socket
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-proxy-privacy-',dir=None))
repo=pathlib.Path(__file__).resolve().parents[2]; name='hc-privacy-'+uuid.uuid4().hex[:10]; resources=[]
def run(*a): return subprocess.check_output(a,text=True,stderr=subprocess.STDOUT).strip()
def d(*a): return run('docker',*a)
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
result={}; marker='synthetic-private-'+uuid.uuid4().hex
try:
 d('network','create',name)
 (root/'upstream.conf').write_text('server { listen 3000; location / { return 200 "OK"; } }')
 (root/'frontend.conf').write_bytes(b'proxy_connect_timeout 1s; proxy_read_timeout 1s;\n'+(repo/'frontend/nginx.conf').read_bytes())
 (root/'ingress.conf').write_text(('proxy_connect_timeout 1s; proxy_read_timeout 1s;\n'+(repo/'deploy/ingress/default.conf.template').read_text()).replace('${PUBLIC_HOST}','privacy.example.invalid'))
 (root/'current').mkdir(mode=0o700)
 run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=privacy.example.invalid','-keyout',str(root/'current/privkey.pem'),'-out',str(root/'current/fullchain.pem')); (root/'current/privkey.pem').chmod(0o600)
 def start(suffix,*args):
  n=name+'-'+suffix; d('run','-d','--name',n,'--network',name,*args); resources.append(n); return n
 upstream=start('upstream','--network-alias','homebackend','-v',str(root/'upstream.conf')+':/etc/nginx/conf.d/default.conf:ro','nginx:alpine')
 fp,ip=port(),port()
 front=start('frontend','--network-alias','frontend','-p',f'127.0.0.1:{fp}:80','-v',str(root/'frontend.conf')+':/etc/nginx/conf.d/default.conf:ro','nginx:alpine')
 ingress=start('ingress','-p',f'127.0.0.1:{ip}:443','-v',str(root/'ingress.conf')+':/etc/nginx/conf.d/default.conf:ro','-v',str(root)+':/etc/nginx/tls:ro','-v',str(repo/'deploy/ingress/upgrade.conf')+':/etc/nginx/conf.d/upgrade.conf:ro','nginx:alpine')
 for c in [front,ingress]: d('exec',c,'nginx','-t'); (root/(c+'-effective.conf')).write_text(d('exec',c,'nginx','-T'))
 def request(p,tls=False):
  return int(run('curl','-ksS','--connect-timeout','2','--max-time','10','-o','/dev/null','-w','%{http_code}','-H','Host: privacy.example.invalid','-H','Referer: https://example.invalid/'+marker,'-H','User-Agent: '+marker,('https' if tls else 'http')+'://127.0.0.1:'+str(p)+'/api/v1/sharing/public/'+marker+'?token='+marker))
 assert request(fp)==200 and request(ip,True)==200
 d('stop',upstream); assert request(fp) in (502,504) and request(ip,True) in (502,504)
 d('stop',front); assert request(ip,True) in (502,504)
 for c in [front,ingress]:
  logs=d('logs',c); (root/(c+'.log')).write_text(logs); assert marker not in logs; assert ('status=502' in logs or 'status=504' in logs) and 'status=200' in logs
 result={'verdict':'PASS','nginx_config':'PASS both','access_and_error_paths':'200 and upstream 502/504 on both boundaries; actual statuses retained in raw logs','privacy_marker_absent':True,'scope':'isolated proxy logging correction only; no production topology or E2E proof'}
except BaseException as error:
 result={'verdict':'FAIL','error':type(error).__name__}
 raise
finally:
 for c in reversed(resources): d('rm','-f','-v',c)
 d('network','rm',name)
 for p in (root/'current').glob('*'): p.unlink()
 result['cleanup']=True; (root/'result.json').write_text(json.dumps(result,indent=2)); print(root); print(json.dumps(result))
