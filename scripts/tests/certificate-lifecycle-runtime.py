#!/usr/bin/env python3
"""Disposable native Linux bind lifecycle smoke; public ACME is unproven.
Builds a temporary Python 3.11 operator image (network/package access required),
uses root-equivalent Docker socket only for this trusted repository CLI, and removes
its unique containers, native volume/private material and operator image.
Mac host shared bind rotation is unsupported: atomic symlink visibility was stale.
"""
import hashlib, json, os, pathlib, shutil, socket, ssl, subprocess, tempfile, time, uuid, threading
repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='hc-cert-runtime-',dir='/private/tmp')).resolve()
name = 'hc-cert-' + uuid.uuid4().hex[:10]
containers = []; volumes = []; image_created = False
operator_image = name + "-operator"
results = {'public_ca_issuance': 'UNPROVEN: disposable local self-signed harness', 'runtime_boundary': 'Linux daemon-side native bind; Mac host shared bind unsupported (observed stale atomic symlink)', 'operator_trust': 'Disposable operator has Docker socket root-equivalent access; controlled repository CLI only'}
def run(*args, env=None):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, env=env).strip()
def docker(*args): return run('docker', *args)
def execute(*args, fail=False):
    return docker('run','--rm','--network',name,'--entrypoint','python3',
        '-v',tls_volume+':/state', '-v',str(root)+':/harness',
        '-v',str(repo/'scripts/certificate-lifecycle.py')+':/work/scripts/certificate-lifecycle.py:ro',
        '-v','/var/run/docker.sock:/var/run/docker.sock',
        '-e','PATH=/harness/fakebin:/usr/local/bin:/usr/bin:/bin',
        '-e','HC_CLIENT_SOURCE=/harness/source2',
        '-e','HC_CLIENT_DEST=/harness/client-state/live/cert-example',
        '-e','HC_CLIENT_FAIL='+('1' if fail else '0'),
        operator_image,'/work/scripts/certificate-lifecycle.py',*args)
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def start(suffix, *args):
    n = name + '-' + suffix
    docker('run', '-d', '--name', n, *args); containers.append(n); return n
httpport, httpsport = port(), port()
def request(path='/', http=False):
    scheme, p = ('http', httpport) if http else ('https', httpsport)
    out = run('curl', '-ksS', '--max-time', '3', '-D', '-', '-H', 'Host: cert.example.invalid', f'{scheme}://127.0.0.1:{p}{path}')
    headers, body = out.split('\r\n\r\n' if '\r\n\r\n' in out else '\n\n', 1)
    return int(headers.split()[1]), headers.lower(), body

def fingerprint():
    ctx = ssl._create_unverified_context()
    with socket.create_connection(('127.0.0.1', httpsport), timeout=3) as sock:
        with ctx.wrap_socket(sock, server_hostname='cert.example.invalid') as tls:
            return hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()
def certificate(label, days):
    p = root / label; p.mkdir(mode=0o700)
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days',str(days),'-subj','/CN='+label+'.example.invalid','-addext','subjectAltName=DNS:cert.example.invalid','-keyout',str(p/'privkey.pem'),'-out',str(p/'fullchain.pem'))
    (p/'privkey.pem').chmod(0o600)
    return p
try:
    build = root/'operator-build'; build.mkdir()
    (build/'Dockerfile').write_text('FROM python:3.11-alpine\nRUN apk add --no-cache openssl docker-cli curl\n')
    docker('build','-t',operator_image,str(build)); image_created = True
    tls_volume = name+'-tls'; docker('volume','create',tls_volume); volumes.append(tls_volume)
    docker('run','--rm','--entrypoint','sh','-v',tls_volume+':/state',operator_image,'-c','chmod 700 /state')
    native = json.loads(docker('volume','inspect',tls_volume))[0]['Mountpoint']
    results['tls_mount_type'] = 'read-only bind from Docker daemon native Linux volume mountpoint'
    results['native_bind_source'] = native
    web = root/'web'; (web/'.well-known/acme-challenge').mkdir(parents=True)
    (web/'.well-known/acme-challenge/token_123').write_text('challenge-proof')
    (web/'sensitive').write_text('not-public')
    (web/'.well-known/acme-challenge/symlink').symlink_to('../../sensitive')
    source1, source2 = certificate('source1',45), certificate('source2',90)
    ca = root/'local-ca-bundle.pem'
    ca.write_bytes((source1/'fullchain.pem').read_bytes() + (source2/'fullchain.pem').read_bytes())
    acme = root/'client-state'; acme.mkdir(mode=0o700)
    live = acme/'live/cert-example'; live.mkdir(parents=True)
    fakebin = root/'fakebin'; fakebin.mkdir()
    client = fakebin/'certbot'
    client.write_text('#!/bin/sh\n[ "$HC_CLIENT_FAIL" != 1 ] || exit 1\ncp "$HC_CLIENT_SOURCE/fullchain.pem" "$HC_CLIENT_DEST/fullchain.pem"\ncp "$HC_CLIENT_SOURCE/privkey.pem" "$HC_CLIENT_DEST/privkey.pem"\nchmod 600 "$HC_CLIENT_DEST/privkey.pem"\n')
    client.chmod(0o700)
    clientenv = dict(os.environ, PATH=str(fakebin)+os.pathsep+os.environ['PATH'], HC_CLIENT_SOURCE=str(source2), HC_CLIENT_DEST=str(live))
    results['acme_client'] = 'SIMULATED certbot renewal result; no ACME protocol/public CA exercise'
    docker('network','create',name)
    (root/'frontend.conf').write_text('server { listen 80; location / { return 200 "healthy"; } }')
    frontend = start('frontend','--network',name,'--network-alias','frontend','-v',str(root/'frontend.conf')+':/etc/nginx/conf.d/default.conf:ro','nginx:alpine')
    conf = root/'ingress.conf'
    conf.write_text((repo/'deploy/ingress/default.conf.template').read_text().replace('${PUBLIC_HOST}','cert.example.invalid'))
    base = ['--hostname','cert.example.invalid','--state-dir','/state','--ca-file','/harness/local-ca-bundle.pem']
    execute('install','--cert','/harness/source1/fullchain.pem','--key','/harness/source1/privkey.pem',*base)
    ingress = start('ingress','--network',name,'-p',f'127.0.0.1:{httpport}:80','-p',f'127.0.0.1:{httpsport}:443','-v',str(conf)+':/etc/nginx/conf.d/default.conf:ro','-v',str(repo/'deploy/ingress/upgrade.conf')+':/etc/nginx/conf.d/upgrade.conf:ro','--mount','type=bind,src='+native+',dst=/etc/nginx/tls,readonly','-v',str(web)+':/var/www/acme:ro','nginx:alpine')
    for _ in range(40):
        try:
            if request()[0] == 200: break
        except (subprocess.CalledProcessError, OSError): pass
        time.sleep(.25)
    assert request()[0] == 200
    docker('exec',ingress,'nginx','-t')
    first = fingerprint()
    results['expiry_check_before'] = json.loads(execute('check',*base).splitlines()[-1])
    status, headers, body = request('/.well-known/acme-challenge/token_123',True)
    assert status == 200 and body == 'challenge-proof' and 'strict-transport-security' not in headers
    status, headers, body = request('/?q=1',True)
    assert status == 308 and 'location: https://cert.example.invalid/?q=1' in headers and 'strict-transport-security' not in headers
    assert request('/.well-known/acme-challenge/missing',True)[0] == 404
    assert request('/.well-known/acme-challenge/symlink',True)[0] in (403,404)
    assert request('/.well-known/acme-challenge/nested/private',True)[0] == 308
    assert 'strict-transport-security: max-age=31536000' in request()[1]
    results['http01_redirect_hsts'] = 'PASS'
    active = ['--container',ingress,'--probe-host',ingress,'--probe-port','443']
    renewal = ['renew',*base,*active,'--acme-dir','/harness/client-state','--webroot','/harness/web','--cert-name','cert-example']
    stop = threading.Event(); probe_errors = []; probe_count = []
    def probe_health():
        while not stop.is_set():
            try:
                assert request()[0] == 200
                probe_count.append(1)
            except BaseException as exc: probe_errors.append(type(exc).__name__)
            time.sleep(.02)
    monitor = threading.Thread(target=probe_health); monitor.start()
    try:
        execute(*renewal)
    finally:
        stop.set(); monitor.join()
    assert probe_count and not probe_errors, probe_errors
    results['healthy_requests_during_reload'] = len(probe_count)
    results['expiry_check_after'] = json.loads(execute('check',*base).splitlines()[-1])
    assert results['expiry_check_after']['days_remaining'] > results['expiry_check_before']['days_remaining']
    results['renewed_expiry_later'] = True
    for _ in range(40):
        if fingerprint() != first: break
        time.sleep(.1)
    renewed = fingerprint()
    assert renewed != first and request()[0] == 200
    results['initial_install_renewal_graceful_reload'] = 'PASS'
    try:
        execute('install','--cert','/harness/source1/fullchain.pem','--key','/harness/source2/privkey.pem',*base,*active)
        raise AssertionError('mismatched key accepted')
    except subprocess.CalledProcessError: pass
    assert fingerprint() == renewed and request()[0] == 200
    results['mismatched_install_preserves_active'] = 'PASS'
    try:
        execute(*renewal,fail=True)
        raise AssertionError('failed ACME client accepted')
    except subprocess.CalledProcessError: pass
    assert fingerprint() == renewed and request()[0] == 200
    results['failed_simulated_acme_renewal_preserves_active'] = 'PASS'
    version_before = docker('exec',ingress,'readlink','/etc/nginx/tls/current')
    unchanged = json.loads(execute(*renewal).splitlines()[-1])
    assert unchanged['status'] == 'unchanged' and docker('exec',ingress,'readlink','/etc/nginx/tls/current') == version_before
    results['idempotent_renewal'] = 'PASS'
    before = docker('exec',ingress,'readlink','/etc/nginx/tls/current')
    original = conf.read_text()
    conf.write_text(original + '\ninvalid_directive;\n')
    try:
        execute('install','--cert','/harness/source1/fullchain.pem','--key','/harness/source1/privkey.pem',*base,*active)
        raise AssertionError('invalid config accepted')
    except subprocess.CalledProcessError: pass
    finally: conf.write_text(original)
    assert docker('exec',ingress,'readlink','/etc/nginx/tls/current') == before
    docker('exec',ingress,'nginx','-t')
    assert fingerprint() == renewed and request()[0] == 200
    results['failed_config_test_preserves_active'] = 'PASS'
    results['key_permissions'] = docker('exec',ingress,'stat','-c','%a','/etc/nginx/tls/current/privkey.pem')
except BaseException as exc:
    results['failure'] = type(exc).__name__ + ': ' + str(exc)
    if isinstance(exc, subprocess.CalledProcessError): results['failure_output'] = exc.output[-2000:]
finally:
    for container in containers:
        try: (root/(container+'.log')).write_text(docker('logs',container))
        except subprocess.CalledProcessError: pass
    errors=[]
    for container in reversed(containers):
        try: docker('rm','-f',container)
        except subprocess.CalledProcessError: errors.append(container)
    try: docker('network','rm',name)
    except subprocess.CalledProcessError: errors.append(name)
    for volume in volumes:
        try: docker('volume','rm',volume)
        except subprocess.CalledProcessError: errors.append(volume)
    if image_created:
        try: docker('image','rm',operator_image)
        except subprocess.CalledProcessError: errors.append(operator_image)
    results['isolated_resources_removed'] = not errors
    for sensitive in ('tls','source1','source2','client-state','expired'):
        shutil.rmtree(root/sensitive, ignore_errors=True)
    results['sensitive_test_material_removed'] = all(not (root/p).exists() for p in ('tls','source1','source2','client-state','expired'))
    (root/'result.json').write_text(json.dumps(results,indent=2))
    print(json.dumps({'evidence':str(root),'result':results},indent=2))
if 'failure' in results or errors: raise SystemExit(1)
