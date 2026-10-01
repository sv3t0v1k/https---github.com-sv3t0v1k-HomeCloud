#!/usr/bin/env python3
"""Bounded logical offsite recovery drill. Same Docker daemon is NOT a physical offsite."""
import datetime as dt, hashlib, json, os, pathlib, secrets, shutil, subprocess, sys, tempfile, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
IMAGE=os.environ.get('DR_IMAGE','homecloud-backup-dr:checkpoint')
BASE=pathlib.Path(tempfile.mkdtemp(prefix='hc-independent-',dir='/private/tmp')); os.chmod(BASE,0o700)
PREFIX='hc-independent-'+str(os.getpid())+'-'+secrets.token_hex(3)
VOLUMES=[PREFIX+'-'+x for x in ('offsite','custody-a','custody-b')]
PROJECTS=[]; SENSITIVE=[]; report={'scope':'logical isolated Docker volumes; same physical host and Docker administrator','runs':[]}
ENV=os.environ.copy(); ENV['PATH']='/private/tmp/homecloud-backup-tools:'+ENV['PATH']
ENV.update(COMPOSE_ENV_FILES='/dev/null',COMPOSE_DISABLE_ENV_FILE='1')
def run(args,env=None,data=None,check=True):
 p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env or ENV)
 if check and p.returncode: raise RuntimeError('command failed: '+args[0]+' '+args[1]+'\n'+p.stderr.decode(errors='replace')[-2000:])
 return p
def docker(*args,**kw): return run(['docker',*args],**kw)
def compose(env,*args,**kw): return run(['docker','compose',*args],env=env,**kw)
def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def volume_store(vol,filename,data):
 docker('run','--rm','--user','root','-i','-v',vol+':/vault',IMAGE,'sh','-c','umask 077; cat > /vault/'+filename,data=data)
def volume_read(vol,filename):
 return docker('run','--rm','--user','root','-v',vol+':/vault:ro',IMAGE,'cat','/vault/'+filename).stdout
def configured(folder,project):
 folder.mkdir(mode=0o700); PROJECTS.append((folder,project))
 env=ENV.copy(); env.update(COMPOSE_FILE=str(folder/'compose.yml'),COMPOSE_PROJECT_NAME=project,DB_NAME='hc_dr_db',DB_USER='hc_dr_user',DB_PASSWORD=secrets.token_hex(32),JWT_SECRET=secrets.token_hex(32),JWT_REFRESH_SECRET=secrets.token_hex(32),REDIS_PASSWORD=secrets.token_hex(32),BACKEND_IMAGE=IMAGE,STORAGE_VOLUME=project+'_storage_data',BACKUP_PRODUCTION_DIR=str(folder/'backups'),BACKUP_OFFSITE_DIR=str(folder/'transport'),BACKUP_OFFSITE_CONFIRMED='1',BACKUP_WRITE_BARRIER_CONFIRMED='1',BACKUP_AGE_RECIPIENTS_FILE=str(folder/'recipient'),BACKUP_AGE_IDENTITY_FILE=str(folder/'identity'))
 SENSITIVE.extend(env[k].encode() for k in ('DB_PASSWORD','JWT_SECRET','JWT_REFRESH_SECRET','REDIS_PASSWORD'))
 (folder/'compose.yml').write_text(COMPOSE)
 (folder/'package.json').write_bytes((ROOT/'backend/package.json').read_bytes())
 (folder/'transport').mkdir(mode=0o700)
 return env
def config(env,folder):
 path=folder/'recovery.env'; keys=('DB_NAME','DB_USER','DB_PASSWORD','JWT_SECRET','JWT_REFRESH_SECRET','REDIS_PASSWORD','COMPOSE_FILE','COMPOSE_PROJECT_NAME','BACKEND_IMAGE','STORAGE_VOLUME','BACKUP_PRODUCTION_DIR','BACKUP_OFFSITE_DIR','BACKUP_OFFSITE_CONFIRMED','BACKUP_WRITE_BARRIER_CONFIRMED','BACKUP_AGE_RECIPIENTS_FILE','BACKUP_AGE_IDENTITY_FILE')
 path.write_text(''.join(k+'='+env[k]+'\n' for k in keys)); path.chmod(0o600); env['HOMECLOUD_ENV_FILE']=str(path)
def coordinator(env,folder,operation,*args,check=True):
 clean={'PATH':ENV['PATH'],'HOME':ENV.get('HOME','/private/tmp'),'HOMECLOUD_ENV_FILE':env['HOMECLOUD_ENV_FILE'],'HC_METRICS':str(folder/'metrics.jsonl')}
 p=run(['python3',str(BASE/'instrument.py'),str(ROOT/'scripts/backup-production.py'),operation,*args],env=clean,check=False)
 assert not any(secret in p.stdout+p.stderr for secret in SENSITIVE), 'secret leakage in coordinator logs'
 (folder/(operation+'-'+str(time.monotonic_ns())+'.log')).write_bytes(p.stdout+p.stderr)
 if check and p.returncode: raise RuntimeError('coordinator '+operation+' failed '+p.stdout.decode(errors='replace'))
 return p.returncode
def dbwait(env):
 for _ in range(40):
  if compose(env,'exec','-T','db','pg_isready','-U',env['DB_USER'],'-d',env['DB_NAME'],check=False).returncode==0:return
  time.sleep(.5)
 raise RuntimeError('db not ready')
def snapshot(env):
 rows=compose(env,'exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U',env['DB_USER'],'-d',env['DB_NAME'],'-tA',data=SNAPSHOT.encode()).stdout
 assert b'quota|t' in rows and b'upload-consistency|t' in rows
 files=docker('run','--rm','-v',env['STORAGE_VOLUME']+':/storage:ro',IMAGE,'sh','-c','cd /storage; find . -type f -not -path "./.tmp/*" -exec sha256sum {} \;').stdout
 return rows,sorted(files.decode().splitlines())
COMPOSE='services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_DB: ${DB_NAME}\n      POSTGRES_USER: ${DB_USER}\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n    volumes:\n      - db_data:/var/lib/postgresql/data\n  backend:\n    image: ${BACKEND_IMAGE}\n    environment:\n      NODE_ENV: production\n      FRONTEND_URL: https://dr.example.invalid\n      PORT: 3000\n      DB_PASSWORD: ${DB_PASSWORD}\n      REDIS_PASSWORD: ${REDIS_PASSWORD}\n      DATABASE_URL: postgres://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}\n      JWT_SECRET: ${JWT_SECRET}\n      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}\n      STORAGE_PATH: /storage\n    volumes:\n      - storage_data:/storage\nvolumes:\n  db_data:\n  storage_data:\n'
SNAPSHOT='SELECT \'users\',row_to_json(t) FROM (SELECT * FROM users ORDER BY id)t;\nSELECT \'folders\',row_to_json(t) FROM (SELECT * FROM folders ORDER BY id)t;\nSELECT \'files\',row_to_json(t) FROM (SELECT * FROM files ORDER BY id)t;\nSELECT \'shares\',row_to_json(t) FROM (SELECT * FROM share_links ORDER BY id)t;\nSELECT \'uploads\',row_to_json(t) FROM (SELECT * FROM upload_sessions ORDER BY id)t;\nSELECT \'upload-consistency\',bool_and("totalSize"="uploadedSize") FROM upload_sessions WHERE status=\'completed\';\nSELECT \'quota\',"storageUsed"=(SELECT SUM(size) FROM files WHERE "userId"=1 AND NOT "isFolder") FROM users WHERE id=1;\n'
INSTRUMENT=r'''import importlib.util, json, os, pathlib, subprocess, sys, time
spec=importlib.util.spec_from_file_location('hc_backup',sys.argv[1]);sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def emit(label,start,end):
 with open(os.environ['HC_METRICS'],'a') as f:f.write(json.dumps(dict(label=label,start=start,end=end,seconds=end-start))+'\n')
original=m.child
def child(args,env=None):
 start=time.monotonic()
 if args[0]=='bash' and args[1].endswith('/restore.sh'):
  p=subprocess.Popen(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); previous=None; boundary=start
  for raw in p.stdout:
   line=raw.decode(errors='replace');stamp=time.monotonic()
   markers={'[1/6]':'stop','[2/6]':'db_restore','[3/6]':'db_validation','[4/6]':'storage_restore','[5/6]':'app_start_migrations','[6/6]':'reconciliation','=== Post-Restore Health':'health'}
   for marker,label in markers.items():
    if marker in line:
     if previous:emit(previous,boundary,stamp)
     previous=label;boundary=stamp
   print(line,end='')
  if previous:emit(previous,boundary,time.monotonic())
  if p.wait():raise RuntimeError('restore child failed')
 else:original(args,env)
 emit('decrypt' if args[0]=='age' and '-d' in args else ('encrypt' if args[0]=='age' else ('legacy_restore' if args[1].endswith('/restore.sh') else 'legacy_backup')),start,time.monotonic())
m.child=child
publish=m.publish
def measured_publish(source,target,name):
 start=time.monotonic();publish(source,target,name);emit('helper_publication_'+('offsite_staging' if str(target)==os.environ['BACKUP_OFFSITE_DIR'] else 'local'),start,time.monotonic())
m.publish=measured_publish
sys.argv=sys.argv[1:]
try:m.main()
except Exception:m.event('backup_production_failed',stage=m.stage);sys.exit(1)
'''
try:
 (BASE/'instrument.py').write_text(INSTRUMENT)
 for vol in VOLUMES:docker('volume','create',vol)
 keyfolder=BASE/'key-generation';keyfolder.mkdir(mode=0o700)
 run(['age-keygen','-o',str(keyfolder/'identity')]);key=(keyfolder/'identity').read_bytes()
 SENSITIVE.extend(line for line in key.splitlines() if line.startswith(b'AGE-SECRET-KEY-'))
 recipient=run(['age-keygen','-y',str(keyfolder/'identity')]).stdout
 for v in VOLUMES[1:]:volume_store(v,'identity',key)
 shutil.rmtree(keyfolder); del key
 assert volume_read(VOLUMES[1],'identity')==volume_read(VOLUMES[2],'identity')
 docker('volume','rm',VOLUMES[1]);report['custody_copy_a_deleted']=True
 for iteration in range(2):
  source=BASE/('source-'+str(iteration));s=configured(source,PREFIX+'-source-'+str(iteration));(source/'recipient').write_bytes(recipient);(source/'recipient').chmod(0o600);config(s,source)
  assert not (source/'identity').exists()
  compose(s,'up','-d','db');dbwait(s);compose(s,'run','--rm','backend','npm','run','migration:run')
  sql="INSERT INTO users(id,email,password,name,\"storageQuota\",\"storageUsed\") SELECT n,'dr'||n||'@example.invalid','fixture','DR',268435456,67108864 FROM generate_series(1,2)n;\nINSERT INTO folders(id,name,\"userId\") VALUES(1,'root',1),(2,'root',2);\n"
  for n in range(1,9):
   user=1 if n<=4 else 2
   sql+=f"INSERT INTO files(id,name,\"storagePath\",size,\"mimeType\",\"userId\",\"isDeleted\",\"deletedAt\") VALUES({n},'file-{n}.bin','{user}/file-{n}.bin',16777216,'application/octet-stream',{user},{'true' if n==8 else 'false'},{'NOW()' if n==8 else 'NULL'});\n"
  sql+="INSERT INTO share_links(token,\"fileId\",\"userId\",\"maxDownloads\") VALUES('independent-token',1,1,5);\nINSERT INTO upload_sessions(\"uploadId\",filename,\"totalSize\",\"uploadedSize\",\"chunkSize\",\"totalChunks\",\"uploadedChunks\",\"tempPath\",status,\"userId\") VALUES('completed-dr','file-1.bin',16777216,16777216,16777216,1,'[0]','.tmp/completed-dr','completed',1);"
  compose(s,'exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U',s['DB_USER'],'-d',s['DB_NAME'],data=sql.encode())
  docker('run','--rm','--user','root','-v',s['STORAGE_VOLUME']+':/storage',IMAGE,'node','-e',"const fs=require('fs'),c=require('crypto');for(let n=1;n<=8;n++){let u=n<=4?1:2;fs.mkdirSync('/storage/'+u,{recursive:true});let fd=fs.openSync('/storage/'+u+'/file-'+n+'.bin','w');for(let j=0;j<16;j++)fs.writeSync(fd,c.randomBytes(1048576));fs.closeSync(fd);}fs.mkdirSync('/storage/.tmp');")
  expected=snapshot(s)
  for gate,args in [('backup-safety',['bash',str(ROOT/'scripts/tests/test-backup-safety.sh')]),('restore-safety',['bash',str(ROOT/'scripts/tests/test-restore-safety.sh'),'--skip-integration'])]:
   checked=run(args,env=s); assert not any(secret in checked.stdout+checked.stderr for secret in SENSITIVE); (BASE/(gate+'-'+str(iteration)+'.log')).write_bytes(checked.stdout+checked.stderr)
  point=now();pointmono=time.monotonic();start=time.monotonic();coordinator(s,source,'backup');backupseconds=time.monotonic()-start
  generation=next((source/'transport').glob('hc_*'));manifest=json.loads((generation/'manifest.json').read_text());artifact=(generation/'backup.age').read_bytes()
  start=time.monotonic();volume_store(VOLUMES[0],'backup.age',artifact);volume_store(VOLUMES[0],'manifest.json',(generation/'manifest.json').read_bytes());assert hashlib.sha256(volume_read(VOLUMES[0],'backup.age')).hexdigest()==manifest['sha256'];replicationseconds=time.monotonic()-start;offsite_completed=now(); offsite_completed_mono=time.monotonic(); escrow_inventory_sha256=manifest['sha256']
  source_metrics=[json.loads(x) for x in (source/'metrics.jsonl').read_text().splitlines()]
  # Unavailable offsite: no success accepted; production helper records failure.
  shutil.rmtree(source/'transport');assert coordinator(s,source,'backup',check=False)!=0
  incident=now();incidentmono=time.monotonic()
  compose(s,'down','-v','--remove-orphans');assert not docker('ps','-aq','--filter','label=com.docker.compose.project='+s['COMPOSE_PROJECT_NAME']).stdout.strip();assert not docker('volume','ls','-q','--filter','label=com.docker.compose.project='+s['COMPOSE_PROJECT_NAME']).stdout.strip()
  shutil.rmtree(source); assert not source.exists();assert hashlib.sha256(volume_read(VOLUMES[0],'backup.age')).hexdigest()==escrow_inventory_sha256
  replacement=BASE/('replacement-'+str(iteration));r=configured(replacement,PREFIX+'-replacement-'+str(iteration));config(r,replacement)
  compose(r,'up','-d','db');dbwait(r);docker('volume','create',r['STORAGE_VOLUME'])
  start=time.monotonic();g=replacement/'transport'/manifest['generation'];g.mkdir(mode=0o700);(g/'manifest.json').write_bytes(volume_read(VOLUMES[0],'manifest.json'));(g/'backup.age').write_bytes(volume_read(VOLUMES[0],'backup.age'));selectedmono=time.monotonic();selected_at=now();selectionseconds=selectedmono-start;assert hashlib.sha256((g/'backup.age').read_bytes()).hexdigest()==escrow_inventory_sha256
  # Failures must leave DB and storage intact before restore mutation.
  docker('run','--rm','--user','root','-v',r['STORAGE_VOLUME']+':/storage',IMAGE,'sh','-c','printf "pre-mutation-sentinel" > /storage/sentinel')
  def fingerprint():
   rows=compose(r,'exec','-T','db','psql','-U',r['DB_USER'],'-d',r['DB_NAME'],'-tAc',"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name").stdout
   storage=docker('run','--rm','-v',r['STORAGE_VOLUME']+':/storage:ro',IMAGE,'sh','-c','cd /storage; find . -type f -exec sha256sum {} \;').stdout
   return rows,storage
  baseline=fingerprint();failure_fingerprint=dict(db_inventory_sha256=hashlib.sha256(baseline[0]).hexdigest(),storage_inventory_sha256=hashlib.sha256(baseline[1]).hexdigest(),storage_inventory=baseline[1].decode());assert not baseline[0];assert b'./sentinel' in baseline[1]
  assert coordinator(r,replacement,'restore',g.name,'--yes',check=False)!=0;assert fingerprint()==baseline
  run(['age-keygen','-o',str(replacement/'identity')]);(replacement/'identity').chmod(0o600)
  SENSITIVE.extend(line for line in (replacement/'identity').read_bytes().splitlines() if line.startswith(b'AGE-SECRET-KEY-'))
  assert coordinator(r,replacement,'restore',g.name,'--yes',check=False)!=0;assert fingerprint()==baseline
  (replacement/'identity').write_bytes(volume_read(VOLUMES[2],'identity'));(replacement/'identity').chmod(0o600)
  good=(g/'backup.age').read_bytes();(g/'backup.age').write_bytes(b'corrupt');assert coordinator(r,replacement,'restore',g.name,'--yes',check=False)!=0;assert fingerprint()==baseline;(g/'backup.age').write_bytes(good);del good,artifact
  validationstart=time.monotonic();coordinator(r,replacement,'restore',g.name,'--validate-only');validationseconds=time.monotonic()-validationstart
  restorestart=time.monotonic();coordinator(r,replacement,'restore',g.name,'--yes');restoreseconds=time.monotonic()-restorestart
  readiness=compose(r,'exec','-T','backend','node','-e',"require('http').get('http://localhost:3000/api/v1/health/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(b);process.exit(r.statusCode===200?0:1)});}).on('error',()=>process.exit(1))").stdout.decode();readyseconds=time.monotonic()-incidentmono
  actual=snapshot(r);assert actual==expected;verifiedseconds=time.monotonic()-incidentmono
  metrics=[json.loads(x) for x in (replacement/'metrics.jsonl').read_text().splitlines()]
  result=dict(before_rows_sha256=hashlib.sha256(expected[0]).hexdigest(),after_rows_sha256=hashlib.sha256(actual[0]).hexdigest(),failed_restore_fingerprint=failure_fingerprint,source_containers_after_destruction=[],source_volumes_after_destruction=[],iteration=iteration+1,dataset_bytes=134217728,files=8,users=2,shares=1,trash=1,snapshot_time=point,artifact_selected_at=selected_at,last_success_age_seconds=incidentmono-offsite_completed_mono,offsite_completed=offsite_completed,incident_start=incident,backup_seconds=backupseconds,replication_seconds=replicationseconds,incident_to_artifact_selected_seconds=selectedmono-incidentmono,artifact_fetch_seconds=selectionseconds,validation_seconds=validationseconds,restore_seconds=restoreseconds,rto_readiness_seconds=readyseconds,rto_verified_seconds=verifiedseconds,rpo_snapshot_age_seconds=incidentmono-pointmono,escrow_inventory_sha256=escrow_inventory_sha256,secret_leakage_scan='PASS',legacy_backup_safety='PASS',legacy_restore_safety='PASS',failed_restore_db_storage_fingerprint_equal=True,source_destroyed=True,source_volumes_absent=True,source_private_key_absent=True,restored_from_custody_b=True,rows_equal=True,sha256_equal=True,readiness_http=200,missing_wrong_key_corrupt_blocked_before_mutation=True,offsite_unavailable_failed=True,manifest=manifest,metrics=metrics,backup_metrics=source_metrics,file_sha256=actual[1])
  report['runs'].append(result);compose(r,'down','-v','--remove-orphans');shutil.rmtree(replacement)
 report['verdict']='PASS'; report['all_custody_copies_lost']='unrecoverable; no alternate key path claimed';report['source_compromise_retention']='NOT_QUALIFIED: shared Docker administrator can erase escrow; source app has no vault mount or Docker socket'
finally:
 cleanup=[]
 for folder,project in PROJECTS:
  if folder.exists():
   env=ENV.copy();env.update(COMPOSE_FILE=str(folder/'compose.yml'),COMPOSE_PROJECT_NAME=project,DB_NAME='hc_dr_db',DB_USER='hc_dr_user',DB_PASSWORD='cleanup-placeholder',JWT_SECRET='cleanup-placeholder',JWT_REFRESH_SECRET='cleanup-placeholder',REDIS_PASSWORD='cleanup-placeholder',BACKEND_IMAGE=IMAGE)
   cleanup.append(compose(env,'down','-v','--remove-orphans',check=False).returncode==0)
 for vol in VOLUMES:docker('volume','rm',vol,check=False)
 report['cleanup']=all(cleanup)
 gate_logs=pathlib.Path(os.environ.get('DR_GATE_LOGS','/private/tmp/homecloud-offsite-gate-logs'));gate_logs.mkdir(exist_ok=True)
 for log in BASE.glob('*safety-*.log'):shutil.copy2(log,gate_logs/log.name)
 for log in BASE.glob('*.log'):
  assert not any(secret in log.read_bytes() for secret in SENSITIVE)
 output=pathlib.Path(os.environ.get('DR_EVIDENCE','/private/tmp/homecloud-independent-offsite-result.json'));output.write_text(json.dumps(report,indent=2)+'\n');shutil.rmtree(BASE)
 print('Evidence:',output)
