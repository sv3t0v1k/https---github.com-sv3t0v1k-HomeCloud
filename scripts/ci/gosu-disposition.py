#!/usr/bin/env python3
"""Qualify one owner-authorized gosu disposition; never filter raw scan findings."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
ELF_SHA = '52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0'
MANIFEST = 'sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551'
CONFIG = 'sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542'
TARGET = 'usr/local/bin/gosu'
EXPIRY = datetime(2026, 11, 15, tzinfo=timezone.utc)
PROOF_DIR = 'docs/evidence/d5-1-5-20261014/'
PROOFS = {
    'pg-per-cve-binary-evidence.json': '07dc1d87b24e4175b4fb989a7bad41e59d450208f092b5cf28d0cb4e79ba2f0b',
    'pg-extraction-evidence.json': '83aae46f824d1c735708ae4b2113ac003e8c666fb33526827b9da9d22936b3fa',
    'pg-govulncheck-summary.json': '2b5272fdedde4e3b7151169966e08a352c299d835da3e6af1d523b89ca8a2bdd',
    'pg-extracted-symbols.txt': 'aabf87b37f2571aea1b4b5ae0fb471ff7ccdb6de8fc790ca20cca49ad244e593',
    'pg-govulncheck.json': '0d60de75490fbd9ba2f2ef0e1327e4fd9e2e4fa4bb1de5159d6e7575aa6c7d7b',
}
POLICY = 'docs/evidence/d5-1-8-gosu-disposition-20261016.json'
spec = importlib.util.spec_from_file_location('gosu_oci_binding', Path(__file__).with_name('oci-scan-binding.py'))
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_stream(data):
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(data):
        while offset < len(data) and data[offset].isspace():
            offset += 1
        if offset == len(data):
            break
        item, offset = decoder.raw_decode(data, offset)
        yield item


def proofs(root=ROOT):
    retained = {}
    for name, expected in PROOFS.items():
        path = root / PROOF_DIR / name
        require(path.is_file() and not path.is_symlink(), 'missing or unsafe proof: '+name)
        data = path.read_bytes()
        require(sha(data) == expected, 'proof checksum mismatch: '+name)
        retained[name] = data.decode()
    extraction = json.loads(retained['pg-extraction-evidence.json'])
    require(extraction['manifest_sha256'] == MANIFEST[7:]
            and extraction['config_digest'] == CONFIG
            and extraction['gosu_final_sha256'] == ELF_SHA
            and extraction['all_layer_hashes_verified'] is True, 'proof identity mismatch')
    blob = list(json_stream(retained['pg-extracted-symbols.txt']))
    require(len(blob) == 2 and blob[0] == {'name': 'govulncheck-extract', 'version': '0.1.0'},
            'invalid binary extraction format')
    binary = blob[1]
    require((binary['goos'], binary['goarch'], binary['path']) == ('linux', 'amd64', 'github.com/tianon/gosu'),
            'binary extraction platform/main mismatch')
    symbols = binary['pkgSymbols']
    require(isinstance(symbols, list) and len(symbols) == 2962, 'missing binary symbol extraction')
    present = {(symbol.get('pkg'), symbol.get('name')) for symbol in symbols}
    require(('main', 'main') in present and ('main', 'SetupUser') in present
            and ('os', 'Open') in present and ('os', 'OpenFile') in present, 'missing positive symbol controls')
    require(not any(package == 'crypto/tls' for package, _ in present), 'affected crypto/tls package present')
    events = list(json_stream(retained['pg-govulncheck.json']))
    configs = [event['config'] for event in events if 'config' in event]
    require(len(configs) == 1 and configs[0]['scan_mode'] == 'binary'
            and configs[0]['scan_level'] == 'symbol' and configs[0]['scanner_version'] == 'v1.9.0',
            'invalid binary scanner evidence')
    advisories = [event['osv'] for event in events if isinstance(event.get('osv'), dict)
                  and event['osv'].get('id') == 'GO-2026-4337']
    require(len(advisories) == 1 and advisories[0]['aliases'] == ['CVE-2025-68121'], 'advisory alias mismatch')
    imports = [imp for affected in advisories[0]['affected']
               for imp in affected.get('ecosystem_specific', {}).get('imports', [])]
    require(imports and all(imp['path'] == 'crypto/tls' and imp['symbols'] for imp in imports),
            'advisory affected-package mismatch')
    findings = [event['finding'] for event in events if event.get('finding', {}).get('osv') == 'GO-2026-4337']
    require(findings and all(finding['trace'] == [{'module': 'stdlib', 'version': 'v1.24.6'}]
                             for finding in findings), 'unexpected affected package/function evidence')
    return {PROOF_DIR + name: expected for name, expected in PROOFS.items()}


def archive_binary(path, manifest):
    """Read only the exact regular member; reject ambiguous target layer semantics."""
    ancestors = {'usr', 'usr/local', 'usr/local/bin'}
    data = None
    with tarfile.open(path, 'r:*') as archive:
        for layer in manifest['layers']:
            stream = archive.extractfile('blobs/sha256/' + layer['digest'][7:])
            with tarfile.open(fileobj=stream, mode='r|*') as content:
                for member in content:
                    name = member.name
                    while name.startswith('./'):
                        name = name[2:]
                    require(not name.startswith('/') and '..' not in PurePosixPath(name).parts,
                            'unsafe layer path')
                    name = name.rstrip('/')
                    parent, _, leaf = name.rpartition('/')
                    if leaf.startswith('.wh.'):
                        removed = (parent + '/' if parent else '') + leaf[4:]
                        require(not (removed in ancestors or removed == TARGET
                                     or (leaf == '.wh..wh..opq' and (not parent or parent in ancestors))),
                                'target-relevant whiteout/opaque directory')
                    if name in ancestors:
                        require(member.isdir(), 'non-directory gosu ancestor mutation')
                    require(not name.startswith(TARGET + '/'), 'gosu target used as ancestor')
                    if name == TARGET:
                        require(data is None, 'gosu layer override or duplicate')
                        require(member.isfile() and member.size == 1769900, 'gosu must be exact regular file size')
                        data = content.extractfile(member).read(1769901)
    require(data is not None and len(data) == 1769900, 'exact gosu file missing')
    require(data[:4] == b'\x7fELF', 'gosu is not ELF')
    return data


def qualify(archive, source, root=ROOT, now=None):
    require(re.fullmatch(r'[a-f0-9]{40}', source or ''), 'full source commit required')
    current = now if now is not None else datetime.now(timezone.utc)
    require(current.tzinfo is not None and current < EXPIRY, 'disposition expired or time lacks timezone')
    policy = json.loads((root / POLICY).read_text())
    require(policy['cve'] == 'CVE-2025-68121' and policy['binary_sha256'] == ELF_SHA
            and policy['platform_digest'] == MANIFEST and policy['config_digest'] == CONFIG
            and policy['target'] == TARGET and policy['expires_at'] == EXPIRY.isoformat()
            and policy['authorized_disposition'] == 'not_affected'
            and policy['platform'] == 'linux/amd64' and policy['other_cves_covered'] == []
            and policy['raw_findings_retained'] is True, 'disposition authorization mismatch')
    lock = json.loads((root / 'scripts/ci/production-images.lock.json').read_text())
    require(lock['postgres'].split('@')[-1] == MANIFEST, 'PostgreSQL lock changed; disposition inactive')
    proof_hashes = proofs(root)
    platform, manifest, config = binding.identity(archive)
    require(platform == MANIFEST and manifest['config']['digest'] == CONFIG,
            'actual archive manifest/config mismatch; disposition inactive')
    require((config['os'], config['architecture']) == ('linux', 'amd64'), 'archive platform mismatch')
    binary_hash = sha(archive_binary(archive, manifest))
    require(binary_hash == ELF_SHA, 'actual gosu hash changed; disposition inactive')
    return dict(format='homecloud-gosu-disposition-qualification-v1',
                status='ACTIVE_EXACT_BINARY_NOT_AFFECTED', cve='CVE-2025-68121',
                disposition='not_affected', justification='vulnerable_code_not_present',
                source_commit=source, observed_at=current.isoformat(), expires_at=EXPIRY.isoformat(),
                platform='linux/amd64', platform_digest=platform, config_digest=CONFIG,
                archive_sha256=binding.file_digest(archive), target=TARGET, binary_sha256=binary_hash,
                proof_sha256=proof_hashes, raw_findings_retained=True, other_cves_covered=[],
                changes_severity_gate=False, production='NO_GO',
                limitations=['Exact binary only; binary symbol metadata does not reconstruct runtime call graphs.',
                             'Recorded Go vulnerability database last modified 2026-10-08; no new vulnerability scan.',
                             'Other PostgreSQL findings including 24 HIGH remain open; raw scan counts are unchanged.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        result = qualify(args.archive, args.source)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError) as error:
        result = dict(format='homecloud-gosu-disposition-qualification-v1', status='INVALID',
                      cve='CVE-2025-68121', error=str(error), source_commit=args.source,
                      raw_findings_retained=True, changes_severity_gate=False, production='NO_GO')
    Path(args.output).write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'ACTIVE_EXACT_BINARY_NOT_AFFECTED' else 1


if __name__ == '__main__':
    sys.exit(main())
