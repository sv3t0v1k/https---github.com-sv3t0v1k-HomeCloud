"""Одноразовая квалификация на GitHub hosted runner, без production-политики."""
import collections
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request

BASE = "docker.io/library/postgres:16.15-alpine@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551"
SOURCE = "6456aaa0f3c854d199d0f037f068eb97515b7513"
GO_SHA = "42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d"
TAG = "homecloud-d5110:experimental"
assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
assert os.uname().machine == "x86_64"
ROOT = Path(os.environ["RUNNER_TEMP"]) / "d5110"
ROOT.mkdir(exist_ok=False)
E = ROOT / "evidence"
E.mkdir()
events = []


def write(name, data):
    (E / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def run(args, *, cwd=None, env=None, data=None, ok=True):
    p = subprocess.run(args, cwd=cwd, env=env, input=data, capture_output=True,
                       text=True, timeout=900)
    events.append({"command": args, "returncode": p.returncode,
                   "stdout": p.stdout, "stderr": p.stderr})
    write("commands.json", events)
    print(" ".join(args[:4]), p.returncode, flush=True)
    if ok and p.returncode:
        raise RuntimeError(f"Command failed: {args[:4]}: {p.stderr[-2000:]}")
    return p.stdout.strip()


def docker(*args, **kwargs):
    return run(["docker", *args], **kwargs)


def inspect(image):
    return json.loads(docker("image", "inspect", image))[0]


def oci(name, image):
    archive = ROOT / (name + ".oci.tar")
    source = "docker://" + image.split("@")[0].rsplit(":", 1)[0] + "@" + image.split("@")[1] if name == "baseline" else "docker-daemon:" + image
    preserve = ["--preserve-digests"] if name == "baseline" else ["--format=v2s2", "--preserve-digests"]
    run(["skopeo", "copy", "--override-os", "linux", "--override-arch", "amd64",
         *preserve, source, "oci-archive:" + str(archive)])
    with tarfile.open(archive) as t:
        index = json.load(t.extractfile("index.json"))
        digest = index["manifests"][0]["digest"]
        manifest = json.load(t.extractfile("blobs/sha256/" + digest.split(":")[1]))
        config = json.load(t.extractfile("blobs/sha256/" + manifest["config"]["digest"].split(":")[1]))
    assert config["architecture"] == "amd64" and config["os"] == "linux"
    write(name + "-identity.json", {"manifest_digest": digest, "manifest": manifest,
          "config": config, "archive_sha256": sha(archive)})
    return archive, digest, manifest, config


def sql(container, statement, db="qualification"):
    return docker("exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                  "-U", "qualifier", "-d", db, "-At", data=statement)


def ready(container):
    for _ in range(40):
        result = subprocess.run(["docker", "exec", container, "pg_isready", "-U", "qualifier",
                                 "-d", "qualification"], capture_output=True, timeout=5)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("PostgreSQL startup timeout")


def start(name, image, volume, port=False):
    args = ["run", "-d", "--name", name, "--network", "none", "--memory", "512m",
            "--cpus", "2", "--mount", f"type=volume,source={volume},target=/var/lib/postgresql/data",
            "-e", "POSTGRES_USER=qualifier", "-e", "POSTGRES_DB=qualification",
            "-e", "POSTGRES_PASSWORD=disposable-experiment-only"]
    # Локальный порт только на одноразовом runner для реальных backend suites.
    if port:
        args[args.index("none")] = "bridge"
        args += ["-p", "127.0.0.1:55432:5432"]
    docker(*args, image)
    ready(name)


containers = ["d5110-base", "d5110-candidate", "d5110-restore", "d5110-backward"]
volumes = ["d5110-upgrade", "d5110-restore"]
try:
    write("scope.json", {"source": os.environ["GITHUB_SHA"], "baseline_source": "1c7d2424140fa3a8dfc49295edb56c9a471e9857",
          "run_id": os.environ["GITHUB_RUN_ID"], "base": BASE, "production": "NO_GO",
          "policy_changed": False, "new_disposition": False, "gosu_disposition_transferred": False})
    resume = os.environ.get("D5110_RESUME")
    if resume:
        previous = Path(resume)
        expected_proof = "fb8fc1ae84cdbde69093927ca6c1fc1eb0b0b0009dddc9c5c56f8289228a3e54"
        assert sha(previous / "reproducibility.json") == expected_proof
        proof = json.loads((previous / "reproducibility.json").read_text())
        assert proof["source_commit"] == SOURCE and proof["go_archive_sha256"] == GO_SHA
        builds = proof["builds"]
        assert builds[0] == builds[1]
        assert sha(previous / "gosu.experimental-linux-amd64") == builds[0]["binary_sha256"] == "3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085"
        for name in ["reproducibility.json", "gosu-go.mod", "gosu-go.sum", "gosu-version.go", "gosu-SECURITY.md",
                     "gosu-build-1-metadata.txt", "gosu-build-2-metadata.txt", "gosu.experimental-linux-amd64"]:
            shutil.copy2(previous / name, E / name)
        shutil.copy2(previous / "gosu.experimental-linux-amd64", ROOT / "gosu-1")
        write("reused-build.json", {"run_id": "38981422399", "source_head": "a73a6db586ff5b82f327a7e4d230e29de5a7055b", "proof_sha256": expected_proof,
              "reason": "Reuse successful reproducible build; only image export/runtime/scans remain"})
    else:
        go_archive = ROOT / "go.tar.gz"
        urllib.request.urlretrieve("https://go.dev/dl/go1.26.9.linux-amd64.tar.gz", go_archive)
        assert sha(go_archive) == GO_SHA
        run(["tar", "-xzf", str(go_archive), "-C", str(ROOT)])
        source = ROOT / "source"
        run(["git", "init", str(source)])
        run(["git", "-C", str(source), "fetch", "--depth=1", "https://github.com/tianon/gosu.git", SOURCE])
        run(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"])
        assert run(["git", "-C", str(source), "rev-parse", "HEAD"]) == SOURCE
        for name in ["go.mod", "go.sum", "version.go", "SECURITY.md"]:
            shutil.copy2(source / name, E / ("gosu-" + name))
        builds = []
        for attempt in (1, 2):
            build_src = ROOT / f"source-{attempt}"
            shutil.copytree(source, build_src, symlinks=True)
            assert run(["git", "status", "--porcelain"], cwd=build_src) == ""
            env = dict(os.environ, GOTOOLCHAIN="local", CGO_ENABLED="0", GOOS="linux", GOARCH="amd64",
                       GOAMD64="v1", GOPATH=str(ROOT / f"gopath-{attempt}"),
                       GOCACHE=str(ROOT / f"gocache-{attempt}"), GOFLAGS="-mod=readonly",
                       GOSUMDB="sum.golang.org", GOPROXY="https://proxy.golang.org")
            go = str(ROOT / "go/bin/go")
            run([go, "mod", "download"], cwd=build_src, env=env)
            run([go, "mod", "verify"], cwd=build_src, env=env)
            assert run(["git", "status", "--porcelain"], cwd=build_src) == ""
            binary = ROOT / f"gosu-{attempt}"
            run([go, "build", "-trimpath", "-buildvcs=true", "-ldflags=-d -w", "-o", str(binary), "."], cwd=build_src, env=env)
            metadata = run([go, "version", "-m", str(binary)])
            (E / f"gosu-build-{attempt}-metadata.txt").write_text(metadata + "\n")
            assert "go1.26.9" in metadata and "vcs.revision=" + SOURCE in metadata and "vcs.modified=false" in metadata
            assert metadata.startswith(str(binary) + ": ")
            builds.append({"binary_sha256": sha(binary), "metadata": metadata.removeprefix(str(binary) + ": ")})
        assert builds[0] == builds[1]
        shutil.copy2(ROOT / "gosu-1", E / "gosu.experimental-linux-amd64")
        write("reproducibility.json", {"go_archive_sha256": GO_SHA, "source_commit": SOURCE, "builds": builds,
              "scope": "two independent source paths, module and compiler caches; same runner and verified toolchain"})
    docker("pull", "--platform=linux/amd64", BASE)
    base_inspect = inspect(BASE)
    write("baseline-docker-inspect.json", base_inspect)
    assert base_inspect["RepoDigests"] and base_inspect["Architecture"] == "amd64"
    context = ROOT / "context"
    context.mkdir()
    shutil.copy2(ROOT / "gosu-1", context / "gosu")
    (context / "Dockerfile").write_text(f"FROM {BASE}\nCOPY --chown=0:0 --chmod=0755 gosu /usr/local/bin/gosu\n")
    docker("build", "--network=none", "--platform=linux/amd64", "-t", TAG, str(context))
    candidate_inspect = inspect(TAG)
    assert candidate_inspect["Config"] == base_inspect["Config"]
    assert candidate_inspect["RootFS"]["Layers"][:-1] == base_inspect["RootFS"]["Layers"]
    write("candidate-docker-inspect.json", candidate_inspect)
    base_oci = oci("baseline", BASE)
    candidate_oci = oci("candidate", TAG)
    assert candidate_oci[2]["config"]["digest"] == candidate_inspect["Id"]
    assert base_oci[1] == BASE.split("@")[1]
    for image, expected in [(BASE, "52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0"), (TAG, builds[0]["binary_sha256"])]:
        got = docker("run", "--rm", "--network=none", "--entrypoint", "sha256sum", image, "/usr/local/bin/gosu").split()[0]
        assert got == expected
    for spec in ["postgres", "postgres:postgres", "70:70"]:
        uid = docker("run", "--rm", "--network=none", "--entrypoint", "gosu", TAG, spec, "id", "-u")
        assert uid == "70"
    perms = docker("run", "--rm", "--network=none", "--entrypoint", "stat", TAG, "-c", "%u:%g:%a", "/usr/local/bin/gosu")
    assert perms == "0:0:755"
    for volume in volumes:
        docker("volume", "create", volume)
    start(containers[0], BASE, volumes[0])
    assert sql(containers[0], "SHOW server_version_num") == "160015"
    sql(containers[0], "CREATE TABLE qualification_marker(id integer PRIMARY KEY, value text); INSERT INTO qualification_marker VALUES(1,'isolated-d5110');")
    docker("stop", "-t", "30", containers[0])
    assert json.loads(docker("inspect", containers[0]))[0]["State"]["ExitCode"] == 0
    start(containers[1], TAG, volumes[0], port=True)
    assert sql(containers[1], "SELECT value FROM qualification_marker") == "isolated-d5110"
    assert sql(containers[1], "SHOW server_version_num") == "160015"
    proc = docker("exec", containers[1], "sh", "-c", "cat /proc/1/status")
    assert "Uid:\t70\t70\t70\t70" in proc and "Gid:\t70\t70\t70\t70" in proc
    write("runtime-process.json", {"status": proc, "gosu_mode": perms})
    backend = Path(os.environ["GITHUB_WORKSPACE"]) / "backend"
    run(["npm", "ci", "--no-audit"], cwd=backend)
    run(["sh", "native/build.sh"], cwd=backend)
    env = dict(os.environ, HOMECLOUD_TEST_DATABASE_URL="postgres://qualifier:disposable-experiment-only@127.0.0.1:55432/qualification")
    run(["npm", "test", "--", "--runInBand", "--testPathPatterns=\\.postgres\\.spec\\.ts$", "--json", "--outputFile=" + str(E / "postgres-tests.json")], cwd=backend, env=env)
    tests = json.loads((E / "postgres-tests.json").read_text())
    assert tests["numFailedTests"] == 0 and tests["numPendingTests"] == 0 and tests["numPassedTestSuites"] == 12 and tests["numPassedTests"] > 0
    # Дополнительно запускаем реальную production migration chain на пустой БД.
    sql(containers[1], "CREATE DATABASE migration_qualification")
    run(["npm", "run", "build"], cwd=backend)
    migration_env = dict(os.environ, DATABASE_URL="postgres://qualifier:disposable-experiment-only@127.0.0.1:55432/migration_qualification")
    run(["npm", "run", "migration:run"], cwd=backend, env=migration_env)
    run(["npm", "run", "migration:run"], cwd=backend, env=migration_env)
    dump = docker("exec", containers[1], "pg_dump", "-U", "qualifier", "-d", "qualification", "--no-owner", "--no-acl")
    (E / "fixture.sql").write_text(dump + "\n")
    start(containers[2], TAG, volumes[1])
    sql(containers[2], dump)
    assert sql(containers[2], "SELECT value FROM qualification_marker") == "isolated-d5110"
    docker("stop", "-t", "30", containers[1])
    assert json.loads(docker("inspect", containers[1]))[0]["State"]["ExitCode"] == 0
    docker("start", containers[1])
    ready(containers[1])
    assert sql(containers[1], "SELECT value FROM qualification_marker") == "isolated-d5110"
    docker("stop", "-t", "30", containers[1])
    start(containers[3], BASE, volumes[0])
    assert sql(containers[3], "SELECT value FROM qualification_marker") == "isolated-d5110"
    write("compatibility.json", {"status": "PASS", "postgres": "16.15", "data_format": "16",
          "tests": tests["numPassedTests"], "suites": tests["numPassedTestSuites"],
          "checks": ["privilege drop named/numeric user", "root owned mode 0755", "PID1 postgres uid/gid70", "fresh init",
          "official-to-candidate same PGDATA", "shutdown exit0", "restart", "candidate-to-official same PGDATA",
          "real PostgreSQL suites without skips", "production migration chain fresh DB and idempotent rerun", "SQL backup/restore fixture"]})
    trivy = str(Path(os.environ["RUNNER_TEMP"]) / "d5110-trivy/trivy")
    cache = ROOT / "trivy-cache"
    run([trivy, "image", "--cache-dir", str(cache), "--download-db-only"])
    db = cache / "db/trivy.db"
    db_hash = sha(db)
    db_meta = json.loads((cache / "db/metadata.json").read_text())
    from datetime import datetime, timezone
    assert (datetime.now(timezone.utc) - datetime.fromisoformat(db_meta["UpdatedAt"].replace("Z", "+00:00"))).total_seconds() < 86400
    for name, artifact in [("baseline", base_oci), ("candidate", candidate_oci)]:
        run([trivy, "image", "--cache-dir", str(cache), "--skip-db-update", "--offline-scan", "--scanners", "vuln",
             "--list-all-pkgs", "--format", "json", "--output", str(E / (name + "-scan.json")), "--input", str(artifact[0])])
        assert sha(db) == db_hash
        run([trivy, "image", "--cache-dir", str(cache), "--skip-db-update", "--offline-scan", "--format", "cyclonedx",
             "--output", str(E / (name + "-sbom.cdx.json")), "--input", str(artifact[0])])
    write("scanner-db.json", {"sha256": db_hash, "metadata": db_meta, "same_db_both_scans": True})
    def findings(name):
        report = json.loads((E / (name + "-scan.json")).read_text())
        results = report.get("Results", [])
        assert any(r.get("Type") == "gobinary" and r.get("Target") == "usr/local/bin/gosu" and r.get("Packages") for r in results)
        return [{"target": r["Target"], "package": v["PkgName"], "version": v["InstalledVersion"], "cve": v["VulnerabilityID"], "severity": v["Severity"], "fixed": v.get("FixedVersion")} for r in results for v in r.get("Vulnerabilities", [])]
    before, after = findings("baseline"), findings("candidate")
    key = lambda v: (v["target"], v["package"], v["cve"])
    before_keys, after_keys = set(map(key, before)), set(map(key, after))
    write("comparison.json", {"before": dict(collections.Counter(v["severity"] for v in before)), "after": dict(collections.Counter(v["severity"] for v in after)),
          "fixed": [v for v in before if key(v) not in after_keys], "remaining": after,
          "new": [v for v in after if key(v) not in before_keys], "no_disposition_applied": True})
    assert not any(v["severity"] in ("HIGH", "CRITICAL") and v["target"] == "usr/local/bin/gosu" for v in after)
    write("result.json", {"experimental_qualification": "PASS", "production": "NO_GO", "image": TAG,
          "image_digest": candidate_oci[1], "binary_sha256": builds[0]["binary_sha256"], "disposition_transferred": False})
finally:
    for container in containers:
        logs = docker("logs", container, ok=False)
        (E / (container + ".log")).write_text(logs)
        docker("rm", "-f", "-v", container, ok=False)
    for volume in volumes:
        docker("volume", "rm", volume, ok=False)
    write("evidence-hashes.json", {p.name: sha(p) for p in E.iterdir() if p.is_file() and p.name != "evidence-hashes.json"})
