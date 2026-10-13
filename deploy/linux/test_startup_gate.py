#!/usr/bin/env python3
"""Admission fixtures: metadata/device/mountinfo подменены, Docker API не используется."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class GateTests(unittest.TestCase):
    def setUp(self):
        self.role = 'backend'
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.runroot = self.root / 'run'
        self.runroot.mkdir()
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / '.tmp').mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.dev = self.runroot / 'dev'
        (self.dev / 'disk/by-uuid').mkdir(parents=True)
        (self.dev / 'sda1').touch()
        (self.dev / 'disk/by-uuid/real-uuid').symlink_to('../../sda1')
        self.config = self.runroot / 'startup.gate'
        self.config.write_text('backend real-uuid /srv/hdd /srv/hdd/storage 1001 65533\n')
        self.marker = self.runroot / 'volume-marker'
        self.marker.write_text('homecloud-v1 backend real-uuid\n')
        self.host = self.runroot / 'host-mountinfo'
        self.host.write_text('1 0 8:1 / /srv/hdd rw shared:1 - ext4 /dev/sda1 rw\n')
        self.mounts = self.root / 'mountinfo'
        self.mounts.write_text(f'2 0 8:1 /storage {self.data} rw - ext4 /dev/sda1 rw\n'
                              f'3 0 8:1 /.homecloud-backend {self.marker} ro - ext4 /dev/sda1 rw\n')
        self.metadata = {str(self.config): '0:0:644', str(self.marker): '1001:65533:400',
                         str(self.data): '1001:65533:700', str(self.data / '.tmp'): '1001:65533:700'}
        # stat rdev/owner подменены; -b заменён на -e только в fixture-копии.
        stat = self.bin / 'stat'
        stat.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                        'print({"%t":"8","%T":"1"}.get(sys.argv[-2],'
                        'json.loads(os.environ["FIXTURE_METADATA"]).get(sys.argv[-1],"bad")))\n')
        stat.chmod(0o755)
        self.proof = self.root / 'writer-proof'
        self.writer = self.root / 'writer'
        self.writer.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "' + str(self.proof) + '"\n')
        self.writer.chmod(0o755)
        script = Path(__file__).with_name('startup-gate.sh').read_text()
        script = script.replace('/run/homecloud', str(self.runroot))
        script = script.replace('/proc/self/mountinfo', str(self.mounts))
        script = script.replace('data=/storage', 'data=' + str(self.data))
        script = script.replace('[ -b "$device" ]', '[ -e "$device" ]')
        script = script.replace('exec sh docker/entrypoint.sh', 'exec ' + str(self.writer))
        self.script = self.root / 'gate.sh'
        self.script.write_text(script)

    def run_gate(self, allowed=False):
        result = subprocess.run(['sh', str(self.script), self.role, 'node', 'dist/main.js', 'literal arg'],
                                capture_output=True, text=True,
                                env={**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'],
                                     'FIXTURE_METADATA': json.dumps(self.metadata), 'PGDATA': str(self.data), 'STORAGE_PATH': str(self.data)})
        self.assertEqual(result.returncode == 0, allowed, result.stderr)
        self.assertEqual(self.proof.exists(), allowed)
        if allowed:
            self.assertEqual(self.proof.read_text(), 'node\ndist/main.js\nliteral arg\n')

    def test_correct_bind_and_literal_argv(self): self.run_gate(True)
    def test_missing_host_mount_existing_directory(self):
        self.host.write_text('1 0 8:2 / / rw - ext4 /dev/sda2 rw\n')
        self.run_gate()
    def test_late_correct_host_mount_stale_underlay_bind(self):
        self.mounts.write_text(self.mounts.read_text().replace('2 0 8:1', '2 0 8:2'))
        self.run_gate()
    def test_cloned_marker_on_root_disk(self):
        self.mounts.write_text(self.mounts.read_text().replace('8:1', '8:2'))
        self.run_gate()
    def test_wrong_source(self):
        self.mounts.write_text(self.mounts.read_text().replace('/dev/sda1', '/dev/sdb1'))
        self.run_gate()
    def test_wrong_bind_root(self):
        self.mounts.write_text(self.mounts.read_text().replace('/storage ', '/wrong '))
        self.run_gate()
    def test_wrong_uuid(self):
        self.config.write_text(self.config.read_text().replace('real-uuid', 'other-uuid'))
        self.run_gate()
    def test_readonly_data(self):
        self.mounts.write_text(self.mounts.read_text().replace(f'{self.data} rw', f'{self.data} ro'))
        self.run_gate()
    def test_readonly_superblock(self):
        self.mounts.write_text(self.mounts.read_text().replace('/dev/sda1 rw', '/dev/sda1 ro'))
        self.run_gate()
    def test_wrong_marker(self):
        self.marker.write_text('homecloud-v1 backend other-uuid\n')
        self.run_gate()
    def test_marker_symlink(self):
        self.marker.unlink(); self.marker.symlink_to(self.config)
        self.run_gate()
    def test_wrong_permissions(self):
        self.metadata[str(self.data)] = '1001:65533:777'
        self.run_gate()
    def test_writable_gate(self):
        self.metadata[str(self.config)] = '1001:65533:644'
        self.run_gate()
    def test_tmp_symlink(self):
        (self.data / '.tmp').rmdir(); (self.data / '.tmp').symlink_to(self.root)
        self.run_gate()
    def test_wrong_tmp_permissions(self):
        self.metadata[str(self.data / '.tmp')] = '1001:65533:755'
        self.run_gate()
    def test_nested_file_mount(self):
        with self.mounts.open('a') as stream:
            stream.write(f'4 2 8:2 /file {self.data}/file rw - ext4 /dev/sda2 rw\n')
        self.run_gate()
    def test_ambiguous_bind(self):
        with self.mounts.open('a') as stream:
            stream.write(self.mounts.read_text().splitlines()[0] + '\n')
        self.run_gate()
    def test_ambiguous_bind_with_invalid_second_fs(self):
        with self.mounts.open('a') as stream:
            stream.write(self.mounts.read_text().splitlines()[0].replace('ext4', 'overlay') + '\n')
        self.run_gate()
    def test_ambiguous_host_with_invalid_second_fs(self):
        with self.host.open('a') as stream:
            stream.write(self.host.read_text().splitlines()[0].replace('ext4', 'overlay') + '\n')
        self.run_gate()
    def test_repeated_start_revalidates_mount(self):
        self.run_gate(True)
        self.proof.unlink()
        self.host.write_text('')
        self.run_gate()


class DatabaseGateTests(unittest.TestCase):
    run_gate = GateTests.run_gate
    def setUp(self):
        GateTests.setUp(self)
        self.role = 'db'
        self.config.write_text('db real-uuid /srv/hdd /srv/hdd/storage 1001 65533\n')
        self.marker.write_text('homecloud-v1 db real-uuid\n')
        self.mounts.write_text(self.mounts.read_text().replace('.homecloud-backend', '.homecloud-db'))
        script = self.script.read_text()
        script = script.replace('data=/var/lib/postgresql/data', 'data=' + str(self.data))
        script = script.replace('exec /usr/local/bin/docker-entrypoint.sh', 'exec ' + str(self.writer))
        self.script.write_text(script)
    test_verified_database = GateTests.test_correct_bind_and_literal_argv
    test_missing_mount = GateTests.test_missing_host_mount_existing_directory
    test_stale_bind = GateTests.test_late_correct_host_mount_stale_underlay_bind
    test_nested_file_mount = GateTests.test_nested_file_mount
    test_ambiguous_bind = GateTests.test_ambiguous_bind_with_invalid_second_fs
    def test_wal_symlink(self):
        (self.data / 'pg_wal').symlink_to(self.root)
        self.run_gate()
    def test_external_tablespace(self):
        (self.data / 'pg_tblspc').mkdir()
        (self.data / 'pg_tblspc/42').symlink_to(self.root)
        self.run_gate()


if __name__ == '__main__':
    unittest.main()
