#!/usr/bin/env python3
"""Evidence for actual CI filesystems, never image-digest provenance."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


def command(argv):
    result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return {'argv': argv, 'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}


def scopes(workspace, component):
    root = Path(workspace).resolve()
    if root == Path('/') or component not in ('backend', 'frontend', 'none'):
        raise ValueError('Invalid checkout/component scope')
    selected = None if component == 'none' else root / component
    if selected is not None and selected.resolve() != selected:
        raise ValueError('Component directory must not be a symlink')
    return root, selected


def installed_manifests(node_modules, workspace, allow_workspace=False):
    candidate = Path(node_modules)
    if allow_workspace and candidate.is_symlink():
        raise ValueError('Installed component node_modules must not be a symlink')
    root = candidate.resolve()
    checkout = Path(workspace).resolve()
    if not allow_workspace and (root == checkout or checkout in root.parents):
        raise ValueError('Global npm root must be outside checkout')
    if allow_workspace and checkout not in root.parents:
        raise ValueError('Installed component dependencies must remain inside checkout')
    result = []
    def visit(directory):
        for entry in sorted(directory.iterdir()):
            if entry.is_symlink() or not entry.is_dir() or entry.name.startswith('.'):
                continue
            if entry.name.startswith('@'):
                visit(entry)
                continue
            manifest = entry / 'package.json'
            if manifest.is_file() and not manifest.is_symlink():
                package = json.loads(manifest.read_text())
                if not package.get('name') or not package.get('version'):
                    raise ValueError('Installed npm manifest lacks name/version')
                result.append(dict(name=package['name'], version=package['version'], path=str(manifest)))
            nested = entry / 'node_modules'
            if nested.is_dir() and not nested.is_symlink():
                visit(nested)
    visit(root)
    if not result:
        raise ValueError('Missing installed npm manifests')
    return result


def inventory_graph(record):
    if record.get('exit_code') != 0:
        raise ValueError('Installed npm inventory command failed')
    value = json.loads(record['stdout'])
    if not isinstance(value, dict) or value.get('problems') or value.get('error'):
        raise ValueError('Invalid installed npm inventory')
    result = set()
    def walk(node):
        for name, dependency in node.get('dependencies', {}).items():
            # Successful npm ls emits {} for absent optional/peer dependency slots.
            # They are not installed packages; every actual manifest remains mandatory.
            if dependency == {}:
                continue
            if dependency.get('missing') or dependency.get('invalid') or not dependency.get('version'):
                raise ValueError('Incomplete installed npm dependency graph')
            result.add((name, dependency['version']))
            walk(dependency)
    walk(value)
    if not result:
        raise ValueError('Empty installed npm dependency graph')
    return result


def normalize_debian_version(version, epoch=0, release=''):
    value = str(version)
    if release:
        value += '-' + str(release)
    if epoch and ':' not in value:
        value = str(epoch) + ':' + value
    if value.startswith('0:'):
        value = value[2:]
    return value


def validate_os_inventory(report, inventory):
    if inventory.get('exit_code') != 0:
        raise ValueError('Actual OS inventory command failed')
    scanned = set()
    for result in report.get('Results', []):
        if result.get('Class') != 'os-pkgs':
            continue
        for package in result.get('Packages', []):
            scanned.add((package.get('Name'), normalize_debian_version(
                package.get('Version', ''), package.get('Epoch', 0), package.get('Release', '')),
                package.get('Arch')))
    installed = []
    for line in inventory.get('stdout', '').splitlines():
        columns = line.split('\t')
        if len(columns) != 4:
            raise ValueError('Malformed actual OS package inventory')
        name, version, arch, status = columns
        if status != 'installed':
            continue  # dpkg retains removed/config-only records; these are not installed packages.
        if not name or not version or not arch:
            raise ValueError('Incomplete installed OS package inventory')
        installed.append((name.removesuffix(':' + arch), normalize_debian_version(version), arch))
    if not installed:
        raise ValueError('Missing installed OS packages')
    for package in installed:
        if package not in scanned:
            raise ValueError('Installed OS package absent from scan inventory: ' + str(package))


def validate_installed(report, manifests, graph, target):
    expected_graph = inventory_graph(graph)
    actual = {(p['name'], p['version']) for p in manifests}
    # npm graph keys may be installation aliases (string-width-cjs -> string-width).
    # Coverage against Trivy still requires the manifest's canonical Name+Version+path.
    for manifest in manifests:
        directory = Path(manifest['path']).parent
        install_name = directory.name
        if directory.parent.name.startswith('@'):
            install_name = directory.parent.name + '/' + install_name
        actual.add((install_name, manifest['version']))
    if not manifests or not expected_graph.issubset(actual):
        raise ValueError('Installed manifest inventory does not cover npm graph')
    for manifest in manifests:
        expected_path = str(Path(manifest['path'])).lstrip('/')
        relative_path = str(Path(manifest['path']).relative_to(target)).lstrip('/')
        covered = False
        for result in report.get('Results', []):
            for package in result.get('Packages', []):
                if (package.get('Name'), package.get('Version')) != (manifest['name'], manifest['version']):
                    continue
                locations = [package.get('FilePath', ''), package.get('PkgPath', ''), result.get('Target', '')]
                locations.extend(location.get('Path', '') for location in package.get('Locations', []) if isinstance(location, dict))
                if any(str(location).lstrip('/') in (expected_path, relative_path) for location in locations):
                    covered = True
        if not covered:
            raise ValueError('Installed npm package absent from scan inventory: ' + manifest['path'])


def capture(environment_id, component, workspace, output, skip_dirs):
    root, selected = scopes(workspace, component)
    excluded = skip_dirs.split(',')
    if str(root) not in excluded:
        raise ValueError('Rootfs must exclude the entire checkout before traversal')
    tools = {name: command([name, '--version']) for name in ('node', 'npm')}
    tools['node']['path'] = command(['node', '-p', 'process.execPath'])
    node_path = Path(tools['node']['path']['stdout'].strip()).resolve()
    tools['node']['sha256'] = hashlib.sha256(node_path.read_bytes()).hexdigest()
    tools['npm']['cli_path'] = str(Path(subprocess.check_output(['which', 'npm'], text=True).strip()).resolve())
    global_root_record = command(['npm', 'root', '--global'])
    if global_root_record['exit_code'] != 0:
        raise ValueError('Cannot identify actual global npm root')
    global_root = str(Path(global_root_record['stdout'].strip()).resolve())
    evidence = dict(format='homecloud-environment-scan-evidence-v1', source_kind='actual-job-filesystem',
                    observed_at=datetime.now(timezone.utc).isoformat(), environment_id=environment_id,
                    platform=f'{platform.system().lower()}/{platform.machine()}', component=component,
                    workspace=str(root), source_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), rootfs_target='/', rootfs_excluded_dirs=excluded,
                    component_target=str(selected) if selected else None, tools=tools,
                    os_release=Path('/etc/os-release').read_text(),
                    github=dict(run_id=os.environ.get('GITHUB_RUN_ID'), run_attempt=os.environ.get('GITHUB_RUN_ATTEMPT'),
                                sha=os.environ.get('GITHUB_SHA'), job=os.environ.get('GITHUB_JOB'),
                                runner_environment=os.environ.get('RUNNER_ENVIRONMENT')),
                    evidence_status='BLOCKED', scope_limitations=[
                        'Pseudo filesystems and temporary directories excluded; installed system/toolcache directories included.',
                        'Checkout excluded before rootfs traversal; selected application scanned separately.',
                        'Environment is observed at this job step; this is not container image provenance.'])
    evidence['global_npm_inventory'] = command(['npm', 'list', '--global', '--all', '--json'])
    evidence['global_npm_root'] = global_root_record
    evidence['global_npm_manifests'] = installed_manifests(global_root, root)
    evidence['os_package_inventory'] = command(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n'])
    if selected:
        evidence['component_npm_inventory'] = command(['npm', 'list', '--all', '--json', '--prefix', str(selected)])
        evidence['component_npm_manifests'] = installed_manifests(selected / 'node_modules', root, allow_workspace=True)
        evidence['lockfile_sha256'] = hashlib.sha256((selected / 'package-lock.json').read_bytes()).hexdigest()
        if not (selected / 'node_modules').is_dir():
            raise ValueError('Actual installed component dependencies are missing')
    Path(output, 'environment.json').write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')


def validate(evidence, reports, metadata, now, java_metadata=None):
    spec = importlib.util.spec_from_file_location('scan_evidence', Path(__file__).with_name('scan-evidence.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if metadata.get('Version') != 2:
        raise ValueError('Expected vulnerability DB schema 2')
    updated, downloaded, next_update = (module.timestamp(metadata[k]) for k in ('UpdatedAt', 'DownloadedAt', 'NextUpdate'))
    tolerance = timedelta(minutes=5)
    if not (now - timedelta(hours=24) <= updated <= now + tolerance and updated - tolerance <= downloaded <= now + tolerance and next_update > now and next_update > updated):
        raise ValueError('Stale or invalid vulnerability DB metadata')
    if evidence.get('source_kind') != 'actual-job-filesystem' or evidence.get('platform') != 'linux/x86_64':
        raise ValueError('Expected actual Linux amd64 job environment')
    if evidence['workspace'] not in evidence['rootfs_excluded_dirs']:
        raise ValueError('Checkout was not excluded')
    if evidence['os_package_inventory']['exit_code'] != 0 or not evidence['os_package_inventory']['stdout'].strip():
        raise ValueError('Missing actual OS package inventory')
    for name in ('node', 'npm'):
        if evidence['tools'][name]['exit_code'] != 0:
            raise ValueError('Missing actual tool version')
    if not evidence.get('source_commit') or len(evidence['source_commit']) != 40:
        raise ValueError('Missing actual source commit')
    validate_os_inventory(reports['rootfs'], evidence['os_package_inventory'])
    validate_installed(reports['rootfs'], evidence['global_npm_manifests'], evidence['global_npm_inventory'], '/')
    expected = {'rootfs': '/'}
    if evidence.get('component_target'):
        expected['component'] = evidence['component_target']
        validate_installed(reports['component'], evidence['component_npm_manifests'], evidence['component_npm_inventory'], evidence['component_target'])
    for name, target in expected.items():
        report = reports[name]
        if report.get('ArtifactType') not in ('filesystem', 'rootfs') or report.get('ArtifactName') != target:
            raise ValueError(f'{name}: scan target does not match actual scope')
        if report.get('Trivy', {}).get('Version') != '0.75.0':
            raise ValueError('Unexpected scanner version')
        if any(r.get('Type') == 'jar' for r in report.get('Results', [])):
            if not java_metadata or java_metadata.get('Version') != 1:
                raise ValueError('Java packages require qualified Java DB evidence')
            java_updated, java_downloaded, java_next = (module.timestamp(java_metadata[k]) for k in ('UpdatedAt', 'DownloadedAt', 'NextUpdate'))
            if not (java_updated <= now + tolerance and java_updated - tolerance <= java_downloaded <= now + tolerance and java_next > now and java_next > java_updated):
                raise ValueError('Stale or invalid Java DB metadata')
        package_class = 'os-pkgs' if name == 'rootfs' else 'lang-pkgs'
        if not any(r.get('Class') == package_class and r.get('Packages') for r in report.get('Results', [])):
            raise ValueError(f'{name}: missing actual package inventory')


def main():
    if sys.argv[1] == 'capture':
        try:
            capture(*sys.argv[2:])
        except (ValueError, KeyError, OSError, TypeError, subprocess.SubprocessError) as error:
            Path(sys.argv[5], 'environment.json').write_text(json.dumps(dict(
                format='homecloud-environment-scan-evidence-v1', evidence_status='BLOCKED',
                environment_id=sys.argv[2], error=str(error)), indent=2) + '\n')
            raise
        return
    output, db_path = map(Path, sys.argv[2:])
    path = output / 'environment.json'
    evidence = json.loads(path.read_text())
    try:
        db = json.loads(db_path.read_text())
        evidence['vulnerability_db'] = db
        reports = {'rootfs': json.loads((output / 'rootfs.json').read_text())}
        if evidence.get('component_target'):
            reports['component'] = json.loads((output / 'component.json').read_text())
        java_path = db_path.parent.parent / 'java-db' / 'metadata.json'
        java_db = json.loads(java_path.read_text()) if java_path.is_file() else None
        evidence['java_db'] = java_db
        validate(evidence, reports, db, datetime.now(timezone.utc), java_db)
        evidence['report_sha256'] = {k: hashlib.sha256((output / f'{k}.json').read_bytes()).hexdigest() for k in reports}
        evidence['evidence_status'] = 'PASS'
    except (ValueError, KeyError, OSError, TypeError) as error:
        evidence['error'] = str(error)
        raise
    finally:
        path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
