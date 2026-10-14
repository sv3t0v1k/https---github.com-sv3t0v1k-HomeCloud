#!/usr/bin/env python3
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from provenance import digest

spec = importlib.util.spec_from_file_location('binding', Path(__file__).with_name('oci-scan-binding.py'))
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name)/'image.oci.tar')
        self.source = 'a'*40
        self.config = dict(os='linux', architecture='amd64', rootfs=dict(type='layers', diff_ids=['sha256:'+'b'*64]),
                           config=dict(Labels={'org.opencontainers.image.revision': self.source, 'io.homecloud.role': 'backend'}))
        blobs = {}

        def blob(data):
            sha = digest(data)
            blobs['blobs/sha256/'+sha[7:]] = data
            return dict(digest=sha, size=len(data))

        config = blob(json.dumps(self.config).encode())
        layer = blob(b'fixture compressed layer')
        self.manifest = blob(json.dumps(dict(schemaVersion=2, config=config, layers=[layer])).encode())
        self.manifest['mediaType'] = 'application/vnd.oci.image.manifest.v1+json'
        blobs['index.json'] = json.dumps(dict(schemaVersion=2, manifests=[self.manifest])).encode()
        with tarfile.open(self.path, 'w') as archive:
            for name, data in blobs.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.report = dict(ArtifactType='container_image', ArtifactName=self.path,
                           Metadata=dict(ImageID=config['digest'], ImageConfig=self.config))
        self.proof = dict(platform_digest=self.manifest['digest'], commit=self.source, status='OFFLINE_OCI_VERIFIED')

    def test_exact_artifact(self):
        result = binding.bind(self.path, self.report, 'backend', self.source, provenance=self.proof)
        self.assertEqual(result['platform_digest'], self.manifest['digest'])

    def test_other_scan_config_or_filesystem(self):
        for mutate in (lambda x:x.update(ArtifactName='other.tar'),
                       lambda x:x['Metadata'].update(ImageID='sha256:'+'c'*64),
                       lambda x:x['Metadata']['ImageConfig'].update(rootfs={'diff_ids': []})):
            with self.subTest(mutate=mutate):
                report = copy.deepcopy(self.report)
                mutate(report)
                with self.assertRaises(ValueError):
                    binding.bind(self.path, report, 'backend', self.source, provenance=self.proof)

    def test_source_and_provenance_required(self):
        for source, proof in (('b'*40, self.proof), (self.source, None),
                              (self.source, {**self.proof, 'platform_digest': 'sha256:'+'e'*64})):
            with self.subTest(source=source, proof=proof), self.assertRaises(ValueError):
                binding.bind(self.path, self.report, 'backend', source, provenance=proof)

    def test_external_digest_lock(self):
        with self.assertRaises(ValueError):
            binding.bind(self.path, self.report, 'postgres', self.source)
        with self.assertRaises(ValueError):
            binding.bind(self.path, self.report, 'postgres', self.source, 'sha256:'+'f'*64)
        binding.bind(self.path, self.report, 'postgres', self.source, self.manifest['digest'])

    def test_loaded_runtime_must_be_exact_config_and_layers(self):
        observed = [dict(Id=self.report['Metadata']['ImageID'], RootFS={'Layers': self.config['rootfs']['diff_ids']})]
        binding.loaded(self.path, observed, 'backend', self.source)
        observed[0]['RootFS']['Layers'] = []
        with self.assertRaises(ValueError):
            binding.loaded(self.path, observed, 'backend', self.source)

    def test_tampered_layer(self):
        path = Path(self.path)
        path.write_bytes(path.read_bytes().replace(b'fixture compressed layer', b'tampered compressed dat!'))
        with self.assertRaises(ValueError):
            binding.bind(self.path, self.report, 'backend', self.source, provenance=self.proof)


if __name__ == '__main__':
    unittest.main()
