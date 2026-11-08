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
        result['operations'] = verify(Path(progress).read_text(), runs[role])
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
