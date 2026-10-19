"""Read-only GitHub origin checks and exact retained OCI download; hosted only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
repository = os.environ["GITHUB_REPOSITORY"]
assert repository == "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud"
root = Path(os.environ["RUNNER_TEMP"]) / "d5111-candidate"
root.mkdir(exist_ok=False)
def api(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{repository}/{path}"], text=True))

artifact = api("actions/artifacts/12095095760")
build = api("actions/runs/39015752148")
assert not artifact["expired"]
assert artifact["name"] == "d5111-experimental-image-1"
assert artifact["workflow_run"]["id"] == build["id"] == 39015752148
assert artifact["workflow_run"]["head_sha"] == build["head_sha"] == "d3770c4e49c9d45572f7c0dc70daf3021d8055bd"
assert build["event"] == "push" and build["run_attempt"] == 1
assert build["path"] == ".github/workflows/pg-residual-experiment.yml"
assert artifact["digest"] == "sha256:c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83"
archive = root / "artifact.zip"
with archive.open("xb") as target:
    subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/12095095760/zip"],
                   stdout=target, check=True, timeout=180)
assert archive.stat().st_size == artifact["size_in_bytes"]
with archive.open("rb") as stream:
    assert "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest() == artifact["digest"]
with zipfile.ZipFile(archive) as source:
    assert source.namelist() == ["candidate.oci.tar"]
    with source.open("candidate.oci.tar") as stream, (root / "candidate.oci.tar").open("xb") as target:
        import shutil
        shutil.copyfileobj(stream, target)
with (root / "candidate.oci.tar").open("rb") as stream:
    sha = hashlib.file_digest(stream, "sha256").hexdigest()
assert sha == "392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645"
evidence = dict(repository=repository, artifact=artifact, build_run=build, archive_sha256=sha,
                previous_build_run=38981697774, previous_archive_sha256="2cffc90fb5c5f3309c3c1e2e708de8267dabab60dc49f164f418f3e1e0581961",
                signature="UNSIGNED", production="NO_GO")
(root / "provenance.json").write_text(json.dumps(evidence, indent=2) + "\n")
print("PASS: retained artifact origin and archive bytes; no image build")
