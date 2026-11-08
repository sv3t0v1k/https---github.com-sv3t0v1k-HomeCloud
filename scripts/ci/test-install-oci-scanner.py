#!/usr/bin/env python3
"""Негативные тесты OCI-установщика без доступа к Docker."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).with_name(
    "install-oci-scanner.sh"
)

FAKE_DOCKER = r'''#!/bin/sh
set -eu
[ "${MOCK_FAIL:-}" != "$1" ] || exit 77
case "$1" in
  pull)
    test "$2" = '--platform'
    test "$3" = 'linux/amd64'
    case "$4" in
      ghcr.io/aquasecurity/trivy@sha256:166061a4a15c64a94a3aab430659e2c166dc0815fbc54a222c6d56d64132f552|ghcr.io/gitleaks/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb)
        ;;
      *) exit 77 ;;
    esac
    ;;
  image)
    printf '%s\n' "${MOCK_PLATFORM:-linux/amd64}"
    ;;
  create)
    printf '%s\n' 'scanner-test-container'
    ;;
  cp)
    case "$2" in
      scanner-test-container:/usr/local/bin/trivy|scanner-test-container:/usr/bin/gitleaks)
        ;;
      *) exit 2 ;;
    esac
    cp "$MOCK_SCANNER" "$3"
    ;;
  rm)
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
'''


class InstallerTests(unittest.TestCase):
    def invoke(self, tool="trivy", version="Version: 0.76.0",
               exit_code=0, platform="linux/amd64",
               missing=False, existing=False, symlink=False,
               wrong_digest=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / "bin"
            bindir.mkdir()

            docker = bindir / "docker"
            docker.write_text(FAKE_DOCKER)
            docker.chmod(0o755)

            scanner = root / "scanner"
            scanner.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' " + shlex.quote(version) + "\n"
                "exit " + str(exit_code) + "\n"
            )
            scanner.chmod(0o755)

            if missing:
                scanner.unlink()

            target = root / "installed"
            if existing:
                target.write_text("existing")
            if symlink:
                target.symlink_to(root / "outside")

            script = INSTALLER

            if wrong_digest:
                content = INSTALLER.read_text()
                content = content.replace(
                    "166061a4a15c64a94a3aab430659e2c166dc0815fbc54a222c6d56d64132f552",
                    "0" * 64,
                )
                script = root / "altered-installer.sh"
                script.write_text(content)

            env = dict(os.environ)
            env["PATH"] = str(bindir) + os.pathsep + env["PATH"]
            env["MOCK_SCANNER"] = str(scanner)
            env["MOCK_PLATFORM"] = platform

            return subprocess.run(
                ["sh", str(script), tool, str(target)],
                env=env,
                capture_output=True,
                text=True,
            )

    def test_valid_trivy(self):
        self.assertEqual(self.invoke().returncode, 0)

    def test_valid_gitleaks(self):
        self.assertEqual(
            self.invoke("gitleaks", "v8.30.1").returncode,
            0,
        )

    def test_trivy_stdout_with_error_exit_blocks(self):
        result = self.invoke(exit_code=7)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PASS: verified", result.stdout)

    def test_wrong_version_blocks(self):
        self.assertNotEqual(
            self.invoke(version="Version: 0.1.0").returncode,
            0,
        )

    def test_wrong_platform_blocks(self):
        self.assertNotEqual(
            self.invoke(platform="linux/arm64").returncode,
            0,
        )

    def test_wrong_digest_blocks(self):
        self.assertNotEqual(
            self.invoke(wrong_digest=True).returncode,
            0,
        )

    def test_missing_binary_blocks(self):
        self.assertNotEqual(
            self.invoke(missing=True).returncode,
            0,
        )

    def test_existing_destination_blocks(self):
        self.assertNotEqual(
            self.invoke(existing=True).returncode,
            0,
        )

    def test_symlink_destination_blocks(self):
        self.assertNotEqual(
            self.invoke(symlink=True).returncode,
            0,
        )


if __name__ == "__main__":
    unittest.main()
