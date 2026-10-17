"""Целевые fail-closed проверки подготовки; synthetic bytes, без Docker/сети/БД."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pg_prepare', HERE / 'prepare.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gosu, self.apk = self.root/'source-gosu', self.root/'source-apk'
        self.gosu.write_bytes(b'synthetic gosu')
        self.apk.write_bytes(b'synthetic apk')
        self.lock = copy.deepcopy(p.load_lock())
        self.lock['inputs'] = {'gosu': p.sha(self.gosu), 'zlib.apk': p.sha(self.apk)}
        self.destination = self.root/'context'

    def prepare(self):
        return p.prepare_context(self.gosu, self.apk, self.destination, self.lock)

    def test_minimal_deterministic_context_and_no_overwrite(self):
        self.prepare()
        self.assertEqual({x.name for x in self.destination.iterdir()},
                         {'gosu','zlib.apk','Dockerfile','.dockerignore'})
        for name, digest in self.lock['inputs'].items():
            self.assertEqual(p.sha(self.destination/name), digest)
        self.assertEqual((self.destination/'gosu').stat().st_mode & 0o777, 0o755)
        self.assertEqual(int((self.destination/'gosu').stat().st_mtime), self.lock['source_date_epoch'])
        with self.assertRaisesRegex(ValueError, 'new output'):
            self.prepare()
        self.assertEqual((self.destination/'gosu').read_bytes(), self.gosu.read_bytes())

    def test_modified_input_rejected_before_write(self):
        self.apk.write_bytes(b'untrusted apk')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.prepare()
        self.assertFalse(self.destination.exists())

    def test_symlink_input_and_output_rejected(self):
        alias = self.root/'alias'
        alias.symlink_to(self.gosu)
        with self.assertRaisesRegex(ValueError, 'non-symlink'):
            p.prepare_context(alias, self.apk, self.destination, self.lock)
        self.destination.symlink_to(self.root/'missing')
        with self.assertRaisesRegex(ValueError, 'new output'):
            self.prepare()
        self.assertFalse((self.root/'missing').exists())

    def test_copy_mutation_rejected_and_only_new_output_removed(self):
        real_copy = p.shutil.copyfileobj
        def corrupt(src, dst):
            real_copy(src, dst)
            if Path(src.name) == self.apk:
                dst.write(b'changed during copy')
        with patch.object(p.shutil, 'copyfileobj', corrupt):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                self.prepare()
        self.assertFalse(self.destination.exists())
        self.assertTrue(self.gosu.exists())

    def test_reject_unknown_archive_before_oci_parse(self):
        with patch.object(p, 'binding_module', side_effect=AssertionError('must not parse')):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                p.verify_archive(self.apk, self.lock)

    def test_wrong_manifest_config_platform_fail(self):
        lock = copy.deepcopy(self.lock)
        lock['archive_sha256'] = p.sha(self.apk)
        module = unittest.mock.Mock()
        correct = (lock['manifest'], {'config':{'digest':lock['config']}, 'layers':[{}]},
                   {'os':'linux','architecture':'amd64'})
        for value, expected in [
            (('sha256:'+'0'*64, correct[1], correct[2]), 'manifest'),
            ((correct[0], {'config':{'digest':'sha256:'+'0'*64}}, correct[2]), 'config'),
            ((correct[0], correct[1], {'os':'linux','architecture':'arm64'}), 'platform')]:
            module.identity.return_value = value
            with patch.object(p, 'binding_module', return_value=module):
                with self.assertRaisesRegex(ValueError, expected):
                    p.verify_archive(self.apk, lock)

    def test_evidence_tamper_and_traversal_rejected(self):
        lock = {'evidence_root':str(self.root), 'evidence':{'source-apk':p.sha(self.apk)}}
        p.verify_evidence(lock)
        self.apk.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            p.verify_evidence(lock)
        lock['evidence'] = {'../outside':'0'*64}
        with self.assertRaisesRegex(ValueError, 'unsafe evidence'):
            p.verify_evidence(lock)

    def test_retained_evidence(self):
        self.assertEqual(p.verify_evidence(p.load_lock())['files'], 25)


if __name__ == '__main__':
    unittest.main()
