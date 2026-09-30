#!/usr/bin/env python3
"""Disposable compiled-backend/PostgreSQL secret cutover drill; prints no secrets."""
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
repo = pathlib.Path(__file__).resolve().parents[2]
backend = repo / 'backend'


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


root = pathlib.Path(tempfile.mkdtemp(prefix='hc-secret-drill-')).resolve()
os.chmod(root, 0o700)
storage = root / 'storage'
storage.mkdir()
name = 'hc-secret-drill-' + uuid.uuid4().hex[:12]
dbport, appport = port(), port()
proc = None
result = {}
secret_values = []


def generate():
    value = secrets.token_hex(32)
    secret_values.append(value)
    return value


def docker(*args, stdin=None):
    completed = subprocess.run(['docker', *args], input=stdin, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError('Docker operation failed (output suppressed)')
    return completed.stdout.strip()


def request(route, token=None, data=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{appport}/api/v1/{route}',
                                 headers=headers, data=body)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def stop():
    global proc
    if proc:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        proc = None


def start():
    global proc
    proc = subprocess.Popen(['node', str(backend / 'dist/main.js')], cwd=root,
                            env=env, stdout=log, stderr=log)
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError('Backend startup failed (log suppressed)')
        try:
            if request('health/ready')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.3)
    raise RuntimeError('Backend readiness timeout')


def sql(statement):
    # SQL/password is stdin, never command arguments; PostgreSQL default does not log statements.
    return docker('exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U',
                  'postgres', '-d', 'hc_secrets', '-At', stdin=statement)


def db_password(value):
    env['DB_PASSWORD'] = value
    env['DATABASE_URL'] = f'postgres://postgres:{value}@127.0.0.1:{dbport}/hc_secrets'


def tokens(route, data):
    status, body = request(route, data=data)
    assert status in (200, 201), f'Authentication request failed: HTTP {status}'
    parsed = json.loads(body)
    pair = parsed.get('data', parsed)
    secret_values.extend([pair['accessToken'], pair['refreshToken']])
    return pair


try:
    first_db, second_db = generate(), generate()
    postgres_env = root / 'postgres.env'
    postgres_env.write_text(f'POSTGRES_PASSWORD={first_db}\nPOSTGRES_DB=hc_secrets\n')
    os.chmod(postgres_env, 0o600)
    docker('run', '-d', '--name', name, '--env-file', str(postgres_env), '-p',
           f'127.0.0.1:{dbport}:5432', 'postgres:16-alpine')
    postgres_env.unlink()
    for _ in range(100):
        try:
            sql('SELECT 1;')
            break
        except RuntimeError:
            time.sleep(0.3)
    else:
        raise RuntimeError('Database startup timeout')
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'USER') if key in os.environ}
    env.update(NODE_ENV='production', PORT=str(appport), JWT_SECRET=generate(),
               JWT_REFRESH_SECRET=generate(), METRICS_TOKEN=generate(),
               STORAGE_PATH=str(storage), FRONTEND_URL='https://secrets.example.invalid')
    db_password(first_db)
    with (root / 'runtime.log').open('w') as log:
        probe = ('const {Client}=require(' + json.dumps(str(backend / 'node_modules/pg')) + ');'
                 'const c=new Client({connectionString:process.env.DATABASE_URL});'
                 'c.connect().then(()=>c.query("SELECT 1")).then(()=>c.end()).catch(()=>process.exit(1))')
        for _ in range(100):
            if subprocess.run(['node', '-e', probe], cwd=root, env=env,
                              stdout=log, stderr=log).returncode == 0:
                break
            time.sleep(0.3)
        else:
            raise RuntimeError('Database TCP readiness timeout')
        cli, source = backend / 'node_modules/typeorm/cli.js', backend / 'dist/data-source.js'
        subprocess.run(['node', str(cli), 'migration:run', '-d', str(source),
                        '--transaction', 'all'], cwd=root, env=env,
                       stdout=log, stderr=log, check=True)
        for key, value in [('JWT_SECRET', None), ('JWT_REFRESH_SECRET', ''),
                           ('JWT_SECRET', 'a' * 64), ('METRICS_TOKEN', 'weak'),
                           ('DATABASE_URL', 'postgres://postgres:password@127.0.0.1/db')]:
            invalid = env.copy()
            if value is None:
                invalid.pop(key)
            else:
                invalid[key] = value
            rejected = subprocess.run(['node', str(backend / 'dist/main.js')],
                                      cwd=root, env=invalid, stdout=log, stderr=log, timeout=10)
            assert rejected.returncode != 0, 'Invalid production secret accepted'
        result['invalid_production_startup_rejected'] = True
        start()
        credentials = {'email': 'secrets@example.invalid', 'password': generate(), 'name': 'Drill'}
        result['stage'] = 'initial_register'
        old = tokens('auth/register', credentials)
        result['stage'] = 'initial_access'
        assert request('users/me', old['accessToken'])[0] == 200
        old_metrics = env['METRICS_TOKEN']
        result['stage'] = 'initial_metrics'
        result['initial_metrics_status'] = request('metrics', old_metrics)[0]
        assert result['initial_metrics_status'] == 200
        stop()
        result['stage'] = 'jwt_metrics_cutover'
        env.update(JWT_SECRET=generate(), JWT_REFRESH_SECRET=generate(), METRICS_TOKEN=generate())
        start()
        assert request('users/me', old['accessToken'])[0] == 403
        assert request('auth/refresh', data={'refreshToken': old['refreshToken']})[0] == 401
        fresh = tokens('auth/login', {key: credentials[key] for key in ('email', 'password')})
        rotated = tokens('auth/refresh', {'refreshToken': fresh['refreshToken']})
        assert request('users/me', rotated['accessToken'])[0] == 200
        assert request('auth/refresh', data={'refreshToken': fresh['refreshToken']})[0] == 401
        assert request('auth/refresh', data={'refreshToken': rotated['refreshToken']})[0] == 401
        result['jwt_old_invalid_new_login_refresh_reuse_revocation'] = True
        assert request('metrics', old_metrics)[0] == 401
        assert request('metrics', env['METRICS_TOKEN'])[0] == 200
        result['metrics_old_rejected_new_accepted'] = True
        stop()
        result['stage'] = 'database_cutover'
        sql(f"ALTER ROLE postgres PASSWORD '{second_db}';")
        assert subprocess.run(['node', '-e', probe], cwd=root, env=env,
                              stdout=log, stderr=log).returncode != 0
        result['db_old_credential_rejected_after_cutover'] = True
        db_password(second_db)
        start()
        assert request('health/ready')[0] == 200
        result['db_credential_cutover_ready'] = True
        stop()
        result['stage'] = 'database_rollback'
        sql(f"ALTER ROLE postgres PASSWORD '{first_db}';")
        assert subprocess.run(['node', '-e', probe], cwd=root, env=env,
                              stdout=log, stderr=log).returncode != 0
        result['db_new_credential_rejected_after_rollback'] = True
        db_password(first_db)
        start()
        assert request('health/ready')[0] == 200
        tokens('auth/login', {key: credentials[key] for key in ('email', 'password')})
        result['db_credential_rollback_ready_login'] = True
        stop()
        log.flush()
    result['stage'] = 'leakage_review'
    combined_logs = (root / 'runtime.log').read_text() + docker('logs', name)
    assert not any(value in combined_logs for value in secret_values), 'Secret detected in logs'
    result['runtime_and_database_logs_no_secret_values'] = True
    result.pop('stage', None)
    result['status'] = 'PASS'
    result['limitation'] = 'Isolated localhost compiled backend, disposable PostgreSQL; maintenance cutover with explicit token invalidation; no ingress/frontend/public deployment proof.'
except Exception as error:
    result['status'] = 'FAIL'
    result['error_type'] = type(error).__name__
    if isinstance(error, AssertionError):
        result['assertion'] = str(error)
finally:
    stop()
    try:
        docker('rm', '-f', '-v', name)
        result['cleanup_container_removed'] = name not in docker('ps', '-a', '--format', '{{.Names}}').splitlines()
    except RuntimeError:
        result['cleanup_container_removed'] = False
        result['status'] = 'FAIL'
    shutil.rmtree(root)
    result['cleanup_sensitive_temp_removed'] = not root.exists()
    print(json.dumps(result, indent=2))
    if result.get('status') != 'PASS':
        raise SystemExit(1)
