#!/usr/bin/env python3
"""Isolated executable ingress -> frontend -> current backend TLS smoke.
Requires built backend/dist and frontend/dist, Docker, openssl, curl, and
local homecloud-frontend:latest nginx and postgres:16-alpine images. Builds disposable current backend dependencies. No public CA proof.
Only uniquely named containers/networks created by this script are removed.
"""
import base64, hashlib, json, os, pathlib, socket, subprocess, tempfile, time, uuid
repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='hc-tls-proxy-'))
name = 'hc-tls-' + uuid.uuid4().hex[:10]
resources = []; networks = []; image_created = False; runtime_image = name+'-deps'; result = {}; failure = None

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()
def docker(*args): return run('docker', *args)
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def start(suffix, *args):
    n = name + '-' + suffix
    docker('run', '-d', '--name', n, *args); resources.append(n); return n
httpport, httpsport = port(), port()

def request(path, token=None, data=None, content_type='application/json', headers=None, http=False):
    target = ('http' if http else 'https') + '://127.0.0.1:' + str(httpport if http else httpsport) + path
    args = ['curl', '-ksS', '--max-time', '15', '-D', str(root/'headers'), '-o', str(root/'body'), '-w', '%{http_code}', '-H', 'Host: proxy.example.invalid']
    for k, v in (headers or {}).items(): args += ['-H', k + ': ' + v]
    if token: args += ['-H', 'Authorization: Bearer ' + token]
    if data is not None:
        if isinstance(data, dict): data = json.dumps(data).encode()
        (root/'request-body').write_bytes(data)
        args += ['-H', 'Content-Type: '+content_type, '--data-binary', '@'+str(root/'request-body')]
    code = int(run(*args, target))
    h = dict(line.split(':', 1) for line in (root/'headers').read_text().splitlines() if ':' in line)
    return code, (root/'body').read_bytes(), {k.lower(): v.strip() for k, v in h.items()}
def wait_backend():
    code = "require('http').get('http://localhost:3000/api/v1/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
    for _ in range(100):
        try: docker('exec', backend, 'node', '-e', code); return
        except subprocess.CalledProcessError: time.sleep(.3)
    raise RuntimeError('backend readiness timeout')
def container_requests(network, ip, url, routes, headers=None):
    # Dedicated source IPs prove ingress rewrites spoofed chains independently.
    script = "const u="+json.dumps(url)+",paths="+json.dumps(routes)+",headers="+json.dumps(headers or {})+";async function go(){const out=[];for(const p of paths){out.push(await new Promise((resolve,reject)=>require(u.startsWith('https')?'https':'http').get(u+p,{rejectUnauthorized:false,headers},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve({status:r.statusCode,body:b}));}).on('error',reject)));}console.log(JSON.stringify(out));}go().catch(e=>{console.error(e);process.exit(1)})"
    return json.loads(docker('run', '--rm', '--network', network, '--ip', ip, '--entrypoint', 'node', runtime_image, '-e', script))
try:
    for image in ['homecloud-frontend:latest','postgres:16-alpine']: docker('image','inspect',image)
    docker('build','--target','deps','-t',runtime_image,str(repo/'backend')); image_created=True
    assert (repo/'backend/dist/main.js').exists() and (repo/'frontend/dist/index.html').exists(), 'Build backend and frontend first'
    # Abort on existing overlapping subnets instead of modifying any network.
    import ipaddress
    existing = json.loads(docker('network', 'inspect', *docker('network', 'ls', '-q').splitlines()))
    for n in existing:
        for c in n['IPAM'].get('Config') or []:
            if c.get('Subnet') and ':' not in c['Subnet']:
                assert not any(ipaddress.ip_network(c['Subnet']).overlaps(ipaddress.ip_network(s)) for s in ['172.29.0.0/24','172.30.0.0/24']), 'Proxy smoke subnet already occupied'
    edge, internal = name+'-edge', name+'-internal'
    for n, subnet in [(edge,'172.29.0.0/24'),(internal,'172.30.0.0/24')]:
        docker('network','create','--subnet',subnet,n); networks.append(n)
    db = start('db','--network',internal,'--network-alias','db','-e','POSTGRES_PASSWORD=tls-db-938475abcdef','-e','POSTGRES_DB=hc_tls','postgres:16-alpine')
    for _ in range(100):
        try: docker('exec',db,'pg_isready','-U','postgres','-d','hc_tls'); break
        except subprocess.CalledProcessError: time.sleep(.3)
    env = dict(NODE_ENV='production',PORT='3000',DATABASE_URL='postgres://postgres:tls-db-938475abcdef@db/hc_tls',DB_PASSWORD='tls-db-938475abcdef',JWT_SECRET='tls-access-938475abcdefghijklmnopqrstuvwxyz',JWT_REFRESH_SECRET='tls-refresh-938475abcdefghijklmnopqrstuvwxyz',STORAGE_PATH='/tmp/storage',FRONTEND_URL='https://proxy.example.invalid',METRICS_TOKEN='tls-metrics-938475abcdefghijklmnopqrstuvwxyz',TRUSTED_PROXY_IP='172.30.0.10')
    envargs = sum((['-e',k+'='+v] for k,v in env.items()),[])
    mounts = ['-v',str(repo/'backend/dist')+':/app/dist:ro']
    docker('run','--rm','--network',internal,*envargs,*mounts,runtime_image,'node','node_modules/typeorm/cli.js','migration:run','-d','dist/data-source.js','--transaction','all')
    backend = start('backend','--network',internal,'--network-alias','homebackend',*envargs,*mounts,runtime_image,'node','dist/main.js')
    wait_backend()
    frontendconf = (repo/'frontend/nginx.conf').read_text()
    # Test-only route, separate Express diagnostic listener, never product code.
    frontendconf = frontendconf.replace('  location / {', '  location = /api/v1/probe { proxy_pass http://homebackend:3001; proxy_set_header Host $authoritative_host; proxy_set_header X-Forwarded-Host $authoritative_host; proxy_set_header X-Forwarded-Proto $authoritative_proto; proxy_set_header X-Forwarded-For $remote_addr; }\n  location / {')
    (root/'frontend.conf').write_text(frontendconf)
    diagnostic = "const express=require('express'),p=require('./dist/common/trusted-proxy'),s=require('./dist/common/security.config'),rate=require('express-rate-limit');const app=express();p.configureTrustedProxy(app,{get:k=>k==='TRUSTED_PROXY_IP'?'172.30.0.10':undefined});app.use(rate({...s.getAuthRateLimitOptions(),windowMs:60000,max:10}));app.get('*',(req,res)=>res.json({ip:p.clientIp(req),protocol:req.protocol,host:req.hostname}));app.listen(3001,'0.0.0.0');"
    docker('exec','-d',backend,'node','-e',diagnostic)
    frontend = start('frontend','--network',internal,'--ip','172.30.0.10','--network-alias','frontend','-v',str(root/'frontend.conf')+':/etc/nginx/conf.d/default.conf:ro','-v',str(repo/'frontend/dist')+':/usr/share/nginx/html:ro','homecloud-frontend:latest')
    docker('network','connect','--ip','172.29.0.20','--alias','frontend',edge,frontend)
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=proxy.example.invalid','-keyout',str(root/'privkey.pem'),'-out',str(root/'fullchain.pem'))
    (root/'ingress.conf').write_text((repo/'deploy/ingress/default.conf.template').read_text().replace('${PUBLIC_HOST}','proxy.example.invalid'))
    ingress = start('ingress','--network',edge,'--ip','172.29.0.10','-p',f'127.0.0.1:{httpport}:80','-p',f'127.0.0.1:{httpsport}:443','-v',str(root/'ingress.conf')+':/etc/nginx/conf.d/default.conf:ro','-v',str(repo/'deploy/ingress/upgrade.conf')+':/etc/nginx/conf.d/upgrade.conf:ro','-v',str(root)+':/etc/nginx/tls:ro','homecloud-frontend:latest')
    for _ in range(40):
        try:
            if request('/')[0] == 200: break
        except subprocess.CalledProcessError: pass
        time.sleep(.25)
    for c in [frontend,ingress]: docker('exec',c,'nginx','-t')
    code,body,h=request('/?x=1',http=True); assert code==308 and h['location']=='https://proxy.example.invalid/?x=1'; assert 'strict-transport-security' not in h
    result['http_redirect_no_hsts']=True
    code,body,h=request('/'); assert code==200
    for header in ['strict-transport-security','x-content-type-options','referrer-policy','x-frame-options','content-security-policy','permissions-policy']: assert header in h, header
    result['https_tls_headers_root']=True
    asset_count=0
    for asset in (repo/'frontend/dist').rglob('*'):
        if asset.suffix in ['.js','.css','.woff','.woff2']:
            path='/'+asset.relative_to(repo/'frontend/dist').as_posix()
            assert request(path)[0]==200, path
            asset_count+=1
    assert asset_count>0
    result['same_origin_csp_assets_served']=asset_count
    result['browser_limitation']='Asset/CSP source verification only; no full browser interaction claim.'
    for path in ['/api/v1/health','/api/v1/health/ready','/api/v1/metrics','/API/v1/HEALTH/ready/','/api//v1//metrics','/health/ready']:
        assert request(path)[0]==404, path
    result['operational_public_blocked']=True
    metrics = container_requests(internal,'172.30.0.45','http://homebackend:3000',['/api/v1/metrics'])[0]
    assert metrics['status']==401
    assert container_requests(internal,'172.30.0.45','http://homebackend:3000',['/api/v1/metrics'],{'Authorization':'Bearer incorrect-token'})[0]['status']==401
    assert container_requests(internal,'172.30.0.45','http://homebackend:3000',['/api/v1/metrics'],{'Authorization':'Bearer '+env['METRICS_TOKEN']})[0]['status']==200
    result['internal_metrics_token_enforced']=True
    assert docker('inspect',backend,'--format','{{json .HostConfig.PortBindings}}') in ['null','{}']
    direct = container_requests(internal,'172.30.0.40','http://homebackend:3001',['/probe'],{'X-Forwarded-For':'198.51.100.42','X-Forwarded-Proto':'https','X-Forwarded-Host':'evil.invalid'})[0]
    assert json.loads(direct['body'])=={'ip':'172.30.0.40','protocol':'http','host':'homebackend'}
    direct_limit = container_requests(internal,'172.30.0.40','http://homebackend:3001',['/probe']*10,{'X-Forwarded-For':'203.0.113.88','X-Forwarded-Proto':'https'})
    assert all(x['status']==200 for x in direct_limit[:9]) and direct_limit[9]['status']==429
    assert container_requests(internal,'172.30.0.40','http://homebackend:3001',['/probe'],{'X-Forwarded-For':'203.0.113.89'})[0]['status']==429
    result['direct_spoof_rotation_limited']=True
    spoof={'Host':'proxy.example.invalid','X-Forwarded-For':'198.51.100.42, 203.0.113.8','X-Forwarded-Proto':'http','X-Forwarded-Host':'evil.invalid'}
    a=container_requests(edge,'172.29.0.40','https://172.29.0.10',['/api/v1/probe']*11,spoof)
    assert all(x['status']==200 for x in a[:10]) and a[10]['status']==429
    assert json.loads(a[0]['body'])=={'ip':'172.29.0.40','protocol':'https','host':'proxy.example.invalid'}
    b=container_requests(edge,'172.29.0.41','https://172.29.0.10',['/api/v1/probe'],spoof); assert b[0]['status']==200
    # Same exhausted source changes spoofed identity but stays rate limited.
    spoof['X-Forwarded-For']='203.0.113.99'
    assert container_requests(edge,'172.29.0.40','https://172.29.0.10',['/api/v1/probe'],spoof)[0]['status']==429
    result.update(trusted_protocol_client_host=True,direct_spoof_ignored=True,independent_client_budgets=True,spoof_rotation_limited=True,backend_no_host_publish=True)
    credentials={'email':'tls@example.invalid','password':'TlsPassword938475!','name':'TLS'}
    code,body,h=request('/api/v1/auth/register',data=credentials,headers={'X-Request-Id':'tls-proxy-runtime-938475'}); assert code==201 and h['x-request-id']=='tls-proxy-runtime-938475'
    docker('exec',db,'psql','-U','postgres','-d','hc_tls','-c',"UPDATE users SET \"storageQuota\"=1048576 WHERE email='tls@example.invalid'")
    code,body,h=request('/api/v1/auth/login',data={'email':credentials['email'],'password':credentials['password']}); assert code==200
    token=json.loads(body)['data']['accessToken']; assert request('/api/v1/files',token)[0]==200
    payload=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
    code,body,_=request('/api/v1/uploads/session',token,{'filename':'tls.png','totalSize':len(payload),'chunkSize':len(payload)}); assert code==201
    upload=json.loads(body)['data']['uploadId']; boundary='hc'+uuid.uuid4().hex
    chunk=(f'--{boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--{boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.txt"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+payload+f'\r\n--{boundary}--\r\n'.encode())
    assert request('/api/v1/uploads/session/'+upload+'/chunk',token,chunk,'multipart/form-data; boundary='+boundary)[0]==200
    code,body,_=request('/api/v1/uploads/session/'+upload+'/complete',token,{}); assert code==200
    fid=json.loads(body)['data']['id']; assert request(f'/api/v1/files/{fid}/download',token)[1]==payload
    code,body,_=request('/api/v1/sharing',token,{'fileId':fid}); assert code==201
    share=json.loads(body)['data']['token']; assert request('/api/v1/sharing/public/'+share)[0]==200
    assert request('/api/v1/sharing/public/'+share+'/download',data={})[1]==payload
    result['auth_login_root_upload_download_share']=True
    module=os.environ.get('HOMECLOUD_PLAYWRIGHT_MODULE')
    if module:
        # Local-only hostname substitution avoids OS DNS setup for browser.
        (root/'ingress.conf').write_text((repo/'deploy/ingress/default.conf.template').read_text().replace('${PUBLIC_HOST}','localhost'))
        docker('exec',ingress,'nginx','-t'); docker('exec',ingress,'nginx','-s','reload'); time.sleep(.2)
        browser_script = """const {chromium}=require(MODULE);(async()=>{const browser=await chromium.launch({headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP proxy.example.invalid 127.0.0.1']});try{const ctx=await browser.newContext({ignoreHTTPSErrors:true});const page=await ctx.newPage();const errors=[];page.on('console',m=>{if(/Content Security Policy|Refused to/i.test(m.text()))errors.push(m.text().includes('font-src')?'CSP font-src violation':m.text().slice(0,200))});page.on('pageerror',e=>errors.push(String(e)));await page.goto('https://localhost:PORT/login');await page.locator('#email').fill('tls@example.invalid');await page.locator('#password').fill('TlsPassword938475!');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForURL('**/files');await page.getByText('tls.png',{exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);if(errors.length)throw new Error(errors.join('; '));console.log(JSON.stringify({login_files_fonts_csp:true}));}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)})""".replace('MODULE',json.dumps(module)).replace(':PORT/',':'+str(httpsport)+'/')
        result['browser_hostname']='localhost substitution only; same ingress template and CSP policy'
        result['browser_smoke']=json.loads(run(os.environ.get('HOMECLOUD_NODE','node'),'-e',browser_script))
        result.pop('browser_limitation',None)
    result.update(auth_login_root_upload_download_share=True,request_id_preserved=True,payload_sha256=hashlib.sha256(payload).hexdigest(),internal_readiness=True,certificate='Disposable self-signed certificate only; public CA provisioning is not tested.',diagnostic='Test-only separate listener imports actual compiled trust proxy and production auth limiter options; no product debug route.')
except BaseException as e:
    failure = type(e).__name__+': '+str(e) if not isinstance(e,subprocess.CalledProcessError) else 'Subprocess failed with code '+str(e.returncode); result['failure']=failure
    if isinstance(e,subprocess.CalledProcessError): (root/'failure-output.log').write_text(e.output or '')
    import traceback
    result['failure_location']=[{'file':f.filename,'line':f.lineno} for f in traceback.extract_tb(e.__traceback__)]
finally:
    for n in resources:
        try: (root/(n+'.log')).write_text(docker('logs',n))
        except subprocess.CalledProcessError: pass
    cleanup_errors=[]
    for n in reversed(resources):
        try: docker('rm','-f','-v',n)
        except subprocess.CalledProcessError as e: cleanup_errors.append(n+': '+e.output)
    for n in reversed(networks):
        try: docker('network','rm',n)
        except subprocess.CalledProcessError as e: cleanup_errors.append(n+': '+e.output)
    if image_created:
        try: docker('image','rm',runtime_image)
        except subprocess.CalledProcessError as e: cleanup_errors.append(runtime_image+': '+e.output)
    result['isolated_resources_removed']=not cleanup_errors
    if cleanup_errors:
        result['cleanup_errors']=cleanup_errors
        failure=failure or 'cleanup failed'
    (root/'result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({'evidence':str(root),'result':result},indent=2))
if failure: raise SystemExit(1)
