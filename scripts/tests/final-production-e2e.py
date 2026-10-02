#!/usr/bin/env python3
"""Disposable final acceptance through local TLS ingress; no external qualification."""
import argparse, base64, hashlib, json, os, pathlib, re, secrets, socket, ssl, subprocess, tempfile, time, urllib.request, urllib.error, uuid
P=argparse.ArgumentParser();P.add_argument('--repo',default=str(pathlib.Path(__file__).resolve().parents[2]));P.add_argument('--current',default='0d766777a41493e237b77df18f5597901d5f080e');P.add_argument('--browser-script',default=str(pathlib.Path(__file__).with_name('final-browser-acceptance.cjs')));P.add_argument('--node',default='node');P.add_argument('--previous',default='647aa7b949698f9b84feee3ce5134cb2a7b542de');a=P.parse_args();repo=pathlib.Path(a.repo)
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-pair-drill-'));os.chmod(root,0o700);name='hc-pair-'+uuid.uuid4().hex[:10];result={'evidence':str(root),'source_current':a.current,'source_previous':a.previous};owned=[];nets=[];log=open(root/'operations.log','w');pairs={}
def run(*args):
 p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=log)
 if p.returncode:raise RuntimeError('Operation failed: '+args[0]+' '+args[1])
 return p.stdout.strip()
def docker(*args):return run('docker',*args)
def wait(fn):
 for _ in range(180):
  try:
   if fn():return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('Readiness timeout')
def envargs():
 f=root/'app.env';f.write_text(''.join(k+'='+v+'\n' for k,v in env.items()));os.chmod(f,0o600);return ['--env-file',str(f)]
def container(role,image,*args,command=()):
 n=name+'-'+role;owned.append(n);docker('run','-d','--name',n,*args,image,*command);return n
def sql(q):return docker('exec',db,'psql','-U','postgres','-d','qualification','-At','-c',q)
def snapshot():
 tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
 data={t:sql('SELECT row_to_json(t) FROM (SELECT * FROM "'+t+'" ORDER BY 1)t') for t in tables}
 schema=docker('exec',db,'pg_dump','-U','postgres','-d','qualification','--schema-only','--no-owner','--no-privileges');schema='\n'.join(l for l in schema.splitlines() if not l.startswith('\\restrict') and not l.startswith('\\unrestrict'))
 files=docker('exec',be,'sh','-c','find /storage -type f -exec sha256sum {} \\; | sort')
 return {'tables_sha256':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in data.items()},'schema_sha256':hashlib.sha256(schema.encode()).hexdigest(),'storage_sha256':hashlib.sha256(files.encode()).hexdigest(),'migrations':sql('SELECT timestamp,name FROM migrations ORDER BY timestamp'),'quota':sql('SELECT "storageUsed","storageQuota" FROM users ORDER BY id')}
def request(route='',token=None,data=None,ctype='application/json',method=None):
 headers={'Host':'localhost','Content-Type':ctype}
 if token:headers['Authorization']='Bearer '+token
 if isinstance(data,dict):data=json.dumps(data).encode()
 req=urllib.request.Request('https://127.0.0.1:'+str(port)+'/'+route,headers=headers,data=data,method=method)
 with opener.open(req,timeout=15) as r:return r.status,r.read()
def api(route,**kw):return request('api/v1/'+route,**kw)
def unpack(b):return json.loads(b)['data']
def ready():
 code=docker('exec',be,'node','-e',"require('http').get('http://localhost:3000/api/v1/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))")
 return request()[0]==200
try:
 for label,commit in [('current',a.current),('previous',a.previous)]:
  context=root/label;context.mkdir()
  archive=root/(label+'.tar');archive.write_bytes(subprocess.check_output(['git','-C',str(repo),'archive',commit,'backend','frontend','docker-compose.production.yml']))
  run('tar','-xf',str(archive),'-C',str(context));pair={}
  manifest=json.loads((repo/('docs/evidence/final-prep/current-build-manifest.json' if label=='current' else 'docs/evidence/immutable-release/previous-manifest.json')).read_text());pairs[label]={role:manifest['images'][role]['image_id'] for role in ('backend','frontend')}
 result['pairs']=pairs
 helper=str(repo/'scripts/release-manifest.cjs');manifests={}
 for label,commit in [('current',a.current),('previous',a.previous)]:
  mf=root/(label+'-manifest.json');run('node',helper,'generate','--source-root',str(root/label),'--source-commit',commit,'--backend',pairs[label]['backend'],'--frontend',pairs[label]['frontend'],'--output',str(mf));manifests[label]=mf
 result['manifests']={k:json.loads(v.read_text()) for k,v in manifests.items()}
 current_m={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'current/backend/src/migrations').glob('*.ts')};previous_m={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'previous/backend/src/migrations').glob('*.ts')};assert current_m==previous_m
 result['migration_source_hashes']=current_m
 for role in ('app','proxy','ingress'):
  n=name+'-'+role;docker('network','create',n);nets.append(n)
 db=container('db','postgres:16-alpine','--network',nets[0],'--network-alias','db','-e','POSTGRES_PASSWORD='+secrets.token_hex(32),'-e','POSTGRES_DB=qualification')
 # Password from our isolated container is kept in private memory, never evidence.
 dbpass=json.loads(docker('inspect',db))[0]['Config']['Env'];password=next(v.split('=',1)[1] for v in dbpass if v.startswith('POSTGRES_PASSWORD='))
 env={'NODE_ENV':'production','DATABASE_URL':'postgres://postgres:'+password+'@db:5432/qualification','JWT_SECRET':secrets.token_hex(32),'JWT_REFRESH_SECRET':secrets.token_hex(32),'FRONTEND_URL':'https://release.example.invalid','STORAGE_PATH':'/storage'}
 wait(lambda:docker('exec',db,'pg_isready','-U','postgres','-d','qualification') is not None)
 volume=name+'-storage';docker('volume','create',volume)
 docker('run','--rm','-v',volume+':/storage','alpine','chown','1001:1001','/storage')
 migration=name+'-migration';owned.append(migration)
 docker('run','--name',migration,'--network',nets[0],*envargs(),pairs['current']['backend'],'node','node_modules/typeorm/cli.js','migration:run','-d','dist/data-source.js','--transaction','all')
 expected='\n'.join(str(re.match(r'(\d+)',p).group(1))+'|'+p.split('-',1)[1][:-3]+re.match(r'(\d+)',p).group(1) for p in sorted(current_m))
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 cert=root/'tls';cert.mkdir();run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(cert/'key.pem'),'-out',str(cert/'cert.pem'),'-days','1','-subj','/CN=release.example.invalid')
 ingressconf=root/'ingress.conf';ingressconf.write_text((repo/'deploy/ingress/upgrade.conf').read_text()+'\n'+(repo/'deploy/ingress/default.conf.template').read_text().replace('${PUBLIC_HOST}','localhost').replace('/etc/nginx/tls/current/fullchain.pem','/tls/cert.pem').replace('/etc/nginx/tls/current/privkey.pem','/tls/key.pem'))
 ingress=container('ingress','nginx:alpine','--network',nets[2],'-p','127.0.0.1:'+str(port)+':443','-v',str(cert)+':/tls:ro','-v',str(ingressconf)+':/etc/nginx/conf.d/default.conf:ro',command=('sh','-c','sleep infinity'))
 ingressip=json.loads(docker('inspect',ingress))[0]['NetworkSettings']['Networks'][nets[2]]['IPAddress']
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
 def deploy(label):
  global be,fe
  applied=root/'applied-migrations.json';applied.write_text(json.dumps(sql('SELECT name FROM migrations ORDER BY timestamp').splitlines()))
  override=root/(label+'-override.yml');run('node',helper,'override','--manifest',str(manifests[label]),'--compatibility-manifest',str(manifests['current']),'--applied-migrations',str(applied),'--output',str(override))
  compose_env={**os.environ,'DB_PASSWORD':password,'JWT_SECRET':env['JWT_SECRET'],'JWT_REFRESH_SECRET':env['JWT_REFRESH_SECRET'],'PUBLIC_HOST':'localhost','TLS_CERT_DIR':str(cert),'ACME_WEBROOT_DIR':str(root),'REDIS_PASSWORD':secrets.token_hex(32)}
  merged=subprocess.run(['docker','compose','--env-file','/dev/null','-f',str(root/label/'docker-compose.production.yml'),'-f',str(override),'config','--format','json'],env=compose_env,stdout=subprocess.PIPE,stderr=log,text=True);assert merged.returncode==0
  services=json.loads(merged.stdout)['services'];pair={r:services[r]['image'] for r in ('backend','frontend')};assert all('build' not in services[r] and services[r]['pull_policy']=='never' for r in pair)
  result.setdefault('compose_effective',[]).append({'release':label,'immutable_images':pair,'build_absent':True,'pull_policy':'never'})
  # Live preflight using the exact selected immutable backend, no migrations run.
  output=docker('run','--rm','--network',nets[0],*envargs(),pair['backend'],'node','node_modules/typeorm/cli.js','migration:show','-d','dist/data-source.js');assert '[ ]' not in output
  result.setdefault('migration_preflight',[]).append({'release':label,'no_pending':True})
  for role in ('backend','frontend'):
   n=name+'-'+role
   if n in owned:docker('rm','-f',n);owned.remove(n)
  fe=container('frontend',pair['frontend'],'--network',nets[1],'--network-alias','frontend',command=('sh','-c','sleep infinity'))
  docker('network','connect','--alias','frontend',nets[2],fe)
  feip=json.loads(docker('inspect',fe))[0]['NetworkSettings']['Networks'][nets[1]]['IPAddress'];env['TRUSTED_PROXY_IP']=feip
  conf=(root/label/'frontend/nginx.conf').read_text().replace('172.29.0.10',ingressip);(root/'frontend.conf').write_text(conf)
  docker('cp',str(root/'frontend.conf'),fe+':/etc/nginx/conf.d/default.conf')
  be=container('backend',pair['backend'],'--network',nets[0],*envargs(),'-v',volume+':/storage');docker('network','connect','--alias','homebackend',nets[1],be)
  docker('exec',fe,'nginx');
  if label=='current' and 'current_deployed' not in result:docker('exec',ingress,'nginx')
  else:docker('exec',ingress,'nginx','-s','reload')
  wait(ready)
  actual={r:json.loads(docker('inspect',name+'-'+r))[0]['Image'] for r in ('backend','frontend')};assert actual==pair;result[label+'_deployed']=actual;result.setdefault('transitions',[]).append({'release':label,'actual_images':actual})
 # A live unexpected migration must block the operator before any deployment.
 sql("INSERT INTO migrations(timestamp,name) VALUES (9999999999999,'FixtureIncompatible9999999999999')")
 applied=root/'applied-extra.json';applied.write_text(json.dumps(sql('SELECT name FROM migrations ORDER BY timestamp').splitlines()))
 negative=subprocess.run(['node',helper,'override','--manifest',str(manifests['previous']),'--compatibility-manifest',str(manifests['current']),'--applied-migrations',str(applied),'--output',str(root/'blocked.json')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);assert negative.returncode!=0 and 'incompatible applied migrations' in negative.stderr;result['live_incompatible_migration_blocked']=True
 sql("DELETE FROM migrations WHERE name='FixtureIncompatible9999999999999'")
 deploy('current')
 _,b=api('auth/register',data={'email':'pair@example.invalid','password':'PairPassword938475!','name':'Pair'});token=unpack(b)['accessToken'];sql('UPDATE users SET "storageQuota"=1048576')
 payload=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
 def upload(filename):
  _,b=api('uploads/session',token=token,data={'filename':filename,'totalSize':len(payload),'chunkSize':len(payload)});uid=unpack(b)['uploadId'];boundary='hc'+uuid.uuid4().hex
  body=(f'--{boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--{boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.txt"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+payload+f'\r\n--{boundary}--\r\n'.encode());assert api('uploads/session/'+uid+'/chunk',token=token,data=body,ctype='multipart/form-data; boundary='+boundary)[0]==200
  return unpack(api('uploads/session/'+uid+'/complete',token=token,data={})[1])['id']
 fid=upload('pair.png');trashid=upload('trash.png');api('files/'+str(trashid),token=token,method='DELETE');share=unpack(api('sharing',token=token,data={'fileId':fid})[1]);before=snapshot();result['before']=before
 def verify():
  assert api('files/'+str(fid)+'/download',token=token)[1]==payload
  assert str(trashid) in api('files/trash',token=token)[1].decode()
  assert share['token'] in api('sharing',token=token)[1].decode()
  assert api('sharing/public/'+share['token'])[0]==200
  page=request()[1].decode();assets=re.findall(r'(?:src|href)="(/assets/[^"]+)"',page);assert assets
  for asset in assets:
   served=request(asset.lstrip('/'))[1];expected=docker('exec',fe,'sha256sum','/usr/share/nginx/html'+asset).split()[0];assert hashlib.sha256(served).hexdigest()==expected
  expected=docker('exec',fe,'sha256sum','/usr/share/nginx/html/index.html').split()[0];assert hashlib.sha256(page.encode()).hexdigest()==expected
  result.setdefault('ui_artifact_checks',[]).append({'index_sha256':expected,'assets_verified':len(assets)})
  assert snapshot()==before
 verify();result['current_flows']=True
 auth=unpack(api('auth/login',data={'email':'pair@example.invalid','password':'PairPassword938475!'})[1]);token=auth['accessToken']
 folder=unpack(api('files/folders',token=token,data={'name':'API parent'})[1]);nested=unpack(api('files/folders',token=token,data={'name':'API nested','parentId':folder['folderId']})[1])
 assert api('files/folders/'+str(nested['folderId']),token=token)[0]==200
 assert 'API parent' in api('files/folders',token=token)[1].decode()
 assert 'API nested' in api('files/folders?parentId='+str(folder['folderId']),token=token)[1].decode()
 assert api('previews/'+str(fid),token=token)[0]==200
 api('sharing/'+str(share['id']),token=token,method='DELETE')
 try:api('sharing/public/'+share['token']);raise AssertionError('Revoked share active')
 except urllib.error.HTTPError as err:assert err.code in (403,404)
 api('files/'+str(trashid)+'/restore',token=token,data={});assert api('files/'+str(trashid)+'/download',token=token)[1]==payload
 api('files/'+str(trashid),token=token,method='DELETE');api('files/'+str(trashid)+'/permanent',token=token,method='DELETE')
 api('auth/logout',token=token,data={'refreshToken':auth['refreshToken']})
 assert api('auth/login',data={'email':'pair@example.invalid','password':'PairPassword938475!'})[0] in (200,201)
 for path in ('health','health/ready','metrics'):
  try:api(path);raise AssertionError('Operational endpoint public')
  except urllib.error.HTTPError as err:assert err.code==404
 result['internal_health_status']=int(docker('exec',be,'node','-e',"require('http').get('http://localhost:3000/api/v1/health',r=>console.log(r.statusCode))"));result['internal_readiness_status']=int(docker('exec',be,'node','-e',"require('http').get('http://localhost:3000/api/v1/health/ready',r=>console.log(r.statusCode))"));assert result['internal_health_status']==result['internal_readiness_status']==200
 result['final_api_acceptance']={'login':True,'root_nested_folders':True,'create_folder':True,'upload_download_bytes':True,'preview':True,'share_create_revoke':True,'trash_restore_permanent_delete':True,'logout_relogin':True,'private_operational_endpoints':True,'local_tls_only':True}
 subprocess.check_call([a.node,a.browser_script,'https://localhost:'+str(port),str(root/'browser-result.json')],stdout=log,stderr=log)
 result['browser_acceptance']=json.loads((root/'browser-result.json').read_text())
 # Restore the preservation fixture after final acceptance mutated it.
 fid=upload('pair.png');trashid=upload('trash.png');api('files/'+str(trashid),token=token,method='DELETE');share=unpack(api('sharing',token=token,data={'fileId':fid})[1]);before=snapshot();result['before']=before

 docker('stop',be,fe)
 try:request();raise AssertionError('Stopped pair still serving')
 except urllib.error.HTTPError as err:assert err.code in (502,504)
 except (OSError,TimeoutError):pass
 result['controlled_regression']=True
 deploy('previous');verify();result['rollback']=True;result['after_rollback']=snapshot()
 deploy('current');verify();result['rollforward']=True;result['after_rollforward']=snapshot();assert api('auth/login',data={'email':'pair@example.invalid','password':'PairPassword938475!'})[0] in (200,201);result['login_after_preservation_proof']=True;result['data_preservation']=True;result['schema_down_migration']=False;result['registry_distribution']='NOT_QUALIFIED';result['application_tree_limitation']='Same application/migration source; initial HEAD pair and retained previous pair qualify artifact switching, not cross-schema compatibility.'
finally:
 for n in reversed(owned):
  subprocess.run(['docker','rm','-f','-v',n],stdout=log,stderr=log)
 for n in reversed(nets):subprocess.run(['docker','network','rm',n],stdout=log,stderr=log)
 if 'volume' in globals():subprocess.run(['docker','volume','rm',volume],stdout=log,stderr=log)
 result['cleanup_complete']=all(n not in docker('ps','-a','--format','{{.Names}}').splitlines() for n in owned)
 result['cleanup_networks_removed']=all(n not in docker('network','ls','--format','{{.Name}}').splitlines() for n in nets)
 result['cleanup_volume_removed']='volume' not in globals() or volume not in docker('volume','ls','--format','{{.Name}}').splitlines()
 if (root/'app.env').exists():(root/'app.env').unlink()
 if 'cert' in globals():
  for secretfile in cert.iterdir():secretfile.unlink()
 log.flush();secret_values=[password,*[env[k] for k in ('JWT_SECRET','JWT_REFRESH_SECRET')]] if 'password' in globals() else []
 operations=(root/'operations.log').read_text();assert not any(secret in operations for secret in secret_values);result['operation_logs_secret_scan']=True;result['external_config_removed']=not (root/'app.env').exists();result['local_ingress_only']=True;result['overall_production_readiness']='NOT_READY'
 (root/'result.json').write_text(json.dumps(result,indent=2,sort_keys=True));print(json.dumps(result,indent=2,sort_keys=True));log.close()
