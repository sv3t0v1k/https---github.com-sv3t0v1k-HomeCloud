#!/usr/bin/env python3
"""Opt-in REAL D1 runtime fixtures; never uses a checkout .env or live stack.

Root invocation supplies an already built, uniquely named backend image. Every
mutation is confined to random hc-d1-* projects, fresh labeled resources and a
/private/tmp directory. No image pulls, ports, prune, or pre-existing data writes.
Logs/evidence are saved before finally-cleanup; cleanup residue is a failure.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

SCRIPTS = Path(__file__).resolve().parents[1]
OWNER = 'homecloud.d1.fixture'
PAYLOAD = b'd1 fixture original bytes\n'
SSD_ID = '99ca4521-b94d-4d54-94a8-7c207af52202'
UPLOAD_ID = '11111111-2222-4333-8444-555555555555'
PENDING = '''INSERT INTO upload_sessions
("uploadId",filename,"totalSize","chunkSize","totalChunks","tempPath","userId","workspaceId","expectedSha256")
VALUES ('%s','pending-ssd',1,1,1,'/ssd-fixture/%s',1,'%s','%s');''' % (UPLOAD_ID, UPLOAD_ID, SSD_ID, '0'*64)

# Executed only by recovery CLIs, delegates to the actual Docker executable.
# Scope validation occurs BEFORE fault injection and BEFORE delegation.
WRAPPER = r'''#!__PYTHON__
import json, os, pathlib, subprocess, sys
cfg=json.loads(pathlib.Path(os.environ['D1_WRAPPER_CONFIG']).read_text())
args=sys.argv[1:]
real=cfg['docker']; project=cfg['project']; root=pathlib.Path(cfg['root'])
def reject():
    print('D1 FIXTURE: Docker operation rejected outside owned scope',file=sys.stderr); sys.exit(97)
def actual(a):
    p=subprocess.run([real,*a],capture_output=True,text=True)
    if p.returncode: reject()
    return p.stdout.strip()
def owned(ref):
    if ref.startswith('homecloud-restore-validation-'):
        try: return actual(['inspect','-f','{{ index .Config.Labels "homecloud.d1.fixture" }}',ref]) == project
        except: return False
    return actual(['inspect','-f','{{ index .Config.Labels "com.docker.compose.project" }}',ref]) == project
def value(flag):
    return args[args.index(flag)+1] if flag in args else None
if not args: reject()
command=args[0]
data=None
if command=='compose':
    if os.environ.get('COMPOSE_PROJECT_NAME')!=project or os.environ.get('COMPOSE_FILE')!=cfg['manifest']: reject()
    if '--env-file' not in args or value('--env-file')!='/dev/null': reject()
    if any(a in args for a in ('--project-name','-p','--file','-f')): reject()
    if 'exec' in args and 'psql' in args and not any(a in args for a in ('-c','-tAc')):
        data=sys.stdin.buffer.read()
elif command=='volume':
    if args[1:2]!=['inspect'] or args[-1]!=cfg['volume']: reject()
elif command=='image':
    if args[1:2]!=['inspect'] or args[-1] not in cfg['images']: reject()
elif command=='inspect':
    if not owned(args[-1]): reject()
elif command in ('exec','start','rm'):
    ref=next((a for a in args[1:] if not a.startswith('-')),None)
    if not ref or not owned(ref): reject()
elif command=='create':
    name=value('--name')
    if not name or not name.startswith('homecloud-restore-validation-') or value('--network')!='none' or not '--tmpfs' in args: reject()
    args[1:1]=['--label','homecloud.d1.fixture='+project]
elif command=='run':
    if '--volumes-from' in args:
        if not owned(value('--volumes-from').split(':')[0]): reject()
    elif '--mount' in args:
        spec=value('--mount'); fields=dict(p.split('=',1) for p in spec.split(',') if '=' in p)
        if fields.get('type')!='bind' or not pathlib.Path(fields.get('src',fields.get('source',''))).is_relative_to(root): reject()
    elif '-v' in args:
        if value('-v').split(':')[0]!=cfg['volume']: reject()
        label=actual(['volume','inspect','-f','{{ index .Labels "homecloud.d1.fixture" }}',cfg['volume']])
        if label!=project: reject()
    else:
        net=value('--network')
        if net!='none' and not (net and net.startswith('container:') and owned(net[10:])): reject()
        if not '--tmpfs' in args: reject()
    args[1:1]=['--label','homecloud.d1.fixture='+project,'--pull=never']
else: reject()
redacted=[('<redacted-password>' if 'PASSWORD=' in a or 'DATABASE_URL=' in a else a) for a in args]
with open(cfg['trace'],'a') as f: f.write(json.dumps(redacted)+'\n')
fault=os.environ.get('D1_INJECT','')
marker=pathlib.Path(os.environ.get('D1_FAULT_MARKER',cfg['root']+'/unused'))
phase=None
if command=='compose' and data and b'CREATE TABLE' in data and 'exec' in args and 'db' in args: phase='import'
if command=='run' and '-i' in args and '--entrypoint' in args and ('--volumes-from' in args or '--mount' in args): phase='storage'
if command=='compose' and 'migration:run' in args: phase='migration'
if command=='run' and any('find "$1"' in a for a in args): phase='reconcile'
if command=='compose' and 'exec' in args and 'backend' in args and 'node' in args and '-' in args: phase='health'
if fault==phase and not marker.exists():
    marker.write_text(phase)
    print('D1 FIXTURE: injected '+phase+' failure',file=sys.stderr)
    if phase=='health': print('{"status":"injected-failure"}'); sys.exit(0)
    sys.exit(71)
if data is not None:
    sys.exit(subprocess.run([real,*args],input=data).returncode)
os.execv(real,[real,*args])
'''

class FixtureError(RuntimeError): pass

def require(condition, detail):
    if not condition: raise FixtureError(detail)

def sha(data): return hashlib.sha256(data).hexdigest()

class Harness:
    def __init__(self,args):
        self.args=args; self.real=shutil.which('docker')
        require(self.real is not None,'Docker executable unavailable')
        self.evidence=Path(args.evidence); require(self.evidence.is_absolute(),'evidence path must be absolute')
        self.evidence.parent.mkdir(parents=True,exist_ok=True)
        self.logdir=self.evidence.parent/(self.evidence.stem+'-logs'); self.logdir.mkdir(exist_ok=True)
        self.report={'cases':[],'fixtures':[],'isolation':{},'limitations':['Fixture backend uses a readiness HTTP sentinel; actual compiled migrations, backup/restore/reconcile and PostgreSQL run.','Bind inode verification is client-side; this fixture does not establish remote Docker bind identity guarantees.']}
        self.projects=set(); self.counter=0
        self.source_paths=['backup.sh','restore.sh','reconcile.py','recovery_storage.py','recovery-storage.sh','recovery-pending.sql']
        self.report['source_sha256']={name:sha((SCRIPTS/name).read_bytes()) for name in self.source_paths}
    def docker(self,args,check=True,input=None):
        p=subprocess.run([self.real,*args],input=input,capture_output=True,timeout=120)
        if check and p.returncode: raise FixtureError('Docker fixture command failed: '+args[0]+' '+p.stderr.decode(errors='replace')[-1000:])
        return p
    def inspect(self,kind,ref,format):
        return self.docker([*kind,'inspect','-f',format,ref]).stdout.decode().strip()
    def snapshot(self):
        result={}
        specs=[('containers',['ps','-aq'],[], '{{json .Id}} {{json .Name}} {{json .State.Status}} {{json .State.Running}} {{json .State.StartedAt}} {{json .State.FinishedAt}} {{json .RestartCount}} {{json .Mounts}} {{json .NetworkSettings.Networks}}'),('volumes',['volume','ls','-q'],['volume'],'{{json .Name}} {{json .Driver}} {{json .Mountpoint}} {{json (index .Labels "com.docker.compose.project")}}'),('networks',['network','ls','-q'],['network'],'{{json .Id}} {{json .Name}} {{json .Internal}} {{json (index .Labels "com.docker.compose.project")}} {{json .Containers}}')]
        for key,listing,kind,fmt in specs:
            result[key]={}
            for ref in self.docker(listing).stdout.decode().splitlines():
                raw=self.inspect(kind,ref,fmt)
                # Docker inspect mount/alias arrays are unordered API records.
                decoder=json.JSONDecoder(); values=[]; remaining=raw
                while remaining.strip():
                    value,end=decoder.raw_decode(remaining.lstrip())
                    values.append(value);remaining=remaining.lstrip()[end:]
                def canonical(value):
                    if isinstance(value,dict): return {k:canonical(v) for k,v in sorted(value.items())}
                    if isinstance(value,list): return sorted((canonical(v) for v in value),key=lambda v:json.dumps(v,sort_keys=True))
                    return value
                result[key][ref]=json.dumps([canonical(v) for v in values],sort_keys=True,separators=(',',':'))
        return result
    def save(self):
        self.evidence.write_text(json.dumps(self.report,ensure_ascii=False,indent=2)+'\n')
    def case(self,name,detail):
        self.report['cases'].append({'name':name,'status':'passed',**detail}); self.save()
    def script(self,fixture,script,backup=None,baseline=False,fault=None):
        self.counter+=1; title='%02d-%s-%s'%(self.counter,fixture.variant,script.replace('.sh',''))
        scriptdir=Path(self.args.baseline_root)/'scripts' if baseline else SCRIPTS
        env=fixture.environment(backup)
        if baseline: env['STORAGE_VOLUME']=fixture.volume
        if fault:
            env['D1_INJECT']=fault; env['D1_FAULT_MARKER']=str(fixture.root/('fault-'+fault))
            Path(env['D1_FAULT_MARKER']).unlink(missing_ok=True)
        p=subprocess.run(['bash',str(scriptdir/script),'--yes'],cwd=fixture.root,env=env,capture_output=True,text=True,timeout=240)
        log=self.logdir/(title+('-'+fault if fault else '')+('-baseline' if baseline else '')+'.log')
        log.write_text((p.stdout+'\n'+p.stderr).replace(fixture.password,'<fixture-password>'))
        return p, str(log)

class Fixture:
    def __init__(self,harness,variant):
        self.h=harness; self.variant=variant
        self.target='/data/storage' if variant=='custom-root' else '/storage'
        self.project='hc-d1-'+variant+'-'+secrets.token_hex(6)
        self.root=Path(tempfile.mkdtemp(prefix=self.project+'-',dir='/private/tmp')).resolve()
        self.volume='hc-d1-external-'+secrets.token_hex(8) if variant!='bind' else ''
        self.password=secrets.token_hex(20); self.backups=self.root/'backups'; self.backups.mkdir()
        self.manifest=self.root/'compose.json'; self.config=self.root/'recovery.env'; self.trace=self.root/'docker-trace.jsonl'
        self.h.projects.add(self.project)
        self.record={'project':self.project,'variant':variant,'storage_target':self.target,'ports':[],'db_storage':'tmpfs','storage_volume':self.volume,'temporary_root':str(self.root),'cleanup':'pending'}
        self.h.report['fixtures'].append(self.record); self.h.save()
    def environment(self,backup=None):
        env={key:os.environ[key] for key in ('PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH') if key in os.environ}
        env.update(HOMECLOUD_ENV_FILE=str(self.config),COMPOSE_FILE=str(self.manifest),COMPOSE_PROJECT_NAME=self.project,DB_NAME='d1_fixture',DB_USER='d1_fixture',DB_PASSWORD=self.password,BACKUP_DIR=str(backup or self.backups),BACKEND_IMAGE=self.h.args.image,STORAGE_PATH=self.target,D1_WRAPPER_CONFIG=str(self.root/'wrapper.json'))
        env['PATH']=str(self.root/'bin')+':'+env.get('PATH','')
        return env
    def compose(self,args,check=True,input=None):
        env=self.environment(); env['PATH']=os.environ['PATH']
        p=subprocess.run([self.h.real,'compose','--env-file','/dev/null',*args],env=env,cwd=self.root,input=input,capture_output=True,timeout=120)
        if check and p.returncode: raise FixtureError('Owned Compose command failed: '+args[0]+' '+p.stderr.decode(errors='replace')[-1000:])
        return p
    def sql(self,sql):
        sql=sql.replace('/storage/',self.target+'/')
        return self.compose(['exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','d1_fixture','-d','d1_fixture','-tAc',sql]).stdout.decode().strip()
    def cid(self,service='backend'):
        value=self.compose(['ps','--all','-q',service]).stdout.decode().strip()
        require(bool(re.fullmatch('[a-f0-9]{64}',value)),'fixture container identity is missing')
        return value
    def storage(self,command):
        command=[arg.replace('/storage',self.target) for arg in command]
        cid=self.cid()
        require(self.h.inspect([],cid,'{{ index .Config.Labels "com.docker.compose.project" }}')==self.project,'storage helper owner mismatch')
        return self.h.docker(['run','--rm','--pull=never','--label',OWNER+'='+self.project,'--volumes-from',cid+':ro',self.h.args.image,*command]).stdout
    def running(self):
        return self.h.inspect([],self.cid(),'{{.State.Running}}')=='true'
    def count(self):
        return int(self.storage(['sh','-c','wc -l < /storage/.tmp/writer-starts.log']).strip())
    def state(self):
        return {'users':self.sql('SELECT id,email,name FROM users ORDER BY id'),'files':self.sql('SELECT id,name,size,"storagePath" FROM files ORDER BY id'),'pending':self.sql("SELECT count(*) FROM upload_sessions WHERE status IN ('pending','uploading')"),'bytes_sha256':sha(self.storage(['cat','/storage/fixture/object'])),'backend_running':self.running(),'writer_starts':self.count()}
    def mutate(self):
        self.sql("UPDATE users SET name='target mutation' WHERE id=1")
        self.compose(['exec','-T','backend','sh','-c',"printf 'mutated target bytes\\n' > /storage/fixture/object".replace('/storage',self.target)])
    def setup(self):
        image=self.h.args.image; pg=self.h.args.postgres_image
        require(re.fullmatch(r'hc-d1-runtime[a-zA-Z0-9_.:-]*',image),'backend image must be a uniquely tagged hc-d1-runtime fixture image')
        image_id=self.h.inspect(['image'],image,'{{.Id}}'); pg_id=self.h.inspect(['image'],pg,'{{.Id}}')
        image_volumes=json.loads(self.h.inspect(['image'],image,'{{json .Config.Volumes}}') or 'null') or {}
        require(set(image_volumes).issubset({'/storage'}),'backend fixture image has unisolated VOLUME declarations')
        if self.volume:
            self.h.docker(['volume','create','--label',OWNER+'='+self.project,self.volume])
            mount={'type':'volume','source':'storage_data','target':self.target}
        else:
            bind=self.root/'storage'; bind.mkdir(); mount={'type':'bind','source':str(bind),'target':self.target,'bind':{'create_host_path':False}}
        program="process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));const fs=require('fs'),http=require('http');fs.mkdirSync('/storage/.tmp',{recursive:true});fs.appendFileSync('/storage/.tmp/writer-starts.log','start\\n');http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ready',checks:{database:'ok',storage:'ok'}}));}).listen(3000,'0.0.0.0');"
        # The fixture matches the application's service uid. Explicit storage
        # already exists and is owned by this random fixture before setup writes.
        if self.volume:
            require(self.h.inspect(['volume'],self.volume,'{{ index .Labels "'+OWNER+'" }}')==self.project,'fresh volume ownership mismatch')
            setup_mount=['--mount','type=volume,src='+self.volume+',dst=/fixture-storage']
        else:
            require((self.root/'storage').resolve().is_relative_to(self.root),'fresh bind ownership mismatch')
            setup_mount=['--mount','type=bind,src='+str(self.root/'storage')+',dst=/fixture-storage']
        self.h.docker(['run','--rm','--pull=never','--network','none','--label',OWNER+'='+self.project,'--user','root',*setup_mount,image,'sh','-c','chmod 755 /fixture-storage; chown 1001:1001 /fixture-storage'])
        program=program.replace('/storage',self.target)
        manifest={'name':self.project,'services':{'db':{'image':pg,'environment':{'POSTGRES_USER':'d1_fixture','POSTGRES_DB':'d1_fixture','POSTGRES_PASSWORD':self.password},'tmpfs':['/var/lib/postgresql/data:rw,size=1073741824'],'networks':['fixture'],'labels':{OWNER:self.project}},'backend':{'image':image,'user':'1001:1001','command':['node','-e',program],'environment':{'DATABASE_URL':'postgresql://d1_fixture:'+self.password+'@db:5432/d1_fixture','STORAGE_PATH':self.target,'UPLOAD_SSD_PATH':'/ssd-fixture'},'volumes':[mount],'networks':['fixture'],'labels':{OWNER:self.project}},'frontend':{'image':image,'user':'root','command':['node','-e',"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],'networks':['fixture'],'labels':{OWNER:self.project}}},'networks':{'fixture':{'name':self.project+'-internal','internal':True,'labels':{OWNER:self.project}}}}
        if self.volume: manifest['volumes']={'storage_data':{'external':True,'name':self.volume}}
        self.manifest.write_text(json.dumps(manifest)); self.manifest.chmod(0o600)
        self.config.write_text(''.join(k+'='+v+'\n' for k,v in {'DB_NAME':'d1_fixture','DB_USER':'d1_fixture','DB_PASSWORD':self.password,'COMPOSE_FILE':str(self.manifest),'COMPOSE_PROJECT_NAME':self.project,'BACKUP_DIR':str(self.backups),'BACKEND_IMAGE':image,'STORAGE_PATH':self.target}.items()));self.config.chmod(0o600)
        wrappercfg={'docker':self.h.real,'project':self.project,'root':str(self.root),'manifest':str(self.manifest),'volume':self.volume,'images':[image,image_id,pg,pg_id],'trace':str(self.trace)}
        (self.root/'wrapper.json').write_text(json.dumps(wrappercfg)); bin=self.root/'bin';bin.mkdir()
        wrapper=bin/'docker';wrapper.write_text(WRAPPER.replace('__PYTHON__',sys.executable));wrapper.chmod(0o700)
        self.compose(['up','-d','--pull','never'])
        for attempt in range(40):
            if self.compose(['exec','-T','db','pg_isready','-U','d1_fixture','-d','d1_fixture'],check=False).returncode==0:break
            time.sleep(1)
        else: raise FixtureError('fixture PostgreSQL readiness timeout')
        self.compose(['exec','-T','backend','sh','-c','mkdir -p /storage/.tmp /storage/fixture'.replace('/storage',self.target)])
        self.compose(['run','--rm','--no-deps','-T','backend','node','./node_modules/typeorm/cli.js','migration:run','-d','dist/data-source.js','--transaction','all'])
        tables=self.sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
        require(tables=='13','actual current migrations did not produce 13 tables: '+tables)
        self.record['table_count']=13
        self.sql("INSERT INTO users (email,password,name,\"storageUsed\") VALUES ('d1-fixture@example.invalid','nonlogin-fixture','backup original',%d); INSERT INTO files (name,\"storagePath\",size,\"userId\",\"storageLocationId\",\"relativeObjectKey\") SELECT 'object','/storage/fixture/object',%d,1,id,'fixture/object' FROM storage_locations WHERE \"machineKey\"='legacy-storage'"%(len(PAYLOAD),len(PAYLOAD)))
        self.compose(['exec','-T','backend','sh','-c','cat > /storage/fixture/object'.replace('/storage',self.target)],input=PAYLOAD)
        self.record['initial_backend_id']=self.cid(); self.record['image_id']=image_id; self.record['postgres_image_id']=pg_id
    def cleanup(self):
        failures=[]
        if self.variant == 'bind' and (self.root / 'storage').exists():
            # Restore deliberately chowns the own bind. Return it to the test
            # process before deleting the private temporary directory.
            own_bind = str(self.root / 'storage')
            reclaim = self.h.docker(['run','--rm','--pull=never','--label',OWNER+'='+self.project,'--user','root','--mount','type=bind,src='+own_bind+',dst=/storage',self.h.args.image,'chown','-R',str(os.getuid())+':'+str(os.getgid()),'/storage'],check=False)
            if reclaim.returncode: failures.append('owned bind permissions reclaim failed')
        # Explicit IDs and owner labels, never blanket compose down/prune.
        ids=self.h.docker(['ps','-aq','--filter','label='+OWNER+'='+self.project]).stdout.decode().splitlines()
        ids+=self.h.docker(['ps','-aq','--filter','label=com.docker.compose.project='+self.project]).stdout.decode().splitlines()
        for cid in sorted(set(ids)):
            owner=self.h.inspect([],cid,'{{ index .Config.Labels "'+OWNER+'" }}')
            compose=self.h.inspect([],cid,'{{ index .Config.Labels "com.docker.compose.project" }}')
            if owner!=self.project and compose!=self.project: failures.append('container ownership mismatch');continue
            if self.h.docker(['rm','-fv',cid],check=False).returncode:failures.append('owned container removal failed')
        networks=self.h.docker(['network','ls','-q','--filter','label='+OWNER+'='+self.project]).stdout.decode().splitlines()
        for network in networks:
            if self.h.inspect(['network'],network,'{{ index .Labels "'+OWNER+'" }}')!=self.project:failures.append('network ownership mismatch');continue
            if self.h.docker(['network','rm',network],check=False).returncode:failures.append('owned network removal failed')
        if self.volume:
            exists=self.h.docker(['volume','inspect',self.volume],check=False)
            if exists.returncode==0:
                if self.h.inspect(['volume'],self.volume,'{{ index .Labels "'+OWNER+'" }}')!=self.project:failures.append('volume ownership mismatch')
                elif self.h.docker(['volume','rm',self.volume],check=False).returncode:failures.append('owned volume removal failed')
        for listing in (['ps','-aq','--filter','label='+OWNER+'='+self.project],['ps','-aq','--filter','label=com.docker.compose.project='+self.project],['network','ls','-q','--filter','label='+OWNER+'='+self.project],['volume','ls','-q','--filter','label='+OWNER+'='+self.project]):
            if self.h.docker(listing).stdout.strip():failures.append('owned resource residue')
        if self.trace.exists():
            trace=self.h.logdir/(self.project+'-docker-trace.jsonl');shutil.copyfile(self.trace,trace);self.record['trace']=str(trace)
        self.record['cleanup']='passed' if not failures else failures
        self.h.save()
        # Temp dir can contain own secret configuration. Keep only sanitized logs.
        shutil.rmtree(self.root)
        require(not failures,'fixture cleanup failed: '+repr(failures))


def replace_dump(destination,raw):
    meta_path=next(destination.glob('homecloud_*.meta')); meta=json.loads(meta_path.read_text())
    dump=destination/meta['db_dump']; dump.write_bytes(gzip.compress(raw));dump.chmod(0o600)
    meta['db_dump_sha256']=sha(dump.read_bytes());meta['db_dump_size']=dump.stat().st_size
    meta_path.write_text(json.dumps(meta,indent=2)+'\n');meta_path.chmod(0o600)
    side=Path(str(meta_path)+'.sha256');side.write_text(sha(meta_path.read_bytes())+'  '+meta_path.name+'\n');side.chmod(0o600)

def clone_backup(fixture,label):
    path=fixture.root/('backup-'+label);shutil.copytree(fixture.backups,path);return path

def success(h,f):
    p,log=h.script(f,'backup.sh'); require(p.returncode==0,'actual '+f.variant+' backup failed: '+log)
    require(len(list(f.backups.glob('*.meta')))==1,'backup metadata count mismatch')
    f.mutate();p,restorelog=h.script(f,'restore.sh'); require(p.returncode==0,'actual '+f.variant+' restore failed: '+restorelog)
    state=f.state();require(state['bytes_sha256']==sha(PAYLOAD) and 'backup original' in state['users'] and state['backend_running'],'restored DB/storage/readiness mismatch')
    commands=[json.loads(line) for line in f.trace.read_text().splitlines()]
    archive=[cmd for cmd in commands if cmd[0]=='run' and 'tar' in cmd and '-czf' in cmd]
    require(bool(archive),'no actual storage archive helper observed')
    require(all((':ro' in ' '.join(cmd) or ',readonly' in ' '.join(cmd)) for cmd in archive),'archive helper did not mount storage read-only')
    require(all('-v' not in cmd for cmd in archive),'archive used implicit-creation -v syntax')
    h.case(f.variant+' round-trip current13',{'backup_log':log,'restore_log':restorelog,'restored_state':state,'archive_read_only':True})

def negatives(h,f):
    f.mutate();before=f.state()
    invalid=clone_backup(f,'invalid-sql');meta=json.loads(next(invalid.glob('*.meta')).read_text()); raw=gzip.decompress((invalid/meta['db_dump']).read_bytes())
    replace_dump(invalid,raw+b'\nSELECT homecloud_d1_intentional_missing_function();\n')
    p,log=h.script(f,'restore.sh',backup=invalid)
    require(p.returncode!=0 and f.state()==before,'invalid SQL did not reject before target mutation')
    require('isolated validation' in (p.stdout+p.stderr).lower(),'invalid SQL failed before real isolated SQL replay; inspect '+log)
    h.case('invalid SQL with recomputed metadata',{'log':log,'target_unchanged':True})
    f.sql(PENDING); before=f.state()
    p,log=h.script(f,'backup.sh');require(p.returncode!=0 and f.state()==before,'pending SSD backup failed-open or changed target')
    h.case('pending SSD backup rejection',{'log':log,'target_unchanged':True})
    pending=clone_backup(f,'pending-ssd')
    raw=f.compose(['exec','-T','db','pg_dump','-U','d1_fixture','-d','d1_fixture','--clean','--if-exists']).stdout
    replace_dump(pending,raw)
    p,targetlog=h.script(f,'restore.sh');require(p.returncode!=0 and f.state()==before,'target pending SSD restore failed-open or changed target')
    h.case('target pending SSD rejection',{'log':targetlog,'target_unchanged':True})
    f.sql("DELETE FROM upload_sessions WHERE \"uploadId\"='"+UPLOAD_ID+"'")
    before=f.state();p,dumplog=h.script(f,'restore.sh',backup=pending)
    require(p.returncode!=0 and f.state()==before,'dump pending SSD restore failed-open or changed target')
    h.case('dump pending SSD rejection',{'log':dumplog,'target_unchanged':True})
    p,log=h.script(f,'restore.sh');require(p.returncode==0,'restore reset after negative checks failed: '+log)

def failures(h,f):
    for phase in ('import','storage','migration','reconcile','health'):
        p,log=h.script(f,'restore.sh',fault=phase)
        marker=f.root/('fault-'+phase)
        require(marker.exists(),'phase injection was not reached: '+phase+' '+log)
        require(p.returncode!=0,'injected '+phase+' returned success')
        require(not f.running(),'writers resumed after injected '+phase+' failure')
        frontend=f.cid('frontend');require(h.inspect([],frontend,'{{.State.Running}}')=='false','frontend writer remained running after failure')
        h.case('failure fencing '+phase,{'log':log,'injection_reached':True,'backend_running':False,'frontend_running':False})
        p,resetlog=h.script(f,'restore.sh');require(p.returncode==0,'successful recovery after '+phase+' failed: '+resetlog)

def baseline(h,f):
    p,log=h.script(f,'backup.sh');require(p.returncode==0,'baseline fixture current backup failed: '+log)
    f.mutate();before=f.state();p,log=h.script(f,'restore.sh',baseline=True)
    require(p.returncode!=0,'baseline unexpectedly accepted schema13')
    require('found 13' in (p.stdout+p.stderr),'baseline defect did not reach schema13 rejection: '+log)
    # Baseline cleanup restarts services asynchronously. Poll only own backend.
    for attempt in range(20):
        try:
            after=f.state()
            if after['backend_running'] and after['writer_starts']>before['writer_starts']:break
        except FixtureError: pass
        time.sleep(1)
    else: raise FixtureError('baseline did not reproduce writer restart after failure')
    require('backup original' in after['users'],'baseline did not replace target DB before schema rejection')
    require(after['bytes_sha256']==before['bytes_sha256'],'baseline modified storage before expected schema rejection')
    h.case('baseline destructive13 rejection and writer restart',{'log':log,'db_replaced_before_error':True,'storage_left_old':True,'writers_restarted':True,'before':before,'after':after})

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True);parser.add_argument('--postgres-image',default='postgres:16-alpine')
    parser.add_argument('--baseline-root',required=True);parser.add_argument('--evidence',required=True)
    parser.add_argument('--skip-failure-injections',action='store_true')
    args=parser.parse_args();require(Path(args.baseline_root).is_absolute(),'baseline-root must be absolute')
    h=Harness(args);before=h.snapshot();h.report['isolation']['before']=before;h.save()
    error=None
    try:
        for variant in ('named','bind','baseline'):
            f=Fixture(h,variant)
            try:
                f.setup()
                if variant=='baseline':baseline(h,f)
                else:
                    success(h,f)
                    if variant=='named':
                        negatives(h,f)
                        if not args.skip_failure_injections:failures(h,f)
            finally:f.cleanup()
        h.report['status']='passed'
    except BaseException as exc:
        error=exc;h.report['status']='failed';h.report['error']=str(exc)
    finally:
        after=h.snapshot();h.report['isolation']['after']=after
        h.report['isolation']['pre_existing_resources_identical']=after==before
        if after!=before:
            h.report['status']='failed';h.report['isolation']['error']='pre-existing Docker resource snapshot changed or fixture residue exists'
            if error is None:error=FixtureError(h.report['isolation']['error'])
        h.save()
    print(json.dumps({'status':h.report['status'],'passed_cases':len(h.report['cases']),'evidence':str(h.evidence)},ensure_ascii=False))
    if error:
        print(str(error),file=sys.stderr);return 1
    return 0

if __name__=='__main__':sys.exit(main())
