#!/usr/bin/env python3
"""Только offline-проверка evidence/OCI или создание нового минимального build context."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def checked_file(path, expected):
    require(path.is_file() and not path.is_symlink(), 'regular non-symlink file required: ' + str(path))
    require(sha(path) == expected, 'checksum mismatch: ' + str(path))


def load_lock():
    lock = json.loads((HERE / 'qualification.lock.json').read_text())
    require(lock['production'] == 'NO_GO' and lock['signature'] == 'UNSIGNED'
            and lock['risk_acceptance'] is False and lock['gosu_disposition_transferred'] is False,
            'preparation scope violated')
    return lock


def verify_evidence(lock):
    base = ROOT / lock['evidence_root']
    for name, expected in lock['evidence'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'unsafe evidence path')
        path = base / relative
        require(path.resolve().is_relative_to(base.resolve()), 'evidence escapes root')
        checked_file(path, expected)
    return {'status': 'RETAINED_EVIDENCE_HASHES_VERIFIED', 'files': len(lock['evidence']),
            'production': 'NO_GO', 'fresh_scan_performed': False}


def binding_module():
    path = ROOT / 'scripts/ci/oci-scan-binding.py'
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location('postgres_oci_binding', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_archive(path, lock):
    # Hash bound archive first; never extract or load any layer and never use Docker.
    checked_file(path, lock['archive_sha256'])
    manifest_digest, manifest, config = binding_module().identity(path)
    require(manifest_digest == lock['manifest'], 'qualified manifest mismatch')
    require(manifest['config']['digest'] == lock['config'], 'qualified config mismatch')
    require((config['os'], config['architecture']) == ('linux', 'amd64'), 'platform mismatch')
    return {'status': 'EXACT_RETAINED_OCI_VERIFIED', 'manifest': manifest_digest,
            'config': manifest['config']['digest'], 'layers': len(manifest['layers']),
            'signature': 'UNSIGNED', 'production': 'NO_GO'}


def prepare_context(gosu, apk, destination, lock):
    # Validate before creating output. No overwrite/merge or execution of supplied bytes.
    checked_file(gosu, lock['inputs']['gosu'])
    checked_file(apk, lock['inputs']['zlib.apk'])
    require(not destination.exists() and not destination.is_symlink(), 'new output directory required')
    destination.mkdir(mode=0o700)
    try:
        for source, name, mode in [(gosu, 'gosu', 0o755), (apk, 'zlib.apk', 0o644),
                                   (HERE / 'Dockerfile', 'Dockerfile', 0o644),
                                   (HERE / '.dockerignore', '.dockerignore', 0o644)]:
            target = destination / name
            with source.open('rb') as src, target.open('xb') as dst:
                shutil.copyfileobj(src, dst)
            target.chmod(mode)
        # Recheck the copied bytes, including a possible input change during copy.
        for name, expected in lock['inputs'].items():
            checked_file(destination / name, expected)
        import os
        for path in destination.iterdir():
            os.utime(path, (lock['source_date_epoch'], lock['source_date_epoch']))
        os.utime(destination, (lock['source_date_epoch'], lock['source_date_epoch']))
    except Exception:
        # Only this exclusively created, minimal directory is eligible for cleanup.
        shutil.rmtree(destination)
        raise
    return {'status': 'CONTEXT_PREPARED_NO_BUILD', 'path': str(destination),
            'production': 'NO_GO', 'full_oci_reproducibility': 'UNPROVEN',
            'context_sha256': {path.name: sha(path) for path in sorted(destination.iterdir())}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('evidence')
    archive = commands.add_parser('verify-archive')
    archive.add_argument('archive', type=Path)
    context = commands.add_parser('prepare-context')
    context.add_argument('--gosu', required=True, type=Path)
    context.add_argument('--apk', required=True, type=Path)
    context.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    lock = load_lock()
    verify_evidence(lock)
    if args.command == 'verify-archive':
        result = verify_archive(args.archive, lock)
    elif args.command == 'prepare-context':
        result = prepare_context(args.gosu, args.apk, args.output, lock)
    else:
        result = verify_evidence(lock)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit('STOP: ' + str(error))
