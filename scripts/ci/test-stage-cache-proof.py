#!/usr/bin/env python3
import importlib.util
import copy
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('cache_proof', Path(__file__).with_name('stage-cache-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class CacheTests(unittest.TestCase):
    def test_cached_update_stream(self):
        rows = [dict(id='one', name='[deps 1/2] RUN npm ci'),
                dict(id='one', completed='now', cached=True),
                dict(id='two', name='[deps 2/2] COPY . .', completed='now', cached=True),
                dict(id='export', name='exporting to oci image format', completed='now')]
        self.assertEqual(len(proof.verify('\n'.join(map(json.dumps, rows)))), 2)

    def test_reexecution_missing_or_log_only_fails(self):
        for text in ('', 'CLI warning', json.dumps(dict(id='one', name='RUN apk add gcc', completed='now', cached=False)),
                     json.dumps(dict(id='one', name='RUN apk add gcc', cached=True))):
            with self.subTest(text=text), self.assertRaises(ValueError):
                proof.verify(text)

    def test_truncated_json_never_qualifies(self):
        text = '\n'.join([json.dumps(dict(id='cached', name='RUN npm ci', cached=True, completed='now')),
                          json.dumps(dict(id='export', name='exporting to oci image format', completed='now')),
                          '{"id":"uncached",'])
        with self.assertRaisesRegex(ValueError, 'truncated'):
            proof.verify(text)


    def fixture(self):
        source='a'*40
        role='frontend-deps'
        config='sha256:'+'1'*64
        manifest='sha256:'+'2'*64
        archive='sha256:'+'3'*64
        report='sha256:'+'4'*64
        build={
            'containerimage.config.digest':config,
            'containerimage.digest':manifest,
            'containerimage.descriptor':{
                'digest':manifest,
                'mediaType':'application/vnd.oci.image.manifest.v1+json',
                'platform':{'os':'linux','architecture':'amd64'},
                'annotations':{},
            },
        }
        stage={
            'binding':'ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED',
            'role':role,
            'source_commit':source,
            'platform':'linux/amd64',
            'config_digest':config,
            'platform_digest':manifest,
            'archive_sha256':archive,
            'scan_sha256':report,
        }
        runtime={
            'binding':'ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED',
            'role':'frontend',
            'source_commit':source,
            'platform':'linux/amd64',
            'platform_digest':'sha256:'+'5'*64,
        }
        return build,stage,runtime,role,source,archive,report

    def test_exact_stage_metadata_matches_scanned_artifact(self):
        args=self.fixture()
        result=proof.check_stage(*args)
        self.assertEqual(result['config_digest'],
                         args[1]['config_digest'])
        self.assertEqual(result['platform_digest'],
                         args[1]['platform_digest'])
        self.assertEqual(result['archive_sha256'],args[5])
        self.assertEqual(result['scan_sha256'],args[6])

    def test_mismatched_stage_identity_fails_closed(self):
        mutations=(
            ('config',lambda a:a[0].update({
                'containerimage.config.digest':'sha256:'+'9'*64})),
            ('manifest',lambda a:a[0].update({
                'containerimage.digest':'sha256:'+'9'*64})),
            ('descriptor',lambda a:a[0]['containerimage.descriptor'].update({
                'digest':'sha256:'+'9'*64})),
            ('platform',lambda a:a[0]['containerimage.descriptor']['platform'].update({
                'architecture':'arm64'})),
            ('stage role',lambda a:a[1].update({'role':'frontend-builder'})),
            ('source',lambda a:a[1].update({'source_commit':'b'*40})),
            ('binding',lambda a:a[1].update({'binding':'UNVERIFIED'})),
            ('runtime',lambda a:a[2].update({'role':'backend'})),
            ('stage config',lambda a:a[1].update({
                'config_digest':'sha256:'+'9'*64})),
            ('stage manifest',lambda a:a[1].update({
                'platform_digest':'sha256:'+'9'*64})),
            ('archive',lambda a:a[1].update({
                'archive_sha256':'sha256:'+'9'*64})),
            ('report',lambda a:a[1].update({
                'scan_sha256':'sha256:'+'9'*64})),
        )
        for label,mutate in mutations:
            with self.subTest(label=label):
                args=list(copy.deepcopy(self.fixture()))
                mutate(args)
                with self.assertRaises(ValueError):
                    proof.check_stage(*args)

    def test_uncached_copy_or_run_always_blocks(self):
        for operation in ('RUN npm ci','COPY . .'):
            rows=[
                dict(id='run',name='[deps 1/2] RUN npm ci',
                     completed='now',cached=True),
                dict(id='other',name='[deps 2/2] '+operation,
                     completed='now',cached=False),
                dict(id='export',name='exporting to oci image format',
                     completed='now'),
            ]
            with self.subTest(operation=operation),self.assertRaisesRegex(ValueError, "rebuilt operations"):
                proof.verify(chr(10).join(map(json.dumps,rows)))


    def test_complete_frontend_stage_graph(self):
        dockerfile = (
            Path(__file__).resolve().parents[2]
            / 'frontend' / 'Dockerfile'
        ).read_text()

        expected = proof.expected_operations(dockerfile, 'builder')
        self.assertEqual(sum(expected.values()), 8)

        rows = [
            dict(
                id=f'op-{i}',
                name=f'[{stage} 1/1] {opcode} {command}',
                completed='now',
                cached=True,
            )
            for i, (stage, opcode, command)
            in enumerate(expected.elements())
        ]
        rows.append(dict(
            id='export',
            name='exporting to oci image format',
            completed='now',
        ))

        def progress(events):
            return chr(10).join(map(json.dumps, events))

        self.assertEqual(
            len(proof.verify(
                progress(rows), 3,
                dockerfile=dockerfile, target='builder'
            )),
            8,
        )

        for marker in (
            'COPY --from=deps',
            'COPY package.json',
            'RUN npm run build',
        ):
            with self.subTest(missing=marker):
                incomplete = [
                    row for row in rows
                    if marker not in row.get('name', '')
                ]
                with self.assertRaisesRegex(
                    ValueError, 'graph mismatch'
                ):
                    proof.verify(
                        progress(incomplete), 3,
                        dockerfile=dockerfile, target='builder'
                    )

        for marker in ('COPY --from=deps', 'RUN npm run build'):
            with self.subTest(uncached=marker):
                changed = copy.deepcopy(rows)
                for row in changed:
                    if marker in row.get('name', ''):
                        row['cached'] = False
                with self.assertRaisesRegex(
                    ValueError, 'rebuilt operations'
                ):
                    proof.verify(
                        progress(changed), 3,
                        dockerfile=dockerfile, target='builder'
                    )

        extra = copy.deepcopy(rows)
        extra.insert(0, dict(
            id='unexpected',
            name='[builder 5/5] RUN echo unexpected',
            cached=True,
            completed='now',
        ))
        with self.assertRaisesRegex(ValueError, 'graph mismatch'):
            proof.verify(
                progress(extra), 3,
                dockerfile=dockerfile, target='builder'
            )


if __name__ == '__main__':
    unittest.main()
