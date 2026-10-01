#!/usr/bin/env python3
"""Encrypted full backup coordinator. Never prints child output or secret values."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from recovery_config import load_config

NAME = re.compile(r'hc_\d{8}T\d{6}Z_[0-9a-f]{16}')
MEMBER = re.compile(r'homecloud_(?:db_\d{8}_\d{6}_[0-9a-f]{8}\.sql\.gz|storage_\d{8}_\d{6}_[0-9a-f]{8}\.tar\.gz|\d{8}_\d{6}_[0-9a-f]{8}\.meta(?:\.sha256)?)')
SCRIPT = Path(__file__).resolve().parent
stage = 'configuration'

def event(kind, **fields):
    print(json.dumps(dict(event=kind, **fields)), flush=True)
    operations={'backup_production_completed':'backup','encrypted_offsite_restore_completed':'restore','encrypted_offsite_validation_completed':'restore-validation'}
    if kind in operations:
        marker(operations[kind],'success',dict(event=kind,**fields))

def marker(operation, status, fields):
    local=Path(os.environ['BACKUP_PRODUCTION_DIR'])
    fields=dict(fields, timestamp=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    fd,path=tempfile.mkstemp(prefix='.marker_',dir=local)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(fields,f); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(path,local/('last-'+operation+'-'+status+'.json'))
    finally:
        if os.path.exists(path): os.unlink(path)

def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()

def regular(p):
    return stat.S_ISREG(p.lstat().st_mode)

def root(key, create=True):
    p = Path(os.environ[key]).expanduser()
    if not p.is_absolute(): raise ValueError('absolute path required')
    # Reject symlink components before creating directories.
    for ancestor in (p, *p.parents):
        if ancestor.is_symlink(): raise ValueError('symlink root')
    if create: p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not p.is_dir(): raise ValueError('invalid root')
    if create and p.stat().st_mode & 0o077: raise ValueError('local root permissions')
    return p.resolve()

def keyfile(key, secret=False):
    p = Path(os.environ[key]).expanduser()
    if any(x.is_symlink() for x in (p,*p.parents)): raise ValueError('symlink key path')
    if not p.is_absolute() or not regular(p): raise ValueError('invalid key file')
    if p.stat().st_mode & 0o077: raise ValueError('key file permissions')
    repo = SCRIPT.parent
    if p.resolve().is_relative_to(repo): raise ValueError('key file must be external')
    for variable in ('BACKUP_PRODUCTION_DIR','BACKUP_OFFSITE_DIR'):
        if p.resolve().is_relative_to(Path(os.environ[variable]).resolve()): raise ValueError('key inside backup root')
    return p

def child(args, env=None):
    r = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode:
        # Legacy backup already distinguishes these stages. Preserve only fixed codes.
        for code in ('pg_dump_failed', 'storage_tar_failed', 'storage_tar_integrity_failed', 'storage_not_accessible', 'storage_empty', 'dump_empty', 'dump_gzip_invalid', 'dump_no_ddl', 'db_checksum_mismatch', 'storage_checksum_mismatch', 'meta_generation_failed', 'sha256_meta_failed', 'sha256_db_failed', 'sha256_storage_failed', 'sha256_db_recheck_failed', 'sha256_storage_recheck_failed', 'storage_archive_unreadable', 'file_count_mismatch', 'meta_sidecar_verify_failed', 'meta_sidecar_malformed', 'meta_sidecar_hash_mismatch', 'meta_sidecar_name_mismatch', 'missing_staging_artifacts', 'insufficient_disk_space', 'disk_space_unknown'):
            if code.encode() in r.stdout + r.stderr: event('legacy_backup_failure', reason=code)
        raise RuntimeError('child failed')

def verify(p):
    if not NAME.fullmatch(p.name) or p.is_symlink() or not p.is_dir(): raise ValueError('invalid generation')
    if set(x.name for x in p.iterdir()) != {'backup.age','manifest.json'}: raise ValueError('partial generation')
    if not all(regular(p/x) for x in ('backup.age','manifest.json')): raise ValueError('invalid member')
    m = json.loads((p/'manifest.json').read_text())
    if set(m) != {'format','generation','created_at','size','sha256'} or m['format'] != 1 or m['generation'] != p.name: raise ValueError('manifest mismatch')
    if not isinstance(m['size'],int) or m['size'] <= 0 or not re.fullmatch('[0-9a-f]{64}',m['sha256']): raise ValueError('invalid manifest')
    dt.datetime.strptime(m['created_at'],'%Y-%m-%dT%H:%M:%SZ')
    if (p/'backup.age').stat().st_size != m['size'] or digest(p/'backup.age') != m['sha256']: raise ValueError('integrity mismatch')
    return m

def syncdir(path):
    fd=os.open(path,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def publish(source, target, name):
    expected=verify(source)
    partial = target/('.partial_'+uuid.uuid4().hex)
    try:
        shutil.copytree(source,partial)
        # Verify using final naming without making the generation discoverable.
        check = partial/name
        check.mkdir()
        for filename in ('backup.age','manifest.json'): (partial/filename).rename(check/filename)
        if verify(check) != expected: raise ValueError('replication manifest changed')
        for filename in ('backup.age','manifest.json'):
            with (check/filename).open('rb') as f: os.fsync(f.fileno())
        syncdir(check)
        if (target/name).exists(): raise ValueError('collision')
        check.rename(target/name)
        syncdir(target)
    finally:
        shutil.rmtree(partial,ignore_errors=True)

def retain(target, count, days, protected=None):
    valid=[]
    for p in target.iterdir():
        if NAME.fullmatch(p.name):
            try: valid.append((verify(p)['created_at'],p))
            except Exception: event('retention_warning',reason='invalid_generation_ignored')
    valid.sort(key=lambda item: (item[0], item[1].name == protected, item[1].name), reverse=True)
    cutoff=dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=days)
    for created,p in valid[count:]:
        if p.name != protected and dt.datetime.strptime(created,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) < cutoff:
            try:
                tombstone=target/('.expired_'+uuid.uuid4().hex)
                p.rename(tombstone)
                shutil.rmtree(tombstone)
            except OSError: event('retention_warning',reason='cleanup_failed')

def operation():
    global stage
    os.umask(0o077)
    if not shutil.which('age'): raise ValueError('age dependency missing')
    local=root('BACKUP_PRODUCTION_DIR'); remote=root('BACKUP_OFFSITE_DIR',create=False)
    if local == remote or local.is_relative_to(remote) or remote.is_relative_to(local): raise ValueError('overlapping roots')
    if os.environ.get('BACKUP_OFFSITE_CONFIRMED') != '1': raise ValueError('offsite storage confirmation required')
    if sys.argv[1] == 'backup':
        if os.environ.get('BACKUP_WRITE_BARRIER_CONFIRMED') != '1': raise ValueError('write barrier confirmation required')
        recipients=keyfile('BACKUP_AGE_RECIPIENTS_FILE')
        count=int(os.environ.get('BACKUP_RETAIN_COUNT','7')); days=int(os.environ.get('BACKUP_RETENTION_DAYS','30'))
        if count<2 or days<0: raise ValueError('invalid retention')
        with tempfile.TemporaryDirectory(prefix='.plaintext_',dir=local) as tmp:
            tmp=Path(tmp); plain=tmp/'plain'; plain.mkdir()
            env=os.environ.copy(); env['BACKUP_DIR']=str(plain)
            stage='legacy_backup'; child(['bash',str(SCRIPT/'backup.sh')],env)
            members=[x for x in plain.iterdir() if MEMBER.fullmatch(x.name)]
            if len(members)!=4 or not all(regular(p) for p in members): raise ValueError('legacy artifact set incomplete')
            stage='archive'; bundle=tmp/'bundle.tar'
            with tarfile.open(bundle,'w') as archive:
                for p in sorted(members): archive.add(p,arcname=p.name,recursive=False)
            name='hc_'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'_'+uuid.uuid4().hex[:16]
            generation=tmp/name; generation.mkdir()
            stage='encryption'; child(['age','-R',str(recipients),'-o',str(generation/'backup.age'),str(bundle)])
            stage='metadata'
            manifest=dict(format=1,generation=name,created_at=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),size=(generation/'backup.age').stat().st_size,sha256=digest(generation/'backup.age'))
            (generation/'manifest.json').write_text(json.dumps(manifest,sort_keys=True)+'\n'); verify(generation)
            stage='local_publication'; publish(generation,local,name)
            stage='offsite_replication'; publish(generation,remote,name); verify(remote/name)
        stage='retention'
        for target in (local,remote):
            try: retain(target,count,days,name)
            except Exception: event('retention_warning',reason='scan_failed')
        event('backup_production_completed',generation=name,offsite_verified=True)
    elif sys.argv[1]=='restore':
        if len(sys.argv)<3 or not NAME.fullmatch(sys.argv[2]) or any(x not in ('--yes','--validate-only') for x in sys.argv[3:]): raise ValueError('invalid restore arguments')
        identity=keyfile('BACKUP_AGE_IDENTITY_FILE',True)
        stage='offsite_verification'; source=remote/sys.argv[2]; expected=verify(source)
        with tempfile.TemporaryDirectory(prefix='.restore_',dir=local) as tmp:
            tmp=Path(tmp); copied=tmp/source.name; shutil.copytree(source,copied)
            if verify(copied) != expected: raise ValueError('fetched manifest changed')
            stage='decryption'; bundle=tmp/'bundle.tar'; child(['age','-d','-i',str(identity),'-o',str(bundle),str(copied/'backup.age')])
            stage='archive_validation'; plain=tmp/'plain'; plain.mkdir()
            with tarfile.open(bundle,'r:') as archive:
                members=archive.getmembers()
                if len(members)!=4 or len({x.name for x in members})!=4 or not all(MEMBER.fullmatch(x.name) and x.isfile() for x in members): raise ValueError('invalid archive')
                for member in members:
                    with archive.extractfile(member) as src, (plain/member.name).open('xb') as dst: shutil.copyfileobj(src,dst)
            stage='legacy_restore'; env=os.environ.copy(); env['BACKUP_DIR']=str(plain)
            child(['bash',str(SCRIPT/'restore.sh'),*sys.argv[3:]],env)
            event('encrypted_offsite_validation_completed' if '--validate-only' in sys.argv[3:] else 'encrypted_offsite_restore_completed',generation=source.name)
    else: raise ValueError('invalid operation')

def main():
    global stage
    os.umask(0o077)
    os.environ.update(load_config())
    local=root('BACKUP_PRODUCTION_DIR')
    lock=local/'.production.lock'
    lock.mkdir() # stale lock requires operator inspection
    try:
        operation()
    except Exception:
        marker(sys.argv[1] if len(sys.argv)>1 and sys.argv[1] in ('backup','restore') else 'backup','failure',dict(event='operation_failed',stage=stage))
        raise
    finally: lock.rmdir()

if __name__=='__main__':
    try: main()
    except Exception:
        event('backup_production_failed',stage=stage)
        sys.exit({'configuration':2,'legacy_backup':10,'archive':11,'metadata':12,'encryption':13,'offsite_replication':14,'offsite_verification':15,'decryption':16,'archive_validation':17,'legacy_restore':18}.get(stage,1))
