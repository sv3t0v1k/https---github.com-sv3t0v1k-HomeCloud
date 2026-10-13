#!/usr/bin/env python3
"""Resolve existing backend storage identity; never guess or create a volume.

Named volumes are inherited from a pinned existing backend container. Binds use
--mount (Docker fails if the source disappears) and require a locally visible
source directory. Each helper run re-resolves identity immediately before use.
"""
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
from recovery_config import compose_command

class StorageError(ValueError):
    pass

def query(args, json_result=False):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise StorageError('Docker storage inspection unavailable') from None
    if result.returncode:
        raise StorageError('Docker storage inspection failed')
    if json_result:
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError):
            raise StorageError('Docker storage inspection returned invalid JSON') from None
    return result.stdout.strip()

def only(items, what):
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise StorageError('expected exactly one ' + what)
    return items[0]

def clean_path(path):
    if not isinstance(path, str) or not path.startswith('/') or path == '/' or '\\' in path or any(c in path for c in '\x00\n\r,:') or str(PurePosixPath(path)) != path or '..' in path.split('/'):
        raise StorageError('invalid storage mount path')
    return path

def resolve_storage():
    target = clean_path(os.environ.get('STORAGE_PATH', '/storage'))
    project = os.environ.get('COMPOSE_PROJECT_NAME')
    if not project:
        raise StorageError('COMPOSE_PROJECT_NAME is required')
    config = query([*compose_command(), 'config', '--format', 'json'], True)
    if not isinstance(config, dict) or config.get('name') != project:
        raise StorageError('Compose project identity mismatch')
    declared = only([m for m in config.get('services', {}).get('backend', {}).get('volumes', []) if isinstance(m, dict) and m.get('target') == target], 'declared backend storage mount')
    mount_type = declared.get('type')
    if mount_type not in ('bind', 'volume') or not declared.get('source') or declared.get('read_only', False):
        raise StorageError('backend storage must be an explicit writable bind or named volume')
    # Nested mount shadows make the selected root insufficient for an archive.
    for other in config.get('services', {}).get('backend', {}).get('volumes', []):
        if isinstance(other, dict) and str(other.get('target', '')).startswith(target + '/'):
            raise StorageError('nested storage mounts are unsupported')
    ids = query([*compose_command(), 'ps', '--all', '-q', 'backend']).splitlines()
    if len(ids) != 1 or not re.fullmatch(r'[0-9a-f]{12,64}', ids[0]):
        raise StorageError('exactly one existing backend container is required')
    container = only(query(['docker', 'inspect', ids[0]], True), 'backend container')
    cid = container.get('Id', '')
    labels = container.get('Config', {}).get('Labels') or {}
    if not re.fullmatch(r'[0-9a-f]{64}', cid) or not cid.startswith(ids[0]) or labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.service') != 'backend' or labels.get('com.docker.compose.oneoff', '').lower() != 'false':
        raise StorageError('backend container identity mismatch')
    hashes = query([*compose_command(), 'config', '--hash', 'backend']).split()
    if len(hashes) != 2 or hashes[0] != 'backend' or not hashes[1] or labels.get('com.docker.compose.config-hash') != hashes[1]:
        raise StorageError('backend container does not match current Compose configuration')
    backend_image = config.get('services', {}).get('backend', {}).get('image')
    if not backend_image:
        raise StorageError('explicit local backend image is required')
    image_info = only(query(['docker', 'image', 'inspect', backend_image], True), 'configured local backend image')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', container.get('Image', '')) or image_info.get('Id') != container['Image']:
        raise StorageError('configured backend image differs from pinned container image')
    mount = only([m for m in container.get('Mounts' , []) if isinstance(m, dict) and m.get('Destination') == target], 'actual backend storage mount')
    if any(str(m.get('Destination', '')).startswith(target + '/') for m in container.get('Mounts', [])):
        raise StorageError('actual nested storage mounts are unsupported')
    if mount.get('Type') != mount_type or mount.get('RW') is not True:
        raise StorageError('actual storage mount type/access mismatch')
    result = {'container_id': cid, 'image_id': container['Image'], 'project': project, 'config_hash': hashes[1], 'target': target, 'type': mount_type, 'source': mount.get('Source'), 'name': '', 'declared': declared}
    override = os.environ.get('STORAGE_VOLUME', '')
    if mount_type == 'volume':
        info = config.get('volumes', {}).get(declared['source'])
        if not isinstance(info, dict) or not info.get('name'):
            raise StorageError('resolved Compose volume name is required')
        name = info['name']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) or mount.get('Name') != name or (override and override != name):
            raise StorageError('actual storage volume identity mismatch')
        volume = only(query(['docker', 'volume', 'inspect', name], True), 'existing storage volume')
        if volume.get('Name') != name or not volume.get('Mountpoint') or volume.get('Mountpoint') != mount.get('Source') or volume.get('Driver') != mount.get('Driver'):
            raise StorageError('storage volume inspection identity mismatch')
        result.update(name=name, volume=volume)
    else:
        source = clean_path(declared['source'])
        if override or mount.get('Source') != source:
            raise StorageError('actual storage bind identity mismatch')
        try:
            path = Path(source)
            if path.is_symlink() or not path.is_dir() or str(path.resolve()) != source:
                raise StorageError('bind storage must be an existing canonical local directory')
            info = path.stat()
        except OSError:
            raise StorageError('bind storage source unavailable locally') from None
        result['bind_identity'] = [info.st_dev, info.st_ino]
    return result

def checked_storage(snapshot):
    if not isinstance(snapshot, dict) or resolve_storage() != snapshot:
        raise StorageError('backend storage identity changed after preflight')
    return snapshot

def storage_command(snapshot, mode, image, command, options=()):
    checked_storage(snapshot)
    if mode not in ('ro', 'rw') or not image or not command:
        raise StorageError('invalid storage helper invocation')
    if any(option not in ('--user', 'root', '-i', '--entrypoint', 'sh') for option in options):
        raise StorageError('unsupported storage helper option')
    # Pin an existing local helper image. Extra VOLUME declarations create
    # anonymous disks even when the selected storage itself is inherited.
    helper = only(query(['docker', 'image', 'inspect', image], True), 'local helper image')
    image_id = helper.get('Id', '')
    declared_volumes = helper.get('Config', {}).get('Volumes') or {}
    if image_id != snapshot['image_id'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) or not isinstance(declared_volumes, dict) or not set(declared_volumes).issubset({snapshot['target']}):
        raise StorageError('helper image identity or unmounted VOLUME declaration rejected')
    if snapshot['type'] == 'volume':
        mount = ['--volumes-from', snapshot['container_id'] + ':' + mode]
    else:
        spec = 'type=bind,src=' + snapshot['source'] + ',dst=' + snapshot['target']
        if mode == 'ro':
            spec += ',readonly'
        mount = ['--mount', spec]
    return ['docker', 'run', '--rm', '--network', 'none', '--pull=never', *options, *mount, image_id, *command]

def main():
    try:
        action = sys.argv[1] if len(sys.argv) > 1 else ''
        if action == 'resolve':
            snapshot = resolve_storage()
            values = {'RECOVERY_STORAGE_SNAPSHOT': json.dumps(snapshot, sort_keys=True), 'RECOVERY_STORAGE_CONTAINER': snapshot['container_id'], 'RECOVERY_STORAGE_TYPE': snapshot['type'], 'RECOVERY_STORAGE_SOURCE': snapshot['source'], 'RECOVERY_STORAGE_TARGET': snapshot['target'], 'STORAGE_VOLUME': snapshot['name']}
            for key, value in values.items():
                print('export %s=%s' % (key, shlex.quote(value)))
        elif action in ('check', 'run', 'image'):
            snapshot = json.loads(os.environ['RECOVERY_STORAGE_SNAPSHOT'])
            if action == 'check':
                checked_storage(snapshot)
            elif action == 'image':
                args = storage_command(snapshot, 'ro', sys.argv[2], ['true'])
                print(args[-2])
            else:
                # ro/rw OPTIONS -- IMAGE COMMAND...
                mode = sys.argv[2]
                separator = sys.argv.index('--', 3)
                args = storage_command(snapshot, mode, sys.argv[separator + 1], sys.argv[separator + 2:], sys.argv[3:separator])
                return subprocess.call(args)
        else:
            raise StorageError('unsupported storage helper action')
        return 0
    except (StorageError, ValueError, KeyError, IndexError, OSError):
        print('ERROR: recovery storage identity validation failed; no storage helper started', file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
