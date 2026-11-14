#!/usr/bin/env python3
"""Qualify current sources in disposable Docker Desktop containers, no mounts.

No Git writes, host data, ports, existing databases or privileged containers.
Jest executes as UID/GID1000 on a freshly built Linux builder with real PG16.15.
The production runner used for maintenance/copy tests is built separately and
pinned by its actual image ID. Reports survive in a new /tmp artifact directory.
"""
import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import re
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
# Non-DinD Python/HTTP/age tooling retains its qualified AMD64 platform.
# Product builder/runner/PG retain the requested platform. The separate DinD
# launcher requires native Engine/tool executables, never an emulated daemon.
TOOLING_PLATFORM = "linux/amd64"
NATIVE_COPY_ASSERTION = "copy-file benchmark harness invokes production FilesService with secure Linux storage"
STAGES = ("backend-unit", "postgres-prerequisite", "backend-integration", "native-inherited-orphan-fence",
          "linux-storage-crash", "encrypted-backup", "scheduled-http-encrypted", "maintenance-supervisor", "copy-recovery")


def same_product_source(previous, current):
    for field in ("branch", "head"):
        if previous[field] != current[field]:
            raise ValueError("Platform probe source " + field + " changed")
    old = {e["path"]: e["sha256"] for e in previous["code_manifest"] if e["path"].startswith("backend/")}
    new = {e["path"]: e["sha256"] for e in current["code_manifest"] if e["path"].startswith("backend/")}
    if not old or old != new:
        raise ValueError("Platform probe backend source changed")


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def verify_jest(profile, raw):
    """Only map container source paths; preserve every assertion/status/count."""
    routing = module("qualification_routing", ROOT / "scripts/ci/test-routing.py")
    report = copy.deepcopy(raw)
    for item in report.get("testResults", []):
        name = PurePosixPath(item["name"])
        if not name.is_absolute() or ".." in name.parts:
            raise ValueError("Invalid container test report path")
        relative = name.relative_to(PurePosixPath("/app"))
        item["name"] = str(ROOT / "backend" / str(relative))
    routing.verify(profile, report)
    postgres = [item for item in report["testResults"] if item["name"].endswith(".postgres.spec.ts")]
    postgres_tests = sum(len(item["assertionResults"]) for item in postgres)
    previously_skipped = postgres_tests
    if profile == "integration":
        # The historical318 skips were317 PostgreSQL assertions plus the
        # Linux-only production secure-copy benchmark (bench passed109 on Mac).
        native = [assertion for item in report["testResults"]
                  if Path(item["name"]) == ROOT / "backend/bench/copy-file-runner.spec.ts"
                  for assertion in item["assertionResults"]
                  if assertion.get("fullName") == NATIVE_COPY_ASSERTION]
        if len(native) != 1 or native[0].get("status") != "passed":
            raise ValueError("Required native secure-copy benchmark missing: historical318 skips not qualified")
        previously_skipped += 1
        if postgres_tests < 317 or previously_skipped < 318:
            raise ValueError("Fewer than the required historical318 skipped assertions qualified")
    return {"suites": len(report["testResults"]),
            "pass": sum(len(item["assertionResults"]) for item in report["testResults"]),
            "postgres_suites": len(postgres), "postgres_assertions": postgres_tests,
            "previously_skipped_assertions": previously_skipped,
            "skip": 0, "fail": 0}


def checkpoint():
    data = json.loads((ROOT / "docs/handoff/PR-45-CLOSURE-CHECKS.json").read_text())
    for field, command in (("branch", ["git", "branch", "--show-current"]),
                           ("head", ["git", "rev-parse", "HEAD"])):
        if subprocess.check_output(command, cwd=ROOT, text=True).strip() != data[field]:
            raise ValueError("Working " + field + " differs from checkpoint")
    for item in data["code_manifest"]:
        path = PurePosixPath(item["path"])
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Invalid checkpoint source path")
        if hashlib.sha256((ROOT / str(path)).read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("Source changed since checkpoint: " + str(path))
    fingerprint = hashlib.sha256(json.dumps(data["code_manifest"], ensure_ascii=False,
                                           separators=(",", ":")).encode()).hexdigest()
    if fingerprint != data["code_snapshot_sha256"]:
        raise ValueError("Checkpoint fingerprint mismatch")
    return {key: data[key] for key in ("branch", "head", "code_snapshot_sha256", "code_manifest")}


class Qualification:
    def __init__(self, platform):
        self.platform = platform
        self.arch = platform.split("/")[1]
        self.output = Path(tempfile.mkdtemp(prefix="homecloud-pr45-qualification-" + self.arch + ".", dir="/tmp"))
        self.env = dict(os.environ)
        for name in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            self.env.pop(name, None)
        self.env["DOCKER_HOST"] = "unix://" + str(Path.home() / ".docker/run/docker.sock")
        self.containers = []
        self.network = None
        self.stage = "setup"
        self.report = {"platform": platform, "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       "source": checkpoint(), "checks": [], "images": {}, "complete": False}

    def command(self, args, capture=False, stdin=None, timeout=None):
        log = self.output / (self.stage + ".log")
        with log.open("a") as stream:
            process = subprocess.Popen(args, cwd=ROOT, env=self.env, text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=stdin)
            timer = threading.Timer(timeout, process.terminate) if timeout else None
            if timer:
                timer.start()
            lines = []
            try:
                for line in process.stdout:
                    stream.write(line)
                    stream.flush()
                    if capture:
                        lines.append(line)
                    else:
                        print(line, end="", flush=True)
                code = process.wait()
            finally:
                if timer:
                    timer.cancel()
        if code:
            raise RuntimeError("Operation failed (exit %s); see %s" % (code, log))
        return "".join(lines).strip()

    def attempt(self, name, function):
        self.stage = name
        print("=== " + name + " ===", flush=True)
        try:
            details = function() or {}
            self.report["checks"].append({"name": name, "status": "PASS", "details": details})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            print("FAIL: " + name + ": " + str(error), flush=True)
            self.report["checks"].append({"name": name, "status": "FAIL", "error": str(error)})

    def image(self, reference, platform=None):
        data = json.loads(self.command([
            "docker", "image", "inspect", reference, "--format",
            '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}}}',
        ], capture=True))
        if data["os"] + "/" + data["arch"] != (platform or self.platform):
            raise ValueError("Image architecture differs: " + reference)
        self.report["images"][reference] = data
        return data["id"]

    def node_image(self, reference):
        identity = self.image(reference)
        result = json.loads(self.command([
            "docker", "run", "--rm", "--pull=never", "--platform", self.platform,
            "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--entrypoint", "node", identity, "-e",
            (ROOT / "scripts/ci/native-boundary-preflight.cjs").read_text(),
        ], capture=True))
        self.report.setdefault("execution_probes", {})[identity] = result
        actual = result["os"] + "/" + {"x64": "amd64", "arm64": "arm64"}.get(result["arch"], "unknown")
        if actual != self.platform or result.get("nativeAddonLoaded") is not True:
            raise ValueError("Runtime executable/native addon differs from requested product platform")
        if result.get("nativeBoundaryOperational") is not True:
            raise ValueError("Native storage boundary unavailable: " + json.dumps(result, sort_keys=True))
        return identity

    def inspect_engine(self):
        self.report["engine"] = json.loads(self.command([
            "docker", "info", "--format",
            '{"version":{{json .ServerVersion}},"os":{{json .OSType}},"arch":{{json .Architecture}}}',
        ], capture=True))

    def prepare(self, scheduled_only=False):
        self.inspect_engine()
        if scheduled_only:
            self.prepare_tooling()
            return
        builder = "homecloud-pr45-builder:" + self.arch + "-local"
        runner = "homecloud-pr45-runner:" + self.arch + "-local"
        built = {}
        for stage, tag in (("builder", builder), ("runner", runner)):
            iid = self.output / (stage + "-image.id")
            self.command(["docker", "build", "--pull=false", "--platform", self.platform,
                          "--target", stage, "--iidfile", str(iid), "-t", tag, "backend"])
            built[stage] = self.node_image(iid.read_text().strip())
        self.builder = built["builder"]
        self.runner = built["runner"]
        # PG must be the current native16.15 fixture, never an existing DB.
        pg_reference = "postgres:16-alpine"
        if self.arch == "amd64":
            pg_reference = json.loads((ROOT / "scripts/ci/production-images.lock.json").read_text())["postgres"]
            self.command(["docker", "pull", "--platform", self.platform, pg_reference])
        self.pg_image = self.image(pg_reference)
        self.prepare_tooling()

    def prepare_tooling(self):
        self.report["tooling_platform"] = TOOLING_PLATFORM
        with (ROOT / "scripts/ci/restore-e2e-runner.Dockerfile").open("rb") as dockerfile:
            self.command(["docker", "build", "--platform", TOOLING_PLATFORM,
                          "-t", "homecloud-restore-e2e-runner:local", "-"], stdin=dockerfile)
        context = module("qualification_context", ROOT / "scripts/ci/restore-e2e-context.py")
        extra = [path.relative_to(ROOT) for folder in ("scripts/ci", "scripts/tests")
                 for path in (ROOT / folder).iterdir() if path.suffix in (".py", ".sh", ".sql")]
        extra += [path.relative_to(ROOT) for path in (ROOT / "ops/systemd").iterdir()
                  if path.suffix in (".service", ".timer")]
        tooling = "homecloud-pr45-tools:" + self.arch + "-local"
        tooling_iid = self.output / "tooling-image.id"
        # Use a streaming allowlist, never a second host checkout or bind mount.
        with (self.output / "tooling-build.log").open("w") as log:
            process = subprocess.Popen(["docker", "build", "--pull=false", "--platform", TOOLING_PLATFORM,
                                        "--iidfile", str(tooling_iid), "-t", tooling, "-"], cwd=ROOT, env=self.env,
                                       stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT)
            try:
                context.write_context(process.stdin, ROOT, extra_paths=extra,
                                      dockerfile=(ROOT / "scripts/ci/pr45-qualification-tools.Dockerfile").read_bytes())
                process.stdin.close()
                if process.wait():
                    raise RuntimeError("Tooling build failed; see tooling-build.log")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait()
        self.tools = self.image(tooling_iid.read_text().strip(), platform=TOOLING_PLATFORM)

    def remove(self, cid):
        self.command(["docker", "rm", "-f", "-v", cid], capture=True)
        self.containers.remove(cid)

    def postgres(self):
        network = "hc-pr45-qualification-" + secrets.token_hex(8)
        self.command(["docker", "network", "create", "--internal", network], capture=True)
        self.network = network
        password = secrets.token_hex(24)
        self.database_url = "postgres://hc_pr45:" + password + "@postgres:5432/hc_pr45"
        cid = self.command([
            "docker", "create", "--pull=never", "--platform", self.platform, "--network", self.network,
            "--network-alias", "postgres", "--security-opt", "no-new-privileges",
            "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1073741824",
            "-e", "POSTGRES_DB=hc_pr45", "-e", "POSTGRES_USER=hc_pr45",
            "-e", "POSTGRES_PASSWORD=" + password, self.pg_image,
        ], capture=True)
        self.containers.append(cid)
        self.command(["docker", "start", cid], capture=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = subprocess.run(["docker", "exec", cid, "pg_isready", "-h", "127.0.0.1",
                                     "-U", "hc_pr45", "-d", "hc_pr45"], env=self.env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                version = self.command(["docker", "exec", cid, "psql", "-U", "hc_pr45", "-d", "hc_pr45",
                                        "-tAc", "SHOW server_version"], capture=True)
                if version != "16.15":
                    raise ValueError("Actual PostgreSQL version differs from16.15: " + version)
                self.report["postgres_version"] = version
                return {"server_version": version, "storage": "private tmpfs", "network": "internal"}
            time.sleep(1)
        raise RuntimeError("Disposable PostgreSQL did not become ready")

    def jest(self, profile):
        if profile == "integration" and self.report.get("postgres_version") != "16.15":
            raise RuntimeError("Real PostgreSQL prerequisite failed; integration not executed")
        routing = module("qualification_routes", ROOT / "scripts/ci/test-routing.py")
        args = ["--runInBand", "--runTestsByPath", *routing.routes()[profile], "--json",
                "--outputFile=/app/.ci-reports/" + profile + ".json"]
        drop = ('process.setgroups([]);process.setgid(1000);process.setuid(1000);'
                'const r=require("node:child_process").spawnSync(process.execPath,'
                '["node_modules/jest/bin/jest.js",...process.argv.slice(1)],{stdio:"inherit"});'
                'process.exit(r.status===null?1:r.status);')
        options = ["--network", self.network] if profile == "integration" else ["--network", "none"]
        if profile == "integration":
            options += ["-e", "HOMECLOUD_TEST_DATABASE_URL=" + self.database_url]
        cid = self.command([
            "docker", "create", "--pull=never", "--init", "--platform", self.platform, *options,
            "--security-opt", "no-new-privileges", "--user", "0:0", "--entrypoint", "sh", self.builder,
            "-ec", 'mkdir -p /app/.ci-reports; rm -f /app/.ci-reports/unit.json /app/.ci-reports/integration.json; '
                   'chown -R 1000:1000 /app; code=$1; shift; exec node -e "$code" -- "$@"',
            "qualification", drop, *args,
        ], capture=True)
        self.containers.append(cid)
        error = None
        raw_path = self.output / ("backend-" + profile + "-raw.json")
        try:
            try:
                self.command(["docker", "start", "-a", cid], timeout=1800)
            except RuntimeError as failure:
                error = failure
            self.command(["docker", "cp", cid + ":/app/.ci-reports/" + profile + ".json", str(raw_path)], capture=True)
        finally:
            self.remove(cid)
        if error:
            raise error
        details = verify_jest(profile, json.loads(raw_path.read_text()))
        details["raw_report_sha256"] = hashlib.sha256(raw_path.read_bytes()).hexdigest()
        return details

    def native(self):
        self.command([
            "docker", "run", "--rm", "--pull=never", "--init", "--platform", self.platform, "--network", "none",
            "--user", "1000:1000", "--security-opt", "no-new-privileges", "--entrypoint", "node",
            self.builder, "--test", "--test-timeout=30000", "test/inherited-root-fence.runtime.cjs",
            "test/copy-root-fence-supervisor.runtime.cjs", "test/operator-cli-fence.runtime.cjs",
        ])

    def tooling(self, command):
        self.command(["docker", "run", "--rm", "--pull=never", "--init", "--platform", TOOLING_PLATFORM, "--network", "none",
                      "--security-opt", "no-new-privileges", self.tools, *command])

    def probe_existing(self, directories):
        evidence = []
        for directory in directories:
            previous = json.loads((directory / "qualification.json").read_text())
            same_product_source(previous["source"], self.report["source"])
            if previous["platform"] != self.platform:
                raise ValueError("Existing report product platform differs")
            # Only retained product executables establish product architecture.
            # Old untagged tooling may have been garbage-collected; tooling
            # platform is enforced independently when building current tools.
            for role, filename in (("builder", "builder-image.id"), ("runner", "runner-image.id")):
                path = directory / filename
                if not path.exists():
                    continue
                reference = path.read_text().strip()
                if re.fullmatch(r"sha256:[0-9a-f]{64}", reference) is None:
                    raise ValueError("Invalid retained image identity")
                identity = self.node_image(reference)
                runtime = self.report["execution_probes"][identity]
                actual = runtime["os"] + "/" + {"x64": "amd64", "arm64": "arm64"}.get(runtime["arch"], "unknown")
                evidence.append({"role": role, "report": str(directory), "source_snapshot": previous["source"]["code_snapshot_sha256"],
                                 "image_id": identity, "metadata_platform": self.platform, "runtime_platform": actual,
                                 "native_addon_loaded": runtime.get("nativeAddonLoaded", False),
                                 "native_boundary_operational": runtime.get("nativeBoundaryOperational", False)})
        if {item["role"] for item in evidence} != {"builder", "runner"}:
            raise ValueError("Required retained product builder/runner probes missing")
        return {"images": evidence}

    def finish(self):
        self.stage = "cleanup"
        failures = []
        for cid in self.containers[:]:
            try:
                self.remove(cid)
            except (OSError, RuntimeError) as error:
                failures.append(str(error))
        if self.network:
            try:
                self.command(["docker", "network", "rm", self.network], capture=True)
            except (OSError, RuntimeError) as error:
                failures.append(str(error))
        self.report["cleanup_errors"] = failures
        scope = self.report.get("scope", "all")
        expected = {"all": set(STAGES), "scheduled-http-encrypted": {"scheduled-http-encrypted"},
                    "platform-evidence": {"platform-evidence"}}.get(scope, set())
        self.report["scope_complete"] = bool(expected) and not failures and len(self.report["checks"]) == len(expected) and {
            item.get("name") for item in self.report["checks"]} == expected and all(
            item["status"] == "PASS" for item in self.report["checks"])
        try:
            same_source = checkpoint() == self.report["source"]
        except (OSError, ValueError) as error:
            same_source = False
            self.report["source_check_error"] = str(error)
        if not same_source:
            self.report["scope_complete"] = False
            self.report["source_changed_during_run"] = True
        self.report["complete"] = scope == "all" and self.report["scope_complete"]
        (self.output / "qualification.json").write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + "\n")
        print("REPORTS: " + str(self.output), flush=True)
        label = {"all": "LOCAL LINUX QUALIFICATION", "scheduled-http-encrypted": "SCHEDULED HTTP ENCRYPTED QUALIFICATION",
                 "platform-evidence": "PLATFORM EVIDENCE"}.get(scope, "UNKNOWN QUALIFICATION SCOPE")
        print(("PASS: " if self.report["scope_complete"] else "FAIL: ") + label, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("linux/arm64", "linux/amd64"))
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--scheduled-only", action="store_true", help="Run only the remaining scheduled fixture; never report full qualification PASS")
    selection.add_argument("--probe-existing", nargs="+", type=Path, help="Read retained image executable/native addon architecture without rerunning suites")
    args = parser.parse_args()
    qualification = Qualification(args.platform)
    qualification.report["scope"] = "platform-evidence" if args.probe_existing else "scheduled-http-encrypted" if args.scheduled_only else "all"
    try:
        if args.probe_existing:
            qualification.inspect_engine()
            qualification.attempt("platform-evidence", lambda: qualification.probe_existing(args.probe_existing))
        else:
            qualification.prepare(scheduled_only=args.scheduled_only)
            if args.scheduled_only:
                qualification.attempt("scheduled-http-encrypted", lambda: qualification.tooling(["-ec", "python3 -B scripts/tests/test-scheduled-operations.py"]))
            else:
                run_all(qualification)
    finally:
        qualification.finish()
    return 0 if qualification.report["scope_complete"] else 1


def run_all(qualification):
    qualification.attempt("backend-unit", lambda: qualification.jest("unit"))
    qualification.attempt("postgres-prerequisite", qualification.postgres)
    qualification.attempt("backend-integration", lambda: qualification.jest("integration"))
    qualification.attempt("native-inherited-orphan-fence", qualification.native)
    qualification.attempt("linux-storage-crash", lambda: qualification.tooling(["-ec", "python3 -B scripts/ci/test-restore-storage-linux.py"]))
    qualification.attempt("encrypted-backup", lambda: qualification.tooling(["scripts/tests/test-backup-production.sh"]))
    qualification.attempt("scheduled-http-encrypted", lambda: qualification.tooling(["-ec", "python3 -B scripts/tests/test-scheduled-operations.py"]))
    qualification.attempt("maintenance-supervisor", lambda: qualification.command([
        "bash", "scripts/ci/test-maintenance-supervisor.sh", qualification.runner, qualification.platform]))
    qualification.attempt("copy-recovery", lambda: qualification.command([
        "bash", "scripts/ci/test-copy-recovery-e2e.sh", qualification.runner, qualification.platform]))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("STOP: " + str(error), file=sys.stderr)
        sys.exit(1)
