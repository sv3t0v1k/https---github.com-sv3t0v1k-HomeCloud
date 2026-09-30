#!/usr/bin/env bash
# Focused production backup contract tests; real age, isolated legacy-tool stubs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo 'FAIL: age and age-keygen required'; exit 1; }
python3 - "$SCRIPT_DIR" <<'PY'
import os, sys, tempfile, pathlib, shutil, subprocess, json, hashlib, importlib.util
source=pathlib.Path(sys.argv[1]).parent
passed=0
with tempfile.TemporaryDirectory(prefix='homecloud-production-test-',dir=str(pathlib.Path(tempfile.gettempdir()).resolve())) as temp:
    root=pathlib.Path(temp); scripts=root/'project'/'scripts'; scripts.mkdir(parents=True)
    for name in ('backup-production.sh','restore-offsite.sh','backup-production.py'):
        shutil.copy2(source/name,scripts/name)
    fixtures=root/'fixtures'
    subprocess.run([sys.executable,str(source/'tests/create_fixtures.py'),str(fixtures)],check=True,stdout=subprocess.DEVNULL)
    valid=fixtures/'valid'
    for item in list(valid.iterdir()):
        item.rename(valid/item.name.replace('20260101_000000','20260101_000000_12345678'))
    target=root/'target'; target.write_text('unchanged')
    (scripts/'backup.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [ "${STUB_FAIL:-}" != "" ]; then printf 'event=backup_failure stage=%s\\n' "$STUB_FAIL"; exit 1; fi
cp "$FIXTURE"/* "$BACKUP_DIR"/
''')
    (scripts/'restore.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do [ "$arg" != "--validate-only" ] || exit 0; done
printf restored > "$TARGET"
''')
    local=root/'local'; offsite=root/'offsite'; local.mkdir(mode=0o700); offsite.mkdir(mode=0o700)
    identity=root/'identity'; wrong=root/'wrong'; recipients=root/'recipients'
    for key in (identity,wrong):
        subprocess.run(['age-keygen','-o',str(key)],check=True,capture_output=True); key.chmod(0o600)
    recipient=subprocess.check_output(['age-keygen','-y',str(identity)],text=True).strip()
    recipients.write_text(recipient+'\n'); recipients.chmod(0o600)
    env=dict(os.environ,BACKUP_PRODUCTION_DIR=str(local),BACKUP_OFFSITE_DIR=str(offsite),BACKUP_OFFSITE_CONFIRMED='1',BACKUP_AGE_RECIPIENTS_FILE=str(recipients),BACKUP_AGE_IDENTITY_FILE=str(identity),BACKUP_RETAIN_COUNT='2',BACKUP_RETENTION_DAYS='0',FIXTURE=str(fixtures/'valid'),TARGET=str(target),BACKUP_WRITE_BARRIER_CONFIRMED='1')
    logs=[]
    def run(script,args=(),updates=None):
        current=env.copy(); current.update(updates or {})
        p=subprocess.run(['bash',str(scripts/script),*args],env=current,text=True,capture_output=True)
        logs.append(p.stdout+p.stderr); return p
    def check(condition,name):
        global passed
        if not condition: raise AssertionError(name+'\n'+logs[-1])
        passed+=1; print('PASS:',name)
    def generations(path): return sorted(p.name for p in path.iterdir() if p.is_dir() and p.name.startswith('hc_'))
    p=run('backup-production.sh'); check(p.returncode==0,'real age encryption and verified replication')
    names=generations(offsite); check(len(names)==1,'one completed offsite generation')
    generation=names[0]; artifact=offsite/generation/'backup.age'
    check(artifact.read_bytes().startswith(b'age-encryption.org/v1'),'standard age artifact')
    check(not any(p.suffix in ('.gz','.sql') for p in local.rglob('*')),'plaintext not published locally')
    check({p.name for p in (offsite/generation).iterdir()}=={'backup.age','manifest.json'},'offsite encrypted artifact and metadata only')
    shutil.rmtree(local); local.mkdir(mode=0o700)
    p=run('restore-offsite.sh',[generation,'--yes']); check(p.returncode==0 and target.read_text()=='restored','restore fetched from offsite after deleting local copy')
    target.write_text('unchanged')
    for key,label in ((wrong,'wrong identity'),(root/'missing','missing identity')):
        p=run('restore-offsite.sh',[generation,'--yes'],{'BACKUP_AGE_IDENTITY_FILE':str(key)})
        check(p.returncode!=0 and target.read_text()=='unchanged',label+' fails before target mutation')
    original=artifact.read_bytes(); artifact.write_bytes(original+b'corrupt')
    p=run('restore-offsite.sh',[generation,'--yes']); check(p.returncode!=0 and target.read_text()=='unchanged','corrupt offsite artifact rejected before mutation')
    artifact.write_bytes(original)
    partial=offsite/'.partial-test'; partial.mkdir(); (partial/'backup.age').write_bytes(original)
    p=run('restore-offsite.sh',['.partial-test','--yes']); check(p.returncode!=0 and target.read_text()=='unchanged','partial generation rejected')
    p=run('backup-production.sh',updates={'BACKUP_AGE_RECIPIENTS_FILE':str(root/'missing')}); check(p.returncode!=0,'missing recipients fail closed')
    bad=root/'bad-recipients'; bad.write_text('invalid-recipient\n'); bad.chmod(0o600)
    p=run('backup-production.sh',updates={'BACKUP_AGE_RECIPIENTS_FILE':str(bad)}); check(p.returncode!=0,'invalid recipients fail closed')
    blocker=root/'not-directory'; blocker.write_text('x')
    p=run('backup-production.sh',updates={'BACKUP_OFFSITE_DIR':str(blocker)}); check(p.returncode!=0 and (offsite/generation).exists(),'replication target failure preserves newest verified offsite backup')
    p=run('backup-production.sh',updates={'BACKUP_OFFSITE_CONFIRMED':'0'}); check(p.returncode!=0,'offsite acknowledgement required')
    for stage in ('pg_dump_failed','storage_tar_failed','meta_sidecar_hash_mismatch'):
        p=run('backup-production.sh',updates={'STUB_FAIL':stage}); check(p.returncode!=0 and stage in p.stdout,'legacy '+stage+' failure propagates with fixed reason')
    for _ in range(4):
        p=run('backup-production.sh'); check(p.returncode==0,'additional generation completed')
    check(len(generations(local))==2 and len(generations(offsite))==2,'retention preserves two verified generations locally and offsite')
    newest=generations(offsite)[-1]
    marker=local/'last-restore-success.json'
    sentinel=b'previous verified restore marker'; marker.write_bytes(sentinel)
    p=run('restore-offsite.sh',[newest,'--validate-only']); check(p.returncode==0,'newest retained generation remains decryptable')
    check('validation_completed' in p.stdout and 'restore_completed' not in p.stdout and marker.read_bytes()==sentinel,'validate-only reports validation and preserves restore success marker')
    marker.unlink()
    p=run('restore-offsite.sh',[newest,'--validate-only'])
    check(p.returncode==0 and not marker.exists(),'validate-only never creates restore success marker')
    # Direct helper fault injection exercises post-copy verification, without production hooks.
    spec=importlib.util.spec_from_file_location('backup_production',scripts/'backup-production.py')
    helper=importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    from unittest import mock
    from contextlib import redirect_stdout
    import io, datetime
    remote_fault=root/'fault-target'; remote_fault.mkdir(mode=0o700)
    real_copy=shutil.copytree
    def corrupt_copy(src,dst,*args,**kwargs):
        result=real_copy(src,dst,*args,**kwargs)
        with (pathlib.Path(dst)/'backup.age').open('ab') as out: out.write(b'fault')
        return result
    rejected=False
    with mock.patch.object(helper.shutil,'copytree',side_effect=corrupt_copy):
        try: helper.publish(offsite/newest,remote_fault,newest)
        except ValueError: rejected=True
    check(rejected and not list(remote_fault.iterdir()),'post-copy checksum mismatch rejects publication and cleans partial')
    with mock.patch.object(helper.shutil,'copytree',side_effect=OSError('injected')):
        try: helper.publish(offsite/newest,remote_fault,newest)
        except OSError: rejected=True
    check(not list(remote_fault.iterdir()),'copy failure leaves no completed or partial generation')
    # A matching untrusted checksum cannot bypass authenticated age decryption.
    artifact=offsite/newest/'backup.age'; manifest=offsite/newest/'manifest.json'
    original=artifact.read_bytes(); original_manifest=manifest.read_bytes()
    damaged=bytearray(original); damaged[-1]^=1; artifact.write_bytes(damaged)
    m=json.loads(original_manifest); m['sha256']=hashlib.sha256(damaged).hexdigest(); manifest.write_text(json.dumps(m))
    target.write_text('unchanged')
    p=run('restore-offsite.sh',[newest,'--yes'])
    check(p.returncode!=0 and target.read_text()=='unchanged','authenticated decryption rejects tamper even with recomputed checksum')
    artifact.write_bytes(original); manifest.write_bytes(original_manifest)
    # Retention tests use explicit historical generations, independent of current wall clock.
    retention=root/'retention'; retention.mkdir(mode=0o700)
    deterministic=[]
    for day in range(1,6):
        name=f'hc_2026010{day}T000000Z_{day:016x}'; deterministic.append(name)
        real_copy(offsite/newest,retention/name)
        meta=json.loads((retention/name/'manifest.json').read_text()); meta.update(generation=name,created_at=f'2026-01-0{day}T00:00:00Z')
        (retention/name/'manifest.json').write_text(json.dumps(meta))
    invalid=retention/'hc_20260106T000000Z_ffffffffffffffff'; invalid.mkdir(); (invalid/'backup.age').write_bytes(b'partial')
    warning=io.StringIO()
    with redirect_stdout(warning): helper.retain(retention,2,0)
    check(generations(retention)==deterministic[-2:]+[invalid.name],'retention deletes old complete sets, preserves newest two and ignores partial')
    check('invalid_generation_ignored' in warning.getvalue(),'invalid retention generation emits warning')
    same_second=root/'same-second'; same_second.mkdir(mode=0o700)
    same_names=[]
    for index in range(5):
        name=f'hc_20260107T000000Z_{index:016x}'; same_names.append(name)
        real_copy(offsite/newest,same_second/name)
        meta=json.loads((same_second/name/'manifest.json').read_text()); meta.update(generation=name,created_at='2026-01-07T00:00:00Z')
        (same_second/name/'manifest.json').write_text(json.dumps(meta))
    protected=same_names[0]
    helper.retain(same_second,2,0,protected=protected)
    check(len(generations(same_second))==2 and (same_second/protected).exists(),'same-second retention respects count and protects just-published generation')
    real_copy(offsite/newest,retention/deterministic[0])
    meta=json.loads((retention/deterministic[0]/'manifest.json').read_text()); meta.update(generation=deterministic[0],created_at='2026-01-01T00:00:00Z')
    (retention/deterministic[0]/'manifest.json').write_text(json.dumps(meta))
    warning=io.StringIO()
    with redirect_stdout(warning),mock.patch.object(helper.shutil,'rmtree',side_effect=OSError('injected')): helper.retain(retention,2,0)
    check('cleanup_failed' in warning.getvalue() and all((retention/n).exists() for n in deterministic[-2:]),'cleanup failure warns and preserves newest valid restore points')
    p=run('backup-production.sh',updates={'BACKUP_WRITE_BARRIER_CONFIRMED':'0'})
    check(p.returncode!=0,'write barrier acknowledgement required')
    all_logs='\n'.join(logs)
    secret=next(line for line in identity.read_text().splitlines() if line.startswith('AGE-SECRET-KEY-'))
    check(secret not in all_logs,'identity never leaks in logs')
print(f'Production backup focused tests: {passed} PASS, 0 FAIL')
PY
