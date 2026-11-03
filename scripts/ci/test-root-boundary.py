#!/usr/bin/env python3
"""Root boundary refusal tests; no privilege, Docker, systemd or host writes."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('root_boundary_test', ROOT / 'deploy/linux/root-boundary.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


class RootBoundary(unittest.TestCase):
    path = Path('/home/hs/homecloud-test/deploy/linux/test-job.py')

    def info(self, node, bad=None, uid=0, mode=None, links=1):
        regular = node == self.path
        return SimpleNamespace(st_uid=uid if node == bad else 0,
            st_mode=mode if node == bad and mode is not None else (stat.S_IFREG | 0o755 if regular else stat.S_IFDIR | 0o755),
            st_nlink=links if node == bad else 1)

    def check(self, **kwargs):
        with patch.object(Path, 'lstat', autospec=True, side_effect=lambda node: self.info(node, **kwargs)), \
             patch.object(boundary.os, 'listxattr', return_value=[], create=True):
            boundary.trusted_path(self.path)

    def test_tree_read_error_refuses_validation(self):
        def unreadable(*args, **kwargs):
            kwargs['onerror'](PermissionError('unreadable subtree'))
            return iter(())
        with patch.object(boundary, 'trusted_path'), patch.object(boundary.os, 'walk', side_effect=unreadable):
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.trusted_tree(Path('/trusted'))

    def test_root_owned_closed_chain_allowed(self):
        self.check()

    def test_user_owned_executable_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=self.path, uid=1001)

    def test_user_owned_home_ancestor_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=Path('/home/hs'), uid=1001)

    def test_group_writable_parent_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=self.path.parent, mode=stat.S_IFDIR | 0o775)

    def test_writable_executable_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=self.path, mode=stat.S_IFREG | 0o777)

    def test_symlink_dependency_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=self.path, mode=stat.S_IFLNK | 0o777)

    def test_hardlinked_dependency_refused(self):
        with self.assertRaises(boundary.UnsafeRoot):
            self.check(bad=self.path, links=2)

    def test_acl_grants_refused(self):
        with patch.object(Path, 'lstat', autospec=True, side_effect=self.info), \
             patch.object(boundary.os, 'listxattr', return_value=['system.posix_acl_access'], create=True):
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.trusted_path(self.path)

    def test_unsafe_tree_cannot_reach_exec(self):
        with patch.object(boundary.os, 'geteuid', return_value=0), \
             patch.object(boundary.sys, 'flags', SimpleNamespace(isolated=1)), \
             patch.object(boundary, '__file__', str(boundary.LAUNCHER)), \
             patch.object(boundary, 'trusted_path'), \
             patch.object(boundary, 'validate_checkout', side_effect=boundary.UnsafeRoot('substitution')), \
             patch.object(boundary.os, 'execve') as execute:
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.main()
            execute.assert_not_called()

    def test_git_config_rejects_executable_injection_and_includes(self):
        for key in ('filter.evil.smudge', 'core.sshcommand', 'core.fsmonitor',
                    'include.path', 'remote.origin.uploadpack', 'credential.helper'):
            with self.subTest(key=key), patch.object(boundary.subprocess, 'run', return_value=SimpleNamespace(
                    stdout=(key + '\n/tmp/evil\0').encode())):
                with self.assertRaises(boundary.UnsafeRoot):
                    boundary.validate_git_configuration(ROOT)

    def test_git_transport_refuses_ssh_file_and_ext(self):
        for url in ('ssh://example/x', '/tmp/evil', 'ext::evil', 'https://evil.example/x'):
            with self.subTest(url=url), patch.object(boundary.subprocess, 'run', return_value=SimpleNamespace(
                    stdout=('remote.origin.url\n' + url + '\0').encode())):
                with self.assertRaises(boundary.UnsafeRoot):
                    boundary.validate_git_configuration(ROOT)

    def backup_config(self, override=''):
        manifests = ':'.join(str(ROOT / name) for name in (
            'docker-compose.yml', 'docker-compose.production.yml', 'docker-compose.project-test.yml'))
        return 'COMPOSE_FILE=' + manifests + '\nBACKUP_DIR=/srv/root-backups\n' + override

    def backup_context(self, config):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(boundary, 'trusted_path'))
        stack.enter_context(patch.object(boundary, 'trusted_tree'))
        stack.enter_context(patch.object(Path, 'read_text', return_value=config))
        stack.enter_context(patch.object(Path, 'stat', autospec=True, side_effect=lambda p:
            SimpleNamespace(st_mode=0o600 if p.name == 'recovery.env' else 0o700)))
        return stack

    def test_backup_config_accepts_only_qualified_manifests(self):
        with self.backup_context(self.backup_config()):
            result = boundary.validate_backup_configuration(Path('/etc/recovery.env'), ROOT, {})
            self.assertEqual(result['BACKUP_DIR'], '/srv/root-backups')

    def test_backup_external_compose_refused_before_execution(self):
        with self.backup_context('COMPOSE_FILE=/tmp/evil.yml\nBACKUP_DIR=/srv/root-backups\n'), \
             patch.object(boundary.subprocess, 'run') as execute:
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.validate_backup_configuration(Path('/etc/recovery.env'), ROOT, {})
            execute.assert_not_called()

    def test_backup_untrusted_existing_staging_refused(self):
        with self.backup_context(self.backup_config()), \
             patch.object(boundary, 'trusted_tree', side_effect=boundary.UnsafeRoot('symlink staging')):
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.validate_backup_configuration(Path('/etc/recovery.env'), ROOT, {})

    def test_backup_runtime_identity_mismatch_refused(self):
        with self.backup_context(self.backup_config('DB_NAME=other\n')):
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.validate_backup_configuration(Path('/etc/recovery.env'), ROOT, {'DB_NAME': 'homecloud'})

    def test_backup_duplicate_assignment_refused(self):
        with self.backup_context(self.backup_config('BACKUP_DIR=/tmp/evil\n')):
            with self.assertRaises(boundary.UnsafeRoot):
                boundary.validate_backup_configuration(Path('/etc/recovery.env'), ROOT, {})

    def test_environment_drops_interpreter_and_docker_injection(self):
        with patch.dict(os.environ, {'PYTHONPATH': '/tmp/evil', 'BASH_ENV': '/tmp/evil',
                                     'GIT_CONFIG_COUNT': '1', 'DOCKER_HOST': 'tcp://evil'}):
            env = boundary.clean_environment()
        self.assertNotIn('PYTHONPATH', env)
        self.assertNotIn('BASH_ENV', env)
        self.assertNotIn('GIT_CONFIG_COUNT', env)
        self.assertEqual(env['GIT_CONFIG_GLOBAL'], '/dev/null')
        self.assertEqual(env['GIT_NO_REPLACE_OBJECTS'], '1')
        self.assertEqual(env['DOCKER_HOST'], 'unix:///var/run/docker.sock')
        self.assertNotIn('/usr/local/bin', env['PATH'])






class DockerConfigIsolationTests(unittest.TestCase):
    """Проверка Shell-защиты на изолированных фикстурах."""

    @classmethod
    def setUpClass(cls):
        import tempfile
        cls.tempfile = tempfile
        lines = (ROOT / "deploy/linux/project-test.sh").read_text().splitlines()
        guard = (
            "docker_entries=$(/usr/bin/find /etc/homecloud-test/docker "
            "-mindepth 1 -print -quit) || fail"
        )
        assert lines.count(guard) == 1
        index = lines.index(guard)
        assert lines[index + 1] == '[ -z "$docker_entries" ] || fail'
        cls.guard = "\n".join(lines[index:index + 2])

    def execute_guard(self, directory):
        import shlex
        script = (
            "set -eu\nfail() { exit 77; }\n"
            + self.guard.replace(
                "/etc/homecloud-test/docker",
                shlex.quote(str(directory))
            )
            + "\n"
        )
        return subprocess.run(
            ["/bin/sh", "-c", script],
            capture_output=True, text=True
        ).returncode

    def test_empty_directory_allowed(self):
        with self.tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "docker"
            directory.mkdir()
            self.assertEqual(self.execute_guard(directory), 0)

    def test_missing_directory_refused(self):
        with self.tempfile.TemporaryDirectory() as tmp:
            self.assertNotEqual(
                self.execute_guard(Path(tmp) / "missing"), 0
            )

    def test_unexpected_config_and_plugin_refused(self):
        for entry in ("config.json", "cli-plugins"):
            with self.subTest(entry=entry):
                with self.tempfile.TemporaryDirectory() as tmp:
                    directory = Path(tmp) / "docker"
                    directory.mkdir()
                    target = directory / entry
                    if entry == "config.json":
                        target.write_text(
                            '{"cliPluginsExtraDirs":["/tmp/evil"]}'
                        )
                    else:
                        target.mkdir()
                    self.assertNotEqual(self.execute_guard(directory), 0)

    def test_symlink_refused_by_trusted_boundary(self):
        directory = Path("/etc/homecloud-test/docker")

        def metadata(path):
            mode = (
                stat.S_IFLNK | 0o777 if path == directory
                else stat.S_IFDIR | 0o755
            )
            return SimpleNamespace(
                st_uid=0, st_mode=mode, st_nlink=1
            )

        with patch.object(boundary.os, "listxattr",
                          return_value=[], create=True):
            with patch.object(Path, "lstat", autospec=True,
                              side_effect=metadata):
                with self.assertRaises(boundary.UnsafeRoot):
                    boundary.trusted_tree(directory)


class ProjectTestWrapperEnvironment(unittest.TestCase):
    """Контракт окружения project-test wrapper."""

    @classmethod
    def setUpClass(cls):
        script = (ROOT / "deploy/linux/project-test.sh").read_text()
        cls.preflight = script.split("preflight() {", 1)[1].split("\n}", 1)[0]
        cls.compose = script.split("compose() {", 1)[1].split("\n}", 1)[0]

    def test_preflight_has_clean_environment(self):
        self.assertIn(
            'env -i HOME=/root PATH="$clean_path" /usr/bin/python3 -I -S',
            self.preflight,
        )
        for variable in ("DOCKER_CONFIG=", "DOCKER_HOST=", "DOCKER_CONTEXT="):
            self.assertNotIn(variable, self.preflight)

    def test_compose_preserves_isolated_docker_config(self):
        self.assertIn(
            'DOCKER_CONFIG=/etc/homecloud-test/docker docker --host unix:///var/run/docker.sock compose',
            self.compose,
        )

    def test_preflight_still_rejects_docker_overrides(self):
        source = (ROOT / "deploy/linux/preflight.py").read_text()
        self.assertIn("'DOCKER_',", source)

if __name__ == '__main__':
    unittest.main()
