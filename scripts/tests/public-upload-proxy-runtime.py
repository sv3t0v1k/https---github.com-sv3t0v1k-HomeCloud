#!/usr/bin/env python3
"""Exercise the real frontend nginx location selection, not a regex simulation.

Requires local Docker images supplied with --nginx-image and --node-image.
Only disposable, uniquely named containers/network and loopback ports are used.
The upstream consumes bodies; application authorization is tested separately.
"""
import argparse
import http.client
import json
import pathlib
import subprocess
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nginx-image', required=True)
    parser.add_argument('--node-image', required=True)
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[2]
    prefix = 'hc-public-chunk-' + uuid.uuid4().hex[:10]
    containers = []
    network_created = False

    def docker(*parts):
        return subprocess.check_output(['docker', *parts], stderr=subprocess.STDOUT, text=True).strip()

    def request(port, route, body=b'x'):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
        try:
            conn.request('POST', route, body, {'Content-Type': 'application/octet-stream'})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    try:
        with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
            conf = pathlib.Path(tmp) / 'frontend.conf'
            template = (repo / 'frontend/nginx.conf.template').read_text()
            conf.write_text(template.replace('${INGRESS_PROXY_IP}', '127.0.0.2'))
            # Docker Desktop does not publish loopback ports on internal-only networks.
            docker('network', 'create', prefix)
            network_created = True
            upstream = prefix + '-upstream'
            docker('run', '-d', '--name', upstream, '--network', prefix,
                   '--network-alias', 'backend', '--memory', '128m', '--cpus', '1',
                   '--entrypoint', 'node', args.node_image, '-e',
                   "require('http').createServer((req,res)=>{let bytes=0;req.on('data',b=>bytes+=b.length);"
                   "req.on('end',()=>res.end(JSON.stringify({bytes,protocol:req.headers['x-forwarded-proto']})));"
                   "}).listen(3000,'0.0.0.0')")
            containers.append(upstream)
            proxy = prefix + '-nginx'
            docker('run', '-d', '--name', proxy, '--network', prefix,
                   '--memory', '128m', '--cpus', '1', '-p', '127.0.0.1::80',
                   '--mount', f'type=bind,source={conf},target=/etc/nginx/conf.d/default.conf,readonly',
                   '--entrypoint', 'nginx', args.nginx_image, '-g', 'daemon off;')
            containers.append(proxy)
            port = int(docker('port', proxy, '80/tcp').rsplit(':', 1)[1])
            for attempt in range(40):
                try:
                    if request(port, '/api/v1/probe')[0] == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                if attempt == 39:
                    raise RuntimeError('nginx/upstream startup timeout')
                time.sleep(.1)
            docker('exec', proxy, 'nginx', '-t')
            payload = b'x' * (1024 * 1024 + 290)
            positive = ['/api/v1/uploads/session/u/chunk',
                        '/api/v1/sharing/public/t/uploads/session/u/chunk',
                        '/api/v1/sharing/public/t/uploads/session/u/chunk?retry=1']
            negative = ['/api/v1/sharing/public/t/uploads/session',
                        '/api/v1/sharing/public/t/uploads/session/u/complete',
                        '/api/v1/sharing/public/t/folders', '/api/v1/files/folders',
                        '/api/v1/uploads/session/u/chunk/extra',
                        '/api/v1/sharing/public/t/uploads/session/u/chunk/extra',
                        '/api/v1/sharing/public/t/other/uploads/session/u/chunk']
            for route in positive:
                status, response = request(port, route, payload)
                assert status == 200 and json.loads(response)['bytes'] == len(payload), (route, status)
            for route in negative:
                assert request(port, route, payload)[0] == 413, route
            assert request(port, '/api/v1/health/ready')[0] == 404
            # The existing 51 MiB ceiling still applies to both chunk routes.
            for route in positive[:2]:
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
                try:
                    conn.putrequest('POST', route)
                    conn.putheader('Content-Length', str(51 * 1024 * 1024 + 1))
                    conn.endheaders()
                    response = conn.getresponse()
                    assert response.status == 413
                    response.read()
                finally:
                    conn.close()
            print(json.dumps({'nginxSyntax': 'PASS', 'bodyBytes': len(payload),
                              'positiveLocations': len(positive), 'unrelatedRoutesStill413': len(negative),
                              'operationalEndpointBlocked': True, 'existing51MiBCeiling': 'PASS'}))
    except Exception:
        for container in containers:
            print(docker('logs', container))
        raise
    finally:
        for container in reversed(containers):
            docker('rm', '-f', container)
        if network_created:
            docker('network', 'rm', prefix)


if __name__ == '__main__':
    main()
