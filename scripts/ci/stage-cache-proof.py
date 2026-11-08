#!/usr/bin/env python3
"""Reject re-executed stage exports: only cached runtime-build operations qualify."""
import json
from collections import Counter
import hashlib
from pathlib import Path
import re
import sys


def verify(text, minimum_runs=1, dockerfile=None, target=None):
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
    if dockerfile is not None:
        expected = expected_operations(dockerfile, target)
        actual = Counter()
        for vertex in operations:
            match = re.fullmatch(
                r'\[([A-Za-z0-9_-]+)\s+\d+/\d+\]\s+'
                r'(RUN|COPY|ADD)\s+(.+)',
                vertex.get('name', '')
            )
            if not match:
                raise ValueError('Unrecognized Buildx operation vertex')
            stage, opcode, command = match.groups()
            actual[(stage, opcode, normalize(command))] += 1

        if actual != expected:
            raise ValueError(
                'Buildx/Dockerfile operation graph mismatch: '
                f'missing={sum((expected-actual).values())}, '
                f'unexpected={sum((actual-expected).values())}'
            )
    return operations


def normalize(command):
    return re.sub(r'\s+', ' ', command).strip()


def expected_operations(dockerfile, target):
    """Require every RUN/COPY/ADD in the reachable Dockerfile stages."""
    logical = []
    pending = ''
    for raw in dockerfile.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.endswith(chr(92)):
            pending += line[:-1].rstrip() + ' '
            continue
        logical.append(pending + line)
        pending = ''

    if pending:
        raise ValueError('Unterminated Dockerfile continuation')

    stages = {}
    current = None
    allowed = {
        'ARG', 'ENV', 'WORKDIR', 'LABEL', 'USER', 'CMD',
        'ENTRYPOINT', 'EXPOSE', 'VOLUME', 'HEALTHCHECK',
        'STOPSIGNAL', 'SHELL',
    }

    for line in logical:
        match = re.fullmatch(r'([A-Za-z]+)\s+(.+)', line)
        if not match:
            raise ValueError('Invalid Dockerfile instruction')

        opcode = match.group(1).upper()
        command = normalize(match.group(2))

        if opcode == 'FROM':
            alias = re.fullmatch(
                r'(.+)\s+[Aa][Ss]\s+([A-Za-z0-9_.-]+)',
                command
            )
            if not alias:
                raise ValueError('Unnamed Dockerfile stage')

            name = alias.group(2)
            if name in stages:
                raise ValueError('Duplicate Dockerfile stage')

            source = alias.group(1).split()[-1]
            stages[name] = {
                'depends': {source} if source in stages else set(),
                'operations': [],
            }
            current = name
            continue

        if current is None:
            if opcode != 'ARG':
                raise ValueError('Dockerfile instruction before FROM')
            continue

        if opcode in ('RUN', 'COPY', 'ADD'):
            stages[current]['operations'].append((opcode, command))
            if opcode in ('COPY', 'ADD'):
                refs = re.findall(
                    r'(?:^|\s)--from=([^\s]+)',
                    command
                )
                for ref in refs:
                    if ref not in stages:
                        raise ValueError('Unknown COPY/ADD stage reference')
                    stages[current]['depends'].add(ref)
        elif opcode not in allowed:
            raise ValueError('Unsupported Dockerfile opcode')

    if target not in stages:
        raise ValueError('Missing Dockerfile target stage')

    expected = Counter()
    visited = set()
    active = set()

    def visit(stage):
        if stage in active:
            raise ValueError('Cyclic Dockerfile stage graph')
        if stage in visited:
            return

        active.add(stage)
        for dependency in sorted(stages[stage]['depends']):
            visit(dependency)
        for opcode, command in stages[stage]['operations']:
            expected[(stage, opcode, command)] += 1
        active.remove(stage)
        visited.add(stage)

    visit(target)
    if not expected:
        raise ValueError('Empty Dockerfile operation graph')
    return expected


def file_digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return 'sha256:' + hasher.hexdigest()


def check_stage(build, stage, runtime, role, source, archive_sha, scan_sha):
    """Bind cached build metadata to the exact scanned stage archive."""
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    def valid_sha(value):
        return isinstance(value, str) and re.fullmatch(
            r'sha256:[a-f0-9]{64}', value
        ) is not None

    require(role in ('backend-deps', 'backend-builder',
                     'frontend-deps', 'frontend-builder'),
            'Unexpected stage role')
    require(isinstance(source, str) and
            re.fullmatch(r'[a-f0-9]{40}', source) is not None,
            'Invalid source commit')
    require(all(isinstance(x, dict) for x in (build, stage, runtime)),
            'Invalid build or scan metadata')

    config = build.get('containerimage.config.digest')
    manifest = build.get('containerimage.digest')

    for value in (config, manifest, archive_sha, scan_sha,
                  stage.get('config_digest'),
                  stage.get('platform_digest'),
                  stage.get('archive_sha256'),
                  stage.get('scan_sha256'),
                  runtime.get('platform_digest')):
        require(valid_sha(value), 'Invalid or missing digest')

    require(config == stage['config_digest'],
            'Buildx/OCI config digest mismatch')
    require(manifest == stage['platform_digest'],
            'Buildx/OCI manifest digest mismatch')
    require(archive_sha == stage['archive_sha256'],
            'Scanned OCI archive digest mismatch')
    require(scan_sha == stage['scan_sha256'],
            'Trivy report digest mismatch')

    descriptor = build.get('containerimage.descriptor')
    require(isinstance(descriptor, dict),
            'Missing Buildx image descriptor')
    require(descriptor.get('digest') == manifest,
            'Buildx image descriptor digest mismatch')
    require(descriptor.get('mediaType') ==
            'application/vnd.oci.image.manifest.v1+json',
            'Expected a single-platform OCI manifest')
    platform = descriptor.get('platform', {})
    require(isinstance(platform, dict) and
            platform.get('os') == 'linux' and
            platform.get('architecture') == 'amd64',
            'Buildx platform mismatch')
    annotations = descriptor.get('annotations', {})
    require(isinstance(annotations, dict), 'Invalid annotations')
    if 'config.digest' in annotations:
        require(annotations['config.digest'] == config,
                'Buildx descriptor config mismatch')

    require(stage.get('binding') ==
            'ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED',
            'Missing verified stage scan binding')
    require(stage.get('role') == role and
            stage.get('source_commit') == source and
            stage.get('platform') == 'linux/amd64',
            'Stage role/source/platform mismatch')

    component = role.split('-')[0]
    require(runtime.get('binding') ==
            'ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED' and
            runtime.get('role') == component and
            runtime.get('source_commit') == source and
            runtime.get('platform') == 'linux/amd64',
            'Runtime provenance mismatch')

    return dict(
        config_digest=config,
        platform_digest=manifest,
        archive_sha256=archive_sha,
        scan_sha256=scan_sha,
        runtime_platform_digest=runtime['platform_digest'],
    )


def main():
    progress, role, source, output, metadata, stage_binding, archive, report = sys.argv[1:]
    result = dict(format='homecloud-stage-cache-proof-v1', role=role, source_commit=source, status='BLOCKED')
    try:
        runs = {'backend-deps': 4, 'backend-builder': 5, 'frontend-deps': 2, 'frontend-builder': 3}
        component, target = role.split('-', 1)
        dockerfile = Path(component) / 'Dockerfile'
        result['dockerfile_sha256'] = file_digest(dockerfile)
        result['operations'] = verify(
            Path(progress).read_text(),
            runs[role],
            dockerfile=dockerfile.read_text(),
            target=target,
        )
        result['progress_sha256'] = hashlib.sha256(Path(progress).read_bytes()).hexdigest()
        result['metadata_sha256'] = hashlib.sha256(Path(metadata).read_bytes()).hexdigest()
        build = json.loads(Path(metadata).read_text())
        stage = json.loads(Path(stage_binding).read_text())
        runtime = json.loads(Path(role.split('-')[0]+'.binding.json').read_text())
        result.update(check_stage(
            build, stage, runtime, role, source,
            file_digest(archive), file_digest(report)
        ))
        result['stage_binding_sha256'] = file_digest(stage_binding)
        result['status'] = 'CACHED_RUNTIME_BUILD_OPERATIONS'
    except (OSError, ValueError, TypeError, AttributeError) as error:
        result['error'] = str(error)
        raise
    finally:
        Path(output).write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
