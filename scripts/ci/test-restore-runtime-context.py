#!/usr/bin/env python3
"""Exercise real context metadata and read-only runtime trust checks, no Docker."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


context = load("restore-e2e-context")
preflight = load("restore-runtime-preflight")


class ContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="hc-runtime-package-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        for name in (*preflight.REQUIRED, "backend/package.json"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
            path.chmod(0o644)
        self.helper = self.root / "deploy/linux/maintenance-inhibit.py"

    def archive(self):
        output = io.BytesIO()
        context.write_context(output, self.root)
        output.seek(0)
        return tarfile.open(fileobj=output, mode="r:")

    def inspect(self, wrong_owner=None, wrong_group=None):
        real_lstat = Path.lstat
        root = self.root

        def image_lstat(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            # macOS tests cannot chown root or use /opt. Preserve actual
            # fixture types/modes/nlink, substitute Linux image ownership;
            # system ancestors are the Docker image's root-owned 0755 dirs.
            inside = path == root or root in path.parents
            return SimpleNamespace(
                st_mode=info.st_mode if inside else stat.S_IFDIR | 0o755,
                st_uid=501 if path == wrong_owner else 0,
                st_gid=20 if path == wrong_group else 0,
                st_nlink=info.st_nlink,
            )
        with patch.object(Path, "lstat", image_lstat), redirect_stdout(io.StringIO()):
            return preflight.inspect_layout(self.root)

    def test_canonical_tar_overrides_mac_ownership_and_writable_modes(self):
        self.helper.chmod(0o666)
        (self.root / "scripts/backup.sh").chmod(0o777)
        with self.archive() as archive:
            members = {member.name: member for member in archive}
            self.assertEqual(members["deploy/linux/maintenance-inhibit.py"].mode, 0o644)
            self.assertEqual(members["scripts/backup.sh"].mode, 0o755)
            self.assertEqual(archive.extractfile(members["deploy/linux/maintenance-inhibit.py"]).read(), b"fixture\n")
            for member in members.values():
                self.assertEqual((member.uid, member.gid, member.uname, member.gname), (0, 0, "", ""))
                self.assertEqual(member.mode & 0o022, 0)
                if member.isdir():
                    self.assertEqual(member.mode, 0o755)
            self.assertIn("scripts/ci/restore-runtime-preflight.py", members)
        # Packaging must not chmod/chown the actual Mac working tree.
        self.assertEqual(stat.S_IMODE(self.helper.stat().st_mode), 0o666)

    def test_context_does_not_include_environment_or_unrelated_files(self):
        (self.root / ".env").write_text("synthetic fixture, never archive")
        (self.root / "scripts/fixture.key").write_text("synthetic fixture")
        with self.archive() as archive:
            names = archive.getnames()
        self.assertNotIn(".env", names)
        self.assertNotIn("scripts/fixture.key", names)

    def test_context_rejects_source_links_and_parent_aliases(self):
        self.helper.unlink()
        self.helper.symlink_to(self.root / "scripts/backup.sh")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.archive()
        self.helper.unlink()
        os.link(self.root / "scripts/backup.sh", self.helper)
        with self.assertRaisesRegex(ValueError, "one link"):
            self.archive()

    def test_runtime_accepts_only_qualified_image_metadata(self):
        records = self.inspect()
        self.assertEqual(len(records), len(preflight.REQUIRED))
        self.assertTrue(all(record["canonical"] and record["regular"] and record["nlink"] == 1 for record in records))

    def test_runtime_rejects_mac_owner_group_and_writable_helper(self):
        for kwargs in ({"wrong_owner": self.helper}, {"wrong_group": self.helper}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(ValueError, "helper"):
                    self.inspect(**kwargs)
        self.helper.chmod(0o664)
        with self.assertRaisesRegex(ValueError, "helper"):
            self.inspect()

    def test_runtime_rejects_writable_or_aliased_parent(self):
        (self.root / "deploy/linux").chmod(0o775)
        with self.assertRaisesRegex(ValueError, "directory"):
            self.inspect()
        (self.root / "deploy/linux").chmod(0o755)
        (self.root / "deploy/linux").rename(self.root / "aliased-linux")
        (self.root / "deploy/linux").symlink_to(self.root / "aliased-linux")
        with self.assertRaisesRegex(ValueError, "directory"):
            self.inspect()

    def test_runtime_rejects_symlink_directory_and_hardlinked_helper(self):
        self.helper.unlink()
        self.helper.symlink_to(self.root / "scripts/backup.sh")
        with self.assertRaisesRegex(ValueError, "helper"):
            self.inspect()
        self.helper.unlink()
        self.helper.mkdir()
        with self.assertRaisesRegex(ValueError, "helper"):
            self.inspect()
        self.helper.rmdir()
        os.link(self.root / "scripts/backup.sh", self.helper)
        with self.assertRaisesRegex(ValueError, "helper"):
            self.inspect()

    def test_image_build_and_entrypoint_check_before_nested_daemon(self):
        self.assertIn(b"COPY --chown=0:0", context.DOCKERFILE)
        self.assertIn(b"RUN python3 -B scripts/ci/restore-runtime-preflight.py", context.DOCKERFILE)
        entrypoint = (ROOT / "scripts/ci/test-restore-e2e-local.sh").read_text()
        self.assertLess(entrypoint.index("python3 -B scripts/ci/restore-runtime-preflight.py"),
                        entrypoint.index("dockerd \\\n"))
        launcher = (ROOT / "scripts/ci/run-restore-e2e-local.sh").read_text()
        self.assertLess(launcher.index("--entrypoint python3 homecloud-restore-e2e-runtime:local"),
                        launcher.index("docker save "))

    def fake_elf(self, name, machine=183):
        binary = self.root / name
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", header, 18, machine)
        binary.write_bytes(header)
        return binary

    def test_native_toolchain_rejects_one_emulated_runtime_binary(self):
        arm = self.fake_elf("arm-node")
        amd = self.fake_elf("amd-runc", 62)
        with patch.object(preflight, "TOOL_BINARIES", {"node": str(arm), "runc": str(amd)}), \
             patch.object(preflight.shutil, "which", side_effect=lambda value: value), \
             patch.object(preflight.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Emulated E2E tool refused: runc"):
                preflight.inspect_toolchain("linux/arm64")
        run.assert_not_called()

    def test_invalid_elf_or_wrong_node_executable_cannot_borrow_metadata(self):
        invalid = self.fake_elf("invalid-elf")
        invalid.write_bytes(b"not an ELF executable")
        with self.assertRaisesRegex(ValueError, "ELF64"):
            preflight.elf_architecture(invalid)
        arm = self.fake_elf("arm-node")
        with patch.object(preflight, "TOOL_BINARIES", {"node": str(arm)}), \
             patch.object(preflight.shutil, "which", side_effect=lambda value: value), \
             patch.object(preflight.subprocess, "run", return_value=SimpleNamespace(stdout='{"os":"linux","arch":"x64"}')):
            with self.assertRaisesRegex(ValueError, "executable architecture"):
                preflight.inspect_toolchain("linux/arm64")

    def test_native_toolchain_requires_pinned_compose_version(self):
        arm = self.fake_elf("arm-node")
        with patch.object(preflight, "TOOL_BINARIES", {"node": str(arm)}), \
             patch.object(preflight.shutil, "which", side_effect=lambda value: value), \
             patch.object(preflight.subprocess, "run") as run, redirect_stdout(io.StringIO()):
            for version in ("5.6.0", "unqualified"):
                run.side_effect = [SimpleNamespace(stdout='{"os":"linux","arch":"arm64"}'), SimpleNamespace(stdout=version)]
                if version == "5.6.0":
                    self.assertEqual(len(preflight.inspect_toolchain("linux/arm64")), 1)
                else:
                    with self.assertRaisesRegex(ValueError, "Compose version"):
                        preflight.inspect_toolchain("linux/arm64")

    def test_fixture_base_reuses_existing_multiarch_index(self):
        pins = json.loads((ROOT / "scripts/ci/images.platforms.json").read_text())
        dockerfile = (ROOT / "scripts/ci/restore-e2e-runner.Dockerfile").read_text()
        self.assertIn("@" + pins["node-ci"]["index_digest"], dockerfile)
        self.assertNotIn("@" + pins["node-ci"]["amd64_digest"], dockerfile)

    def test_tampered_compose_download_never_installs_or_executes(self):
        dockerfile = (ROOT / "scripts/ci/restore-e2e-runner.Dockerfile").read_text()
        source = dockerfile.split("python3 - <<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        with patch.dict(os.environ, {"TARGETARCH": "arm64"}), \
             patch("urllib.request.urlopen", return_value=io.BytesIO(b"tampered executable")), \
             patch.object(Path, "write_bytes") as write, patch.object(Path, "chmod") as chmod:
            with self.assertRaisesRegex(SystemExit, "checksum mismatch"):
                exec(compile(source, "fixture-compose-installer", "exec"), {})
        write.assert_not_called()
        chmod.assert_not_called()


if __name__ == "__main__":
    unittest.main()
