"""Synthetic archival and recovery tests; never reach Docker or host paths."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/linux/update-status-archive.py'
spec = importlib.util.spec_from_file_location('update_status_archive', SCRIPT)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
IDENTITY = 'a' * 64
COMMIT = 'b' * 40


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.status = self.base / 'status'
        self.inbox = self.base / 'inbox'
        self.channel = self.base / 'channel'
        for path in (self.status, self.inbox, self.channel):
            path.mkdir()
        self.current = self.status / 'current.json'
        self.current.write_text(json.dumps(dict(format='homecloud-update-status-v1',
            status='INSTALLED', manifestSha256=IDENTITY, phase='COMPLETE', updatedAt='now')))
        self.current.chmod(0o640)
        self.patches = [
            patch.object(archive, 'STATUS_DIR', self.status),
            patch.object(archive, 'INBOX', self.inbox),
            patch.object(archive, 'CHANNEL', self.channel),
            patch.object(archive, 'CURRENT', self.current),
            patch.object(archive, 'ARCHIVE', self.status / 'archive'),
            patch.object(archive, 'MARKER', self.status / 'archiving.json'),
            patch.object(archive, 'directory'),
            patch.object(archive.os, 'geteuid', return_value=0),
            patch.object(archive.os, 'fchown'),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def fake_root_stat(self, fd):
        info = self.original_fstat(fd)
        return os.stat_result((info.st_mode, info.st_ino, info.st_dev, info.st_nlink,
                               0, 65533 if stat.S_IMODE(info.st_mode) == 0o640 else 0,
                               info.st_size, info.st_atime, info.st_mtime, info.st_ctime))

    def test_successive_archival_and_crash_recovery(self):
        self.original_fstat = os.fstat
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', side_effect=lambda: (IDENTITY, self.current.stat())):
            self.assertTrue(archive.archive_complete())
            self.assertFalse(self.current.exists())
            self.assertTrue((self.status / 'archive' / (IDENTITY + '.json')).exists())
            self.assertFalse(archive.archive_complete())

    def test_second_confirmed_update_archives_independently(self):
        second = 'e' * 64
        self.original_fstat = os.fstat
        current_identity = [IDENTITY]
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', side_effect=lambda *_: (current_identity[0], self.current.stat())):
            self.assertTrue(archive.archive_complete())
            self.current.write_text(json.dumps({'manifestSha256': second}))
            self.current.chmod(0o640)
            current_identity[0] = second
            self.assertTrue(archive.archive_complete())
        self.assertEqual(sorted(path.name for path in (self.status / 'archive').glob('*.json')),
                         [IDENTITY + '.json', second + '.json'])

    def test_crash_after_durable_link_resumes_without_overwrite(self):
        target = self.status / 'archive' / (IDENTITY + '.json')
        target.parent.mkdir()
        os.link(self.current, target)
        self.original_fstat = os.fstat
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', side_effect=lambda: (IDENTITY, self.current.stat())):
            self.assertTrue(archive.archive_complete())
            self.assertFalse(self.current.exists())
            self.assertEqual(target.stat().st_nlink, 1)

    def test_occupied_archive_blocks_without_clearing_receipt(self):
        target = self.status / 'archive' / (IDENTITY + '.json')
        target.parent.mkdir()
        target.write_text('{}')
        target.chmod(0o640)
        self.original_fstat = os.fstat
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', side_effect=lambda: (IDENTITY, self.current.stat())):
            with self.assertRaises(archive.Refusal):
                archive.archive_complete()
        self.assertTrue(self.current.exists())

    def test_failed_status_fsync_keeps_durable_marker_for_recovery(self):
        self.original_fstat = os.fstat
        real_sync = archive.fsync_dir
        status_syncs = 0
        def fail_after_unlink(path):
            nonlocal status_syncs
            if path == self.status:
                status_syncs += 1
                if status_syncs == 3:
                    raise OSError('simulated directory fsync failure')
            return real_sync(path)
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', side_effect=lambda *_: (IDENTITY, self.current.stat() if self.current.exists() else (self.status / 'archive' / (IDENTITY + '.json')).stat())), \
             patch.object(archive, 'fsync_dir', side_effect=fail_after_unlink):
            with self.assertRaises(OSError):
                archive.archive_complete()
        self.assertFalse(self.current.exists())
        self.assertTrue((self.status / 'archiving.json').exists())
        self.assertTrue((self.status / 'archive' / (IDENTITY + '.json')).exists())
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', return_value=(IDENTITY, None)), \
             patch.object(archive, 'fsync_dir', side_effect=OSError('second fsync failure')):
            with self.assertRaises(OSError):
                archive.archive_complete()
        self.assertTrue((self.status / 'archiving.json').exists())
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat), \
             patch.object(archive, 'verify_complete', return_value=(IDENTITY, None)):
            self.assertTrue(archive.archive_complete())
        self.assertFalse((self.status / 'archiving.json').exists())

    def test_unconfirmed_or_pending_completion_refused(self):
        self.current.write_text(json.dumps({'status': 'RUNNING'}))
        with patch.object(archive, 'trusted_parents'), \
             patch.object(archive, 'json_file', return_value=({'status': 'RUNNING'}, None)):
            with self.assertRaises(archive.Refusal):
                archive.verify_complete()
        (self.channel / 'pending.json').write_text('{}')
        with patch.object(archive, 'trusted_parents'):
            with self.assertRaises(archive.Refusal):
                archive.verify_complete()

    def test_complete_requires_matching_install_evidence_and_live_images(self):
        image = {'ref': 'ghcr.io/account/project/backend@sha256:' + 'c' * 64,
                 'id': 'sha256:' + 'd' * 64, 'sha': COMMIT}
        records = {
            'current.json': dict(format='homecloud-update-status-v1', status='INSTALLED',
                                 manifestSha256=IDENTITY, phase='COMPLETE', updatedAt='now'),
            'last-status.json': dict(status='INSTALLED', manifest_sha256=IDENTITY, commit=COMMIT),
            'state.json': dict(format='homecloud-test-install-v1', history=[], active=dict(
                manifest=dict(manifest_sha256=IDENTITY, commit=COMMIT),
                images=dict(backend=image, frontend=image),
                schema_migrations=[dict(name='MigrationOne')])),
            'installed.json': dict(format='homecloud-installed-test-v1', version=COMMIT[:7],
                                   gitSha=COMMIT, schemaMigrations=['MigrationOne']),
        }
        def read(path, *_args):
            return records[path.name], self.current.stat()
        with patch.object(archive, 'trusted_parents'), \
             patch.object(archive, 'json_file', side_effect=read), \
             patch.object(archive, 'project_name', return_value='homecloud-d4-test'), \
             patch.object(archive, 'verify_images') as images:
            self.assertEqual(archive.verify_complete()[0], IDENTITY)
            images.assert_called_once()
            records['installed.json']['gitSha'] = 'e' * 40
            with self.assertRaises(archive.Refusal):
                archive.verify_complete()
            images.assert_called_once()

    def test_parallel_archive_rejected_by_shared_lock(self):
        self.original_fstat = os.fstat
        with patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat):
            first = archive.acquire_lock()
            try:
                with self.assertRaises(BlockingIOError):
                    archive.acquire_lock()
            finally:
                os.close(first)

    def test_compose_project_comes_from_protected_runtime_config(self):
        runtime = self.base / '.runtime'
        runtime.mkdir()
        config = runtime / 'runtime.env'
        config.write_text('COMPOSE_PROJECT_NAME=homecloud-d4-test\n')
        config.chmod(0o600)
        self.original_fstat = os.fstat
        with patch.object(archive, 'ROOT', self.base), \
             patch.object(archive.os, 'fstat', side_effect=self.fake_root_stat):
            self.assertEqual(archive.project_name(), 'homecloud-d4-test')
            config.write_text('COMPOSE_PROJECT_NAME=homecloud-d4-test\nCOMPOSE_PROJECT_NAME=other\n')
            with self.assertRaises(archive.Refusal):
                archive.project_name()


if __name__ == '__main__':
    unittest.main()
