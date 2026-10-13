#!/usr/bin/env python3
"""D3: только чтение host/config; не создаёт каталоги, не монтирует и не запускает API."""
import argparse
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    # stderr/config может содержать секреты: наружу только название операции.
    require(result.returncode == 0, 'Не прошла операция: ' + args[0])
    return result.stdout.strip()


def ordinary_directory(value):
    p = Path(value)
    require(p.is_absolute() and str(p.resolve(strict=True)) == value and p.is_dir(),
            'Каталог отсутствует, не canonical либо содержит symlink')
    return p


def check_disk(spec):
    root = ordinary_directory(spec['mount'])
    require(str(root) != '/', 'Системный root запрещён как диск данных')
    record = json.loads(command('findmnt', '--json', '--target', str(root),
                                '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS'))['filesystems']
    require(len(record) == 1, 'Неоднозначный mount')
    record = record[0]
    require(record['target'] == str(root), 'Диск не смонтирован в exact mountpoint')
    require(record['uuid'] == spec['uuid'] and spec['uuid'] and
            not spec['uuid'].startswith('ЗАПОЛНИТЬ'), 'UUID диска не совпадает')
    require(record['fstype'] in ('ext4', 'xfs') and 'rw' in record['options'].split(','),
            'Нужен writable ext4/xfs; другие FS требуют отдельной квалификации')
    source = record['source']
    require(source.startswith('/dev/') and '[' not in source, 'Необычный/bind source запрещён')
    # --inverse: раздел -> физический parent; поддерживаем только один обычный диск.
    devices = json.loads(command('lsblk', '--json', '--inverse', '--paths',
                                '--output', 'PATH,TYPE,SERIAL', source))['blockdevices']
    disks = []
    def visit(nodes):
        for node in nodes:
            require(node['type'] in ('part', 'disk'), 'LVM/RAID/crypt требуют отдельной схемы')
            if node['type'] == 'disk':
                disks.append(node)
            visit(node.get('children', []))
    visit(devices)
    require(len(disks) == 1 and spec['serial'] and
            (disks[0].get('serial') or '').strip() == spec['serial'], 'Serial physical disk не совпадает')
    usage = os.statvfs(root)
    require(type(spec['min_free_bytes']) is int and spec['min_free_bytes'] > 0 and
            usage.f_bavail * usage.f_frsize >= spec['min_free_bytes'], 'Недостаточно места/нет capacity budget')
    require(type(spec['min_free_inodes']) is int and spec['min_free_inodes'] > 0 and
            usage.f_favail >= spec['min_free_inodes'], 'Недостаточно inodes')
    return disks[0]['path']


def check_data_directory(value, disk, uid, gid):
    p = ordinary_directory(value)
    require(p != Path(disk['mount']) and Path(disk['mount']) in p.parents,
            'Data directory должен быть дочерним каталогом диска')
    record = json.loads(command('findmnt', '--json', '--target', str(p),
                                '--output', 'TARGET,UUID'))['filesystems']
    require(len(record) == 1 and record[0]['target'] == disk['mount'] and
            record[0]['uuid'] == disk['uuid'], 'Data directory на другом/nested mount')
    # --list включает file mounts и mounts ниже PGDATA, например pg_wal на root FS.
    targets = json.loads(command('findmnt', '--json', '--list', '--output', 'TARGET'))['filesystems']
    require(not any(p in Path(row['target']).parents for row in targets),
            'Nested mount внутри data directory запрещён')
    meta = p.stat()
    require((meta.st_uid, meta.st_gid, stat.S_IMODE(meta.st_mode)) == (uid, gid, 0o700),
            'Owner/mode data directory не совпадают с service UID/GID и 0700')


def check_config(config, inventory):
    services = config['services']
    require(config.get('name') not in (None, '', 'homecloud-preview'),
            'Нужен отдельный production project, не Mac preview')
    for name in ('db', 'backend', 'frontend', 'ingress'):
        require(services[name].get('restart') == 'unless-stopped', 'Неверная production restart policy')
        require(not services[name].get('container_name'), 'Fixed container_name запрещён')
    backend = services['backend']
    env = backend['environment']
    require(env.get('UPLOAD_SSD_ENABLED') == 'false' and env.get('UPLOAD_SSD_RECOVERY_MODE') == 'manual',
            'SSD должен оставаться OFF/manual')
    require(not any(key in env for key in ('UPLOAD_SSD_PATH', 'UPLOAD_SSD_MOUNT_SOURCE',
                                         'UPLOAD_SSD_MOUNT_ROOT', 'UPLOAD_SSD_FS_TYPE')),
            'SSD mapping должен отсутствовать целиком')
    require(env.get('STORAGE_PATH') == '/storage' and env.get('NODE_ENV') == 'production',
            'Некорректный storage root/NODE_ENV')
    require(backend.get('user') == '1001:65533', 'Требуется backend UID/GID 1001:65533')
    for name, target, source in (
        ('backend', '/storage', inventory['hdd']['data']),
        ('db', '/var/lib/postgresql/data', inventory['ssd']['data']),
    ):
        mounts = services[name]['volumes']
        require(len(mounts) == 6 and mounts[0]['type'] == 'bind' and
                mounts[0]['target'] == target and mounts[0]['source'] == source and
                not mounts[0].get('read_only', False) and
                mounts[0].get('bind', {}).get('create_host_path') is False,
                'Не совпадает SSD/HDD bind mapping')
        require(services[name].get('entrypoint') == ['sh', '/run/homecloud/startup-gate.sh', name],
                'Writer обязан проходить startup gate')
        require(services[name].get('command') == ({'db': ['postgres'], 'backend': ['node', 'dist/main.js']}[name]),
                'Нужна явная штатная команда после override entrypoint')
        expected = {
            '/run/homecloud/startup-gate.sh': str(Path(__file__).with_name('startup-gate.sh').resolve()),
            '/run/homecloud/startup.gate': '/etc/homecloud/startup-' + name + '.gate',
            '/run/homecloud/host-mountinfo': '/proc/1/mountinfo',
            '/run/homecloud/dev': '/dev',
            '/run/homecloud/volume-marker': str(Path(source).parent / ('.homecloud-' + name)),
        }
        require({m['target'] for m in mounts[1:]} == set(expected), 'Неверный набор gate mounts')
        for mount in mounts[1:]:
            require(mount['type'] == 'bind' and
                    os.path.normpath(mount['source']) == expected[mount['target']] and
                    mount.get('read_only') is True and
                    mount.get('bind', {}).get('create_host_path') is False,
                    'Gate mount обязан быть exact readonly без создания source')
        require(not services[name].get('privileged') and not services[name].get('cap_add') and
                not services[name].get('devices'), 'Gate не требует privileged/devices/cap_add')
    for network in config.get('networks', {}).values():
        require(not network.get('external') and
                str(network.get('name', '')).startswith(config['name'] + '_'),
                'Нужны только project-scoped networks')
    require(not services['frontend'].get('ports') and not backend.get('ports') and
            not services['db'].get('ports'), 'Внутренние ports не должны публиковаться')
    for name in ('backend', 'frontend'):
        image = services[name]['image']
        require((':' in image.rsplit('/', 1)[-1] or '@sha256:' in image) and
                not image.endswith((':dev', ':latest')), 'Нужен отдельный target release tag/digest')
    limits = {'backend': 4 * 1024**3, 'db': 1024**3, 'frontend': 256 * 1024**2, 'ingress': 128 * 1024**2}
    for name, ceiling in limits.items():
        require(0 < int(services[name].get('mem_limit', 0)) <= ceiling, 'Неверный RAM ceiling')


def check_postgres_layout(value):
    pgdata = Path(value)
    require(not (pgdata / 'pg_wal').is_symlink(), 'External pg_wal layout не поддерживается')
    tablespaces = pgdata / 'pg_tblspc'
    require(not tablespaces.is_symlink() and
            (not tablespaces.exists() or not any(tablespaces.iterdir())),
            'External PostgreSQL tablespaces не поддерживаются')


def check_gate_files(role, disk, uid, gid):
    # Строгий line format читается без source/eval и на host, и внутри контейнера.
    values = (role, disk['uuid'], disk['mount'], disk['data'], str(uid), str(gid))
    require(all(value and not any(c.isspace() for c in value) for value in values),
            'Пробелы в gate identity/path не поддерживаются')
    gate = Path('/etc/homecloud/startup-' + role + '.gate')
    marker = Path(disk['data']).parent / ('.homecloud-' + role)
    for path, owner, mode in ((gate, (0, 0), 0o644), (marker, (uid, gid), 0o400)):
        require(path.resolve(strict=True) == path and path.is_file(), 'Gate/marker не canonical file')
        meta = path.stat()
        require((meta.st_uid, meta.st_gid, stat.S_IMODE(meta.st_mode)) == (*owner, mode),
                'Неверный owner/mode gate/marker')
    require(gate.read_text() == ' '.join(values) + '\n', 'Gate не совпадает с inventory')
    require(marker.read_text() == f'homecloud-v1 {role} {disk["uuid"]}\n', 'Marker не совпадает с inventory')
    record = json.loads(command('findmnt', '--json', '--target', str(marker),
                                '--output', 'TARGET,UUID'))['filesystems']
    require(len(record) == 1 and record[0]['target'] == disk['mount'] and
            record[0]['uuid'] == disk['uuid'], 'Marker не на ожидаемом диске')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', default='/etc/homecloud/host-disks.json')
    parser.add_argument('--env-file', default='/etc/homecloud/runtime.env')
    args = parser.parse_args()
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64',
            'D3 рассчитан на native Linux amd64; Desktop/эмуляция не подходят')
    require(os.geteuid() == 0, 'Запускать локально через sudo на Linux daemon host')
    env_file = Path(args.env_file)
    meta = env_file.stat()
    require(env_file.is_absolute() and env_file.resolve() == env_file and meta.st_uid == 0 and
            stat.S_IMODE(meta.st_mode) == 0o600, 'runtime.env обязан быть canonical root:0600')
    inventory_file = Path(args.inventory)
    meta = inventory_file.stat()
    require(inventory_file.is_absolute() and inventory_file.resolve() == inventory_file and
            meta.st_uid == 0 and stat.S_IMODE(meta.st_mode) == 0o600,
            'Inventory обязан быть canonical root:0600')
    inventory = json.loads(inventory_file.read_text())
    # Приоритет shell environment способен подменить значения --env-file. Отказ до config.
    reserved = ('COMPOSE_', 'DOCKER_', 'RELEASE_', 'DB_', 'JWT_', 'UPLOAD_', 'MAX_',
                'SSD_', 'HDD_', 'PUBLIC_', 'TLS_', 'ACME_', 'BACKEND_', 'FRONTEND_',
                'INGRESS_', 'REDIS_', 'STORAGE_', 'HTTP_', 'METRICS_')
    require(not any(key.startswith(reserved) for key in os.environ), 'Очистите override environment через env -i')
    endpoint = command('docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
    require(endpoint.startswith('unix:///'), 'Remote Docker context запрещён')
    info = json.loads(command('docker', 'info', '--format', '{{json .}}'))
    require(info['OSType'] == 'linux' and info['Architecture'] in ('x86_64', 'amd64') and
            'desktop' not in info.get('OperatingSystem', '').lower() and
            not any('rootless' in x or 'userns' in x for x in info.get('SecurityOptions', [])),
            'Нужен local native rootful Linux Docker без userns remap')
    memory = {line.split(':')[0]: int(line.split()[1]) * 1024
              for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
    require(memory['MemTotal'] >= 7 * 1024**3 and memory['MemAvailable'] >= 2 * 1024**3,
            'Требуются установленная RAM 8 GiB и >=2 GiB доступно перед стартом')
    config = json.loads(command('docker', 'compose', '--env-file', str(env_file),
                                '-f', 'docker-compose.yml', '-f', 'docker-compose.production.yml',
                                'config', '--format', 'json'))
    check_config(config, inventory)
    ssd_device, hdd_device = [check_disk(inventory[key]) for key in ('ssd', 'hdd')]
    require(ssd_device != hdd_device and inventory['ssd']['uuid'] != inventory['hdd']['uuid'],
            'SSD/HDD должны быть разными physical disks/filesystems')
    # Оператор заранее сверяет id postgres внутри exact image без data mounts.
    pg_uid, pg_gid = inventory['postgres_uid'], inventory['postgres_gid']
    require(type(pg_uid) is int and type(pg_gid) is int and pg_uid > 0 and pg_gid > 0,
            'Нужны подтверждённые PostgreSQL UID/GID')
    check_data_directory(inventory['ssd']['data'], inventory['ssd'], pg_uid, pg_gid)
    check_postgres_layout(inventory['ssd']['data'])
    check_data_directory(inventory['hdd']['data'], inventory['hdd'], 1001, 65533)
    check_data_directory(str(Path(inventory['hdd']['data']) / '.tmp'), inventory['hdd'], 1001, 65533)
    check_gate_files('db', inventory['ssd'], pg_uid, pg_gid)
    check_gate_files('backend', inventory['hdd'], 1001, 65533)
    for name in ('db', 'backend', 'frontend', 'ingress'):
        image = config['services'][name]['image']
        result = json.loads(command('docker', 'image', 'inspect', image, '--format', '{{json .}}'))
        require(result['Os'] == 'linux' and result['Architecture'] == 'amd64', 'Image не linux/amd64')
    print('PASS: host mounts/UUID/serial, bind mapping, owner/mode, SSD OFF, RAM floor, local amd64 images')
    print('Не квалифицирует logical storage marker/SQL journals/native syscalls/health/TLS/backup/physical outages.')


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Не выводить exception/path/content env; детали refusal не содержат secrets.
        exc = sys.exc_info()[1]
        print('STOP: ' + (str(exc) if isinstance(exc, Refusal) else 'Некорректные входы/ошибка host check'), file=sys.stderr)
        sys.exit(1)
