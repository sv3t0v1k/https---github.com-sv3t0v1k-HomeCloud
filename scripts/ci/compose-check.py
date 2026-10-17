#!/usr/bin/env python3
"""Compose configuration only; no daemon calls, real env or target access."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
values = dict(COMPOSE_PROJECT_NAME='homecloud-ci', DB_PASSWORD='a'*64,
              JWT_SECRET='b'*64, JWT_REFRESH_SECRET='c'*64, REDIS_PASSWORD='d'*64,
              PUBLIC_HOST='cloud.example.invalid', SSD_DB_DIR='/tmp/hc-ci/postgres',
              HDD_STORAGE_DIR='/tmp/hc-ci/storage', TLS_CERT_DIR='/tmp/hc-ci/tls',
              ACME_WEBROOT_DIR='/tmp/hc-ci/acme', RELEASE_BACKEND_IMAGE='homecloud-backend:ci',
              RELEASE_FRONTEND_IMAGE='homecloud-frontend:ci', PUBLIC_HTTP_PORT='18080',
              PUBLIC_HTTPS_PORT='18443', PUBLIC_ORIGIN='https://cloud.example.invalid:18443',
              PUBLIC_BIND_IP='127.0.0.1', INGRESS_SUBNET='172.29.0.0/24',
              INGRESS_PROXY_IP='172.29.0.10', BACKEND_PROXY_SUBNET='172.30.0.0/24',
              FRONTEND_PROXY_IP='172.30.0.10')
with tempfile.NamedTemporaryFile(mode='w') as env:
    env.write(''.join(k+'='+v+'\n' for k, v in values.items()))
    env.flush()
    for overlays in ([], ['docker-compose.local.yml'], ['docker-compose.production.yml'],
                     ['docker-compose.production.yml', 'docker-compose.project-test.yml']):
        command = ['docker', 'compose', '--env-file', env.name, '-f', str(root/'docker-compose.yml')]
        for overlay in overlays:
            command += ['-f', str(root/overlay)]
        subprocess.run(command + ['config', '--quiet'], check=True, cwd=root,
                       env={**os.environ, 'COMPOSE_DISABLE_ENV_FILE': '1'})
        print('PASS: Compose config ' + ', '.join(['base'] + overlays))
