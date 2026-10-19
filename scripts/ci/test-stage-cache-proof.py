#!/usr/bin/env python3
import importlib.util
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


if __name__ == '__main__':
    unittest.main()
