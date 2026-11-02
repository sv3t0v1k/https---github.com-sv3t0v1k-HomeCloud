"""Read-only TEST evidence binding. No networking or installation."""
import re

REPOSITORY = "sv3t0v1k/https---github.com-sv3t0v1k-homecloud"
HASH = re.compile(r"[a-f0-9]{64}")


class EvidenceError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise EvidenceError(reason)


def verify(request_hash, branch, run, artifact, manifest, shape):
    require(type(request_hash) is str and HASH.fullmatch(request_hash),
            "Invalid requested manifest identity")

    # Reuse the established TEST manifest contract.
    validated = shape(manifest)

    require(type(validated) is dict and
            validated.get("repository") == REPOSITORY and
            validated.get("manifest_sha256") == request_hash,
            "Manifest identity mismatch")

    require(type(branch) is dict and branch.get("protected") is True,
            "TEST branch is not protected")

    commit = branch.get("commit")
    require(type(commit) is dict and
            commit.get("sha") == validated["commit"],
            "TEST branch HEAD mismatch")

    require(type(run) is dict and
            type(run.get("id")) is int and run["id"] > 0 and
            type(run.get("run_attempt")) is int and
            run["run_attempt"] > 0 and
            run.get("event") == "push" and
            run.get("head_branch") == "test" and
            run.get("head_sha") == validated["commit"] and
            run.get("path") == ".github/workflows/ci-v2-fast.yml" and
            run.get("status") == "completed" and
            run.get("conclusion") == "success",
            "TEST CI run mismatch")

    ci = validated["ci"]
    require(ci["run_id"] == str(run["id"]) and
            ci["attempt"] == str(run["run_attempt"]) and
            ci["workflow"] == "ci-v2-fast.yml",
            "Manifest CI binding mismatch")

    require(type(artifact) is dict and
            type(artifact.get("id")) is int and artifact["id"] > 0 and
            artifact.get("expired") is False and
            artifact.get("name") ==
            f"test-channel-{run['run_attempt']}",
            "TEST artifact mismatch")

    origin = artifact.get("workflow_run")
    require(type(origin) is dict and
            origin.get("id") == run["id"] and
            origin.get("head_sha") == validated["commit"],
            "TEST artifact origin mismatch")

    return validated
