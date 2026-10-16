#!/usr/bin/env python3
"""Adversarial checks for the single-CVE, exact-binary qualifier."""
from contextlib import ExitStack
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gosu_disposition', Path(__file__).with_name('gosu-disposition.py'))
gosu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gosu)


class GosuDispositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'postgres.oci.tar'
        self.binary = b'\x7fELF' + b'x' * (1769900 - 4)
        self.before = datetime(2026, 10, 16, tzinfo=timezone.utc)
        self.source = 'a' * 40
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)

    def layer(self, members):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as layer:
            for name, kind, content in members:
                info = tarfile.TarInfo(name)
                if kind == 'directory':
                    info.type = tarfile.DIRTYPE
                elif kind == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.linkname = 'elsewhere'
                else:
                    info.size = len(content)
                layer.addfile(info, io.BytesIO(content) if info.isfile() else None)
        return data.getvalue()

    def image(self, layers=None):
        layers = layers or [[(gosu.TARGET, 'file', self.binary)]]
        blobs = {}
        def blob(data):
            digest = 'sha256:' + gosu.sha(data)
            blobs['blobs/sha256/' + digest[7:]] = data
            return {'digest': digest, 'size': len(data)}
        config = blob(json.dumps({'os': 'linux', 'architecture': 'amd64',
                                 'rootfs': {'diff_ids': ['sha256:' + 'd' * 64] * len(layers)}}).encode())
        manifest = {'schemaVersion': 2, 'config': config,
                    'layers': [blob(self.layer(members)) for members in layers]}
        descriptor = blob(json.dumps(manifest).encode())
        descriptor['mediaType'] = 'application/vnd.oci.image.manifest.v1+json'
        blobs['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [descriptor]}).encode()
        with tarfile.open(self.archive, 'w') as archive:
            for name, content in blobs.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return descriptor['digest'], config['digest'], manifest

    def authorized_fixture(self):
        manifest, config, _ = self.image()
        self.contexts.enter_context(patch.object(gosu, 'MANIFEST', manifest))
        self.contexts.enter_context(patch.object(gosu, 'CONFIG', config))
        self.contexts.enter_context(patch.object(gosu, 'ELF_SHA', gosu.sha(self.binary)))
        self.contexts.enter_context(patch.object(gosu, 'proofs', return_value={'fixture': 'checked'}))
        policy = {'cve': 'CVE-2025-68121', 'binary_sha256': gosu.ELF_SHA,
                  'platform_digest': manifest, 'config_digest': config, 'target': gosu.TARGET,
                  'expires_at': gosu.EXPIRY.isoformat(), 'authorized_disposition': 'not_affected',
                  'platform': 'linux/amd64', 'other_cves_covered': [], 'raw_findings_retained': True}
        path = self.root / gosu.POLICY
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(policy))
        lock = self.root / 'scripts/ci/production-images.lock.json'
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({'postgres': 'docker.io/library/postgres@' + manifest}))

    def qualify(self, **kwargs):
        return gosu.qualify(self.archive, self.source, root=self.root, now=kwargs.get('now', self.before))

    def test_exact_archive_active_and_raw_findings_retained(self):
        self.authorized_fixture()
        result = self.qualify()
        self.assertEqual(result['status'], 'ACTIVE_EXACT_BINARY_NOT_AFFECTED')
        self.assertTrue(result['raw_findings_retained'])
        self.assertFalse(result['changes_severity_gate'])
        self.assertEqual(result['other_cves_covered'], [])
        self.assertEqual(result['production'], 'NO_GO')

    def test_expiry_is_exclusive_and_timezone_required(self):
        self.authorized_fixture()
        for now in (gosu.EXPIRY, datetime(2026, 11, 16, tzinfo=timezone.utc), datetime(2026, 10, 16)):
            with self.subTest(now=now), self.assertRaises(ValueError):
                self.qualify(now=now)

    def test_full_source_commit_required(self):
        self.authorized_fixture()
        self.source = '31273c1'
        with self.assertRaises(ValueError):
            self.qualify()

    def test_changed_lock_or_authorization_rejected(self):
        self.authorized_fixture()
        path = self.root / 'scripts/ci/production-images.lock.json'
        path.write_text(json.dumps({'postgres': 'postgres@sha256:' + '0' * 64}))
        with self.assertRaisesRegex(ValueError, 'lock changed'):
            self.qualify()
        path.write_text(json.dumps({'postgres': 'postgres@' + gosu.MANIFEST}))
        policy_path = self.root / gosu.POLICY
        policy = json.loads(policy_path.read_text())
        policy['cve'] = 'CVE-OTHER'
        policy_path.write_text(json.dumps(policy))
        with self.assertRaisesRegex(ValueError, 'authorization mismatch'):
            self.qualify()

    def test_changed_actual_manifest_rejected(self):
        self.authorized_fixture()
        self.image([[('unrelated', 'file', b'changed')]])
        with self.assertRaisesRegex(ValueError, 'manifest/config mismatch'):
            self.qualify()

    def test_changed_actual_binary_hash_rejected(self):
        self.authorized_fixture()
        with patch.object(gosu, 'archive_binary', return_value=b'changed'):
            with self.assertRaisesRegex(ValueError, 'gosu hash changed'):
                self.qualify()

    def test_real_frozen_proof_is_complete(self):
        self.assertEqual(len(gosu.proofs()), 5)

    def test_missing_and_tampered_proofs_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing or unsafe proof'):
            gosu.proofs(self.root)
        path = self.root / gosu.PROOF_DIR / next(iter(gosu.PROOFS))
        path.parent.mkdir(parents=True)
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            gosu.proofs(self.root)

    def test_target_whiteout_opaque_ancestor_and_override_rejected(self):
        first = [(gosu.TARGET, 'file', self.binary)]
        for mutation in [('usr/local/bin/.wh.gosu', 'file', b''),
                         ('usr/local/.wh.bin', 'file', b''),
                         ('.wh..wh..opq', 'file', b''),
                         ('usr/local/bin/.wh..wh..opq', 'file', b''),
                         ('usr/local/bin', 'symlink', b''),
                         (gosu.TARGET, 'file', self.binary)]:
            with self.subTest(mutation=mutation):
                _, _, manifest = self.image([first, [mutation]])
                with self.assertRaises(ValueError):
                    gosu.archive_binary(self.archive, manifest)

    def test_missing_symlink_wrong_size_and_traversal_target_rejected(self):
        for members in ([('elsewhere', 'file', b'x')], [(gosu.TARGET, 'symlink', b'')],
                        [(gosu.TARGET, 'file', b'wrong')], [('usr/../' + gosu.TARGET, 'file', self.binary)]):
            with self.subTest(members=[m[:2] for m in members]):
                _, _, manifest = self.image([members])
                with self.assertRaises(ValueError):
                    gosu.archive_binary(self.archive, manifest)

    def test_layer_corruption_rejected_by_identity(self):
        _, _, _ = self.image()
        with tarfile.open(self.archive, 'a') as archive:
            name = next(member.name for member in archive.getmembers() if member.name.startswith('blobs/'))
            info = tarfile.TarInfo(name)
            info.size = 3
            archive.addfile(info, io.BytesIO(b'bad'))
        with self.assertRaisesRegex(ValueError, 'duplicate OCI archive'):
            gosu.binding.identity(self.archive)


if __name__ == '__main__':
    unittest.main()
