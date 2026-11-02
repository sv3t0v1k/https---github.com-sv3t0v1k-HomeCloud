#!/usr/bin/python3 -IS
"""Separately qualified, installed root trust anchor. Read-only; no installer entry."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import types

ROOT = Path('/home/hs/homecloud-test')
ANCHOR = Path('/usr/local/sbin/homecloud-update-verify')
# Updating any helper requires independent review and reprovisioning this anchor.
QUALIFIED = {
    'boundary': ('deploy/linux/root-boundary.py', '3666305520396683702a9f18cb0504c2aa2f8534f8ef3c3b99801d0f9b789ad4'),
    'admission': ('deploy/linux/update-admission.py', '15d9a20a6941b8595a7a7d3b417b5d5cabbd62eb971faa0b9b20a38b4ef3fef0'),
    'update_evidence': ('deploy/linux/update_evidence.py', '94b42a266489de833c34ce9816e51de27894ca85bc19532b70f96f1ad153be8d'),
    'update_source': ('deploy/linux/update_source.py', '985252f556b9f0cf401161bef34f0a9b9c63a0d33eda59093a7bdcc5870cb3fb'),
    'provenance': ('scripts/ci/provenance.py', 'a980a0df181bbddda4c83c02d85989219bfeae8ac90509b0d48d5d7c0ebd1f56'),
    'test_contract': ('scripts/ci/test-channel.py', '458197501f93e4784d51d576964a1a47b43e9925ca3eb9ee6d961eb023c5f03c'),
}
MAX_BLOB = 16 * 1024 * 1024


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def load_helpers(root):
    """Execute only pinned bytes; never add checkout directories to sys.path."""
    modules = {}
    for name, (path, expected) in QUALIFIED.items():
        fd = os.open(root / path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_BLOB,
                    'unsafe helper')
            raw = os.read(fd, MAX_BLOB + 1)
        finally:
            os.close(fd)
        require(hashlib.sha256(raw).hexdigest() == expected, 'unqualified host helper')
        module = types.ModuleType(name)
        module.__file__ = str(root / path)
        # Dependencies are the explicit pinned modules already loaded, or stdlib.
        sys.modules[name] = module
        exec(compile(raw, module.__file__, 'exec'), module.__dict__)
        modules[name] = module
    return modules


class GitSource:
    """Only read objects already present in the trusted local repository."""
    def __init__(self, root, environment):
        self.root, self.environment = root, environment

    def git(self, *args):
        result = subprocess.run(
            ['/usr/bin/git', '--no-pager', '-c', 'core.hooksPath=/dev/null',
             '-c', 'core.fsmonitor=false', *args], cwd=self.root,
            env=self.environment, capture_output=True, timeout=30, check=True)
        return result.stdout

    def head(self):
        return self.git('rev-parse', '--verify', 'HEAD').strip()

    def inventory(self, commit):
        require(type(commit) is str and re.fullmatch('[a-f0-9]{40}', commit),
                'invalid target commit')
        require(self.git('cat-file', '-t', commit).strip() == b'commit',
                'target is not a commit')
        entries = {}
        for record in self.git('ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
            if record:
                metadata, path = record.split(b'\t', 1)
                entries[path.decode('utf-8')] = metadata.split()
        return entries

    def reader(self, commit):
        entries = self.inventory(commit)
        def read(path):
            entry = entries.get(path)
            require(entry is not None and entry[0] in (b'100644', b'100755')
                    and entry[1] == b'blob', 'target file missing or not regular')
            oid = entry[2].decode('ascii')
            require(int(self.git('cat-file', '-s', oid)) <= MAX_BLOB, 'target blob too large')
            return self.git('cat-file', 'blob', oid)
        return read, entries


def target_sources(manifest, contract, source):
    # Preserve the existing installer gate, without importing installer code.
    current = source.head().decode('ascii')
    for directory in ('deploy', 'scripts'):
        require(source.git('rev-parse', current + ':' + directory) ==
                source.git('rev-parse', manifest['commit'] + ':' + directory),
                'root helper tree changed; separate qualification required')
    read, entries = source.reader(manifest['commit'])
    for path, expected in QUALIFIED.values():
        require(hashlib.sha256(read(path)).hexdigest() == expected,
                'target host helper changed; separate qualification required')
    require(manifest['source_files'] == {
        path: hashlib.sha256(read(path)).hexdigest() for path in contract.FILES
    }, 'target source hashes mismatch')
    migrations = []
    prefix = 'backend/src/migrations/'
    for path in sorted(p for p in entries if p.startswith(prefix)):
        filename = path[len(prefix):]
        require(contract.MIGRATION.fullmatch(filename), 'unsupported target migration')
        raw = read(path)
        classes = re.findall(r'export class ([A-Za-z0-9]+)', raw.decode('utf-8'))
        require(len(classes) == 1, 'invalid target migration class')
        migrations.append(dict(name=classes[0], file=filename,
                               sha256=hashlib.sha256(raw).hexdigest()))
    require(migrations == manifest['schema_migrations'], 'target migrations mismatch')
    return read


def verify_request(raw, modules, client, source, trust_check):
    admission, contract = modules['admission'], modules['test_contract']
    request = admission.validate_request(raw)
    trust_check()
    initial_head = source.head()
    fetch = modules['update_source'].fetch_test_evidence
    manifest = fetch(request['manifestSha256'], contract.shape, client)
    read = target_sources(manifest, contract, source)
    provenance = modules['provenance']
    for role in ('backend', 'frontend'):
        image = manifest['images'][role]
        proof = provenance.verify(provenance.Registry(manifest['repository'] + '/' + role),
                                  image['digest'], role, manifest['commit'],
                                  manifest['repository'], image['version'], source_reader=read)
        require(all(proof[key] == image[field] for key, field in (
            ('index_digest', 'digest'), ('platform_digest', 'platform_digest'),
            ('statement_digest', 'statement_digest'))), 'remote provenance binding mismatch')
    # Re-fetch after registry reads: close the complete verification window.
    require(fetch(request['manifestSha256'], contract.shape, client) == manifest,
            'remote TEST evidence changed')
    trust_check()
    require(source.head() == initial_head, 'trusted checkout HEAD changed')
    return dict(status='HOST_VERIFIED_READ_ONLY', manifestSha256=request['manifestSha256'],
                commit=manifest['commit'], installation_enabled=False,
                provenance_signature='UNSIGNED')


def main():
    require(os.geteuid() == 0 and sys.flags.isolated and sys.flags.no_site,
            'requires root and python -I -S')
    require(Path(__file__).absolute() == ANCHOR, 'use separately provisioned trust anchor')
    # -I -S excludes checkout, PYTHONPATH, user and site packages before any import.
    modules = load_helpers(ROOT)
    boundary = modules['boundary']
    def trust_check():
        boundary.trusted_path(ANCHOR)
        boundary.validate_checkout(ROOT)
        # Re-read/re-hash without executing code again.
        for path, expected in QUALIFIED.values():
            require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected,
                    'host helper changed')
    trust_check()
    require(len(sys.argv) == 1, 'no command arguments accepted')
    # Read once with the existing no-follow, ownership and length contract. No unlink/write.
    admission = modules['admission']
    admission.private_directory(admission.INBOX, 0o770, admission.GID)
    request = admission.read_request()
    client = modules['update_source'].GitHubClient(os.environ.get('GH_TOKEN', ''))
    print(json.dumps(verify_request(json.dumps(request).encode(), modules, client,
                    GitSource(ROOT, boundary.clean_environment()), trust_check), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never emit remote bodies, exception chains, URLs or credentials.
        sys.exit('STOP: host evidence verification refused; operator review required')
