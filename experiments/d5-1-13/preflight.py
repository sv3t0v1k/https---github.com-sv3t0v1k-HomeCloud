#!/usr/bin/env python3
"""Read-only hosted preflight. No build/load/run, mount, SSH or publication path."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import urllib.request
import artifact as transport

REPO = "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud"
ARTIFACT = 12095095760
RUN = 39015752148
BUILD_SHA = "d3770c4e49c9d45572f7c0dc70daf3021d8055bd"
ZIP_SHA = "c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83"
ROOT = Path(__file__).resolve().parents[2]


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def run(argv, timeout=45):
    return subprocess.check_output(argv, text=True, timeout=timeout).strip()


def api(path):
    return json.loads(run(["gh", "api", f"repos/{REPO}/{path}".rstrip("/")]))


def write(root, name, value):
    (root / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def hosted(env, system, machine):
    require(env.get("GITHUB_ACTIONS") == "true" and
            env.get("RUNNER_ENVIRONMENT") == "github-hosted" and
            (system, machine) == ("Linux", "x86_64"), "hosted Linux/amd64 required")
    require(env.get("GITHUB_REPOSITORY") == REPO and
            env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "wrong repository/event")
    require(env.get("GITHUB_RUN_ATTEMPT") == "1", "reruns require a new reviewed dispatch")
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST", "SSH_AUTH_SOCK",
                "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET",
                "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG"):
        require(not env.get(key), "unexpected credential/remote runtime setting: " + key)
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("APPROVED_SHA", env["GITHUB_SHA"])),
            "full approved source SHA required")


def evidence_root():
    root = Path(os.environ["D513_EVIDENCE"])
    temp = Path(os.environ["RUNNER_TEMP"])
    expected = f'd513-evidence-{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}'
    require(temp.resolve() == temp and root == temp / expected and
            root.resolve() == root and root.is_dir(), "unexpected evidence path")
    return root


def context(out):
    hosted(os.environ, platform.system(), platform.machine())
    require(not Path("/.dockerenv").exists(), "job container forbidden")
    for key in ("RUNNER_TEMP", "GITHUB_WORKSPACE"):
        path = Path(os.environ[key])
        require(str(path).startswith("/home/runner/work/") and path.resolve() == path,
                "unexpected hosted path: " + key)
    source = run(["git", "rev-parse", "HEAD"])
    require(source == os.environ["APPROVED_SHA"], "checkout/source mismatch")
    jobs = api(f'actions/runs/{os.environ["GITHUB_RUN_ID"]}/jobs?per_page=100')["jobs"]
    selected = [job for job in jobs if job["name"] == "d513-preflight"]
    require(len(selected) == 1, "one current job required")
    job = selected[0]
    require(job.get("runner_group_name") == "GitHub Actions" and
            "ubuntu-24.04" in job["labels"] and job.get("runner_id"),
            "GitHub API hosted identity not confirmed")
    endpoint = json.loads(run(["docker", "context", "inspect"]))
    require(len(endpoint) == 1 and endpoint[0]["Endpoints"]["docker"]["Host"] ==
            "unix:///var/run/docker.sock", "only local disposable daemon allowed")
    info = json.loads(run(["docker", "info", "--format", "{{json .}}"]))
    require(info["OSType"] == "linux" and info["Architecture"] == "x86_64" and
            info["DockerRootDir"] == "/var/lib/docker", "unexpected daemon identity")
    require(not run(["docker", "ps", "-aq"]), "pre-existing containers")
    require(not run(["docker", "volume", "ls", "-q"]), "pre-existing volumes")
    networks = [json.loads(line) for line in
                run(["docker", "network", "ls", "--format", "json"]).splitlines()]
    require({row["Name"] for row in networks} == {"bridge", "host", "none"},
            "pre-existing custom networks")
    write(out, "context.json", dict(source=source, workflow_sha=os.environ["GITHUB_SHA"],
          run_id=os.environ["GITHUB_RUN_ID"], job=job, os=platform.platform(),
          docker_server_version=info["ServerVersion"], daemon_id=info["ID"],
          startup_gate_sha256=digest(ROOT / "deploy/linux/startup-gate.sh"),
          namespace=f'd513-{os.environ["GITHUB_RUN_ID"]}-1', containers=[], volumes=[],
          networks_created=[], runtime_started=False, isolation="HOSTED_PREFLIGHT_ONLY",
          credential_claim="No production secrets referenced; environment values not dumped",
          limitation="No runtime mounts/network created; full runtime isolation still NOT_PROVEN"))


def validate_origin(artifact, build, now):
    require(artifact["id"] == ARTIFACT and artifact["name"] == "d5111-experimental-image-1"
            and artifact["expired"] is False, "artifact missing/expired/wrong name")
    require(datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00")) > now,
            "artifact retention expired")
    require(artifact["workflow_run"]["id"] == build["id"] == RUN and
            artifact["workflow_run"]["head_sha"] == build["head_sha"] == BUILD_SHA and
            artifact["workflow_run"]["head_repository_id"] == 1361208027,
            "artifact/build origin mismatch")
    require(build["event"] == "push" and build["run_attempt"] == 1 and
            build["status"] == "completed" and
            build["path"] == ".github/workflows/pg-residual-experiment.yml", "build run mismatch")
    require(artifact["digest"] == "sha256:" + ZIP_SHA and
            0 < artifact["size_in_bytes"] <= 128 * 1024 * 1024, "ZIP digest/size mismatch")


def fetch_registry(path, token):
    request = urllib.request.Request("https://registry-1.docker.io/v2/library/postgres/" + path,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read(4 * 1024 * 1024 + 1)
    require(len(body) <= 4 * 1024 * 1024, "oversized registry metadata")
    expected = path.rsplit("/", 1)[-1]
    require("sha256:" + hashlib.sha256(body).hexdigest() == expected, "registry digest mismatch")
    return json.loads(body)


def official(lock):
    ref = lock["base"]
    pinned = ref.split("@", 1)[1]
    with urllib.request.urlopen("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull", timeout=45) as response:
        token = json.load(response)["token"]
    metadata = fetch_registry("manifests/" + pinned, token)
    if "manifests" in metadata:
        children = [d for d in metadata["manifests"] if
                    d.get("platform", {}).get("os") == "linux" and
                    d.get("platform", {}).get("architecture") == "amd64"]
        require(len(children) == 1, "one official amd64 child required")
        child = children[0]
        manifest = fetch_registry("manifests/" + child["digest"], token)
        kind = "multiarch-index"
    else:
        manifest = metadata
        child = dict(digest=pinned, platform=dict(os="linux", architecture="amd64"))
        kind = "platform-manifest"
    config = fetch_registry("blobs/" + manifest["config"]["digest"], token)
    require((config["os"], config["architecture"]) == ("linux", "amd64"), "official platform mismatch")
    require("PG_VERSION=" + lock["postgres_version"] in config["config"]["Env"], "official PG version mismatch")
    return dict(reference=ref, pinned_digest=pinned, reference_kind=kind, child=child,
                manifest=manifest, config=config, security_approved=False,
                layer_bytes_verified=False, runtime_started=False)


def images(out):
    lock = json.loads((ROOT / "ops/postgres/qualification.lock.json").read_text())
    artifact = api(f"actions/artifacts/{ARTIFACT}")
    build = api(f"actions/runs/{RUN}")
    write(out, "origin.json", dict(artifact=artifact, build=build))
    validate_origin(artifact, build, datetime.now(timezone.utc))
    download = Path(os.environ["D513_DOWNLOAD"])
    require(download == Path(os.environ["RUNNER_TEMP"]) /
            f'd513-download-{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}',
            "unexpected download path")
    download.mkdir(mode=0o700)
    spec = importlib.util.spec_from_file_location("prepare", ROOT / "ops/postgres/prepare.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(lock == module.load_lock(), "lock changed")
    try:
        result = transport.fetch_verified(download, artifact, lock, module.verify_archive)
    except transport.TransportError as error:
        write(out, 'artifact-transport.json', error.evidence)
        raise
    write(out, 'artifact-transport.json', result['transport'])
    write(out, "exact-identity.json", result['identity'])
    write(out, "official-metadata.json", official(lock))


def finish(out):
    status = dict(status="BLOCKED_BEFORE_RUNTIME", production="NO_GO",
          release="BLOCKED", complete=False, drill="NOT_RUN", rpo=None, rto=None,
          provenance="UNSIGNED", sbom="UNSIGNED", reproducibility="UNPROVEN",
          medium_unknown_accepted=False, runtime_integration_ready=False,
          blockers=["Official runtime not security-approved", "Actual runner/tools gate requires PASS",
                    "Runtime drill requires explicit input, qualified images and actual runner/tools"],
          retry_policy="At most two attempts for the same blocker; no automatic retry",
          evidence_upload="best effort: cancellation/runner loss may prevent always steps")
    if all(os.environ.get(k) for k in ('RUNNER_TEMP','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT')):
        ledger = Path(os.environ['RUNNER_TEMP']) / ('d513-runtime-'+os.environ['GITHUB_RUN_ID']+'-'+
            os.environ['GITHUB_RUN_ATTEMPT']) / 'ledger.json'
        if ledger.is_file() and not ledger.is_symlink() and ledger.resolve()==ledger:
            write(out,'resource-ledger.json',json.loads(ledger.read_text()))
            status.update(status='INTERRUPTED_RUNTIME',drill='PARTIAL',runtime_started=True)
    result = out/'harness-status.json'
    if result.exists():
        record = json.loads(result.read_text())
        require(record.get('production') == 'NO_GO' and record.get('complete') is False,
                'harness cannot promote production')
        status.update(record)
        if record.get('status') == 'SYNTHETIC_DRILL_PASSED':
            status['blockers'] = ['Production/release qualification and risk triage remain separate']
    write(out, 'status.json', status)
    paths = sorted(p for p in out.rglob("*") if p.is_file() and not p.is_symlink()
                   and "executed-tools" not in p.parts and p.name != "hashes.json")
    write(out, "hashes.json", {str(p.relative_to(out)): digest(p) for p in paths})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["context", "images", "finish"])
    args = parser.parse_args()
    out = evidence_root()
    if args.stage != "finish":
        hosted(os.environ, platform.system(), platform.machine())
    try:
        {"context": context, "images": images, "finish": finish}[args.stage](out)
    except Exception as error:
        write(out, args.stage + "-error.json", dict(status="BLOCKED", error=str(error)))
        raise


if __name__ == "__main__":
    main()
