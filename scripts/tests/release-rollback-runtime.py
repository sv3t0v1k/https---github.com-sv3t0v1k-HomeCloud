#!/usr/bin/env python3
"""Disposable production-mode migration/same-artifact restart drill, no deployment .env."""
import base64, os, pathlib, socket, subprocess, tempfile, time, urllib.request, urllib.error, json, uuid, hashlib
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
repo=pathlib.Path(__file__).resolve().parents[2]; backend=repo/'backend'
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-release-drill-')).resolve(); storage=root/'storage'; storage.mkdir()
name='hc-release-drill-'+uuid.uuid4().hex[:12]; dbport=port(); appport=port(); proc=None; result={}
def docker(*a): return subprocess.check_output(['docker',*a],text=True,stderr=subprocess.STDOUT).strip()
def request(route,token=None,data=None,ctype='application/json'):
 headers={'Content-Type':ctype}
 if token: headers['Authorization']='Bearer '+token
 if isinstance(data,dict): data=json.dumps(data).encode()
 with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{appport}/api/v1/'+route,headers=headers,data=data),timeout=10) as r:return r.status,r.read()
def ready():
 for _ in range(100):
  try:
   if request('health/ready')[0]==200:return
  except (OSError,TimeoutError): pass
  time.sleep(.3)
 raise RuntimeError('readiness timeout')
def run(*a): subprocess.run(a,cwd=root,env=env,check=True,stdout=log,stderr=log)
def snap():return docker('exec',name,'psql','-U','postgres','-d','hc_release','-At','-c','SELECT row_to_json(t) FROM (SELECT id,email,"storageUsed" FROM users ORDER BY id)t; SELECT row_to_json(t) FROM (SELECT * FROM files ORDER BY id)t;')
try:
 docker('run','-d','--name',name,'-e','POSTGRES_PASSWORD=release-db-938475abcdef','-e','POSTGRES_DB=hc_release','-p',f'127.0.0.1:{dbport}:5432','postgres:16-alpine')
 for _ in range(100):
  try: docker('exec',name,'pg_isready','-U','postgres','-d','hc_release'); break
  except subprocess.CalledProcessError:time.sleep(.3)
 env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','USER'] if k in os.environ}
 env.update(NODE_ENV='production',PORT=str(appport),DATABASE_URL=f'postgres://postgres:release-db-938475abcdef@127.0.0.1:{dbport}/hc_release',DB_PASSWORD='release-db-938475abcdef',JWT_SECRET='release-access-938475abcdefghijklmnopqrstuvwxyz',JWT_REFRESH_SECRET='release-refresh-938475abcdefghijklmnopqrstuvwxyz',STORAGE_PATH=str(storage),FRONTEND_URL='https://release.example.invalid',METRICS_TOKEN='release-metrics-938475abcdefghijklmnopqrstuvwxyz')
 with open(root/'runtime.log','w') as log:
  cli=str(backend/'node_modules/typeorm/cli.js'); ds=str(backend/'dist/data-source.js')
  probe='const {Client}=require('+json.dumps(str(backend/'node_modules/pg'))+');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("SELECT 1")).then(()=>c.end()).catch(()=>process.exit(1))'
  for _ in range(100):
   if subprocess.run(['node','-e',probe],cwd=root,env=env,stdout=log,stderr=log).returncode==0:break
   time.sleep(.3)
  else:raise RuntimeError('database TCP readiness timeout')
  run('node',cli,'migration:show','-d',ds);run('node',cli,'migration:run','-d',ds,'--transaction','all')
  run('node',str(repo/'scripts/release-gate.cjs'),'migrations');result['migrations_no_pending']=True
  proc=subprocess.Popen(['node',str(backend/'dist/main.js')],cwd=root,env=env,stdout=log,stderr=log);ready()
  code,b=request('auth/register',data={'email':'release@example.invalid','password':'ReleasePassword938475!','name':'Release'});assert code==201
  docker('exec',name,'psql','-U','postgres','-d','hc_release','-c',"UPDATE users SET \"storageQuota\"=1048576 WHERE email='release@example.invalid'")
  result['fixture_quota_provisioned']=1048576
  token=json.loads(b)['data']['accessToken'];payload=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
  _,b=request('uploads/session',token,{'filename':'release.png','totalSize':len(payload),'chunkSize':len(payload)})
  upload=json.loads(b)['data']['uploadId']; boundary='hc'+uuid.uuid4().hex
  body=(f'--{boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--{boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.txt"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+payload+f'\r\n--{boundary}--\r\n'.encode())
  assert request(f'uploads/session/{upload}/chunk',token,body,'multipart/form-data; boundary='+boundary)[0]==200
  _,b=request(f'uploads/session/{upload}/complete',token,{})
  fid=json.loads(b)['data']['id']; assert request(f'files/{fid}/download',token)[1]==payload
  before=snap();result['auth_upload_download']=True
  proc.terminate();proc.wait(timeout=15);proc=None
  bad=subprocess.run(['node','-e','process.exit(42)'],cwd=root,env=env,stdout=log,stderr=log);assert bad.returncode==42
  try: request('health/ready');raise AssertionError('bad release served traffic')
  except OSError:pass
  result['controlled_bad_release']=True
  proc=subprocess.Popen(['node',str(backend/'dist/main.js')],cwd=root,env=env,stdout=log,stderr=log);ready()
  assert snap()==before;assert request(f'files/{fid}/download',token)[1]==payload
  env['RELEASE_BASE_URL']=f'http://127.0.0.1:{appport}';run('node',str(repo/'scripts/release-gate.cjs'),'runtime')
  result.update(readiness_recovered=True,data_unchanged=True,same_artifact_redeploy=True,payload_sha256=hashlib.sha256(payload).hexdigest(),limitation='Same compiled artifact restart; no previous-version compatibility, frontend or schema rollback proof.')
finally:
 if proc:proc.terminate();proc.wait(timeout=15)
 docker('rm','-f','-v',name)
 result['cleanup_container_removed']=name not in docker('ps','-a','--format','{{.Names}}').splitlines()
 (root/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps({'evidence':str(root),'result':result},indent=2))
