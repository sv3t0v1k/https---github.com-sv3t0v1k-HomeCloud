"""Узкий эксперимент zlib r1; gosu побайтово сохранён после отказа moby/user tests."""
import collections
from datetime import datetime, timezone
import hashlib
import base64
import io
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
OLD_MANIFEST = "sha256:fd2e86b5b1a2d9381d6e6018feacda382e6b669dda0a519dbc4744aa46980f95"
OLD_ARCHIVE = "2cffc90fb5c5f3309c3c1e2e708de8267dabab60dc49f164f418f3e1e0581961"
GOSU_SHA = "3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085"
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

    # moby/user v0.4.1 не прошёл upstream tests в run39015161422.
    # Не обходим отказ и не пересобираем gosu; оставляем exact binary D5.1.10.
    assert docker("run", "--rm", "--network=none", "--entrypoint", "sha256sum", OLD, "/usr/local/bin/gosu").split()[0] == GOSU_SHA
    builds = [GOSU_SHA]
    write("build.json", dict(binary_sha256=GOSU_SHA, binary_rebuilt=False,
          reused_from_run="38981422399", image_from_run="38981697774",
          moby_update="REJECTED: upstream tests fail in run39015161422; no bypass",
          reproducibility="historical D5.1.10 binary only; no new binary or OCI reproducibility claim"))

    context = ROOT / "context"
    context.mkdir()
    dockerfile = f"FROM {OLD}\nCOPY zlib.apk /tmp/d5111-zlib.apk\nRUN apk add --no-network /tmp/d5111-zlib.apk && rm /tmp/d5111-zlib.apk\n"
    (context / "Dockerfile").write_text(dockerfile)
    (E / "Dockerfile").write_text(dockerfile)
    resume = os.environ.get("D5111_CANDIDATE_RESUME")
    if resume:
        assert sha(resume) == "392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645"
        resumed = helper.identity(resume)
        assert resumed[0] == "sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8"
        assert resumed[1]["config"]["digest"] == "sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2"
        shutil.copy2(resume, ROOT / "candidate.oci.tar")
        run(["skopeo", "copy", "--preserve-digests", "oci-archive:" + str(ROOT / "candidate.oci.tar"), "docker-daemon:" + NEW])
        write("reused-image.json", dict(run_id="39015752148", build_head="d3770c4e49c9d45572f7c0dc70daf3021d8055bd",
              qualification_head=os.environ["GITHUB_SHA"], archive_sha256=sha(resume), rebuilt=False,
              reason="retain exact successful image build; correct scripts archive check and continue qualification"))
    else:
        apk = fetch("https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/zlib-1.3.2-r1.apk", "zlib.apk", APK_SHA)
        shutil.copy2(apk, context / "zlib.apk")
        docker("build", "--network=none", "--platform=linux/amd64", "-t", NEW, str(context))
    new = inspect(NEW)
    old = inspect(OLD)
    assert new["Config"] == old["Config"]
    assert new["RootFS"]["Layers"][:len(old["RootFS"]["Layers"])] == old["RootFS"]["Layers"]
    def installed(image):
        raw = docker("run", "--rm", "--network=none", "--entrypoint", "cat", image, "/lib/apk/db/installed")
        packages = {}
        for block in raw.split("\n\n"):
            fields = dict(line.split(":", 1) for line in block.splitlines() if ":" in line)
            if "P" in fields:
                assert fields["P"] not in packages
                packages[fields["P"]] = fields["V"]
        return packages
    before_packages, after_packages = installed(OLD), installed(NEW)
    assert before_packages["zlib"] == "1.3.2-r0" and after_packages["zlib"] == "1.3.2-r1"
    assert {k:v for k,v in before_packages.items() if k != "zlib"} == {k:v for k,v in after_packages.items() if k != "zlib"}
    write("package-inventory.json", dict(previous=before_packages, candidate=after_packages, changed_only=["zlib"]))
    assert docker("run", "--rm", "--network=none", "--entrypoint", "sha256sum", NEW, "/usr/local/bin/gosu").split()[0] == builds[0]
    new_archive = ROOT / "candidate.oci.tar"
    if not new_archive.exists():
        run(["skopeo", "copy", "--format=v2s2", "--preserve-digests", "docker-daemon:" + NEW, "oci-archive:" + str(new_archive)])
    identity = helper.identity(new_archive)
    assert identity[1]["config"]["digest"] == new["Id"]
    write("identity.json", dict(manifest=identity[0], config=new["Id"], archive_sha256=sha(new_archive),
          previous_manifest=OLD_MANIFEST, previous_archive_sha256=OLD_ARCHIVE, binary_sha256=builds[0], apk_sha256=APK_SHA))

    # Архив package scripts может перезаписываться apk, но ни один внутренний
    # member или его bytes/metadata не должен измениться при zlib-only upgrade.
    def scripts(image):
        raw = base64.b64decode(docker("run", "--rm", "--network=none", "--entrypoint", "base64", image, "/lib/apk/db/scripts.tar.gz"))
        entries = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as archive:
            for member in archive:
                assert member.name not in entries
                entries[member.name] = dict(type=member.type.decode(), linkname=member.linkname,
                    mode=member.mode, uid=member.uid, gid=member.gid,
                    sha256=hashlib.sha256(archive.extractfile(member).read()).hexdigest() if member.isfile() else None)
        return entries
    previous_scripts, candidate_scripts = scripts(OLD), scripts(NEW)
    write("apk-scripts-comparison.json", dict(previous=previous_scripts, candidate=candidate_scripts,
          identical=previous_scripts == candidate_scripts))
    assert previous_scripts == candidate_scripts

    # Все новые layers: только zlib и bookkeeping apk. Временный apk допустим
    # лишь в нижнем COPY-layer, затем whiteout; его bytes сохраняются в OCI.
    layer_members = []
    with tarfile.open(new_archive) as store:
        for layer in identity[1]["layers"][len(old_artifact[1]["layers"]):]:
            with tarfile.open(fileobj=store.extractfile("blobs/sha256/" + layer["digest"][7:]), mode="r|*") as stream:
                for member in stream:
                    name = member.name.removeprefix("./").rstrip("/")
                    if member.isdir():
                        continue
                    allowed = {"usr/lib/libz.so.1", "usr/lib/libz.so.1.3.2",
                               "etc/apk/world", "lib/apk/db/installed", "lib/apk/db/scripts.tar.gz",
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
    assert not any(v["cve"] == "CVE-2026-85091" or v["severity"] in ("CRITICAL", "HIGH") for v in findings["candidate"])

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
          checks=["named/numeric UID/GID/groups/HOME", "fresh init", "previous-to-new PGDATA", "PID1 UID/GID70",
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
