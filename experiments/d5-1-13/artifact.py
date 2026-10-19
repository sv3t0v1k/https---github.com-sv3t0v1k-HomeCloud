#!/usr/bin/env python3
"""Bounded, read-only exact artifact transport. Never loads/builds an image."""
import hashlib
import http.client
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud'
ARTIFACT = 12095095760
ZIP_SHA = 'c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83'
MAX_ZIP = 128 * 1024 * 1024
MAX_TAR = 512 * 1024 * 1024


class TransportError(ValueError):
    def __init__(self, reason, evidence):
        super().__init__(reason)  # Controlled strings only; never a URL or upstream error.
        self.evidence = evidence


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fresh_url(timeout):
    """Consume the one-minute API redirect immediately; credentials stay in memory."""
    deadline = time.monotonic() + timeout
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if not token:
        token = subprocess.check_output(['gh', 'auth', 'token'], text=True,
                                        stderr=subprocess.DEVNULL,
                                        timeout=min(timeout, 10)).strip()
    request = urllib.request.Request(
        f'https://api.github.com/repos/{REPO}/actions/artifacts/{ARTIFACT}/zip',
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=min(remaining, 15)):
            pass
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise ValueError('artifact API did not issue 302') from None
        location = error.headers.get('Location', '')
        error.close()
    else:
        raise ValueError('artifact API did not issue 302')
    parsed = urllib.parse.urlsplit(location)
    host = parsed.hostname or ''
    if not (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and not parsed.fragment and parsed.query
            and (host.endswith('.blob.core.windows.net') or
                 host.endswith('.actions.githubusercontent.com'))):
        raise ValueError('unexpected artifact download origin')
    return location


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def transfer(path, expected_size, expected_sha, *, total_timeout=600,
             url_provider=fresh_url, opener=None):
    """At most two HTTP transfer sessions; resume only with a strong matching ETag.

    This low-level routine accepts synthetic providers for tests. Production callers
    use fetch_verified, which hard-pins artifact metadata and verifies the inner tar.
    """
    if not (0 < expected_size <= MAX_ZIP and 0 < total_timeout <= 600):
        raise ValueError('invalid transfer bounds')
    if path.exists() or path.is_symlink():
        raise ValueError('new archive path required')
    opener = opener or urllib.request.build_opener(NoRedirect()).open
    started = time.monotonic()
    deadline = started + total_timeout
    report = {'status': 'NOT_VERIFIED', 'max_sessions': 2, 'timeout_seconds': total_timeout,
              'expected_bytes': expected_size, 'first_session_budget_seconds': total_timeout / 2,
              'sessions': [], 'signed_urls_logged': False}
    etag = None
    path.touch(mode=0o600, exist_ok=False)
    for number in (1, 2):
        event = {'session': number, 'start_bytes': path.stat().st_size}
        report['sessions'].append(event)
        # Reserve at least half the total budget for a fresh-URL resume session.
        session_deadline = (min(deadline, started + total_timeout / 2)
                            if number == 1 else deadline)
        response = None
        try:
            remaining = session_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            url = url_provider(remaining)
            offset = path.stat().st_size if etag else 0
            headers = {'Accept-Encoding': 'identity'}
            if offset:
                headers.update({'Range': f'bytes={offset}-', 'If-Match': etag})
            request = urllib.request.Request(url, headers=headers)
            remaining = session_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            response = opener(request, timeout=min(15, remaining))
            event['http_status'] = response.status
            received_etag = response.headers.get('ETag', '')
            strong_etag = received_etag if re.fullmatch(r'"[^"\r\n]+"', received_etag) else None
            if response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ValueError('encoded response forbidden')
            if response.status == 206:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',
                                     response.headers.get('Content-Range', ''))
                if not (match and tuple(map(int, match.groups())) ==
                        (offset, expected_size - 1, expected_size) and
                        (not offset or (strong_etag and strong_etag == etag))):
                    raise ValueError('range/ETag mismatch')
            elif response.status == 200:
                offset = 0  # Server ignored Range: complete restart in this same session.
            else:
                raise ValueError('unexpected transfer status')
            if response.headers.get('Content-Length') != str(expected_size - offset):
                raise ValueError('response length mismatch')
            event.update({'mode': 'resume' if offset else 'restart',
                          'strong_etag': bool(strong_etag)})
            etag = strong_etag
            with path.open('r+b') as target:
                target.truncate(offset)
                target.seek(offset)
                while True:
                    remaining = session_deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    # CPython HTTPResponse: each read1 performs at most one raw read.
                    raw = getattr(getattr(response, 'fp', None), 'raw', None)
                    sock = getattr(raw, '_sock', None)
                    if sock is not None:
                        sock.settimeout(min(15, remaining))
                    block = response.read1(min(1024 * 1024, expected_size - target.tell() + 1))
                    if not block:
                        break
                    if target.tell() + len(block) > expected_size:
                        raise ValueError('response exceeds pinned size')
                    target.write(block)
                    target.flush()
            event['end_bytes'] = path.stat().st_size
            if path.stat().st_size == expected_size:
                if sha(path) != expected_sha:
                    raise TransportError('pinned ZIP checksum mismatch', report)
                report.update({'status': 'PINNED_ZIP_VERIFIED', 'sha256': expected_sha,
                               'bytes': expected_size,
                               'elapsed_seconds': round(time.monotonic() - started, 3)})
                return report
            event['outcome'] = 'short_body'
        except TransportError:
            raise
        except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as error:
            event.update({'outcome': 'failed', 'error_type': type(error).__name__,
                          'end_bytes': path.stat().st_size})
            # No upstream exception text: HTTP exceptions can contain SAS URLs.
        finally:
            if response is not None:
                response.close()
    report.update({'bytes': path.stat().st_size,
                   'elapsed_seconds': round(time.monotonic() - started, 3)})
    raise TransportError('bounded artifact transfer not verified', report) from None


def fetch_verified(download_dir, metadata, lock, verifier, *, total_timeout=600):
    """Called after validate_origin; return only bytes accepted by existing OCI verifier."""
    if (metadata.get('id') != ARTIFACT or metadata.get('expired') is not False or
            metadata.get('digest') != 'sha256:' + ZIP_SHA):
        raise ValueError('artifact metadata pin mismatch')
    download_dir = Path(download_dir)
    if not download_dir.is_dir() or download_dir.is_symlink():
        raise ValueError('existing private download directory required')
    archive = download_dir / 'artifact.zip'
    candidate = download_dir / 'candidate.oci.tar'
    if candidate.exists() or candidate.is_symlink():
        raise ValueError('new candidate path required')
    report = transfer(archive, metadata['size_in_bytes'], ZIP_SHA, total_timeout=total_timeout)
    created_identity = None
    try:
        with zipfile.ZipFile(archive) as zipped:
            if zipped.namelist() != ['candidate.oci.tar']:
                raise ValueError('unexpected ZIP members')
            member = zipped.getinfo('candidate.oci.tar')
            if not 0 < member.file_size < MAX_TAR or member.flag_bits & 1:
                raise ValueError('unexpected ZIP member size/encryption')
            with zipped.open(member) as source, candidate.open('xb') as target:
                owned = os.fstat(target.fileno())
                created_identity = (owned.st_dev, owned.st_ino)
                total = 0
                while True:
                    block = source.read(min(1024 * 1024, MAX_TAR - total + 1))
                    if not block:
                        break
                    total += len(block)
                    if total >= MAX_TAR:
                        raise ValueError('expanded member exceeds cap')
                    target.write(block)
        identity = verifier(candidate, lock)
    except Exception:
        # Preserve files created/replaced by somebody else after the initial check.
        if created_identity is not None:
            try:
                current = candidate.lstat()
                if (current.st_dev, current.st_ino) == created_identity:
                    candidate.unlink()
            except FileNotFoundError:
                pass
        raise TransportError('ZIP/tar verification failed', report) from None
    return {'archive': archive, 'candidate': candidate, 'identity': identity, 'transport': report}
