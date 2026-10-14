#!/usr/bin/env python3
"""Bind a retained scan to exact OCI archive bytes, platform manifest and config."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile

from provenance import Archive, digest, require


def file_digest(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return 'sha256:' + hasher.hexdigest()


def identity(path):
    store = Archive(path)
    names = store.tar.getnames()
    require(len(names) == len(set(names)), 'duplicate OCI archive members')
    index = json.loads(store.read('index.json'))
    candidates = []

    def visit(value, depth=0):
        require(depth < 5, 'nested OCI index too deep')
        for descriptor in value.get('manifests', []):
            media = descriptor.get('mediaType', '')
            if 'image.index' in media or 'manifest.list' in media:
                visit(store.get(descriptor), depth + 1)
            elif 'manifest' in media:
                manifest = store.get(descriptor)
                config = store.get(manifest['config'])
                if (config.get('os'), config.get('architecture')) == ('linux', 'amd64'):
                    candidates.append((descriptor, manifest, config))

    visit(index)
    require(len(candidates) == 1, 'one exact linux/amd64 image required')
    descriptor, manifest, config = candidates[0]
    require(bool(manifest.get('layers')), 'missing image layers')
    require(len(config.get('rootfs', {}).get('diff_ids', [])) == len(manifest['layers']), 'layer/rootfs mismatch')
    for layer in manifest['layers']:
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', layer['digest']), 'invalid layer digest')
        member = store.tar.getmember('blobs/sha256/' + layer['digest'][7:])
        require(member.isfile() and member.size == layer['size'], 'unsafe/missing layer')
        hasher = hashlib.sha256()
        stream = store.tar.extractfile(member)
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
        require('sha256:' + hasher.hexdigest() == layer['digest'], 'layer checksum mismatch')
    store.tar.close()
    return descriptor['digest'], manifest, config


def bind(archive, report, role, source, expected=None, provenance=None):
    require(re.fullmatch(r'[a-f0-9]{40}', source), 'full source commit required')
    platform_digest, manifest, config = identity(archive)
    if role in ('postgres', 'ingress', 'buildkit'):
        require(bool(expected), 'external image requires locked platform digest')
    if expected:
        require(platform_digest == expected, 'runtime lock/manifest mismatch')
    require(report.get('ArtifactType') == 'container_image', 'expected image scan')
    require(report.get('ArtifactName') == str(archive), 'scan/archive path mismatch')
    require(report.get('Metadata', {}).get('ImageID') == manifest['config']['digest'], 'scan/config digest mismatch')
    observed = report.get('Metadata', {}).get('ImageConfig', {})
    require((observed.get('os'), observed.get('architecture')) == ('linux', 'amd64'), 'scan platform mismatch')
    require(observed.get('rootfs') == config['rootfs'], 'scan/archive filesystem mismatch')
    if role not in ('postgres', 'ingress', 'buildkit'):
        labels = config.get('config', {}).get('Labels', {})
        require(labels.get('org.opencontainers.image.revision') == source, 'runtime/source mismatch')
        require(labels.get('io.homecloud.role') == role, 'runtime/role mismatch')
    if role in ('backend', 'frontend'):
        require(provenance and provenance.get('platform_digest') == platform_digest
                and provenance.get('commit') == source and provenance.get('status') == 'OFFLINE_OCI_VERIFIED',
                'missing or mismatched offline provenance')
    return dict(format='homecloud-qualified-artifact-v1', role=role, source_commit=source,
                platform='linux/amd64', archive_sha256=file_digest(archive),
                platform_digest=platform_digest, config_digest=manifest['config']['digest'],
                scan_sha256=digest(json.dumps(report, sort_keys=True).encode()),
                binding='ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED', production='NO_GO')


def loaded(archive, inspect, role, source):
    platform_digest, manifest, config = identity(archive)
    require(re.fullmatch(r'[a-f0-9]{40}', source), 'full source commit required')
    require(len(inspect) == 1 and inspect[0].get('Id') == manifest['config']['digest'], 'loaded image config mismatch')
    require(inspect[0].get('RootFS', {}).get('Layers') == config['rootfs']['diff_ids'], 'loaded image filesystem mismatch')
    labels = config.get('config', {}).get('Labels', {})
    require(labels.get('org.opencontainers.image.revision') == source and labels.get('io.homecloud.role') == role,
            'loaded source/role mismatch')
    return dict(role=role, source_commit=source, platform_digest=platform_digest,
                config_digest=manifest['config']['digest'], binding='LOADED_EXACT_OCI_CONFIG_AND_FILESYSTEM')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--report')
    parser.add_argument('--loaded-inspect')
    parser.add_argument('--role', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected')
    parser.add_argument('--provenance')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.loaded_inspect:
        require(not args.report, 'select scan or loaded proof')
        result = loaded(args.archive, json.loads(Path(args.loaded_inspect).read_text()), args.role, args.source)
        Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
        return
    require(bool(args.report), 'scan report required')
    report = json.loads(Path(args.report).read_text())
    provenance = json.loads(Path(args.provenance).read_text()) if args.provenance else None
    result = bind(args.archive, report, args.role, args.source, args.expected, provenance)
    result['scan_sha256'] = file_digest(args.report)
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
