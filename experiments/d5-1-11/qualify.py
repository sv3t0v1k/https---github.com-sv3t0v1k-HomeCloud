"""Узкий эксперимент: zlib r1 и moby/user 0.4.1; только одноразовый Linux runner."""
import collections
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request

assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
assert os.uname().machine == "x86_64"
ROOT = Path(os.environ["RUNNER_TEMP"]) / "d5111"
ROOT.mkdir(exist_ok=False)
E = ROOT / "evidence"
E.mkdir()
OLD = "homecloud-d5111:previous"
NEW = "homecloud-d5111:experimental"
SOURCE = "6456aaa0f3c854d199d0f037f068eb97515b7513"
OLD_MANIFEST = "sha256:fd2e86b5b1a2d9381d6e6018feacda382e6b669dda0a519dbc4744aa46980f95"
OLD_ARCHIVE = "2cffc90fb5c5f3309c3c1e2e708de8267dabab60dc49f164f418f3e1e0581961"
GO_SHA = "42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d"
APK_SHA = "63aeea03c15a2f9018f81805cfc8aa926bdf5cd68921f22149c2fbb5d0ee9f47"
events = []
containers = ["d5111-old", "d5111-new", "d5111-restore", "d5111-return"]
volumes = ["d5111-data", "d5111-restore"]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write(name, value):
    (E / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def run(args, *, cwd=None, env=None, data=None, ok=True):
    p = subprocess.run(args, cwd=cwd, env=env, input=data, capture_output=True,
                       text=True, timeout=600)
    events.append(dict(command=args, returncode=p.returncode, stdout=p.stdout, stderr=p.stderr))
    write("commands.json", events)
    print(" ".join(args[:4]), p.returncode, flush=True)
    if ok and p.returncode:
        raise RuntimeError(f"{args[:4]}: {p.stderr[-2000:]}")
    return p.stdout.strip()


def docker(*args, **kw):
    return run(["docker", *args], **kw)


def inspect(image):
    return json.loads(docker("image", "inspect", image))[0]


def fetch(url, name, expected):
    dest = ROOT / name
    urllib.request.urlretrieve(url, dest)
    assert sha(dest) == expected, name
    return dest


def sql(name, query):
    return docker("exec", "-i", name, "psql", "-U", "qualifier", "-d", "qualification",
                  "-v", "ON_ERROR_STOP=1", "-At", data=query + "\n")


def ready(name):
    for _ in range(90):
        result = docker("exec", name, "psql", "-h", "127.0.0.1", "-U", "qualifier",
                        "-d", "qualification", "-Atc", "SELECT 1", ok=False)
        if result == "1":
            return
        time.sleep(1)
    raise RuntimeError("PostgreSQL TCP readiness timeout")


def start(name, image, volume):
    docker("run", "-d", "--name", name, "--network=none", "-e", "POSTGRES_USER=qualifier",
           "-e", "POSTGRES_PASSWORD=disposable-experiment-only", "-e", "POSTGRES_DB=qualification",
           "--mount", f"type=volume,src={volume},dst=/var/lib/postgresql/data", image)
    ready(name)


try:
    # Проверенный immutable helper; никаких изменений security policy.
    helper_path = Path("scripts/ci/oci-scan-binding.py").resolve()
    import sys
    sys.path.insert(0, str(helper_path.parent))
    spec = importlib.util.spec_from_file_location("binding", helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    previous = Path(os.environ["D5111_PREVIOUS_ARCHIVE"])
    assert sha(previous) == OLD_ARCHIVE
    old_artifact = helper.identity(previous)
    assert old_artifact[0] == OLD_MANIFEST
    shutil.copy2(previous, ROOT / "previous.oci.tar")
    docker_old = ROOT / "previous.oci.tar"
    run(["skopeo", "copy", "--preserve-digests", "oci-archive:" + str(docker_old), "docker-daemon:" + OLD])
    assert inspect(OLD)["Id"] == old_artifact[1]["config"]["digest"]
    assert inspect(OLD)["RootFS"]["Layers"] == old_artifact[2]["rootfs"]["diff_ids"]

    archive = fetch("https://go.dev/dl/go1.26.9.linux-amd64.tar.gz", "go.tar.gz", GO_SHA)
    run(["tar", "-xzf", str(archive), "-C", str(ROOT)])
    go = str(ROOT / "go/bin/go")
    source = ROOT / "source"
    run(["git", "init", str(source)])
    run(["git", "-C", str(source), "fetch", "--depth=1", "https://github.com/tianon/gosu.git", SOURCE])
    run(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"])
    assert run(["git", "-C", str(source), "rev-parse", "HEAD"]) == SOURCE
    assert run(["git", "-C", str(source), "status", "--porcelain"]) == ""
    original_mod = (source / "go.mod").read_text()
    assert "github.com/moby/sys/user v0.1.0" in original_mod
    (source / "go.mod").write_text(original_mod.replace("github.com/moby/sys/user v0.1.0", "github.com/moby/sys/user v0.4.1"))
    env = dict(os.environ, GOTOOLCHAIN="local", CGO_ENABLED="0", GOOS="linux", GOARCH="amd64",
               GOAMD64="v1", GOPATH=str(ROOT / "gopath-prepare"), GOCACHE=str(ROOT / "cache-prepare"),
               GOSUMDB="sum.golang.org", GOPROXY="https://proxy.golang.org", GOFLAGS="")
    run([go, "mod", "tidy"], cwd=source, env=env)
    assert (source / "go.mod").read_text() == original_mod.replace("github.com/moby/sys/user v0.1.0", "github.com/moby/sys/user v0.4.1")
    changed = run(["git", "diff", "--name-only"], cwd=source).splitlines()
    assert set(changed) <= {"go.mod", "go.sum"} and "go.mod" in changed
    (E / "gosu-dependency.patch").write_text(run(["git", "diff", "--", "go.mod", "go.sum"], cwd=source) + "\n")
    for name in ("go.mod", "go.sum"):
        shutil.copy2(source / name, E / name)
    deps = run([go, "list", "-deps", "./..."], cwd=source, env=env).splitlines()
    assert "golang.org/x/sys/unix" in deps and not any(p.startswith("golang.org/x/sys/windows") for p in deps)
    write("linux-deps.json", dict(goos="linux", goarch="amd64", imports=deps, source_commit=SOURCE,
                                 applicability="GO-2026-5024 windows package excluded; raw finding retained"))
    run([go, "test", "-count=1", "github.com/moby/sys/user"], cwd=source, env=env)
    builds = []
    for i in (1, 2):
        src = ROOT / f"source-{i}"
        shutil.copytree(source, src, symlinks=True)
        isolated = dict(env, GOPATH=str(ROOT / f"gopath-{i}"), GOCACHE=str(ROOT / f"cache-{i}"), GOFLAGS="-mod=readonly")
        run([go, "mod", "download"], cwd=src, env=isolated)
        run([go, "mod", "verify"], cwd=src, env=isolated)
        binary = ROOT / f"gosu-{i}"
        run([go, "build", "-trimpath", "-buildvcs=false", "-ldflags=-d -w", "-o", str(binary), "."], cwd=src, env=isolated)
        meta = run([go, "version", "-m", str(binary)])
        assert "go1.26.9" in meta and "github.com/moby/sys/user\tv0.4.1" in meta
        assert "golang.org/x/sys\tv0.1.0" in meta and "GOOS=linux" in meta and "CGO_ENABLED=0" in meta
        (E / f"build-{i}.txt").write_text(meta + "\n")
        builds.append(sha(binary))
    assert builds[0] == builds[1]
    shutil.copy2(ROOT / "gosu-1", E / "gosu.experimental-linux-amd64")
    write("build.json", dict(upstream_source_commit=SOURCE, dependency_patch_sha256=sha(E / "gosu-dependency.patch"),
          binaries=builds, go_sha256=GO_SHA, vcs="disabled: dependency-modified source, not pristine upstream",
          reproducibility="binary only, independent source paths/module/compiler caches on one runner"))

    context = ROOT / "context"
    context.mkdir()
    shutil.copy2(ROOT / "gosu-1", context / "gosu")
    apk = fetch("https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/zlib-1.3.2-r1.apk", "zlib.apk", APK_SHA)
    shutil.copy2(apk, context / "zlib.apk")
    dockerfile = f"FROM {OLD}\nCOPY --chown=0:0 --chmod=0755 gosu /usr/local/bin/gosu\nCOPY zlib.apk /tmp/d5111-zlib.apk\nRUN apk add --no-network /tmp/d5111-zlib.apk && rm /tmp/d5111-zlib.apk\n"
    (context / "Dockerfile").write_text(dockerfile)
    (E / "Dockerfile").write_text(dockerfile)
    docker("build", "--network=none", "--platform=linux/amd64", "-t", NEW, str(context))
    new = inspect(NEW)
    old = inspect(OLD)
    assert new["Config"] == old["Config"]
    assert new["RootFS"]["Layers"][:len(old["RootFS"]["Layers"])] == old["RootFS"]["Layers"]
    assert docker("run", "--rm", "--network=none", "--entrypoint", "apk", NEW, "info", "-v", "zlib") == "zlib-1.3.2-r1"
    assert docker("run", "--rm", "--network=none", "--entrypoint", "sha256sum", NEW, "/usr/local/bin/gosu").split()[0] == builds[0]
    new_archive = ROOT / "candidate.oci.tar"
    run(["skopeo", "copy", "--format=v2s2", "--preserve-digests", "docker-daemon:" + NEW, "oci-archive:" + str(new_archive)])
    identity = helper.identity(new_archive)
    assert identity[1]["config"]["digest"] == new["Id"]
    write("identity.json", dict(manifest=identity[0], config=new["Id"], archive_sha256=sha(new_archive),
          previous_manifest=OLD_MANIFEST, previous_archive_sha256=OLD_ARCHIVE, binary_sha256=builds[0], apk_sha256=APK_SHA))

    # Все новые layers: только gosu, zlib и bookkeeping apk. Временный apk допустим
    # лишь в нижнем COPY-layer, затем whiteout; он остаётся частью SBOM/scans.
    layer_members = []
    with tarfile.open(new_archive) as store:
        for layer in identity[1]["layers"][len(old_artifact[1]["layers"]):]:
            with tarfile.open(fileobj=store.extractfile("blobs/sha256/" + layer["digest"][7:]), mode="r|*") as stream:
                for member in stream:
                    name = member.name.removeprefix("./").rstrip("/")
                    if member.isdir():
                        continue
                    allowed = {"usr/local/bin/gosu", "usr/lib/libz.so.1", "usr/lib/libz.so.1.3.2",
                               "etc/apk/world", "lib/apk/db/installed", "lib/apk/db/scripts.tar",
                               "lib/apk/db/triggers", "lib/apk/db/lock", "tmp/d5111-zlib.apk", "tmp/.wh.d5111-zlib.apk"}
                    assert name in allowed, name
                    layer_members.append(dict(layer=layer["digest"], path=name, mode=oct(member.mode), uid=member.uid, gid=member.gid))
    write("layer-members.json", layer_members)

    trivy = str(Path(os.environ["RUNNER_TEMP"]) / "d5111-trivy/trivy")
    cache = ROOT / "trivy-cache"
    run([trivy, "image", "--cache-dir", str(cache), "--download-db-only"])
    db = cache / "db/trivy.db"
    db_hash = sha(db)
    meta = json.loads((cache / "db/metadata.json").read_text())
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(meta["UpdatedAt"].replace("Z", "+00:00"))).total_seconds()
    assert 0 <= age < 86400
    findings = {}
    for name, arc, ident in [("previous", docker_old, old_artifact), ("candidate", new_archive, identity)]:
        layout = str(helper.materialize(arc))
        common = [trivy, "image", "--cache-dir", str(cache), "--skip-db-update", "--offline-scan", "--config", "/dev/null",
                  "--ignorefile", "/dev/null", "--ignore-unfixed=false", "--platform", "linux/amd64", "--input", layout]
        run(common + ["--scanners", "vuln", "--list-all-pkgs", "--format", "json", "--output", str(E / (name + "-scan.json"))])
        report = json.loads((E / (name + "-scan.json")).read_text())
        write(name + "-binding.json", helper.bind(arc, report, "postgres", os.environ["GITHUB_SHA"], ident[0]))
        run(common + ["--format", "cyclonedx", "--output", str(E / (name + "-sbom.cdx.json"))])
        assert sha(db) == db_hash
        assert any(r.get("Target") == "usr/local/bin/gosu" and r.get("Packages") for r in report["Results"])
        findings[name] = [{"target": "os:" + r["Type"] if r.get("Class") == "os-pkgs" else r["Target"],
                           "package": v["PkgName"], "cve": v["VulnerabilityID"], "severity": v["Severity"]}
                          for r in report["Results"] for v in r.get("Vulnerabilities", [])]
    write("scanner-db.json", dict(sha256=db_hash, metadata=meta, same_db=True))
    key = lambda v: (v["target"], v["package"], v["cve"])
    before = set(map(key, findings["previous"]))
    delta = [v for v in findings["candidate"] if key(v) not in before]
    write("comparison.json", dict(findings=findings, counts={k:dict(collections.Counter(v["severity"] for v in vs)) for k,vs in findings.items()}, new=delta))
    assert not delta
    assert not any(v["cve"] in ("CVE-2026-85091", "CVE-2026-61801") or v["severity"] in ("CRITICAL", "HIGH") for v in findings["candidate"])

    assert docker("run", "--rm", "--network=none", "--entrypoint", "stat", NEW, "-c", "%u:%g:%a", "/usr/local/bin/gosu") == "0:0:755"
    for user in ("postgres", "postgres:postgres", "70:70"):
        assert docker("run", "--rm", "--network=none", "--entrypoint", "gosu", NEW, user, "sh", "-c", 'test "$(id -u)" = 70 && test "$(id -g)" = 70 && test "$(id -G)" = 70 && test "$HOME" = /var/lib/postgresql && echo PASS') == "PASS"
    for volume in volumes:
        docker("volume", "create", volume)
    start(containers[0], OLD, volumes[0])
    sql(containers[0], "CREATE TABLE marker AS SELECT g id, repeat(md5(g::text),100) payload FROM generate_series(1,1000) g;")
    digest_query = "SELECT md5(string_agg(payload,'' ORDER BY id)) FROM marker"
    data_hash = sql(containers[0], digest_query)
    docker("stop", "-t", "30", containers[0])
    assert json.loads(docker("inspect", containers[0]))[0]["State"]["ExitCode"] == 0
    start(containers[1], NEW, volumes[0])
    assert sql(containers[1], "SHOW server_version_num") == "160015"
    assert sql(containers[1], digest_query) == data_hash
    proc = docker("exec", containers[1], "cat", "/proc/1/status")
    assert "Name:\tpostgres" in proc and "Uid:\t70\t70\t70\t70" in proc and "Gid:\t70\t70\t70\t70" in proc
    # compressed custom-format dump exercises zlib ABI; binary bytes stay in container.
    docker("exec", containers[1], "pg_dump", "-U", "qualifier", "-d", "qualification", "-Fc", "-Z6", "-f", "/tmp/fixture.dump")
    dump = ROOT / "fixture.dump"
    docker("cp", containers[1] + ":/tmp/fixture.dump", str(dump))
    start(containers[2], NEW, volumes[1])
    docker("cp", str(dump), containers[2] + ":/tmp/fixture.dump")
    docker("exec", containers[2], "pg_restore", "-U", "qualifier", "-d", "qualification", "--exit-on-error", "/tmp/fixture.dump")
    assert sql(containers[2], digest_query) == data_hash
    docker("stop", "-t", "30", containers[1])
    assert json.loads(docker("inspect", containers[1]))[0]["State"]["ExitCode"] == 0
    docker("start", containers[1])
    ready(containers[1])
    assert sql(containers[1], digest_query) == data_hash
    docker("stop", "-t", "30", containers[1])
    start(containers[3], OLD, volumes[0])
    assert sql(containers[3], digest_query) == data_hash
    write("compatibility.json", dict(status="PASS", postgres="16.15", fixture_rows=1000, payload_hash=data_hash,
          checks=["moby/user upstream tests", "named/numeric UID/GID/groups/HOME", "fresh init", "previous-to-new PGDATA", "PID1 UID/GID70",
                  "compressed pg_dump/pg_restore", "clean shutdown", "restart", "new-to-previous PGDATA"],
          prior_154_tests="not rerun; historical D5.1.10 exact previous image only", prior_26_migrations="not rerun; no backend/migration changes"))
    write("result.json", dict(experiment="PASS", production="NO_GO", manifest=identity[0], binary_sha256=builds[0],
          disposition_transferred=False, new_exceptions=False, policy_changed=False))
finally:
    for container in containers:
        (E / (container + ".log")).write_text(docker("logs", container, ok=False))
        docker("rm", "-f", "-v", container, ok=False)
    for volume in volumes:
        docker("volume", "rm", volume, ok=False)
    write("evidence-hashes.json", {p.name:sha(p) for p in E.iterdir() if p.is_file() and p.name != "evidence-hashes.json"})
