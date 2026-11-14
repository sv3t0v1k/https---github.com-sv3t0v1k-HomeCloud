#!/usr/bin/env python3
"""Execute launcher against a recording fake Docker, never a daemon."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FAKE = r'''
import json,os,sys
a=sys.argv[1:]
with open(os.environ['HC_TEST_DOCKER_LOG'],'a') as f:
    f.write(json.dumps(a)+'\n')
if a[0]=='info':
    if '--format' in a: print(os.environ.get('HC_TEST_ENGINE','linux/aarch64'))
elif a[:2]==['image','inspect']:
    if '--format' in a:
        fmt=a[a.index('--format')+1]
        if '.Architecture' in fmt:
            arch=os.environ.get('HC_TEST_IMAGE_ARCH','arm64')
            if a[2]=='homecloud-restore-e2e-runner:local':
                arch=os.environ.get('HC_TEST_BASE_ARCH',arch)
            print('linux/'+arch)
        elif '.Id' in fmt:
            value='sha256:'+'1'*64
            if os.environ.get('HC_TEST_SUBSTITUTION') and a[2]=='homecloud-restore-e2e-backend:local':
                value='sha256:'+'2'*64
            print(value)
elif a[0]=='build' and a[-1]=='-':
    sys.stdin.buffer.read()
elif a[0]=='save':
    sys.stdout.buffer.write(b'disposable fake image stream')
elif a[0]=='run':
    if '-i' in a: sys.stdin.buffer.read()
    if '--entrypoint' in a and a[a.index('--entrypoint')+1]=='node' and os.environ.get('HC_TEST_NATIVE_FAILURE'):
        sys.exit(1)
'''


class LauncherTests(unittest.TestCase):
    def invoke(self, options=(), **extra):
        with tempfile.TemporaryDirectory(prefix="hc-e2e-launcher-") as directory:
            path = Path(directory)
            docker = path / "docker"
            docker.write_text("#!" + sys.executable + "\n" + FAKE)
            docker.chmod(0o755)
            log = path / "calls.jsonl"
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("HOMECLOUD_E2E_", "HC_TEST_"))}
            env.update(PATH=str(path) + os.pathsep + env["PATH"], HC_TEST_DOCKER_LOG=str(log), **extra)
            result = subprocess.run(["bash", "scripts/ci/run-restore-e2e-local.sh", "linux/arm64", *options],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def test_emulated_daemon_is_refused_before_builds(self):
        result, calls = self.invoke(HC_TEST_ENGINE="linux/x86_64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native Docker Engine", result.stderr)
        self.assertTrue(all(call[0] == "info" for call in calls))

    def test_foreign_nested_image_refused_before_builds(self):
        result, calls = self.invoke(HC_TEST_IMAGE_ARCH="amd64")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] in ("build", "run") for call in calls))

    def test_wrong_base_metadata_cannot_reach_backend_or_privileged_run(self):
        result, calls = self.invoke(HC_TEST_BASE_ARCH="amd64")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(call[0] == "build" for call in calls), 1)
        self.assertFalse(any(call[0] == "run" for call in calls))

    def test_native_failure_stops_before_nested_daemon(self):
        result, calls = self.invoke(HC_TEST_NATIVE_FAILURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("--privileged" in call or call[0] == "save" for call in calls))

    def test_encrypted_flow_builds_native_base_and_preflights_before_privileged(self):
        result, calls = self.invoke(("--encrypted-only",))
        self.assertEqual(result.returncode, 0, result.stderr)
        builds = [call for call in calls if call[0] == "build"]
        self.assertEqual(len(builds), 3)  # tooling base, one product, runtime context
        self.assertEqual(builds[0][-1], "-")
        self.assertEqual(builds[1][-1], "backend")
        for call in calls:
            if "--platform" in call:
                self.assertEqual(call[call.index("--platform") + 1], "linux/arm64")
        runs = [call for call in calls if call[0] == "run"]
        self.assertEqual(len(runs), 3)  # native product, runtime trust/tools, DinD
        self.assertIn("--strict", runs[0])
        self.assertNotIn("--privileged", runs[1])
        self.assertIn("--privileged", runs[2])
        self.assertIn("--cgroupns=private", runs[2])
        self.assertIn("HOMECLOUD_E2E_ENCRYPTED=1", runs[2])
        for call in runs[1:]:
            self.assertIn("HOMECLOUD_E2E_PLATFORM=linux/arm64", call)
        self.assertNotIn("seccomp=unconfined", str(calls))
        self.assertNotIn("type=bind", str(calls))

    def test_retained_oci_candidate_is_not_rebuilt(self):
        result, calls = self.invoke(HOMECLOUD_E2E_BACKEND_IMAGE="retained-candidate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "build" and call[-1] == "backend" for call in calls))
        self.assertIn(["tag", "retained-candidate", "homecloud-restore-e2e-backend:local"], calls)

    def test_historical_mode_has_distinct_flag_and_does_not_select_encrypted(self):
        result, calls = self.invoke(("--historical-schema-only",))
        self.assertEqual(result.returncode, 0, result.stderr)
        nested = next(call for call in calls if '--privileged' in call)
        self.assertIn('HOMECLOUD_E2E_HISTORICAL_SCHEMA=1', nested)
        self.assertIn('HOMECLOUD_E2E_ENCRYPTED=0', nested)

    def test_fault_mode_has_a_validated_separate_flag(self):
        result, calls = self.invoke(("--fault-case=staged",))
        self.assertEqual(result.returncode, 0, result.stderr)
        nested = next(call for call in calls if '--privileged' in call)
        self.assertIn('HOMECLOUD_E2E_FAULT_CASE=staged', nested)
        self.assertIn('HOMECLOUD_E2E_ENCRYPTED=0', nested)
        self.assertIn('HOMECLOUD_E2E_HISTORICAL_SCHEMA=0', nested)
        rejected, commands = self.invoke(("--fault-case=unqualified",))
        self.assertEqual(rejected.returncode, 2)
        self.assertEqual(commands, [])

    def test_retained_candidate_substitution_is_fatal(self):
        result, calls = self.invoke(HOMECLOUD_E2E_BACKEND_IMAGE="retained-candidate", HC_TEST_SUBSTITUTION="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == "run" for call in calls))

    def test_unknown_mode_is_refused_before_docker(self):
        result, calls = self.invoke(("--unknown",))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
