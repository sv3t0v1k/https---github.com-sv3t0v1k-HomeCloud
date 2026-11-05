#!/usr/bin/python3 -I
"""Install outside checkout as /usr/local/sbin/homecloud-test-launcher, root:0755.

The installed copy is the trust anchor. Never grant sudo access to checkout scripts.
No chmod/chown repair: an unsafe tree requires explicit operator provisioning.
"""
import os
from pathlib import Path
import stat
import re
import subprocess
import sys

ROOT = Path('/home/hs/homecloud-test')
LAUNCHER = Path('/usr/local/sbin/homecloud-test-launcher')
TOOLS_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'


class UnsafeRoot(ValueError):
    pass


def trusted_path(path, directory=False):
    """Check every lexical ancestor, without resolving away symlinks."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise UnsafeRoot('absolute canonical path required')
    for node in reversed((path, *path.parents)):
        info = node.lstat()
        expected_dir = node != path or directory
        if (info.st_uid != 0 or info.st_mode & 0o022 or
                not (stat.S_ISDIR(info.st_mode) if expected_dir else stat.S_ISREG(info.st_mode)) or
                (not expected_dir and info.st_nlink != 1)):
            raise UnsafeRoot('untrusted root execution path: ' + str(node))
        # A mode-bit check alone does not exclude named-user/default ACL grants.
        if hasattr(os, 'listxattr'):
            attrs = os.listxattr(node, follow_symlinks=False)
            if any(name in attrs for name in ('system.posix_acl_access', 'system.posix_acl_default')):
                raise UnsafeRoot('ACL on root execution path: ' + str(node))


def trusted_tree(path):
    trusted_path(path, directory=True)
    def refuse_walk_error(error):
        raise UnsafeRoot("cannot inspect trusted tree") from error
    for directory, dirs, files in os.walk(path, followlinks=False, onerror=refuse_walk_error):
        for name in dirs:
            trusted_path(Path(directory) / name, directory=True)
        for name in files:
            trusted_path(Path(directory) / name)


def validate_checkout(root):
    root = Path(root)
    trusted_path(root, directory=True)
    # Include untracked Python modules: these can shadow imported dependencies.
    for directory in ('deploy', 'scripts', '.git'):
        trusted_tree(root / directory)
    for name in ('docker-compose.yml', 'docker-compose.production.yml',
                 'docker-compose.project-test.yml', 'docker-compose.project-test-updates.yml'):
        trusted_path(root / name)
    # Git indirection/worktrees/alternates and local repository configuration are
    # executable input too. Only a normal, root-owned Git directory is accepted.
    for name in ('objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'info/grafts'):
        if (root / '.git' / name).exists():
            raise UnsafeRoot('external Git object/database indirection refused')
    validate_git_configuration(root)


def validate_backup_configuration(recovery, root, current):
    """Validate write targets and Compose code BEFORE backup.sh can mutate them."""
    recovery, root = Path(recovery), Path(root)
    trusted_path(recovery)
    if stat.S_IMODE(recovery.stat().st_mode) != 0o600:
        raise UnsafeRoot('recovery config requires root:0600')
    values = {}
    for line in recovery.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch('[A-Z][A-Z0-9_]*', key) or key in values:
            raise UnsafeRoot('invalid recovery config')
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise UnsafeRoot('invalid recovery quoting')
            value = value[1:-1]
        if any(c in value for c in ('\x00', '\r', '\n')):
            raise UnsafeRoot('invalid recovery value')
        values[key] = value
    manifests = [str(root / name) for name in ('docker-compose.yml',
                  'docker-compose.production.yml', 'docker-compose.project-test.yml')]
    if current.get('UPDATE_INSTALL_BRIDGE_ENABLED') == 'true':
        marker = Path('/etc/homecloud-test/update-install-enabled')
        trusted_path(marker)
        if (stat.S_IMODE(marker.stat().st_mode) != 0o600 or
                marker.stat().st_gid != 0 or
                marker.read_bytes() != b'homecloud-test-install-v1\n'):
            raise UnsafeRoot('TEST update host authorization invalid')
        manifests.append(str(root / 'docker-compose.project-test-updates.yml'))
    if values.get('COMPOSE_FILE') != ':'.join(manifests):
        raise UnsafeRoot('recovery Compose files differ from qualified operational contract')
    for manifest in manifests:
        trusted_path(Path(manifest))
    backup = Path(values.get('BACKUP_DIR', ''))
    trusted_path(backup, directory=True)
    if stat.S_IMODE(backup.stat().st_mode) != 0o700:
        raise UnsafeRoot('backup directory requires root:0700')
    # Existing staging/markers are write targets too, and must not redirect root.
    trusted_tree(backup)
    for key in ('DB_USER', 'DB_NAME', 'COMPOSE_PROJECT_NAME', 'SSD_DB_DIR',
                'HDD_STORAGE_DIR', 'STORAGE_PATH'):
        if key in current and values.get(key) != current[key]:
            raise UnsafeRoot('recovery runtime identity differs: ' + key)
    return values


def validate_git_configuration(root):
    result = subprocess.run(['/usr/bin/git', '--no-pager', 'config', '--local',
                             '--no-includes', '--null', '--list'], cwd=root,
                            env=clean_environment(), capture_output=True, timeout=15, check=True)
    basic = {'core.repositoryformatversion', 'core.filemode', 'core.bare',
             'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode',
             'remote.origin.url', 'remote.origin.fetch'}
    for entry in result.stdout.decode().split('\0'):
        if not entry:
            continue
        key, sep, value = entry.partition('\n')
        if not sep or (key not in basic and not re.fullmatch(
                r'branch\..+\.(?:remote|merge|vscode-merge-base)', key)):
            raise UnsafeRoot('unqualified Git config: ' + key)
        if key == 'remote.origin.url' and not re.fullmatch(
                r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?', value):
            raise UnsafeRoot('only qualified HTTPS GitHub origin is allowed')


def clean_environment():
    return {'HOME': '/root', 'PATH': TOOLS_PATH,
            'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
            'GIT_NO_REPLACE_OBJECTS': '1',
            'DOCKER_CONFIG': '/etc/homecloud-test/docker',
            'DOCKER_HOST': 'unix:///var/run/docker.sock'}


def main():
    if os.geteuid() != 0 or not sys.flags.isolated:
        raise UnsafeRoot('root and isolated Python required')
    if Path(__file__).absolute() != LAUNCHER:
        raise UnsafeRoot('use the separately provisioned root-owned launcher')
    trusted_path(LAUNCHER)
    validate_checkout(ROOT)
    trusted_tree(Path('/etc/homecloud-test/docker'))
    if len(sys.argv) == 3 and sys.argv[1] == 'worker':
        import re
        if not re.fullmatch('[a-f0-9]{64}', sys.argv[2]):
            raise UnsafeRoot('invalid worker identity')
        command = ['/usr/bin/python3', '-I', '-S', str(ROOT / 'deploy/linux/test-job.py'),
                   'worker', sys.argv[2]]
    elif len(sys.argv) == 2 and sys.argv[1] in (
            'preflight', 'config', 'start', 'status', 'stop', 'test-baseline-inspect',
            'test-recovery-inspect', 'test-dry-run', 'test-apply', 'test-rollback',
            'test-submit', 'test-job-status'):
        command = ['/bin/sh', str(ROOT / 'deploy/linux/project-test.sh'), sys.argv[1]]
    else:
        raise UnsafeRoot('invalid launcher action')
    os.chdir(ROOT)
    os.execve(command[0], command, clean_environment())


if __name__ == '__main__':
    try:
        main()
    except (UnsafeRoot, OSError, subprocess.SubprocessError, UnicodeError):
        sys.exit('STOP: unsafe root boundary; operator provisioning required')
