#!/usr/bin/env python3
"""External TLS snapshots, guarded nginx activation and expiry signaling."""
import argparse, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, socket, ssl, subprocess, sys, time, uuid

def run(*args):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode: raise ValueError('command failed: ' + args[0])
    return p.stdout

def event(status, **fields): print(json.dumps(dict(status=status, **fields), sort_keys=True))
def fingerprint(cert): return hashlib.sha256(run('openssl','x509','-in',str(cert),'-outform','DER')).hexdigest()
def validate(cert,key,host,ca=None):
    if key.stat().st_mode & 0o077: raise ValueError('private key permissions must be 0600 or stricter')
    if not os.access(key,os.R_OK): raise ValueError('private key unreadable')
    run('openssl','x509','-in',str(cert),'-checkend','0','-noout')
    decoded=ssl._ssl._test_decode_cert(str(cert))
    if not decoded.get('subjectAltName'): raise ValueError('certificate requires SAN')
    ssl.match_hostname(decoded,host)
    if ssl.cert_time_to_seconds(decoded['notBefore']) > time.time(): raise ValueError('certificate not yet valid')
    pub=run('openssl','x509','-in',str(cert),'-pubkey','-noout')
    keypub=run('openssl','pkey','-in',str(key),'-pubout')
    if pub != keypub: raise ValueError('certificate/key mismatch')
    verify=['openssl','verify','-purpose','sslserver','-untrusted',str(cert)]
    if ca: verify += ['-CAfile',str(ca)]
    run(*verify,str(cert))
    return fingerprint(cert)
def point(state,target):
    temporary=state/('.current-'+uuid.uuid4().hex)
    temporary.symlink_to(target)
    os.replace(temporary,state/'current')
def probe(args,expected):
    context=ssl._create_unverified_context()
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        try:
            with socket.create_connection((args.probe_host,args.probe_port),timeout=2) as connection:
                with context.wrap_socket(connection,server_hostname=args.hostname) as tls:
                    if hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()==expected: return
        except OSError: pass
        time.sleep(.1)
    raise ValueError('ingress did not serve expected certificate')
def install(args):
    state=pathlib.Path(args.state_dir).resolve(); cert=pathlib.Path(args.cert).resolve(); key=pathlib.Path(args.key).resolve()
    repo=pathlib.Path(__file__).resolve().parents[1]
    if any(path==repo or repo in path.parents for path in (cert,key)): raise ValueError('certificate/key must be outside repository')
    expected=validate(cert,key,args.hostname,args.ca_file)
    current=state/'current'
    old=os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink(): raise ValueError('current must be managed symlink')
    versions=state/'versions'
    if versions.is_symlink(): raise ValueError('versions must not be symlink')
    versions.mkdir(mode=0o700,exist_ok=True)
    if versions.stat().st_mode & 0o077: raise ValueError('versions permissions must be 0700 or stricter')
    if old and ((state/old).resolve().parent != versions.resolve()): raise ValueError('current target outside managed versions')
    if old and (current/'fullchain.pem').read_bytes()==cert.read_bytes():
        validate(current/'fullchain.pem',current/'privkey.pem',args.hostname,args.ca_file)
        if args.container:
            try: probe(args,expected)
            except ValueError:
                run('docker','exec',args.container,'nginx','-t')
                run('docker','exec',args.container,'nginx','-s','reload')
                probe(args,expected)
        event('unchanged',fingerprint=expected); return
    version=versions/uuid.uuid4().hex; version.mkdir(mode=0o700)
    shutil.copyfile(cert,version/'fullchain.pem'); os.chmod(version/'fullchain.pem',0o644)
    shutil.copyfile(key,version/'privkey.pem'); os.chmod(version/'privkey.pem',0o600)
    validate(version/'fullchain.pem',version/'privkey.pem',args.hostname,args.ca_file)
    point(state,str(version.relative_to(state)))
    try:
        if args.container:
            run('docker','exec',args.container,'nginx','-t')
            run('docker','exec',args.container,'nginx','-s','reload')
            probe(args,expected)
    except Exception:
        if old:
            point(state,old)
            run('docker','exec',args.container,'nginx','-t')
            run('docker','exec',args.container,'nginx','-s','reload')
            probe(args,fingerprint(current/'fullchain.pem'))
        else: current.unlink()
        raise
    event('installed',fingerprint=expected,reloaded=bool(args.container))
def check(args):
    cert=pathlib.Path(args.state_dir)/'current/fullchain.pem'
    decoded=ssl._ssl._test_decode_cert(str(cert)); remaining=(ssl.cert_time_to_seconds(decoded['notAfter'])-time.time())/86400
    validate(cert,cert.parent/'privkey.pem',args.hostname,args.ca_file)
    status,code=('critical',2) if remaining<=args.critical_days else ('warning',1) if remaining<=args.warning_days else ('ok',0)
    event(status,days_remaining=round(remaining,2)); return code

def main():
    p=argparse.ArgumentParser(); subs=p.add_subparsers(dest='command',required=True)
    for name in ['install','check','renew']:
        sub=subs.add_parser(name); sub.add_argument('--state-dir',required=True); sub.add_argument('--hostname',required=True); sub.add_argument('--ca-file')
        if name=='check':
            sub.add_argument('--warning-days',type=int,default=30); sub.add_argument('--critical-days',type=int,default=7)
        else:
            sub.add_argument('--container'); sub.add_argument('--probe-host',default='127.0.0.1'); sub.add_argument('--probe-port',type=int,default=443)
            if name=='install': sub.add_argument('--cert',required=True); sub.add_argument('--key',required=True)
            else:
                sub.add_argument('--acme-dir',required=True); sub.add_argument('--webroot',required=True); sub.add_argument('--cert-name',required=True)
    args=p.parse_args()
    try:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*',args.hostname): raise ValueError('invalid hostname')
        state=pathlib.Path(args.state_dir).resolve()
        repo=pathlib.Path(__file__).resolve().parents[1]
        if state==repo or repo in state.parents: raise ValueError('TLS state must be outside repository')
        state.mkdir(mode=0o700,parents=True,exist_ok=True)
        if state.stat().st_mode & 0o077: raise ValueError('state directory permissions must be 0700 or stricter')
        with open(state/'.lock','a') as lock:
            os.chmod(state/'.lock',0o600); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if args.command=='check':
                if not 0<=args.critical_days<args.warning_days: raise ValueError('invalid expiry thresholds')
                return check(args)
            if args.command=='renew':
                if not args.container: raise ValueError('renew requires ingress container')
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',args.cert_name): raise ValueError('invalid cert name')
                acme=pathlib.Path(args.acme_dir).resolve()
                if acme==repo or repo in acme.parents: raise ValueError('ACME state must be outside repository')
                if acme.stat().st_mode & 0o077: raise ValueError('ACME directory must be 0700 or stricter')
                run('certbot','renew','--non-interactive','--cert-name',args.cert_name,'--webroot','-w',str(pathlib.Path(args.webroot).resolve()),'--config-dir',str(acme),'--work-dir',str(acme/'work'),'--logs-dir',str(acme/'logs'))
                args.cert=str(acme/'live'/args.cert_name/'fullchain.pem'); args.key=str(acme/'live'/args.cert_name/'privkey.pem')
            install(args); return 0
    except Exception as error:
        event('invalid' if args.command=='check' else 'failed',reason=str(error)); return 3
if __name__=='__main__': sys.exit(main())
