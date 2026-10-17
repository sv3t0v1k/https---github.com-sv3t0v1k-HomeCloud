#!/usr/bin/env python3
"""Reject re-executed stage exports: only cached runtime-build operations qualify."""
import json
import hashlib
from pathlib import Path
import re
import sys


def verify(text, minimum_runs=1):
    vertices = {}
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            if line.lstrip().startswith(('{', '[')):
                raise ValueError('Malformed/truncated build progress JSON')
            continue  # CLI notices are not build vertices.
        values = event.get('vertexes', [event.get('vertex', event)])
        for vertex in values:
            key = vertex.get('digest') or vertex.get('id')
            if key:
                vertices.setdefault(key, {}).update(vertex)
    operations = [v for v in vertices.values()
                  if re.search(r'(?:^|\] )(?:RUN|COPY|ADD) ', v.get('name', ''))]
    if sum(bool(re.search(r'(?:^|\] )RUN ', v.get('name', ''))) for v in operations) < minimum_runs:
        raise ValueError('Missing security-relevant stage build vertices')
    if not any('exporting' in v.get('name', '') and v.get('completed') for v in vertices.values()):
        raise ValueError('Missing completed OCI export in build progress')
    if any(not v.get('completed') or v.get('cached') is not True for v in operations):
        raise ValueError('Stage export rebuilt operations; actual runtime-build environment is not bound')
    return operations


def main():
    progress, role, source, output, metadata = sys.argv[1:]
    result = dict(format='homecloud-stage-cache-proof-v1', role=role, source_commit=source, status='BLOCKED')
    try:
        runs = {'backend-deps': 4, 'backend-builder': 5, 'frontend-deps': 2, 'frontend-builder': 3}
        result['operations'] = verify(Path(progress).read_text(), runs[role])
        result['progress_sha256'] = hashlib.sha256(Path(progress).read_bytes()).hexdigest()
        result['metadata_sha256'] = hashlib.sha256(Path(metadata).read_bytes()).hexdigest()
        build = json.loads(Path(metadata).read_text())
        if not build.get('containerimage.config.digest') or not build.get('containerimage.digest'):
            raise ValueError('Missing completed stage build result metadata')
        result['config_digest'] = build['containerimage.config.digest']
        runtime = json.loads(Path(role.split('-')[0]+'.binding.json').read_text())
        result['runtime_platform_digest'] = runtime['platform_digest']
        result['status'] = 'CACHED_RUNTIME_BUILD_OPERATIONS'
    except (OSError, ValueError, TypeError, AttributeError) as error:
        result['error'] = str(error)
        raise
    finally:
        Path(output).write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
