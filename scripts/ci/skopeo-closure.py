#!/usr/bin/env python3
"""Capture and strictly qualify the installed Debian package closure of skopeo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

FORMAT = 'homecloud-skopeo-apt-closure-v2'
DPKG_FORMAT = '${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\t${Pre-Depends}\t${Depends}\t${Provides}\t${Multi-Arch}\n'


def run(argv, check=True):
    result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise ValueError(f"command failed ({result.returncode}): {' '.join(argv)}: {result.stderr.strip()}")
    return result


def apt_global_trust_paths(apt_config, root=Path('/')):
    values = {}
    for line in apt_config.splitlines():
        match = re.match(r'^\s*(Dir(?:::[A-Za-z]+)*)\s+"?([^";]+)"?\s*;', line, re.IGNORECASE)
        if match:
            values[match.group(1).lower()] = match.group(2).strip()
    expected_roots = {
        'dir': ('/',),
        'dir::state': ('var/lib/apt', '/var/lib/apt'),
        'dir::state::lists': ('lists', 'lists/', '/var/lib/apt/lists', '/var/lib/apt/lists/'),
        'dir::cache': ('var/cache/apt', '/var/cache/apt'),
        'dir::cache::archives': ('archives', 'archives/', '/var/cache/apt/archives', '/var/cache/apt/archives/'),
        'dir::cache::pkgcache': ('',),
        'dir::cache::srcpkgcache': ('',),
        'dir::state::status': ('/var/lib/dpkg/status', 'status'),
    }
    if any(key in values and values[key] not in allowed for key, allowed in expected_roots.items()):
        raise ValueError('APT state, index, or package cache paths are redirected')
    etc = values.get('dir::etc', 'etc/apt')
    if etc not in ('etc/apt', '/etc/apt'):
        raise ValueError('APT global configuration directory is redirected')
    expected_paths = {
        'dir::etc::sourcelist': ('sources.list', '/etc/apt/sources.list'),
        'dir::etc::sourceparts': ('sources.list.d', '/etc/apt/sources.list.d'),
        'dir::etc::main': ('apt.conf', '/etc/apt/apt.conf'),
        'dir::etc::parts': ('apt.conf.d', '/etc/apt/apt.conf.d'),
    }
    if any(key in values and values[key] not in allowed for key, allowed in expected_paths.items()):
        raise ValueError('APT source or configuration paths are redirected')
    trusted = values.get('dir::etc::trusted', 'trusted.gpg')
    parts = values.get('dir::etc::trustedparts', 'trusted.gpg.d')
    if trusted not in ('trusted.gpg', '/etc/apt/trusted.gpg') or parts not in ('trusted.gpg.d', '/etc/apt/trusted.gpg.d'):
        raise ValueError('APT global trust roots are redirected')
    return root / 'etc/apt/trusted.gpg', root / 'etc/apt/trusted.gpg.d'


def source_uses_global_trust(source_texts):
    for content in source_texts:
        for paragraph in re.split(r'\n\s*\n', content):
            lines = [line.strip() for line in paragraph.splitlines()
                     if line.strip() and not line.lstrip().startswith('#')]
            if not lines:
                continue
            if lines[0].lower().startswith(('deb ', 'deb-src ')):
                options = re.search(r'\[([^]]*)\]', lines[0])
                if not options or not re.search(r'(?i)(?:^|\s|,)signed-by=', options.group(1)):
                    return True
            elif any(line.lower().startswith(('uris:', 'types:')) for line in lines):
                if not any(line.lower().startswith('signed-by:') for line in lines):
                    return True
    return False


def validate_global_trust_files(paths):
    for trust_path in paths:
        if trust_path.is_symlink():
            raise ValueError('APT global trust root must not be a symlink')
        if trust_path.is_dir():
            for item in trust_path.rglob('*'):
                if item.is_symlink():
                    raise ValueError('APT global trust root contains a symlink')


def reject_symlinks_below(paths):
    for directory in paths:
        if directory.is_symlink():
            raise ValueError('APT source, index, config, or keyring directory is a symlink')
        if directory.is_dir():
            for path in directory.rglob('*'):
                if path.is_symlink():
                    raise ValueError('APT source, index, config, or keyring evidence contains a symlink')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(text):
    result = {}
    for line in text.splitlines():
        fields = line.split('\t', 7)
        if len(fields) != 8:
            raise ValueError('Malformed dpkg package inventory')
        package, version, arch, status, pre_depends, depends, provides, multi_arch = fields
        if status != 'installed':
            continue
        base = package.rsplit(':', 1)[0] if ':' in package else package
        if not base or not version or not arch:
            raise ValueError('Incomplete installed package record')
        multi_arch = multi_arch or 'no'
        if multi_arch not in ('no', 'same', 'foreign', 'allowed'):
            raise ValueError('Unsupported Multi-Arch value for ' + base)
        parsed_provides = []
        for item in filter(None, (part.strip() for part in provides.split(','))):
            match = RELATION.fullmatch(item)
            if not match:
                raise ValueError('Unsupported Debian Provides expression: ' + item)
            name, qualifier, operator, provided_version = match.groups()
            if qualifier or (operator and operator != '='):
                raise ValueError('Unsupported Debian Provides expression: ' + item)
            parsed_provides.append((name, provided_version))
        key = (base, arch)
        if key in result:
            raise ValueError('Duplicate installed package identity')
        result[key] = dict(name=base, package=package, version=version, arch=arch,
                           pre_depends=pre_depends, depends=depends,
                           provides=parsed_provides, multi_arch=multi_arch)
    if not result:
        raise ValueError('Empty installed package inventory')
    return result


RELATION = re.compile(r'^\s*([a-zA-Z0-9][a-zA-Z0-9+.-]*)(?::([a-zA-Z0-9_-]+))?(?:\s*\(\s*(<<|<=|=|>=|>>|<|>)\s*([^()\s]+)\s*\))?\s*$')


def version_satisfies(actual, operator, expected):
    if not operator:
        return True
    comparison = run(['dpkg', '--compare-versions', actual, operator, expected], check=False)
    if comparison.returncode not in (0, 1):
        raise ValueError('dpkg version comparison failed')
    return comparison.returncode == 0


def relation_groups(value):
    groups = []
    for group in filter(None, (part.strip() for part in value.split(','))):
        alternatives = []
        for alternative in group.split('|'):
            match = RELATION.fullmatch(alternative.strip())
            if not match:
                # Architecture/build-profile clauses cannot be safely inferred here.
                raise ValueError('Unsupported Debian dependency expression: ' + alternative.strip())
            name, qualifier, operator, version = match.groups()
            alternatives.append((name, qualifier, operator, version))
        groups.append(alternatives)
    return groups


def dependency_closure(packages, root, compare=version_satisfies, native_arch='amd64'):
    if not isinstance(native_arch, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', native_arch):
        raise ValueError('Missing or invalid native Debian architecture')
    names = [root] if isinstance(root, str) else list(root)
    roots = []
    for name in names:
        matches = [key for key, package in packages.items() if package['name'] == name]
        if len(matches) != 1:
            raise ValueError('Expected exactly one installed dependency package: ' + name)
        roots.extend(matches)
    included, pending = set(), roots
    while pending:
        key = pending.pop()
        if key in included:
            continue
        package = packages.get(key)
        if not package:
            raise ValueError('Unknown package in dependency closure')
        included.add(key)
        for field in ('pre_depends', 'depends'):
            for alternatives in relation_groups(package[field]):
                matches = []
                for name, qualifier, operator, required in alternatives:
                    for candidate_key, candidate in packages.items():
                        provided_versions = [version for provided_name, version in candidate['provides']
                                             if provided_name == name]
                        direct = candidate['name'] == name
                        if not direct and not provided_versions:
                            continue
                        candidate_arch = native_arch if candidate['arch'] == 'all' else candidate['arch']
                        if qualifier == 'native' and candidate_arch != native_arch:
                            continue
                        if qualifier == 'any' and candidate['multi_arch'] != 'allowed':
                            continue
                        if qualifier and qualifier not in ('any', 'native') and candidate_arch != qualifier:
                            continue
                        depender_arch = native_arch if package['arch'] == 'all' else package['arch']
                        if not qualifier and candidate_arch != depender_arch and candidate['multi_arch'] != 'foreign':
                            continue
                        versions = [candidate['version']] if direct else provided_versions
                        if any(not operator or (version is not None and compare(version, operator, required))
                               for version in versions):
                            matches.append(candidate_key)
                if not matches:
                    rendered = ' | '.join(name + ((':'+qualifier) if qualifier else '')
                                          + ((' ('+operator+' '+required+')') if operator else '')
                                          for name, qualifier, operator, required in alternatives)
                    raise ValueError('Unresolved installed dependency of ' + package['name']
                                     + ' field=' + field + ' relation=' + rendered)
                # Include all installed satisfiers; never choose an unverified alternative.
                pending.extend(matches)
    return included


def apt_files(root):
    if os.environ.get('APT_CONFIG'):
        raise ValueError('External APT_CONFIG override is forbidden')
    reject_symlinks_below((root / 'etc/apt', root / 'var/lib/apt/lists', root / 'usr/share/keyrings'))
    paths = []
    for directory in (Path('/etc/apt'), Path('/var/lib/apt/lists')):
        if not directory.exists():
            raise ValueError('Missing apt evidence directory: ' + str(directory))
        for path in sorted(directory.rglob('*')):
            if not path.is_file() or path.is_symlink():
                continue
            if directory.name == 'lists' and ('partial' in path.parts or path.name.endswith('lock')):
                continue
            paths.append(dict(path=str(path.relative_to(root)), sha256=sha256(path)))
    if not any('InRelease' in item['path'] for item in paths) or not any('Packages' in item['path'] for item in paths):
        raise ValueError('Missing apt Release or package index evidence')
    sources, keyrings = [], []
    for directory in (root / 'etc/apt', root / 'usr/share/keyrings'):
        if not directory.exists():
            continue
        for path in sorted(directory.rglob('*')):
            if not path.is_file() or path.is_symlink():
                continue
            if path.name == 'sources.list' or path.suffix in ('.list', '.sources'):
                content = path.read_text(errors='strict')
                for line in content.splitlines():
                    active = line.strip()
                    if active and not active.startswith('#') and re.search(
                            r'(?i)(?:trusted\s*(?:=|:)\s*(?:yes|true|on|1)|allow[-_]insecure\s*(?:=|:)\s*(?:yes|true|on|1)|allow[-_]weak\s*(?:=|:)\s*(?:yes|true|on|1)|check-valid-until\s*(?:=|:)\s*(?:no|false|off|0))', active):
                        raise ValueError('Insecure apt source override is forbidden: ' + str(path))
                sources.append(dict(path=str(path.relative_to(root)), sha256=sha256(path)))
            if (str(path).startswith(str(root / 'usr/share/keyrings'))
                    or str(path).startswith(str(root / 'etc/apt/keyrings'))
                    or str(path).startswith(str(root / 'etc/apt/trusted.gpg'))):
                keyrings.append(dict(path=str(path.relative_to(root)), sha256=sha256(path)))
    if not sources or not keyrings:
        raise ValueError('Missing apt source or trusted keyring evidence')
    apt_config = run(['apt-config', 'dump']).stdout
    if re.search(r'(?im)^\s*(?:Acquire::AllowInsecureRepositories|Acquire::AllowDowngradeToInsecureRepositories|APT::Get::AllowUnauthenticated)\s+"?(?:true|yes|on|1)"?\s*;', apt_config):
        raise ValueError('APT insecure repository configuration is enabled')
    global_trust = apt_global_trust_paths(apt_config, root)
    validate_global_trust_files(global_trust)
    source_texts = [path.read_text(errors='strict') for path in root.joinpath('etc/apt').rglob('*')
                    if path.is_file() and (path.name == 'sources.list' or path.suffix in ('.list', '.sources'))]
    references = source_signed_by_paths(source_texts, root)
    captured_keyrings = {item['path'] for item in keyrings}
    if not references.issubset(captured_keyrings):
        raise ValueError('APT Signed-By keyring is not a captured regular file')
    if source_uses_global_trust(source_texts) and not any(path.startswith('etc/apt/trusted.gpg') for path in captured_keyrings):
        raise ValueError('APT source uses uncaptured global trust roots')
    return dict(files=paths, sources=sources, keyrings=keyrings, apt_config=apt_config,
                apt_config_sha256=hashlib.sha256(apt_config.encode()).hexdigest())


def apt_update_result(path):
    result = json.loads(Path(path).read_text())
    if (result.get('command') != ['apt-get', 'update', '--error-on=any']
            or result.get('exit_code') != 0
            or not re.fullmatch(r'[a-f0-9]{64}', result.get('log_sha256', ''))
            or not result.get('log_path') or sha256(result['log_path']) != result['log_sha256']):
        raise ValueError('APT index update was not successful or lacks bound log evidence')
    return result


def source_signed_by_paths(source_texts, root=Path('/')):
    references = set()
    for content in source_texts:
        for raw in content.splitlines():
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            values = []
            if line.lower().startswith(('deb ', 'deb-src ')):
                options = re.search(r'\[([^]]*)\]', line)
                if options:
                    option = re.search(r'(?i)(?:^|\s|,)signed-by=([^\s]+)', options.group(1))
                    if option:
                        values.extend(option.group(1).split(','))
            else:
                field = re.match(r'(?i)^signed-by:\s*(.*)$', line)
                if field:
                    values.extend(token for token in field.group(1).split() if token.startswith('/'))
            for value in values:
                logical = Path(value)
                if not logical.is_absolute() or '..' in logical.parts:
                    raise ValueError('Unsupported APT Signed-By path')
                candidate = logical if root == Path('/') else root / logical.relative_to('/')
                allowed = (root / 'usr/share/keyrings', root / 'etc/apt/keyrings', root / 'etc/apt/trusted.gpg.d')
                if not any(candidate == directory or directory in candidate.parents for directory in allowed):
                    raise ValueError('APT Signed-By path is outside hashed keyring directories')
                resolved = candidate.resolve(strict=True)
                if (not candidate.is_file() or candidate.is_symlink()
                        or not any(resolved == directory.resolve() or directory.resolve() in resolved.parents
                                   for directory in allowed)):
                    raise ValueError('APT Signed-By must reference a regular non-symlink keyring')
                references.add(str(candidate.relative_to(root)))
    return references


def configured_apt_repositories(source_texts):
    repositories = set()
    for content in source_texts:
        paragraphs = re.split(r'\n\s*\n', content)
        for paragraph in paragraphs:
            lines = [line.strip() for line in paragraph.splitlines()
                     if line.strip() and not line.lstrip().startswith('#')]
            if not lines:
                continue
            if lines[0].startswith(('deb ', 'deb-src ')):
                fields = lines[0].split()
                source_type = fields[0]
                architectures = None
                if len(fields) > 1 and fields[1].startswith('['):
                    end = next((i for i, token in enumerate(fields[1:], 1) if token.endswith(']')), None)
                    if end is None:
                        raise ValueError('Malformed apt source options')
                    options = ' '.join(fields[1:end + 1]).strip('[]').split()
                    if any(token.lower().startswith(('arch+=', 'arch-=')) for token in options):
                        raise ValueError('Unsupported apt architecture source modifier')
                    arch_option = next((token.split('=', 1)[1] for token in options if token.lower().startswith('arch=')), None)
                    if arch_option is not None:
                        architectures = set(arch_option.split(','))
                    fields = [fields[0], *fields[end + 1:]]
                if len(fields) < 4:
                    raise ValueError('Incomplete apt source entry')
                uris, suites, components = [fields[1]], [fields[2]], fields[3:]
            elif any(':' in line for line in lines):
                record = {}
                for line in lines:
                    if line.startswith((' ', '\t')):
                        continue
                    key, sep, value = line.partition(':')
                    if sep:
                        record[key.strip().lower()] = value.strip().split()
                if record.get('enabled', ['yes'])[0].lower() == 'no':
                    continue
                uris, suites = record.get('uris', []), record.get('suites', [])
                components = record.get('components', [])
                source_types = record.get('types', [])
                architectures = set(record['architectures']) if 'architectures' in record else None
                if 'architectures-add' in record or 'architectures-remove' in record:
                    raise ValueError('Unsupported apt architecture source modifiers')
                if bool(uris) != bool(suites):
                    raise ValueError('Incomplete deb822 apt source entry')
                if not source_types or not components:
                    raise ValueError('APT source lacks type or component evidence')
            else:
                continue
            for uri in uris:
                if not re.match(r'^https?://[^/]+/.+', uri):
                    raise ValueError('Unsupported or incomplete apt repository URI')
                for suite in suites:
                    for component in components:
                        for source_type in ([source_type] if lines[0].startswith(('deb ', 'deb-src ')) else source_types):
                            repositories.add((uri.rstrip('/'), suite, component, source_type, frozenset(architectures) if architectures else None))
    if not repositories:
        raise ValueError('No enabled apt repositories found')
    return repositories


def origin_matches_configured(origin, repositories, package_arch=None):
    match = re.match(r'^\d+\s+(https?://\S+)\s+([^/\s]+)/([^\s]+)\s+(\S+)\s+(Packages|Sources)$', origin)
    if not match:
        return False
    uri, suite, component, architecture, index_type = match.groups()
    uri = uri.rstrip('/')
    source_type = 'deb' if index_type == 'Packages' else 'deb-src'
    if package_arch not in (None, 'all') and architecture != package_arch:
        return False
    return any(uri == configured_uri and suite == configured_suite and component == configured_component
               and source_type == configured_type and (architectures is None or architecture in architectures or architecture == 'all')
               for configured_uri, configured_suite, configured_component, configured_type, architectures in repositories)


def package_sources(package):
    spec = package['package'] + '=' + package['version']
    show = run(['apt-cache', 'show', spec]).stdout
    stanzas = [dict(line.split(': ', 1) for line in block.splitlines() if ': ' in line)
               for block in show.strip().split('\n\n') if block.strip()]
    stanza = next((item for item in stanzas
                   if item.get('Version') == package['version']
                   and item.get('Architecture') in (package['arch'], 'all')), None)
    if not stanza or not re.fullmatch(r'[a-fA-F0-9]{64}', stanza.get('SHA256', '')):
        raise ValueError('Missing exact apt package version/SHA256: ' + package['package'])
    if not stanza.get('Filename') or not stanza.get('Package'):
        raise ValueError('Incomplete apt package metadata: ' + package['package'])
    policy = run(['apt-cache', 'policy', package['name']]).stdout
    exact_version = False
    origins = []
    for line in policy.splitlines():
        header = re.match(r'^\s*(?:\*\*\*\s*)?([^\s]+)\s+\d+\s*$', line)
        if header:
            exact_version = header.group(1) == package['version']
            continue
        if exact_version:
            if line and not line[0].isspace():
                exact_version = False
                continue
            if re.search(r'\bhttps?://', line):
                origins.append(line.strip())
    if not origins:
        raise ValueError('Missing repository origin for exact apt package: ' + package['package'])
    source_texts = [path.read_text(errors='strict') for path in Path('/etc/apt').rglob('*')
                    if path.is_file() and (path.name == 'sources.list' or path.suffix in ('.list', '.sources'))]
    configured = configured_apt_repositories(source_texts)
    if not all(origin_matches_configured(origin, configured, package['arch']) for origin in origins):
        raise ValueError('Package origin is not bound to an enabled apt source: ' + package['package'])
    return dict(source=stanza.get('Source', stanza['Package']), filename=stanza['Filename'],
                archive_sha256=stanza['SHA256'].lower(), repository_origins=origins)


def package_files(record):
    output = run(['dpkg-query', '-L', record['package']]).stdout.splitlines()
    files = []
    for raw in output:
        path = Path(raw)
        if not path.is_absolute():
            raise ValueError('dpkg listed a non-absolute package path')
        if not path.exists() and not path.is_symlink():
            raise ValueError('dpkg-listed installed package file is missing: ' + str(path))
        if path.is_symlink():
            files.append(dict(path=str(path), kind='symlink', target=os.readlink(path)))
        elif path.is_file():
            files.append(dict(path=str(path), kind='file', sha256=sha256(path)))
    if not files:
        raise ValueError('Installed package has no verifiable files: ' + record['package'])
    return files


def elf_owners(binary):
    output = run(['ldd', str(binary)]).stdout
    if output.strip() in ('statically linked', 'not a dynamic executable'):
        return []
    dependencies = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith('linux-vdso'):
            continue
        if 'not found' in line:
            raise ValueError('Unresolved skopeo runtime library: ' + line)
        match = re.search(r'=>\s+(/[^ ]+)', line)
        direct = re.match(r'(/[^ ]+)\s+\(', line)
        path = (match.group(1) if match else direct.group(1) if direct else None)
        if not path:
            raise ValueError('Cannot identify ldd dependency: ' + line)
        resolved = str(Path(path).resolve(strict=True))
        owners = run(['dpkg-query', '-S', resolved], check=False)
        if owners.returncode:
            owners = run(['dpkg-query', '-S', path], check=False)
        if owners.returncode:
            raise ValueError('Unowned skopeo runtime library: ' + path)
        package_names = set()
        for owner_line in owners.stdout.splitlines():
            owner = owner_line.split(': ', 1)[0]
            package_names.add(owner)
        if not package_names:
            raise ValueError('Unowned skopeo runtime library: ' + path)
        dependencies.append(dict(path=path, resolved_path=resolved, sha256=sha256(resolved), owners=sorted(package_names)))
    return dependencies


def baseline(path, source_commit):
    packages = run(['dpkg-query', '-W', '-f=' + DPKG_FORMAT]).stdout
    native_arch = run(['dpkg', '--print-architecture']).stdout.strip()
    evidence = dict(format=FORMAT, source_commit=source_commit,
                    run_id=os.environ.get('GITHUB_RUN_ID', ''), attempt=os.environ.get('GITHUB_RUN_ATTEMPT', ''),
                    image_os=os.environ.get('ImageOS', ''), image_version=os.environ.get('ImageVersion', ''),
                    native_arch=native_arch, packages=packages,
                    packages_sha256=hashlib.sha256(packages.encode()).hexdigest())
    if not re.fullmatch(r'[a-f0-9]{40}', evidence['source_commit']) or not evidence['run_id'].isdigit() or not evidence['attempt'].isdigit():
        raise ValueError('Missing GitHub source/run identity for apt baseline')
    Path(path).write_text(json.dumps(evidence, sort_keys=True, indent=2) + '\n')


def capture(baseline_path, output, binary, update_status):
    before = json.loads(Path(baseline_path).read_text())
    if not isinstance(before, dict) or before.get('format') != FORMAT:
        raise ValueError('Missing or unsupported skopeo baseline evidence format')
    packages_text = run(['dpkg-query', '-W', '-f=' + DPKG_FORMAT]).stdout
    native_arch = run(['dpkg', '--print-architecture']).stdout.strip()
    if before.get('native_arch') != native_arch:
        raise ValueError('Native Debian architecture changed after apt baseline')
    packages, before_packages = inventory(packages_text), inventory(before.get('packages', ''))
    executable = Path(binary).resolve(strict=True)
    if executable.name != 'skopeo' or not executable.is_file():
        raise ValueError('Expected the actual skopeo executable')
    ldd = elf_owners(executable)
    owner_names = sorted({owner.split(':', 1)[0] for library in ldd for owner in library['owners']})
    closure_keys = dependency_closure(packages, ['skopeo', *owner_names], native_arch=native_arch)
    closure = []
    for key in sorted(closure_keys):
        package = packages[key]
        record = dict(package=package, files=package_files(package))
        prior = before_packages.get(key)
        if prior and prior['version'] == package['version']:
            record['origin'] = dict(kind='github-hosted-image', image_os=before['image_os'], image_version=before['image_version'])
        else:
            record['origin'] = dict(kind='signed-apt-index', **package_sources(package))
            cache = []
            for candidate in Path('/var/cache/apt/archives').glob(package['name']+'_*.deb'):
                details = run(['dpkg-deb', '-f', str(candidate), 'Package', 'Version', 'Architecture'], check=False)
                values = [line.split(': ', 1)[1] if ': ' in line else line for line in details.stdout.splitlines()]
                if details.returncode == 0 and len(values) >= 3 and values[0].split(':', 1)[0] == package['name'] and values[1] == package['version'] and values[2] in (package['arch'], 'all'):
                    cache.append(candidate)
            if len(cache) != 1 or sha256(cache[0]) != record['origin']['archive_sha256']:
                raise ValueError('Downloaded package archive hash missing or mismatched: ' + package['package'])
            record['origin']['archive_path'] = str(cache[0].relative_to('/'))
        closure.append(record)
    tool_packages = run(['dpkg-query', '-S', str(executable)]).stdout
    package_name = tool_packages.split(': ', 1)[0].split(':', 1)[0]
    skopeo_key = next((key for key, value in packages.items() if value['name'] == 'skopeo'), None)
    if package_name != 'skopeo' or skopeo_key not in closure_keys:
        raise ValueError('skopeo executable is not owned by the qualified package')
    result = dict(format=FORMAT, source_commit=before['source_commit'], run_id=before['run_id'], attempt=before['attempt'],
                  image_os=before['image_os'], image_version=before['image_version'], baseline_sha256=before['packages_sha256'],
                  native_arch=native_arch,
                  baseline_packages=before['packages'], installed_packages=packages_text,
                  installed_inventory_sha256=hashlib.sha256(packages_text.encode()).hexdigest(),
                  apt_metadata=apt_files(Path('/')), apt_update=apt_update_result(update_status), packages=closure,
                  skopeo=dict(path=str(executable), sha256=sha256(executable), ldd=ldd))
    Path(output).write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')


def validate_evidence(evidence, rootfs_report, source_commit, run_id, attempt, image_os, image_version,
                      live_state, filesystem_root='/', compare=version_satisfies):
    if not isinstance(evidence, dict) or evidence.get('format') != FORMAT:
        raise ValueError('Missing or unsupported skopeo closure evidence')
    expected = dict(source_commit=source_commit, run_id=str(run_id), attempt=str(attempt), image_os=image_os, image_version=image_version)
    if any(evidence.get(key) != value or not value for key, value in expected.items()):
        raise ValueError('skopeo closure identity mismatch')
    if not re.fullmatch(r'[a-f0-9]{64}', evidence.get('baseline_sha256', '')) or not re.fullmatch(r'[a-f0-9]{64}', evidence.get('installed_inventory_sha256', '')):
        raise ValueError('Missing apt package inventory hashes')
    if hashlib.sha256(evidence.get('baseline_packages', '').encode()).hexdigest() != evidence['baseline_sha256']:
        raise ValueError('Baseline package inventory hash mismatch')
    installed_packages = evidence.get('installed_packages', '')
    if hashlib.sha256(installed_packages.encode()).hexdigest() != evidence['installed_inventory_sha256']:
        raise ValueError('Installed package inventory hash mismatch')
    parsed_installed = inventory(installed_packages)
    native_arch = evidence.get('native_arch')
    if not isinstance(native_arch, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', native_arch):
        raise ValueError('Missing native Debian architecture evidence')
    ldd_records = evidence.get('skopeo', {}).get('ldd', [])
    ldd_owner_names = sorted({owner.split(':', 1)[0] for item in ldd_records for owner in item.get('owners', [])})
    expected_closure = dependency_closure(parsed_installed, ['skopeo', *ldd_owner_names], compare=compare,
                                          native_arch=native_arch)
    if (not isinstance(live_state, dict) or live_state.get('installed_packages') != installed_packages
            or live_state.get('native_arch') != native_arch):
        raise ValueError('Installed package inventory changed after skopeo closure capture')
    metadata = evidence.get('apt_metadata')
    if (not isinstance(metadata, dict)
            or not isinstance(metadata.get('files'), list)
            or not isinstance(metadata.get('sources'), list) or not metadata['sources']
            or not isinstance(metadata.get('keyrings'), list) or not metadata['keyrings']
            or not re.fullmatch(r'[a-f0-9]{64}', metadata.get('apt_config_sha256', ''))
            or hashlib.sha256(metadata.get('apt_config', '').encode()).hexdigest() != metadata.get('apt_config_sha256')):
        raise ValueError('Incomplete APT source/index/keyring/configuration evidence')
    update = evidence.get('apt_update')
    if (not isinstance(update, dict) or update.get('command') != ['apt-get', 'update', '--error-on=any']
            or update.get('exit_code') != 0 or not re.fullmatch(r'[a-f0-9]{64}', update.get('log_sha256', ''))
            or not update.get('log_path')):
        raise ValueError('APT update evidence missing or unsuccessful')
    update_log = Path(update['log_path'])
    if (update_log.is_absolute() or '..' in update_log.parts
            or sha256(Path(filesystem_root) / update_log) != update['log_sha256']):
        raise ValueError('APT update log evidence missing or changed')
    files = metadata['files']
    if (not any('InRelease' in item.get('path', '') for item in files)
            or not any('Packages' in item.get('path', '') for item in files)):
        raise ValueError('Incomplete APT Release or package index evidence')
    for item in files + metadata['sources'] + metadata['keyrings']:
        relative = Path(item.get('path', ''))
        if (relative.is_absolute() or '..' in relative.parts
                or not (relative.parts[:2] == ('etc', 'apt') or relative.parts[:4] == ('var', 'lib', 'apt', 'lists') or relative.parts[:3] == ('usr', 'share', 'keyrings'))
                or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', ''))):
            raise ValueError('Invalid apt source/index evidence path or hash')
        path = Path(filesystem_root) / relative
        if not path.is_file() or sha256(path) != item.get('sha256'):
            raise ValueError('Apt source/index evidence changed')
    source_texts = []
    if os.environ.get('APT_CONFIG'):
        raise ValueError('External APT_CONFIG override is forbidden')
    reject_symlinks_below((Path(filesystem_root) / 'etc/apt', Path(filesystem_root) / 'var/lib/apt/lists', Path(filesystem_root) / 'usr/share/keyrings'))
    validate_global_trust_files(apt_global_trust_paths(metadata['apt_config'], Path(filesystem_root)))
    if re.search(r'(?im)^\s*(?:Acquire::AllowInsecureRepositories|Acquire::AllowDowngradeToInsecureRepositories|APT::Get::AllowUnauthenticated)\s+"?(?:true|yes|on|1)"?\s*;', metadata['apt_config']):
        raise ValueError('APT insecure repository configuration is enabled')
    for item in metadata['sources']:
        path = Path(filesystem_root) / item['path']
        content = path.read_text(errors='strict')
        source_texts.append(content)
        for line in content.splitlines():
            active = line.strip()
            if active and not active.startswith('#') and re.search(
                    r'(?i)(?:trusted\s*(?:=|:)\s*(?:yes|true|on|1)|allow[-_]insecure\s*(?:=|:)\s*(?:yes|true|on|1)|allow[-_]weak\s*(?:=|:)\s*(?:yes|true|on|1)|check-valid-until\s*(?:=|:)\s*(?:no|false|off|0))', active):
                raise ValueError('Insecure apt source override is forbidden')
    configured_repositories = configured_apt_repositories(source_texts)
    signed_by = source_signed_by_paths(source_texts, Path(filesystem_root))
    captured_keyrings = {item['path'] for item in metadata['keyrings']}
    if not signed_by.issubset(captured_keyrings):
        raise ValueError('APT Signed-By keyring evidence missing')
    packages = evidence.get('packages')
    if not isinstance(packages, list) or not packages:
        raise ValueError('Empty skopeo package closure')
    installed = set()
    for record in packages:
        package = record.get('package', {})
        identity = (package.get('name'), package.get('version'), package.get('arch'))
        if not all(identity) or identity in installed:
            raise ValueError('Invalid or duplicate skopeo dependency identity')
        installed.add(identity)
        package_key = (package.get('name'), package.get('arch'))
        if package_key not in parsed_installed or parsed_installed[package_key] != package:
            raise ValueError('Closure package does not match installed package inventory')
        if not record.get('files'):
            raise ValueError('Package file hashes are missing')
        if live_state.get('files', {}).get(package_key) != record['files']:
            raise ValueError('Installed package file inventory changed after capture')
        for file in record['files']:
            path = Path(file.get('path', ''))
            if file.get('kind') == 'file':
                if not path.is_file() or sha256(path) != file.get('sha256'):
                    raise ValueError('Installed dependency file changed')
            elif file.get('kind') == 'symlink':
                if not path.is_symlink() or os.readlink(path) != file.get('target'):
                    raise ValueError('Installed dependency link changed')
            else:
                raise ValueError('Unknown installed dependency file type')
        origin = record.get('origin', {})
        if origin.get('kind') == 'signed-apt-index':
            if (not re.fullmatch(r'[a-f0-9]{64}', origin.get('archive_sha256', ''))
                    or not origin.get('source') or not origin.get('filename') or not origin.get('repository_origins')):
                raise ValueError('Incomplete apt package source/hash evidence')
            if not all(origin_matches_configured(item, configured_repositories, package.get('arch'))
                       for item in origin['repository_origins']):
                raise ValueError('Package origin is not bound to an enabled apt source')
            archive_relative = Path(origin.get('archive_path', ''))
            if (archive_relative.is_absolute() or '..' in archive_relative.parts
                    or archive_relative.parts[:3] != ('var', 'cache', 'apt')):
                raise ValueError('Invalid apt package archive path')
            archive = Path(filesystem_root) / archive_relative
            if not archive.is_file() or sha256(archive) != origin['archive_sha256']:
                raise ValueError('Downloaded apt package hash mismatch')
        elif origin.get('kind') == 'github-hosted-image':
            if origin.get('image_os') != image_os or origin.get('image_version') != image_version:
                raise ValueError('Baseline package source identity mismatch')
        else:
            raise ValueError('Unknown dependency source')
    for library in evidence.get('skopeo', {}).get('ldd', []):
        if not library.get('path') or not re.fullmatch(r'[a-f0-9]{64}', library.get('sha256', '')) or not library.get('owners'):
            raise ValueError('Incomplete skopeo runtime library evidence')
        if not Path(library['resolved_path']).is_file() or sha256(library['resolved_path']) != library['sha256']:
            raise ValueError('skopeo runtime library changed')
        if not any((owner.split(':', 1)[0], owner.split(':', 1)[1] if ':' in owner else arch)
                   == (package[0], package[2])
                   for owner in library['owners'] for package in installed for arch in (package[2],)):
            raise ValueError('Unknown package owns a skopeo runtime library')
    if {(name, arch) for name, _, arch in installed} != expected_closure:
        raise ValueError('Skopeo package dependency closure is incomplete or has extras')
    if not re.fullmatch(r'[a-f0-9]{64}', evidence.get('skopeo', {}).get('sha256', '')):
        raise ValueError('Missing skopeo executable hash')
    binary = evidence['skopeo'].get('path')
    if not binary or not Path(binary).is_file() or sha256(binary) != evidence['skopeo']['sha256']:
        raise ValueError('skopeo executable changed')
    if live_state.get('skopeo_sha256') != evidence['skopeo']['sha256'] or live_state.get('ldd') != evidence['skopeo']['ldd']:
        raise ValueError('skopeo executable or runtime dependency closure changed')
    report_packages = set()
    closure_names = {(name, version.removeprefix('0:')) for name, version, _ in installed}
    strict_findings = []
    all_findings = []
    os_results = []
    for result in rootfs_report.get('Results', []):
        if result.get('Class') != 'os-pkgs':
            continue
        os_results.append(result)
        if not isinstance(result.get('Packages'), list) or not isinstance(result.get('Vulnerabilities'), list):
            raise ValueError('Incomplete rootfs OS scan result for skopeo closure')
        for item in result.get('Packages', []):
            if not isinstance(item, dict) or not item.get('Name') or not item.get('Version') or not item.get('Arch'):
                raise ValueError('Malformed rootfs package record for skopeo closure')
            version = item.get('Version', '')
            if item.get('Epoch'):
                version = str(item['Epoch']) + ':' + version
            if item.get('Release'):
                version += '-' + item['Release']
            arch = item.get('Arch')
            report_packages.add((item.get('Name'), version.removeprefix('0:'), arch))
        for finding in result.get('Vulnerabilities'):
            if (not isinstance(finding, dict) or not finding.get('VulnerabilityID') or not finding.get('PkgName')
                    or not finding.get('InstalledVersion')
                    or finding.get('Severity') not in ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')):
                raise ValueError('Malformed rootfs vulnerability record for skopeo closure')
            all_findings.append(finding)
    if not os_results or not report_packages:
        raise ValueError('Missing rootfs OS package inventory for skopeo closure')
    for name, version, arch in installed:
        if (name, version.removeprefix('0:'), arch) not in report_packages:
            raise ValueError('skopeo closure package missing from rootfs scan inventory: ' + str((name, version, arch)))
    for finding in all_findings:
        identity = (finding['PkgName'], finding['InstalledVersion'].removeprefix('0:'))
        matched = [package for package in report_packages if package[:2] == identity]
        if not matched:
            raise ValueError('Rootfs vulnerability is not bound to its package inventory')
        if identity in closure_names:
            strict_findings.append(finding)
    if any(item.get('Severity') in ('HIGH', 'CRITICAL') for item in strict_findings):
        raise ValueError('High/Critical finding in strict skopeo dependency closure')
    return dict(gate='PASS', packages=len(installed), strict_findings=len(strict_findings),
                closure_sha256=hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest())


def current_state(evidence):
    packages_text = run(['dpkg-query', '-W', '-f=' + DPKG_FORMAT]).stdout
    native_arch = run(['dpkg', '--print-architecture']).stdout.strip()
    if evidence.get('native_arch') != native_arch:
        raise ValueError('Native Debian architecture changed after skopeo capture')
    packages = inventory(packages_text)
    binary = evidence.get('skopeo', {}).get('path', '')
    if not binary or not Path(binary).is_file():
        raise ValueError('Missing actual skopeo executable for post-scan check')
    ldd = elf_owners(Path(evidence.get('skopeo', {}).get('path', '')))
    owner_names = sorted({owner.split(':', 1)[0] for item in ldd for owner in item['owners']})
    files = {key: package_files(packages[key]) for key in dependency_closure(
        packages, ['skopeo', *owner_names], native_arch=native_arch)}
    return dict(installed_packages=packages_text, native_arch=native_arch, files=files,
                skopeo_sha256=sha256(binary), ldd=ldd)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    baseline_parser = sub.add_parser('baseline')
    baseline_parser.add_argument('--output', required=True)
    baseline_parser.add_argument('--source', required=True)
    capture_parser = sub.add_parser('capture')
    capture_parser.add_argument('--baseline', required=True)
    capture_parser.add_argument('--output', required=True)
    capture_parser.add_argument('--binary', required=True)
    capture_parser.add_argument('--apt-update-status', required=True)
    evaluate_parser = sub.add_parser('evaluate')
    evaluate_parser.add_argument('--evidence', required=True)
    evaluate_parser.add_argument('--rootfs', required=True)
    evaluate_parser.add_argument('--source', required=True)
    evaluate_parser.add_argument('--run-id', required=True)
    evaluate_parser.add_argument('--attempt', required=True)
    evaluate_parser.add_argument('--image-os', required=True)
    evaluate_parser.add_argument('--image-version', required=True)
    evaluate_parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'baseline':
            if not re.fullmatch(r'[a-f0-9]{40}', args.source):
                raise ValueError('Full source commit required for apt baseline')
            baseline(args.output, args.source)
        elif args.command == 'capture':
            capture(args.baseline, args.output, args.binary, args.apt_update_status)
        else:
            evidence_path, rootfs_path = Path(args.evidence), Path(args.rootfs)
            evidence = json.loads(evidence_path.read_text())
            result = validate_evidence(evidence,
                                       json.loads(rootfs_path.read_text()), args.source, args.run_id,
                                       args.attempt, args.image_os, args.image_version, current_state(evidence))
            result['evidence_sha256'] = sha256(evidence_path)
            result['rootfs_report_sha256'] = sha256(rootfs_path)
            Path(args.output).write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
            print(json.dumps(result, sort_keys=True))
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps(dict(gate='INVALID', error=str(error)), sort_keys=True), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
