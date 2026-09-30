import base64, hmac, hashlib
import os, tempfile, pathlib, socket, subprocess, time, urllib.request, urllib.error, json, uuid, shutil
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
repo=str(pathlib.Path(__file__).resolve().parents[2]/'backend')
def port():
 s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();return p
root=pathlib.Path(tempfile.mkdtemp(prefix='hc-failure-security-',dir=tempfile.gettempdir())).resolve(); storage=root/'storage';storage.mkdir()
name='hc-failure-security-'+uuid.uuid4().hex[:12]; dbport=port(); appport=port(); proc=None; result={}; logs=root/'runtime.log'; at=bt=refresh=expired='';rotated=(0,{'data':{'refreshToken':''}})
def docker(*args):
 return subprocess.check_output(['docker',*args],stderr=subprocess.STDOUT,text=True).strip()
def req(path, headers=None, data=None):
 r=urllib.request.Request('http://127.0.0.1:'+str(appport)+'/api/v1/'+path,headers=headers or {},data=data)
 try:
  with urllib.request.urlopen(r,timeout=8) as resp:return resp.status,{k.lower():v for k,v in resp.headers.items()},resp.read().decode()
 except urllib.error.HTTPError as e:return e.code,{k.lower():v for k,v in e.headers.items()},e.read().decode()
def api(path, token=None, body=None, method=None, rid=None):
 headers={'Content-Type':'application/json'}
 if token: headers['Authorization']='Bearer '+token
 if rid: headers['X-Request-Id']=rid
 r=urllib.request.Request('http://127.0.0.1:'+str(appport)+'/api/v1/'+path,headers=headers,data=json.dumps(body).encode() if body is not None else None,method=method)
 try:
  with urllib.request.urlopen(r,timeout=10) as z: return z.status,json.loads(z.read())
 except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
def snap():
 return docker('exec',name,'psql','-U','postgres','-d','hc_smoke','-At','-c',"SELECT json_build_object('users',(SELECT json_agg(row_to_json(u) ORDER BY id) FROM users u),'files',(SELECT json_agg(row_to_json(f) ORDER BY id) FROM files f),'folders',(SELECT json_agg(row_to_json(f) ORDER BY id) FROM folders f),'uploads',(SELECT json_agg(row_to_json(u) ORDER BY id) FROM upload_sessions u));")
def eventually(path,status):
 for _ in range(100):
  try:
   r=req(path)
   if r[0]==status:return r
  except (OSError,TimeoutError):pass
  time.sleep(.3)
 raise RuntimeError('endpoint timeout '+path)
try:
 docker('run','-d','--name',name,'-e','POSTGRES_PASSWORD=smoke-db-secret-938475','-e','POSTGRES_DB=hc_smoke','-p',f'127.0.0.1:{dbport}:5432','postgres:16-alpine')
 for _ in range(100):
  try:
   docker('exec',name,'pg_isready','-U','postgres','-d','hc_smoke');break
  except subprocess.CalledProcessError:time.sleep(.3)
 env={**{key:os.environ[key] for key in ['PATH','HOME','TMPDIR','USER','SystemRoot'] if key in os.environ},'NODE_ENV':'test','PORT':str(appport),'DATABASE_URL':f'postgres://postgres:smoke-db-secret-938475@127.0.0.1:{dbport}/hc_smoke','DB_PASSWORD':'smoke-db-secret-938475','REDIS_PASSWORD':'smoke-unused-redis-938475','JWT_SECRET':'smoke-access-secret-938475abcdefghijk','JWT_REFRESH_SECRET':'smoke-refresh-secret-938475abcdefghijk','STORAGE_PATH':str(storage),'METRICS_TOKEN':'smoke-metrics-secret-938475','FRONTEND_URL':'http://localhost:5173'}
 with open(logs,'w') as log:
  proc=subprocess.Popen(['node',str(pathlib.Path(repo)/'dist/main.js')],cwd=root,env=env,stdout=log,stderr=log)
  live=eventually('health',200);ready=eventually('health/ready',200)
  (root/'active.json').write_text(json.dumps({'name':name,'dbport':dbport,'appport':appport}))
  print('ACTIVE '+str(root),flush=True)
  a=api('auth/register',body={'email':'a@failure.test','password':'FailurePassword938475!','name':'A'});assert a[0]==201,a
  b=api('auth/register',body={'email':'b@failure.test','password':'FailurePassword938475!','name':'B'});assert b[0]==201,b
  at=a[1]['data']['accessToken'];bt=b[1]['data']['accessToken'];refresh=a[1]['data']['refreshToken']
  f=api('files/folders',at,{'name':'private-folder'});assert f[0]==201,f
  fid=f[1]['data']['id']
  result['idor']={'folder_detail':api('files/folders/'+str(fid),bt,rid='fs-idor-folder')[0], 'folder_rename':api('files/folders/'+str(fid),bt,{'name':'stolen'},'PATCH')[0], 'upload_foreign_parent':api('uploads/session',bt,{'filename':'bad.txt','totalSize':4,'chunkSize':4,'parentId':fid})[0]}
  assert result['idor']=={'folder_detail':404,'folder_rename':404,'upload_foreign_parent':403},result['idor']
  result['invalid_share']=api('sharing/public/fs-invalid-token',rid='fs-share-invalid')[0];assert result['invalid_share']==404
  rotated=api('auth/refresh',body={'refreshToken':refresh});assert rotated[0]==200,rotated
  result['refresh_reuse']=api('auth/refresh',body={'refreshToken':refresh},rid='fs-refresh-reuse')[0];assert result['refresh_reuse']==401
  result['revoked_descendant']=api('auth/refresh',body={'refreshToken':rotated[1]['data']['refreshToken']})[0];assert result['revoked_descendant']==401
  result['malformed_authorization']=req('files',{'Authorization':'Bearer malformed-fs-sensitive-marker'})[0];assert result['malformed_authorization']==403
  user_id=json.loads(base64.urlsafe_b64decode(at.split('.')[1]+'=='))['sub']
  def enc(value):return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')
  unsigned=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'sub':user_id,'email':'a@failure.test','exp':int(time.time())-60})
  expired=unsigned+'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),unsigned.encode(),hashlib.sha256).digest()).decode().rstrip('=')
  result['expired_access_mutation']=api('files/folders',expired,{'name':'expired-must-not-commit'},rid='fs-expired-mutation')[0];assert result['expired_access_mutation']==403
  before=snap()
  result['healthy']={'live':live[0],'ready':ready[0],'body':json.loads(ready[2])}
  known=req('health',{'X-Request-ID':'smoke-request-001'});unsafe=req('health',{'X-Request-ID':'unsafe value !'})
  result['request_ids']={'generated':live[1].get('X-Request-ID') or live[1].get('x-request-id'),'accepted':known[1].get('X-Request-ID') or known[1].get('x-request-id'),'unsafe':unsafe[1].get('X-Request-ID') or unsafe[1].get('x-request-id')}
  req('auth/login',{'Content-Type':'application/json','Authorization':'Bearer smoke-sensitive-auth-938475'},json.dumps({'email':'invalid','password':'smoke-sensitive-password-938475'}).encode())
  req('sharing/public/smoke-sensitive-share-938475?token=smoke-sensitive-query-938475')
  unauth=req('metrics');auth=req('metrics',{'Authorization':'Bearer smoke-metrics-secret-938475'})
  result['metrics']={'unauthorized':unauth[0],'authorized':auth[0],'content_type':auth[1].get('content-type'),'lines':auth[2].splitlines()[:20]}
  docker('stop','-t','0',name); down=eventually('health/ready',503)
  result['database_down']={'live':req('health')[0],'ready':down[0],'body':json.loads(down[2])}
  result['database_failed_mutation']=api('files/folders',bt,{'name':'must-not-commit'},rid='fs-db-mutation')[0];assert result['database_failed_mutation']==500
  docker('start',name);recovered=eventually('health/ready',200);result['database_recovered']=recovered[0]
  result['database_state_unchanged']=snap()==before;assert result['database_state_unchanged']
  assert api('files/folders/'+str(fid),at)[0]==200
  moved=root/'storage-offline';storage.rename(moved);storage.write_text('offline fixture')
  try:
   bad=eventually('health/ready',503);result['storage_down']={'live':req('health')[0],'ready':bad[0],'body':json.loads(bad[2])}
   result['storage_failed_upload']=api('uploads/session',bt,{'filename':'unwritable.txt','totalSize':4,'chunkSize':4},rid='fs-storage-upload')[0];assert result['storage_failed_upload']==400
   result['storage_state_unchanged']=snap()==before;assert result['storage_state_unchanged']
  finally:
   if storage.exists():
    storage.unlink()
   moved.rename(storage)
  result['storage_recovered']=eventually('health/ready',200)[0]
  assert api('uploads/session',bt,{'filename':'recovered.txt','totalSize':4,'chunkSize':4},rid='fs-storage-recovered')[0]==201
  attempts=[api('sharing/public/fs-rate-invalid/verify',body={'password':'fs-rate-password-marker'})[0] for _ in range(11)]
  result['share_attempt_rate']={'allowed':attempts[:10],'blocked':attempts[10]};assert attempts==[404]*10+[429]
  auth_attempts=[api('auth/login',body={'email':'nobody@failure.test','password':'fs-rate-password-marker'})[0] for _ in range(6)]
  result['auth_rate_blocked']=429 in auth_attempts;assert result['auth_rate_blocked']
  print('Waiting for actual rate-limit window reset',flush=True)
  time.sleep(61)
  result['share_rate_reset']=api('sharing/public/fs-rate-invalid/verify',body={'password':'fs-rate-password-marker'},rid='fs-rate-reset')[0];assert result['share_rate_reset']==404
  result['auth_rate_reset']=api('auth/login',body={'email':'nobody@failure.test','password':'fs-rate-password-marker'})[0];assert result['auth_rate_reset']==401
  metrics=req('metrics' ,{'Authorization':'Bearer smoke-metrics-secret-938475'})[2]
  result['failure_metrics_present']='status_class="5xx"' in metrics;assert result['failure_metrics_present']
  (root/'metrics.txt').write_text(metrics)
  time.sleep(.3)
finally:
 if proc:
  proc.terminate()
  try:proc.wait(timeout=5)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 try:docker('rm','-f',name)
 except subprocess.CalledProcessError:pass
 raw=logs.read_text() if logs.exists() else ''
 sensitive=[at,bt,refresh,rotated[1]['data']['refreshToken'],expired,str(storage),'smoke-sensitive-auth-938475','smoke-sensitive-password-938475','smoke-sensitive-share-938475','smoke-sensitive-query-938475','smoke-metrics-secret-938475','smoke-db-secret-938475','smoke-access-secret-938475abcdefghijk','FailurePassword938475!','malformed-fs-sensitive-marker','fs-rate-password-marker']
 result['privacy']={'leaked_markers':[f'marker_{i}' for i,x in enumerate(sensitive) if x and x in raw]}
 parsed=[];nonjson=0
 for line in raw.splitlines():
  try:parsed.append(json.loads(line))
  except ValueError:nonjson+=1
 result['logs']={'json_lines':len(parsed),'non_json_lines':nonjson,'completion_samples':[x for x in parsed if 'durationMs' in x][:4]}
 result['cleanup_container_removed']=name not in docker('ps','-a','--format','{{.Names}}').splitlines()
 result['assertions_pass']=(result.get('idor')=={'folder_detail':404,'folder_rename':404,'upload_foreign_parent':403} and result.get('invalid_share')==404 and result.get('refresh_reuse')==401 and result.get('revoked_descendant')==401 and result.get('malformed_authorization')==403 and result.get('database_failed_mutation')==500 and result.get('database_state_unchanged') is True and result.get('storage_state_unchanged') is True and result.get('storage_failed_upload')==400 and result.get('failure_metrics_present') is True and result.get('expired_access_mutation')==403 and result.get('healthy',{}).get('ready')==200 and result.get('request_ids',{}).get('accepted')=='smoke-request-001' and result.get('request_ids',{}).get('generated') is not None and result.get('request_ids',{}).get('unsafe')!='unsafe value !' and result.get('metrics',{}).get('unauthorized')==401 and result.get('metrics',{}).get('authorized')==200 and result.get('database_down',{}).get('ready')==503 and result.get('database_down',{}).get('live')==200 and result.get('share_rate_reset')==404 and result.get('auth_rate_reset')==401 and result.get('auth_rate_blocked') is True and result.get('share_attempt_rate',{}).get('blocked')==429 and result.get('storage_down',{}).get('live')==200 and result.get('storage_down',{}).get('ready')==503 and result.get('storage_recovered')==200 and result.get('database_recovered')==200 and not result['privacy']['leaked_markers'] and nonjson==0 and result['cleanup_container_removed'])
 result['artifacts']=str(root)
 (root/'result.json').write_text(json.dumps(result,indent=2))
 print(json.dumps(result,indent=2))

if not result['assertions_pass']: raise SystemExit(1)
