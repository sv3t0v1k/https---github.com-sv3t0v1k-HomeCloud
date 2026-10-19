#!/usr/bin/env python3
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('artifact', Path(__file__).with_name('artifact.py'))
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'artifact.zip'
        self.body = b'synthetic exact bytes'
        self.sha = hashlib.sha256(self.body).hexdigest()
        self.requests = []
        self.urls = []

    def transfer(self, responses, **kwargs):
        def fresh(timeout):
            self.urls.append(timeout)
            return 'https://example.invalid/payload?secret=SENSITIVE'
        def opener(request, timeout):
            self.requests.append(request)
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return a.transfer(self.path, len(self.body), self.sha,
                          url_provider=fresh, opener=opener, **kwargs)

    def response(self, data=None, **kwargs):
        return Response(self.body if data is None else data, headers={
            'Content-Length': str(len(self.body)), 'ETag': '"same"', **kwargs})

    def test_complete_first_session(self):
        report = self.transfer([self.response()])
        self.assertEqual(report['status'], 'PINNED_ZIP_VERIFIED')
        self.assertEqual(len(self.urls), 1)
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_resume_only_strong_matching_etag_and_exact_range(self):
        split = 5
        resumed = Response(self.body[split:], 206, {
            'Content-Length': str(len(self.body) - split), 'ETag': '"same"',
            'Content-Range': f'bytes {split}-{len(self.body)-1}/{len(self.body)}'})
        report = self.transfer([self.response(self.body[:split]), resumed])
        self.assertEqual(self.requests[1].get_header('Range'), 'bytes=5-')
        self.assertEqual(self.requests[1].get_header('If-match'), '"same"')
        self.assertEqual(report['sessions'][1]['mode'], 'resume')
        self.assertEqual(len(self.urls), 2)

    def test_first_session_slice_reserves_time_for_resume(self):
        split = 5
        resumed = Response(self.body[split:], 206, {
            'Content-Length': str(len(self.body) - split), 'ETag': '\"same\"',
            'Content-Range': f'bytes {split}-{len(self.body)-1}/{len(self.body)}'})
        with patch.object(a.time, 'monotonic', side_effect=[0, 0, 0, 0, 6, 6, 6, 6, 6, 6]):
            report = self.transfer([self.response(self.body[:split]), resumed], total_timeout=10)
        self.assertEqual(report['first_session_budget_seconds'], 5)
        self.assertEqual(report['sessions'][0]['error_type'], 'TimeoutError')
        self.assertEqual(report['sessions'][1]['mode'], 'resume')
        self.assertEqual(report['status'], 'PINNED_ZIP_VERIFIED')

    def test_ignored_range_restarts_without_appending(self):
        report = self.transfer([self.response(self.body[:5]), self.response()])
        self.assertEqual(report['sessions'][1]['mode'], 'restart')
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_no_strong_etag_restarts(self):
        self.transfer([self.response(self.body[:5], ETag='W/"weak"'), self.response()])
        self.assertIsNone(self.requests[1].get_header('Range'))

    def test_wrong_etag_or_range_never_passes(self):
        for field, value in [('ETag', '"changed"'), ('Content-Range', 'bytes 0-19/20')]:
            with self.subTest(field=field):
                self.path.unlink(missing_ok=True)
                headers = {'Content-Length': str(len(self.body)-5), 'ETag': '"same"',
                    'Content-Range': f'bytes 5-{len(self.body)-1}/{len(self.body)}'}
                headers[field] = value
                with self.assertRaises(a.TransportError):
                    self.transfer([self.response(self.body[:5]),
                                   Response(self.body[5:], 206, headers)])

    def test_bad_length_encoding_oversize_and_digest(self):
        cases = [self.response(**{'Content-Length': '1000'}),
                 self.response(**{'Content-Encoding': 'gzip'}),
                 self.response(self.body + b'extra'),
                 self.response(b'x' * len(self.body))]
        for response in cases:
            with self.subTest(headers=response.headers):
                self.path.unlink(missing_ok=True)
                with self.assertRaises(a.TransportError):
                    self.transfer([response, self.response(**{'Content-Length': '0'})])

    def test_two_sessions_bound_and_error_redaction(self):
        with self.assertRaises(a.TransportError) as raised:
            self.transfer([OSError('SENSITIVE https://example.invalid/?token=secret')] * 2)
        self.assertEqual(len(self.requests), 2)
        self.assertNotIn('SENSITIVE', str(raised.exception.evidence))
        self.assertNotIn('secret', str(raised.exception))

    def test_600_second_maximum_and_420_override(self):
        report = self.transfer([self.response()], total_timeout=600)
        self.assertEqual(report['timeout_seconds'], 600)
        self.assertEqual(report['first_session_budget_seconds'], 300)
        self.path.unlink()
        report = self.transfer([self.response()], total_timeout=420)
        self.assertEqual(report['timeout_seconds'], 420)
        self.assertEqual(report['first_session_budget_seconds'], 210)
        self.path.unlink()
        with self.assertRaises(ValueError):
            self.transfer([], total_timeout=601)
        self.assertFalse(self.path.exists())

    def test_timeout_bound_and_no_overwrite(self):
        with self.assertRaises(ValueError):
            self.transfer([], total_timeout=601)
        self.path.write_bytes(b'untouched')
        with self.assertRaises(ValueError):
            self.transfer([])
        self.assertEqual(self.path.read_bytes(), b'untouched')

    def test_deadline_exhaustion_performs_no_transfer(self):
        with patch.object(a.time, 'monotonic', side_effect=[0, 1, 2, 3]):
            with self.assertRaises(a.TransportError):
                self.transfer([], total_timeout=0.5)
        self.assertEqual(self.requests, [])

    def test_fetch_requires_pins_and_inner_verifier(self):
        metadata = {'id': a.ARTIFACT, 'expired': False,
                    'digest': 'sha256:' + a.ZIP_SHA, 'size_in_bytes': 200}
        with patch.object(a, 'transfer', return_value={'status': 'PINNED_ZIP_VERIFIED'}):
            with zipfile.ZipFile(self.path, 'w') as zipped:
                zipped.writestr('candidate.oci.tar', b'synthetic tar')
            def verify(path, lock):
                self.assertEqual(path.read_bytes(), b'synthetic tar')
                return {'status': 'EXACT_RETAINED_OCI_VERIFIED'}
            result = a.fetch_verified(Path(self.directory.name), metadata, {}, verify)
            self.assertEqual(result['identity']['status'], 'EXACT_RETAINED_OCI_VERIFIED')
            result['candidate'].unlink()
            def reject(path, lock):
                raise ValueError('bad tar')
            with self.assertRaises(a.TransportError):
                a.fetch_verified(Path(self.directory.name), metadata, {}, reject)
            self.assertFalse((Path(self.directory.name) / 'candidate.oci.tar').exists())
        metadata['digest'] = 'sha256:wrong'
        with self.assertRaises(ValueError):
            a.fetch_verified(Path(self.directory.name), metadata, {}, verify)

    def test_existing_candidate_is_never_deleted(self):
        candidate = Path(self.directory.name) / 'candidate.oci.tar'
        candidate.write_bytes(b'preserve unrelated')
        metadata = {'id': a.ARTIFACT, 'expired': False,
                    'digest': 'sha256:' + a.ZIP_SHA, 'size_in_bytes': 200}
        with self.assertRaises(ValueError):
            a.fetch_verified(Path(self.directory.name), metadata, {}, lambda p, l: {})
        self.assertEqual(candidate.read_bytes(), b'preserve unrelated')

    def test_candidate_created_during_transfer_is_preserved(self):
        candidate = Path(self.directory.name) / 'candidate.oci.tar'
        metadata = {'id': a.ARTIFACT, 'expired': False,
                    'digest': 'sha256:' + a.ZIP_SHA, 'size_in_bytes': 200}
        def concurrent_transfer(*args, **kwargs):
            candidate.write_bytes(b'foreign file created after precheck')
            with zipfile.ZipFile(self.path, 'w') as zipped:
                zipped.writestr('candidate.oci.tar', b'synthetic own content')
            return {'status': 'PINNED_ZIP_VERIFIED'}
        with patch.object(a, 'transfer', side_effect=concurrent_transfer):
            with self.assertRaises(a.TransportError):
                a.fetch_verified(Path(self.directory.name), metadata, {}, lambda p, l: {})
        self.assertEqual(candidate.read_bytes(), b'foreign file created after precheck')

    def test_zip_path_names_duplicates_and_cap_rejected(self):
        metadata = {'id': a.ARTIFACT, 'expired': False,
                    'digest': 'sha256:' + a.ZIP_SHA, 'size_in_bytes': 200}
        for member in ('../candidate.oci.tar', 'candidate.oci.tar/child', 'other'):
            self.path.unlink(missing_ok=True)
            with zipfile.ZipFile(self.path, 'w') as zipped:
                zipped.writestr(member, b'bad')
            with patch.object(a, 'transfer', return_value={}), self.assertRaises(a.TransportError):
                a.fetch_verified(Path(self.directory.name), metadata, {}, lambda p, l: {})
            self.assertFalse((Path(self.directory.name) / 'candidate.oci.tar').exists())
        self.path.unlink()
        with zipfile.ZipFile(self.path, 'w') as zipped:
            zipped.writestr('candidate.oci.tar', b'01234567890')
        with patch.object(a, 'transfer', return_value={}), patch.object(a, 'MAX_TAR', 10):
            with self.assertRaises(a.TransportError):
                a.fetch_verified(Path(self.directory.name), metadata, {}, lambda p, l: {})


if __name__ == '__main__':
    unittest.main()
