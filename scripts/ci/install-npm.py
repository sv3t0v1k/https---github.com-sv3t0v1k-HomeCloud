#!/usr/bin/env python3
"""Установить точный npm только на одноразовом Linux runner GitHub Actions."""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request


VERSION = '11.21.1'
URL = 'https://registry.npmjs.org/npm/-/npm-11.21.1.tgz'
SHA256 = 'dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b'
MAX_BYTES = 10 * 1024 * 1024


def context(env=None):
    env = os.environ if env is None else env
    if (platform.system() != 'Linux' or env.get('GITHUB_ACTIONS') != 'true'
            or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'):
        raise ValueError('npm bootstrap requires a disposable GitHub-hosted Linux runner')
    root = Path(env.get('RUNNER_TEMP', ''))
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('RUNNER_TEMP must be an existing absolute directory')
    return root


def install(archive, cache):
    # Ни одного npm process до полной проверки загруженных байтов.
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise ValueError('npm archive SHA256 mismatch')
    executable = shutil.which('npm')
    if not executable:
        raise ValueError('npm bootstrap executable missing')
    subprocess.run([executable, 'install', '--global', '--ignore-scripts', '--no-audit',
                    '--no-fund', '--offline', '--cache', str(cache), str(archive)],
                   check=True, timeout=180)
    actual = subprocess.check_output([executable, '--version'], text=True, timeout=30).strip()
    if actual != VERSION:
        raise ValueError('installed npm version differs from the pinned version')


def main():
    root = context()
    with tempfile.TemporaryDirectory(prefix='homecloud-npm-', dir=root) as directory:
        temporary = Path(directory)
        archive = temporary / 'npm.tgz'
        with urllib.request.urlopen(URL, timeout=60) as response:
            data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('npm archive exceeds the expected maximum size')
        archive.write_bytes(data)
        install(archive, temporary / 'cache')
    print('Verified npm ' + VERSION + ' installed from the pinned offline archive')


if __name__ == '__main__':
    main()
