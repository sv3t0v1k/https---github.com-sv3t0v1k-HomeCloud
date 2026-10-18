#!/usr/bin/env python3
"""Synthetic DB+HDD recovery drill. Execution is hosted-only and gate-admitted."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import signal
import time
import admission
import preflight as pre
import recovery_model as model
from runtime_fixture import Fixture

MODEL = Path(__file__).with_name('recovery_model.py').resolve()
CASES = ['switch-sequence','direct-rollback','cold-recovery','logical-recovery',
         'missing-marker','wrong-marker','missing-data-mount','wrong-data-mount','symlink-wal',
         'missing-pgdata','empty-pgdata','incompatible-pgdata','corrupt-pgdata',
         'missing-hdd','corrupt-hdd','generation-mismatch','corrupt-backup','incomplete-backup']


def utc():
    return datetime.now(timezone.utc).isoformat()


class Journal:
    def __init__(self, out):
        self.out = out
        self.config = out/'docker-config'
        self.config.mkdir(mode=0o700, exist_ok=True)

    def __call__(self, argv, input=None, check=True, timeout=60):
        pre.require(isinstance(argv,list) and all(isinstance(a,str) for a in argv), 'argv only')
        # Workload commands get provider identity, never account/Actions API tokens.
        env = {k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','TMPDIR','APPROVED_SHA')
               or k.startswith(('GITHUB_','RUNNER_','D513_'))}
        for key in list(env):
            if any(word in key for word in ('TOKEN','PASSWORD','SECRET','CREDENTIAL')):
                del env[key]
        env['DOCKER_CONFIG'] = str(self.config)
        started = time.monotonic_ns()
        try:
            result = subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            with (self.out/'commands.jsonl').open('a') as stream:
                stream.write(json.dumps(dict(at=utc(),argv=argv,timeout=True,
                    elapsed_seconds=(time.monotonic_ns()-started)/1e9))+'\n')
            raise
        record = dict(at=utc(),argv=argv,exit_code=result.returncode,
                      elapsed_seconds=(time.monotonic_ns()-started)/1e9,
                      stdout_bytes=len(result.stdout),stdout_sha256=model.sha(result.stdout),
                      stderr=result.stderr.decode(errors='replace')[:8000])
        with (self.out/'commands.jsonl').open('a') as stream:
            stream.write(json.dumps(record)+'\n')
        if check and result.returncode:
            raise RuntimeError('command failed: '+argv[0]+' (see command journal)')
        return result


def tree(runner, path):
    return json.loads(runner(['sudo','python3',str(MODEL),'inventory',str(path)]).stdout)


def check_hdd(runner, slot, rows, generation):
    request = json.dumps(dict(rows=rows,generation=generation)).encode()
    return json.loads(runner(['sudo','python3',str(MODEL),'check',str(slot.hdd)],input=request).stdout)


class Drill:
    def __init__(self, out, runner, fixture, images):
        self.out, self.runner, self.f, self.images = out, runner, fixture, images
        self.rows = []
        self.confirmed = []
        self.generation = 'd513-synthetic-v1'
        self.catalog = None
        self.failures = {}
        self.results = {name:dict(status='NOT_RUN') for name in CASES}
        self.checkpoint()

    def checkpoint(self):
        pre.write(self.out,'matrix.json',self.results)
        pre.write(self.out,'resource-ledger.json',self.f.ledger)
        pre.write(self.out,'confirmed-events.json',self.confirmed)

    def pass_case(self, name, **details):
        self.results[name] = dict(status='PASS',at=utc(),**details)
        self.checkpoint()

    def failure_point(self, name):
        stamp = time.monotonic_ns()
        self.failures[stamp] = utc()
        pre.write(self.out,'failure-points.json',dict(points=[dict(scenario=name,monotonic_ns=stamp,
            at=self.failures[stamp],model='Stopped original is unavailable; restore uses separate targets')],
            prior_points=self.failures))
        return stamp

    def logs(self, container):
        result = self.runner(['docker','logs',container],check=False)
        (self.out/('postgres-'+container+'.log')).write_bytes(result.stdout+result.stderr)
        return result.stdout+result.stderr

    def sql(self, container, statement, user='d513_owner', db='d513'):
        pre.require(user in ('d513_owner','d513_restore') and db in ('d513','postgres'), 'synthetic DB only')
        return self.f.exec(container,'psql','--no-psqlrc','--quiet','--set=ON_ERROR_STOP=1',
            '--tuples-only','--no-align','--username='+user,'--dbname='+db,
            input=statement.encode()).stdout.decode().strip()

    def ready(self, container, image, bootstrap='d513_owner'):
        deadline = time.monotonic()+35
        db = 'd513' if bootstrap == 'd513_owner' else 'postgres'
        while time.monotonic() < deadline:
            state = json.loads(self.runner(['docker','inspect',container]).stdout)[0]
            pre.require(state['Image'] == image, 'running config ID differs from admitted OCI')
            if not state['State']['Running']:
                raise RuntimeError('gated server exited before readiness')
            # The official entrypoint temporarily starts a Unix-socket server
            # during initdb. Only the final postgres PID1 can satisfy readiness.
            process = self.f.exec(container,'cat','/proc/1/comm').stdout.strip()
            command = self.f.exec(container,'cat','/proc/1/cmdline').stdout
            if process != b'postgres' or command.split(b'\0',1)[0] not in (b'postgres',b'/usr/local/bin/postgres'):
                time.sleep(.25)
                continue
            if self.f.exec(container,'pg_isready','--username='+bootstrap,'--dbname='+db,check=False).returncode == 0:
                log = self.logs(container)
                pre.require(b'PASS: HomeCloud startup disk gate' in log,
                            'startup gate did not confirm actual mount identity')
                version = self.sql(container,"SELECT current_setting('server_version'),pg_is_in_recovery();",bootstrap,db)
                pre.require(version == '16.15|f','PG version/recovery state mismatch')
                status = self.f.exec(container,'cat','/proc/1/status').stdout.decode()
                pre.require(any(line.split()[1:] == ['70']*4 for line in status.splitlines()
                                if line.startswith('Uid:')), 'actual postgres PID1 UID mismatch')
                pre.write(self.out,'identity-'+container+'.json',dict(config=image,version=version,uid=70,
                                                                    ready_at=utc(),startup_gate='PASS'))
                return
            time.sleep(0.25)
        raise TimeoutError('bounded synthetic PostgreSQL readiness')

    def start(self, slot, role, name, bootstrap='d513_owner'):
        image = self.images[role]['config']
        container = self.f.container(name,image,slot,bootstrap)
        self.ready(container,image,bootstrap)
        return container

    def stop(self, container):
        self.f.stop(container)
        state = json.loads(self.runner(['docker','inspect',container]).stdout)[0]['State']
        pre.require(not state['Running'] and state['ExitCode'] == 0, 'unclean PostgreSQL shutdown')

    def write(self, path, content, mode='0600', owner='70:70'):
        pre.require(path.is_relative_to(self.f.mount), 'write outside synthetic filesystem')
        self.runner(['sudo','tee',str(path)],input=content)
        self.runner(['sudo','chown',owner,str(path)])
        self.runner(['sudo','chmod',mode,str(path)])
        self.runner(['sudo','sync','--file-system',str(path)])

    def init_schema(self, container, slot):
        self.sql(container,"""CREATE ROLE d513_reader NOLOGIN;
CREATE TABLE schema_migrations(id integer PRIMARY KEY,name text NOT NULL);
INSERT INTO schema_migrations VALUES(1,'synthetic-fixture-only');
CREATE TABLE d513_meta(generation text PRIMARY KEY);
INSERT INTO d513_meta VALUES('d513-synthetic-v1');
CREATE TABLE d513_files(event_id integer PRIMARY KEY,generation text NOT NULL REFERENCES d513_meta,
path text NOT NULL UNIQUE,size integer NOT NULL CHECK(size>0),sha256 text NOT NULL,
owner_name text NOT NULL CHECK(owner_name='d513_owner'));
GRANT SELECT ON ALL TABLES IN SCHEMA public TO d513_reader;""")
        self.write(slot.hdd/'generation.json',json.dumps(dict(generation=self.generation)).encode())

    def append(self, container, slot, event_id):
        data = model.payload(event_id)
        name = f'event-{event_id:04d}.bin'
        self.write(slot.hdd/name,data)
        row = dict(event_id=event_id,generation=self.generation,path=name,size=len(data),
                   sha256=model.sha(data),owner_name='d513_owner')
        self.sql(container,"BEGIN; SET LOCAL synchronous_commit=on; INSERT INTO d513_files VALUES("+
                 f"{event_id},'{self.generation}','{name}',{len(data)},'{row['sha256']}','d513_owner'); COMMIT;")
        self.rows.append(row)
        self.confirmed.append(dict(**row,confirmed_ns=time.monotonic_ns(),confirmed_at=utc()))
        self.checkpoint()

    def read_rows(self, container):
        raw = self.sql(container,"BEGIN READ ONLY; SELECT coalesce(json_agg(x ORDER BY event_id),'[]'::json) FROM d513_files x; COMMIT;")
        return json.loads(raw)

    def read_catalog(self, container):
        raw = self.sql(container,"""BEGIN READ ONLY; SELECT json_build_object(
'database_owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
'tables',(SELECT json_agg(x ORDER BY tablename) FROM (SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public') x),
'constraints',(SELECT json_agg(x ORDER BY tablename,definition) FROM (SELECT c.relname AS tablename,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') x),
'grants',(SELECT json_agg(x ORDER BY table_name,grantee,privilege_type) FROM (SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public') x),
'migrations',(SELECT json_agg(x ORDER BY id) FROM schema_migrations x)); COMMIT;""")
        return json.loads(raw)

    def integrity(self, container, slot, expected):
        rows = self.read_rows(container)
        pre.require(rows == expected, 'DB rows differ from confirmed expected snapshot')
        generation = self.sql(container,'BEGIN READ ONLY; SELECT generation FROM d513_meta; COMMIT;')
        pre.require(generation == self.generation, 'DB generation changed')
        result = check_hdd(self.runner,slot,rows,generation)
        result['database_bytes'] = int(self.sql(container,"BEGIN READ ONLY; SELECT pg_database_size('d513'); COMMIT;"))
        catalog = self.read_catalog(container)
        if self.catalog is None:
            self.catalog = catalog
        pre.require(catalog == self.catalog, 'schema, ownership, grants or migration ledger changed')
        pre.write(self.out,'integrity-'+container+'.json',dict(rows=rows,expected_rows=expected,
                  generation=generation,catalog=catalog,integrity=result,checked_at=utc()))
        return result

    def pair(self, slot):
        return dict(db=tree(self.runner,slot.data),hdd=tree(self.runner,slot.hdd))

    def clone(self, name, source_db, source_hdd):
        slot = self.f.slot(name)
        for target,source in [(slot.data,source_db),(slot.hdd,source_hdd)]:
            self.runner(['sudo','rmdir','--',str(target)])
            self.f.copy_tree(source,target)
        return slot

    def backup_inventory(self, backup):
        for key in ('db','hdd','logical'):
            path=backup/key
            pre.require(path.is_dir() and not path.is_symlink() and path.resolve()==path,
                        'missing or linked backup component: '+key)
        return {key:tree(self.runner,backup/key) for key in ('db','hdd','logical')}

    def verified_backup(self, backup, inventory):
        model.verify_backup(self.backup_inventory(backup),inventory)

    def metric(self, restored, failure):
        by_id = {row['event_id']:row for row in self.confirmed}
        acknowledged = []
        for row in restored:
            record = by_id[row['event_id']]
            pre.require(all(record[k] == v for k,v in row.items()), 'unconfirmed restored event')
            acknowledged.append(record)
        result = model.measurements(self.confirmed,acknowledged,failure,time.monotonic_ns(),0)
        result['integrity_ready_at'] = utc()
        result['failure_at'] = self.failures[failure]
        return result

    def run(self):
        self.f.create()
        live = self.f.slot('live',fresh=True)
        container = self.start(live,'official','official-first')
        self.init_schema(container,live)
        self.append(container,live,1)
        self.integrity(container,live,self.rows)
        self.stop(container)
        container = self.start(live,'exact','candidate-first')
        self.integrity(container,live,self.rows)
        self.append(container,live,2)
        self.integrity(container,live,self.rows)
        self.stop(container)
        original = self.pair(live)
        failure = self.failure_point('direct-rollback')
        direct = self.clone('direct',live.data,live.hdd)
        container = self.start(direct,'official','direct-rollback')
        sizes = self.integrity(container,direct,self.rows)
        self.pass_case('direct-rollback',metrics=self.metric(self.read_rows(container),failure),sizes=sizes)
        self.stop(container)
        pre.require(self.pair(live) == original, 'original changed during direct rollback')
        container = self.start(live,'official','official-back')
        self.integrity(container,live,self.rows)
        self.stop(container)
        container = self.start(live,'exact','candidate-back')
        self.integrity(container,live,self.rows)
        self.pass_case('switch-sequence',sequence=['official','exact','official','exact'],events=2)
        # There is exactly one synthetic writer (this process); no writes occur
        # between these two dumps and the clean stop/cold/HDD snapshot.
        backup_started = utc()
        globals_sql = self.f.exec(container,'pg_dumpall','--globals-only','--username=d513_owner').stdout
        dump = self.f.exec(container,'pg_dump','--format=custom','--compress=6','--create',
                            '--username=d513_owner','--dbname=d513').stdout
        self.stop(container)
        backup = self.f.mount/'backup'
        self.runner(['sudo','mkdir','--',str(backup)])
        self.f.copy_tree(live.data,backup/'db')
        self.f.copy_tree(live.hdd,backup/'hdd')
        self.runner(['sudo','mkdir','--',str(backup/'logical')])
        self.write(backup/'logical/globals.sql',globals_sql)
        self.write(backup/'logical/database.dump',dump)
        backup_rows = list(self.rows)
        inventory = self.backup_inventory(backup)
        pre.write(self.out,'backup-manifest.json',dict(inventory=inventory,rows=backup_rows,
            generation=self.generation,catalog=self.catalog,started_at=backup_started,completed_at=utc(),
            db_bytes=sum(r.get('size',0) for r in inventory['db'].values()),
            hdd_bytes=sum(r.get('size',0) for r in inventory['hdd'].values()),
            writer_freeze='No synthetic writer calls between dumps and clean stop',
            custody='Hash-bound copies; no backup path mounted into a database container'))
        container = self.start(live,'exact','candidate-delta')
        self.append(container,live,3)
        self.integrity(container,live,self.rows)
        self.stop(container)
        original = self.pair(live)
        for kind in ('cold','logical'):
            failure = self.failure_point(kind+'-recovery')
            self.verified_backup(backup,inventory)
            if kind == 'cold':
                restored = self.clone('cold-restore',backup/'db',backup/'hdd')
                container = self.start(restored,'exact','cold-restore')
            else:
                restored = self.f.slot('logical-restore',fresh=True)
                self.runner(['sudo','rmdir','--',str(restored.hdd)])
                self.f.copy_tree(backup/'hdd',restored.hdd)
                container = self.start(restored,'official','logical-restore','d513_restore')
                self.sql(container,globals_sql.decode(),user='d513_restore',db='postgres')
                self.f.exec(container,'pg_restore','--exit-on-error','--create','--username=d513_restore',
                            '--dbname=postgres',input=dump)
            sizes = self.integrity(container,restored,backup_rows)
            self.pass_case(kind+'-recovery',metrics=self.metric(self.read_rows(container),failure),sizes=sizes)
            self.stop(container)
        self.negatives(backup,inventory,backup_rows)
        self.verified_backup(backup,inventory)
        pre.require(self.pair(live) == original, 'original changed during recovery/negative tests')
        pre.require(all(case['status']=='PASS' for case in self.results.values()), 'incomplete scenario matrix')

    def expected_gate_failure(self, slot, name, fault=None):
        before = self.pair(slot)
        container = self.f.container(name,self.images['exact']['config'],slot,fault=fault)
        deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            state = json.loads(self.runner(['docker','inspect',container]).stdout)[0]['State']
            if not state['Running']:
                break
            time.sleep(.1)
        data = self.logs(container)
        pre.require(not state['Running'] and state['ExitCode'] != 0 and
                    b'STOP: HomeCloud startup disk gate' in data and
                    b'PASS: HomeCloud startup disk gate' not in data, 'gate negative did not fail closed')
        pre.require(self.pair(slot)==before, 'gate rejection changed DB/HDD')
        self.pass_case(name,rejection='REAL_STARTUP_GATE',exit_code=state['ExitCode'],
                       log_sha256=model.sha(data),original_pair_unchanged=True)

    def negatives(self, backup, inventory, rows):
        for name in ['missing-marker','wrong-marker','missing-data-mount','wrong-data-mount','symlink-wal']:
            slot = self.clone(name,backup/'db',backup/'hdd')
            fault = name if name in ('missing-marker','missing-data-mount','wrong-data-mount') else None
            if name == 'wrong-marker':
                self.write(slot.marker,b'wrong synthetic marker\n',mode='0400')
            if name == 'symlink-wal':
                # A link inside PGDATA remains a link in the bind mount. Point it at
                # a disposable sibling; never link to any host/production path.
                self.runner(['sudo','mv','--',str(slot.data/'pg_wal'),str(slot.data.parent/'wal-copy')])
                self.runner(['sudo','ln','-s','--','../wal-copy',str(slot.data/'pg_wal')])
                # Inventory intentionally refuses links; preserve actual PGDATA via
                # fingerprint excluding the injected link for this one gate test.
                self.runner(['sudo','rm','--',str(slot.data/'pg_wal')])
                before = self.pair(slot)
                self.runner(['sudo','ln','-s','--','../wal-copy',str(slot.data/'pg_wal')])
                container = self.f.container(name,self.images['exact']['config'],slot)
                result = self.runner(['docker','wait',container],timeout=10)
                logs = self.logs(container)
                pre.require(result.stdout.strip()!=b'0' and b'STOP: HomeCloud startup disk gate' in logs,
                            'symlink gate failed open')
                self.runner(['sudo','rm','--',str(slot.data/'pg_wal')])
                pre.require(self.pair(slot)==before,'symlink rejection changed fixture bytes')
                self.pass_case(name,rejection='REAL_STARTUP_GATE')
            else:
                self.expected_gate_failure(slot,name,fault)
        for name in ['missing-pgdata','empty-pgdata','incompatible-pgdata']:
            slot = self.f.slot(name)
            if name == 'missing-pgdata':
                self.runner(['sudo','rmdir','--',str(slot.data)])
            if name == 'incompatible-pgdata':
                self.write(slot.data/'PG_VERSION',b'17\n')
            try:
                self.f.container(name,self.images['exact']['config'],slot)
            except ValueError:
                self.pass_case(name,rejection='PRELAUNCH_NO_INITDB')
            else:
                raise ValueError('recovery target silently initialized')
        slot = self.clone('corrupt-pgdata',backup/'db',backup/'hdd')
        self.write(slot.data/'global/pg_control',b'd513 deliberate corruption')
        container = self.f.container('corrupt-pgdata',self.images['exact']['config'],slot)
        result = self.runner(['docker','wait',container],timeout=20)
        evidence = self.logs(container)
        pre.require(result.stdout.strip()!=b'0' and b'PASS: HomeCloud startup disk gate' in evidence
                    and (b'pg_control' in evidence or b'control file' in evidence),
                    'corrupt PGDATA did not reach server refusal after gate')
        self.pass_case('corrupt-pgdata',rejection='SERVER_REFUSED_CORRUPT_COPY')
        for name in ['missing-hdd','corrupt-hdd','generation-mismatch']:
            slot = self.clone(name,backup/'db',backup/'hdd')
            if name=='missing-hdd':
                self.runner(['sudo','rm','--',str(slot.hdd/rows[0]['path'])])
            elif name=='corrupt-hdd':
                self.write(slot.hdd/rows[0]['path'],b'synthetic corruption')
            else:
                self.write(slot.hdd/'generation.json',b'{"generation":"wrong-synthetic-generation"}')
            result = self.runner(['sudo','python3',str(MODEL),'check',str(slot.hdd)],
                input=json.dumps(dict(rows=rows,generation=self.generation)).encode(),check=False)
            pre.require(result.returncode!=0,'HDD integrity negative accepted')
            self.pass_case(name,rejection='INTEGRITY_CHECK_NO_PROMOTION')
        for name in ['corrupt-backup']:
            target = self.f.mount/name
            self.f.copy_tree(backup,target)
            if name=='corrupt-backup':
                self.write(target/'logical/database.dump',b'invalid synthetic dump')
            try:
                self.verified_backup(target,inventory)
            except ValueError:
                self.pass_case(name,rejection='BACKUP_VALIDATION_BEFORE_TARGET_CREATION')
            else:
                raise ValueError('invalid backup accepted')
        missing=[]
        for component in ['db','hdd','logical/globals.sql']:
            target=self.f.mount/('incomplete-'+component.replace('/','-').replace('.','-'))
            self.f.copy_tree(backup,target)
            self.runner(['sudo','mv','--',str(target/component),str(target)+'-removed'])
            try:
                self.verified_backup(target,inventory)
            except ValueError:
                missing.append(component)
            else:
                raise ValueError('missing backup component accepted')
        self.pass_case('incomplete-backup',rejection='BACKUP_VALIDATION_BEFORE_TARGET_CREATION',
                       missing_components=missing)


def load_images(images, runner):
    binding = admission.module('oci-scan-binding')
    for role, info in images.items():
        tag = 'homecloud-d513-'+role+':'+os.environ['GITHUB_RUN_ID']
        runner(['skopeo','copy','oci-archive:'+info['archive'],'docker-daemon:'+tag],timeout=90)
        actual = json.loads(runner(['docker','image','inspect',tag]).stdout)
        _, _, config = binding.identity(Path(info['archive']))
        pre.require(len(actual)==1 and actual[0]['Id']==info['config'] and
                    actual[0]['RootFS']['Layers']==config['rootfs']['diff_ids'] and
                    (actual[0]['Os'],actual[0]['Architecture'])==('linux','amd64'), 'loaded OCI identity mismatch')


def execute(out, download, runner, admit=admission.admit, factory=Fixture):
    fixture = None
    status = dict(status='BLOCKED_BEFORE_RUNTIME',drill='NOT_RUN',production='NO_GO',
                  complete=False,rpo=None,rto=None,runtime_started=False)
    try:
        receipt, images = admit(out,download,runner)
        # No image load, host sudo mutation, loop or container before all gates PASS.
        load_images(images,runner)
        root = Path(os.environ['RUNNER_TEMP'])/f'd513-runtime-{os.environ["GITHUB_RUN_ID"]}-1'
        fixture = factory(root,f'd513-{os.environ["GITHUB_RUN_ID"]}-1',runner,receipt)
        drill = Drill(out,runner,fixture,images)
        status['runtime_started'] = True
        status['status'] = 'FAILED'
        status['drill'] = 'PARTIAL'
        drill.run()
        status.update(status='SYNTHETIC_DRILL_PASSED',drill='PASS',
                      metrics={k:v['metrics'] for k,v in drill.results.items() if 'metrics' in v})
    except Exception as error:
        status['error_type'] = type(error).__name__
        status['error'] = str(error)[:500]
        raise
    finally:
        if fixture is not None:
            try:
                fixture.cleanup()
            except Exception as error:
                status.update(status='FAILED_CLEANUP',drill='PARTIAL',cleanup_error=type(error).__name__)
            pre.write(out,'resource-ledger.json',fixture.ledger)
        status.update(provenance='UNSIGNED',sbom='UNSIGNED',reproducibility='UNPROVEN',
                      medium_unknown_accepted=False,release='BLOCKED')
        pre.write(out,'harness-status.json',status)
    pre.require(status['status']=='SYNTHETIC_DRILL_PASSED','runtime or cleanup incomplete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage',choices=['qualify','run'])
    args = parser.parse_args()
    pre.hosted(os.environ,__import__('platform').system(),__import__('platform').machine())
    out = pre.evidence_root()
    runner = Journal(out)
    download = Path(os.environ['D513_DOWNLOAD'])
    if args.stage=='qualify':
        admission.qualify(out,download,runner)
    else:
        def interrupt(signum, frame):
            signal.signal(signum,signal.SIG_IGN)
            raise InterruptedError('runner interrupted; best-effort owned-resource cleanup')
        signal.signal(signal.SIGTERM,interrupt)
        signal.signal(signal.SIGINT,interrupt)
        execute(out,download,runner)


if __name__=='__main__':
    main()
