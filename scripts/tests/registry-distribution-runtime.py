#!/usr/bin/env python3
"""Disposable immutable backend/frontend rollback qualification; never downgrade DB."""
import argparse, base64, hashlib, json, os, pathlib, re, secrets, socket, ssl, subprocess, tempfile, time, urllib.request, urllib.error, uuid
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
P=argparse.ArgumentParser();P.add_argument('--repo',default=str(pathlib.Path(__file__).resolve().parents[2]));P.add_argument('--current',default='37b2eae7f8375a01c0b7207f70317c57ee3ae01d');P.add_argument('--previous',default='647aa7b949698f9b84feee3ce5134cb2a7b542de');a=P.parse_args();repo=pathlib.Path(a.repo)
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-pair-drill-'));os.chmod(root,0o700);name='hc-pair-'+uuid.uuid4().hex[:10];result={'evidence':str(root),'source_current':a.current,'source_previous':a.previous};owned=[];nets=[];log=open(root/'operations.log','w');pairs={}
def run(*args):
 p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=log)
 if p.returncode:raise RuntimeError('Operation failed: '+args[0]+' '+args[1])
 return p.stdout.strip()
def docker(*args):return run('docker',*args)
def outer(*args):
 p=subprocess.run(['docker',*args],env=outer_env,text=True,stdout=subprocess.PIPE,stderr=log)
 if p.returncode:raise RuntimeError('Outer Docker operation failed: '+args[0])
 return p.stdout.strip()
def wait(fn):
 for _ in range(180):
  try:
   if fn():return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('Readiness timeout')
def envargs():return sum((['-e',k+'='+v] for k,v in env.items()),[])
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
 headers={'Host':'release.example.invalid','Content-Type':ctype}
 if token:headers['Authorization']='Bearer '+token
 if isinstance(data,dict):data=json.dumps(data).encode()
 req=urllib.request.Request('https://127.0.0.1:'+str(port)+'/'+route,headers=headers,data=data,method=method)
 with opener.open(req,timeout=15) as r:return r.status,r.read()
def api(route,**kw):return request('api/v1/'+route,**kw)
def unpack(b):return json.loads(b)['data']
def ready():
 code=docker('exec',be,'node','-e',"require('http').get('http://localhost:3000/api/v1/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))")
 return request()[0]==200
outer_env=dict(os.environ); outer_env.pop('DOCKER_HOST',None); outer_owned=[];registry_tags=[]
try:
 for label,commit in [('current',a.current),('previous',a.previous)]:
  context=root/label;context.mkdir()
  archive=root/(label+'.tar');archive.write_bytes(subprocess.check_output(['git','-C',str(repo),'archive',commit,'backend','frontend','docker-compose.production.yml']))
  run('tar','-xf',str(archive),'-C',str(context));pair={}
  local=json.loads((repo/'docs/evidence/immutable-release'/ (label+'-manifest.json')).read_text());pairs[label]={r:local['images'][r]['image_id'] for r in ('backend','frontend')}
 result['retained_local_pairs']=json.loads(json.dumps(pairs))
 for role in ('registry','daemon','ingress'):
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));result[role+'_port']=sock.getsockname()[1]
 outer_network=name+'-distribution';outer('network','create',outer_network)
 registry=name+'-registry';outer_owned.append(registry)
 outer('run','-d','--name',registry,'--network',outer_network,'--network-alias','registry.local','-p','127.0.0.1:'+str(result['registry_port'])+':5000','registry:2')
 wait(lambda:urllib.request.urlopen('http://127.0.0.1:'+str(result['registry_port'])+'/v2/',timeout=3).status==200)
 helper=str(repo/'scripts/release-manifest.cjs');manifests={};registry_evidence={}
 for label in ('current','previous'):
  registry_evidence[label]={}
  for role in ('backend','frontend'):
   repository='localhost:'+str(result['registry_port'])+'/hc/'+role
   tag=repository+':'+label;registry_tags.append(tag);outer('tag',pairs[label][role],tag);pushed=outer('push',tag)
   push_digest=re.search(r'digest: (sha256:[a-f0-9]{64})',pushed).group(1)
   url='http://127.0.0.1:'+str(result['registry_port'])+'/v2/hc/'+role+'/manifests/'+label
   req=urllib.request.Request(url,headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'})
   with urllib.request.urlopen(req) as response:content=response.read();digest=response.headers['Docker-Content-Digest']
   assert digest==push_digest=='sha256:'+hashlib.sha256(content).hexdigest()
   (root/(label+'-'+role+'-registry-manifest.json')).write_bytes(content)
   document=json.loads(content)
   if 'manifests' in document:
    platform=json.loads(outer('image','inspect',pairs[label][role]))[0];entry=next(x for x in document['manifests'] if x.get('platform',{}).get('os')==platform['Os'] and x.get('platform',{}).get('architecture')==platform['Architecture'])
    with urllib.request.urlopen(urllib.request.Request(url.rsplit('/',1)[0]+'/'+entry['digest'],headers={'Accept':'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})) as response:platform_bytes=response.read();assert 'sha256:'+hashlib.sha256(platform_bytes).hexdigest()==entry['digest'];document=json.loads(platform_bytes)
    (root/(label+'-'+role+'-platform-manifest.json')).write_bytes(platform_bytes)
   config_id=document['config']['digest']
   registry_evidence[label][role]={'push_digest':push_digest,'registry_digest':digest,'http_body_sha256':hashlib.sha256(content).hexdigest(),'reference':'registry.local:5000/hc/'+role+'@'+digest,'outer_image_id':pairs[label][role],'expected_config_id':config_id}
 result['registry_raw']=registry_evidence
 daemon=name+'-daemon';outer_owned.append(daemon)
 outer('run','-d','--privileged','--name',daemon,'--network',outer_network,'-e','DOCKER_TLS_CERTDIR=','-p','127.0.0.1:'+str(result['daemon_port'])+':2375','-p','127.0.0.1:'+str(result['ingress_port'])+':4443','-v',str(root)+':'+str(root),'docker:27-dind','--insecure-registry=registry.local:5000','--insecure-registry=auth.local:80')
 os.environ['DOCKER_HOST']='tcp://127.0.0.1:'+str(result['daemon_port'])
 wait(lambda:docker('info') is not None)
 assert docker('image','ls','-q')=='';result['clean_daemon_empty_before_pull']=True
 subprocess.check_call(['docker','save','-o',str(root/'dependencies.tar'),'postgres:16-alpine','nginx:alpine','alpine:latest'],env=outer_env,stdout=log,stderr=log)
 docker('load','-i',str(root/'dependencies.tar'));(root/'dependencies.tar').unlink();result['dependencies_loaded_only']=['postgres:16-alpine','nginx:alpine','alpine:latest']
 for label in ('current','previous'):
  refs={}
  for role in ('backend','frontend'):
   ref=registry_evidence[label][role]['reference'];assert subprocess.run(['docker','image','inspect',ref],stdout=log,stderr=log).returncode!=0
   pulled=docker('pull',ref);found=json.loads(docker('image','inspect',ref))[0];assert found['Id']==registry_evidence[label][role]['expected_config_id'] and ref in found['RepoDigests'];refs[role]=ref
   registry_evidence[label][role]['pulled_config_id']=found['Id'];registry_evidence[label][role]['absent_before_pull']=True
  mf=root/(label+'-manifest.json');run('node',helper,'distribute','--manifest',str(repo/'docs/evidence/immutable-release'/(label+'-manifest.json')),'--backend',refs['backend'],'--frontend',refs['frontend'],'--output',str(mf));manifests[label]=mf;pairs[label]=refs
 result['manifests']={k:json.loads(v.read_text()) for k,v in manifests.items()}
 result['pairs']=pairs
 # Move both mutable current tags to the previous pair; pinned references remain unchanged.
 for role in ('backend','frontend'):
  repo_ref='localhost:'+str(result['registry_port'])+'/hc/'+role
  outer('tag',registry_evidence['previous'][role]['outer_image_id'],repo_ref+':current');outer('push',repo_ref+':current')
  with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(result['registry_port'])+'/v2/hc/'+role+'/manifests/current',headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'})) as response:assert response.headers['Docker-Content-Digest']==registry_evidence['previous'][role]['registry_digest']
  docker('pull',pairs['current'][role]);assert json.loads(docker('image','inspect',pairs['current'][role]))[0]['Id']==registry_evidence['current'][role]['expected_config_id']
 result['mutable_tag_movement_digest_stable']=True
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
 port=result['ingress_port']
 cert=root/'tls';cert.mkdir();run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(cert/'key.pem'),'-out',str(cert/'cert.pem'),'-days','1','-subj','/CN=release.example.invalid')
 ingressconf=root/'ingress.conf';ingressconf.write_text('server { listen 443 ssl; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; access_log off; error_log /dev/null; location / { proxy_pass http://frontend:80; proxy_set_header Host release.example.invalid; proxy_set_header X-Forwarded-Host release.example.invalid; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; }}')
 ingress=container('ingress','nginx:alpine','--network',nets[2],'-p','0.0.0.0:4443:443','-v',str(cert)+':/tls:ro','-v',str(ingressconf)+':/etc/nginx/conf.d/default.conf:ro',command=('sh','-c','sleep infinity'))
 ingressip=json.loads(docker('inspect',ingress))[0]['NetworkSettings']['Networks'][nets[2]]['IPAddress']
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
 def deploy(label):
  global be,fe
  run('node',helper,'prepare','--manifest',str(manifests[label]))
  applied=root/'applied-migrations.json';applied.write_text(json.dumps(sql('SELECT name FROM migrations ORDER BY timestamp').splitlines()))
  override=root/(label+'-override.yml');run('node',helper,'override','--manifest',str(manifests[label]),'--compatibility-manifest',str(manifests['current']),'--applied-migrations',str(applied),'--output',str(override))
  compose_env={**os.environ,'DB_PASSWORD':password,'JWT_SECRET':env['JWT_SECRET'],'JWT_REFRESH_SECRET':env['JWT_REFRESH_SECRET'],'PUBLIC_HOST':'release.example.invalid','TLS_CERT_DIR':str(cert),'ACME_WEBROOT_DIR':str(root),'REDIS_PASSWORD':secrets.token_hex(32)}
  merged=subprocess.run(['docker','compose','--env-file','/dev/null','-f',str(root/label/'docker-compose.production.yml'),'-f',str(override),'config','--format','json'],env=compose_env,stdout=subprocess.PIPE,stderr=log,text=True);assert merged.returncode==0
  services=json.loads(merged.stdout)['services'];pair={r:services[r]['image'] for r in ('backend','frontend')};assert all('build' not in services[r] and services[r]['pull_policy']=='always' for r in pair)
  result.setdefault('compose_effective',[]).append({'release':label,'immutable_images':pair,'build_absent':True,'pull_policy':'always'})
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
  actual={r:json.loads(docker('inspect',name+'-'+r))[0]['Image'] for r in ('backend','frontend')};assert actual=={r:registry_evidence[label][r]['expected_config_id'] for r in pair};assert all(json.loads(docker('inspect',name+'-'+r))[0]['Config']['Image']==pair[r] for r in pair);result[label+'_deployed']=actual;result.setdefault('transitions',[]).append({'release':label,'actual_images':actual})
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
 active={r:docker('inspect','--format','{{.Id}}',name+'-'+r) for r in ('backend','frontend')}
 def refused(kind,manifest):
  f=root/('failure-'+kind+'.json');f.write_text(json.dumps(manifest));p=subprocess.run(['node',helper,'prepare','--manifest',str(f)],stdout=log,stderr=log);assert p.returncode!=0
  assert active=={r:docker('inspect','--format','{{.Id}}',name+'-'+r) for r in active};assert ready();result.setdefault('failure_cases',{})[kind]={'rejected':True,'active_pair_unchanged':True,'readiness200':True}
 mf=json.loads(manifests['current'].read_text())
 bad=json.loads(json.dumps(mf));bad['images']['frontend']['digest']='sha256:'+'0'*64
 def resign(v):
  return json.loads(run('node','-e',"const m=require(process.argv[1]),v=JSON.parse(process.argv[2]);v.release_id=m.identity(v);console.log(JSON.stringify(v))",helper,json.dumps(v)))
 refused('nonexistent_digest',resign(bad))
 bad=json.loads(json.dumps(mf));bad['images']['backend']['digest']='sha256:bad';refused('malformed_digest',resign(bad))
 bad=json.loads(json.dumps(mf));bad['images']['backend']['digest']=registry_evidence['previous']['backend']['registry_digest'];refused('substituted_pair',resign(bad))
 denyconf=root/'deny.conf';denyconf.write_text('server { listen 80; location / { add_header WWW-Authenticate \'Basic realm=registry-test\' always; return 401; }}')
 deny=name+'-denied';outer_owned.append(deny);outer('run','-d','--name',deny,'--network',outer_network,'--network-alias','auth.local','-v',str(denyconf)+':/etc/nginx/conf.d/default.conf:ro','nginx:alpine')
 time.sleep(1)
 denied=json.loads(json.dumps(mf))
 for role in ('backend','frontend'):denied['images'][role]['repository']='auth.local:80/hc/'+role
 probe=subprocess.run(['docker','pull',denied['images']['backend']['repository']+'@'+denied['images']['backend']['digest']],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert probe.returncode!=0 and any(word in probe.stderr.lower() for word in ('unauthorized','authentication required','no basic auth credentials','401'))
 (root/'auth-denied-probe.log').write_text(probe.stderr);result['auth_denial_verified']=True
 refused('auth_denied_simulated_401',resign(denied))
 outer('stop',registry);refused('registry_unavailable',mf);outer('start',registry)
 wait(lambda:urllib.request.urlopen('http://127.0.0.1:'+str(result['registry_port'])+'/v2/',timeout=3).status==200)

 docker('stop',be,fe)
 try:request();raise AssertionError('Stopped pair still serving')
 except urllib.error.HTTPError as err:assert err.code in (502,504)
 except (OSError,TimeoutError):pass
 result['controlled_regression']=True
 deploy('previous');verify();result['rollback']=True;result['after_rollback']=snapshot()
 deploy('current');verify();result['rollforward']=True;result['after_rollforward']=snapshot();assert api('auth/login',data={'email':'pair@example.invalid','password':'PairPassword938475!'})[0] in (200,201);result['login_after_preservation_proof']=True;result['data_preservation']=True;result['schema_down_migration']=False;result['registry_distribution']='LOCAL_MECHANICS_PASS';result['external_production_registry']='NOT_QUALIFIED';result['application_tree_limitation']='Same application/migration source; exact distinct source revision labels qualify artifact-pair switching, not cross-schema compatibility.'
finally:
 for n in reversed(owned):
  subprocess.run(['docker','rm','-f','-v',n],stdout=log,stderr=log)
 for n in reversed(nets):subprocess.run(['docker','network','rm',n],stdout=log,stderr=log)
 if 'volume' in globals():subprocess.run(['docker','volume','rm',volume],stdout=log,stderr=log)
 result['cleanup_complete']=all(n not in docker('ps','-a','--format','{{.Names}}').splitlines() for n in owned)
 result['cleanup_networks_removed']=all(n not in docker('network','ls','--format','{{.Name}}').splitlines() for n in nets)
 result['cleanup_volume_removed']='volume' not in globals() or volume not in docker('volume','ls','--format','{{.Name}}').splitlines()
 if 'cert' in globals():
  for secretfile in cert.iterdir():secretfile.unlink()
 log.flush();secret_values=[password,*[env[k] for k in ('JWT_SECRET','JWT_REFRESH_SECRET')]] if 'password' in globals() else []
 operations=(root/'operations.log').read_text();assert not any(secret in operations for secret in secret_values);result['operation_logs_secret_scan']=True
 os.environ.pop('DOCKER_HOST',None)
 for n in reversed(outer_owned):outer('rm','-f','-v',n)
 for tag in registry_tags:outer('image','rm',tag)
 outer('network','rm',outer_network)
 result['outer_cleanup_complete']=True
 (root/'result.json').write_text(json.dumps(result,indent=2,sort_keys=True));print(json.dumps(result,indent=2,sort_keys=True));log.close()
