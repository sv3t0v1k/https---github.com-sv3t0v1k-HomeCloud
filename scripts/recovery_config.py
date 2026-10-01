#!/usr/bin/env python3
"""Explicit recovery configuration; never executes env-file contents."""
import os
from pathlib import Path
import re
import shlex
import stat
import sys

KEYS = set("DB_NAME DB_USER DB_PASSWORD REDIS_PASSWORD JWT_SECRET JWT_REFRESH_SECRET METRICS_TOKEN PUBLIC_HOST TLS_CERT_DIR ACME_WEBROOT_DIR MAX_FILE_SIZE MAX_TOTAL_SIZE CHUNK_SIZE MAX_CHUNK_SIZE COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES RELEASE_BACKEND_IMAGE RELEASE_FRONTEND_IMAGE PREVIOUS_BACKEND_IMAGE PREVIOUS_FRONTEND_IMAGE BACKUP_DIR STORAGE_PATH STORAGE_VOLUME BACKEND_IMAGE RETENTION_DAYS BACKUP_PRODUCTION_DIR BACKUP_OFFSITE_DIR BACKUP_OFFSITE_CONFIRMED BACKUP_WRITE_BARRIER_CONFIRMED BACKUP_AGE_RECIPIENTS_FILE BACKUP_AGE_IDENTITY_FILE BACKUP_RETAIN_COUNT BACKUP_RETENTION_DAYS".split())
REPO = Path(__file__).resolve().parent.parent

class ConfigError(ValueError):
    pass

def load_config():
    env = os.environ.copy()
    path = env.get('HOMECLOUD_ENV_FILE')
    mode = env.get('HOMECLOUD_CONFIG_MODE', 'file')
    if mode not in ('file', 'environment'):
        raise ConfigError('invalid HOMECLOUD_CONFIG_MODE')
    if mode == 'environment':
        if path:
            raise ConfigError('HOMECLOUD_ENV_FILE conflicts with environment mode')
    else:
        if not path:
            raise ConfigError('HOMECLOUD_ENV_FILE required (or explicitly select environment mode)')
        p = Path(path)
        if not p.is_absolute():
            raise ConfigError('HOMECLOUD_ENV_FILE must be absolute')
        # /tmp may itself be a platform alias; reject the final file symlink.
        if p.is_symlink() or p.resolve().is_relative_to(REPO):
            raise ConfigError('HOMECLOUD_ENV_FILE must be external and not a symlink')
        try:
            fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
            with os.fdopen(fd) as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) not in (0o400, 0o440, 0o600, 0o640):
                    raise ConfigError('HOMECLOUD_ENV_FILE requires readable regular file mode 0400/0440/0600/0640')
                values = {}
                for number, line in enumerate(f, 1):
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    key, sep, value = line.partition('=')
                    key = key.strip(); value = value.strip()
                    if not sep or key not in KEYS or key in values:
                        raise ConfigError('invalid or duplicate config key at line %d' % number)
                    if value.startswith(('"', "'")):
                        if len(value) < 2 or value[-1] != value[0]:
                            raise ConfigError('invalid config quoting at line %d' % number)
                        value = value[1:-1]
                    if '\x00' in value or '\r' in value or '\n' in value:
                        raise ConfigError('invalid config value at line %d' % number)
                    values[key] = value
        except (OSError, UnicodeError):
            raise ConfigError('HOMECLOUD_ENV_FILE missing or unreadable') from None
        for key, value in values.items():
            env.setdefault(key, value)
    for key in ('DB_NAME', 'DB_USER', 'DB_PASSWORD', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'):
        if not env.get(key):
            raise ConfigError('missing required variable: ' + key)
    for key in ('DB_NAME', 'DB_USER'):
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', env[key]):
            raise ConfigError('invalid SQL identifier: ' + key)
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', env['COMPOSE_PROJECT_NAME']):
        raise ConfigError('invalid COMPOSE_PROJECT_NAME')
    for name in env['COMPOSE_FILE'].split(':'):
        p = Path(name)
        if not p.is_absolute() or not p.is_file():
            raise ConfigError('COMPOSE_FILE requires existing absolute manifest paths')
    env['COMPOSE_PATH_SEPARATOR'] = ':'
    # Exported variables are the single resolved source. Prevent Compose dotenv loading.
    env['COMPOSE_ENV_FILES'] = '/dev/null'
    env['COMPOSE_DISABLE_ENV_FILE'] = '1'
    return env

def compose_command():
    return ['docker', 'compose', '--env-file', '/dev/null']

if __name__ == '__main__':
    try:
        config = load_config()
        for key in sorted(KEYS | {'COMPOSE_PATH_SEPARATOR', 'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE'}):
            if key in config:
                print('export %s=%s' % (key, shlex.quote(config[key])))
    except ConfigError as exc:
        print('ERROR: recovery configuration: ' + str(exc), file=sys.stderr)
        sys.exit(2)
