"""Bounded GitHub TEST evidence retrieval. Never installs anything."""
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from update_evidence import verify, EvidenceError

REPO = "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud"
API = "https://api.github.com/repos/" + REPO
MAX_JSON = 1_000_000
MAX_ZIP = 2_000_000
SHA = re.compile(r"[a-f0-9]{40}\Z")
BLOB_HOST = re.compile(r"productionresultssa[0-9]+\.blob\.core\.windows\.net\Z")


class SourceError(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise SourceError(reason)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_blob_url(location):
    require(type(location) is str, "Missing artifact location")
    try:
        parsed = urllib.parse.urlsplit(location)
        valid = (parsed.scheme == "https"
                 and parsed.hostname is not None
                 and BLOB_HOST.fullmatch(parsed.hostname)
                 and parsed.port in (None, 443)
                 and parsed.username is None
                 and parsed.password is None
                 and not parsed.fragment)
    except ValueError:
        valid = False
    require(valid, "Untrusted artifact redirect")
    return location


class GitHubClient:
    def __init__(self, token):
        require(type(token) is str, "Invalid GitHub credential")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def read(self, url, limit, authenticated=False):
        headers = {"Accept": "application/vnd.github+json",
                   "User-Agent": "HomeCloud-Host-Evidence/1"}
        if authenticated and self.token:
            headers["Authorization"] = "Bearer " + self.token
        try:
            request = urllib.request.Request(url, headers=headers)
            with self.opener.open(request, timeout=10) as response:
                require(response.status == 200, "Unexpected HTTP response")
                length = response.headers.get("Content-Length")
                if length is not None:
                    require(length.isdecimal() and int(length) <= limit,
                            "Oversized HTTP response")
                data = response.read(limit + 1)
                require(len(data) <= limit, "Oversized HTTP body")
                return data
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise SourceError("Remote evidence unavailable") from error

    def api_json(self, path):
        require(type(path) is str and path.startswith("/")
                and ".." not in path and "//" not in path,
                "Invalid GitHub API path")
        data = self.read(API + path, MAX_JSON, authenticated=True)
        try:
            return json.loads(data)
        except (ValueError, UnicodeDecodeError) as error:
            raise SourceError("Invalid GitHub JSON") from error

    def artifact_json(self, artifact_id):
        require(type(artifact_id) is int and artifact_id > 0,
                "Invalid artifact ID")
        url = API + f"/actions/artifacts/{artifact_id}/zip"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "HomeCloud-Host-Evidence/1",
        }
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        try:
            self.opener.open(
                urllib.request.Request(url, headers=headers),
                timeout=10,
            )
        except urllib.error.HTTPError as error:
            require(error.code == 302, "Unexpected artifact response")
            location = verify_blob_url(error.headers.get("Location"))
            error.close()
        else:
            raise SourceError("Missing artifact redirect")

        # A completely new request: never forward GitHub Authorization.
        archive = self.read(location, MAX_ZIP, authenticated=False)
        try:
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                entries = bundle.infolist()
                require(len(entries) == 1, "Unexpected ZIP entries")
                member = entries[0]
                require(member.filename == "test-channel.json"
                        and not member.is_dir()
                        and not (member.flag_bits & 1)
                        and member.compress_type in
                        (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        and member.file_size <= MAX_JSON
                        and member.compress_size <= MAX_ZIP,
                        "Invalid TEST ZIP entry")
                with bundle.open(member) as stream:
                    data = stream.read(MAX_JSON + 1)
                require(len(data) <= MAX_JSON, "Oversized TEST manifest")
                return json.loads(data)
        except (zipfile.BadZipFile, RuntimeError, ValueError,
                UnicodeDecodeError, OSError) as error:
            raise SourceError("Invalid TEST artifact") from error


def fetch_test_evidence(request_hash, shape, client):
    require(type(request_hash) is str
            and re.fullmatch(r"[a-f0-9]{64}", request_hash),
            "Invalid request hash")

    branch = client.api_json("/branches/test")
    require(type(branch) is dict
            and branch.get("protected") is True
            and type(branch.get("commit")) is dict,
            "Invalid protected TEST branch")
    head = branch["commit"].get("sha")
    require(type(head) is str and SHA.fullmatch(head),
            "Invalid TEST HEAD")

    runs = client.api_json(
        f"/actions/runs?branch=test&event=push&head_sha={head}&per_page=10"
    )
    require(type(runs) is dict
            and type(runs.get("workflow_runs")) is list,
            "Invalid TEST run inventory")

    selected = [
        item for item in runs["workflow_runs"]
        if type(item) is dict
        and item.get("head_sha") == head
        and item.get("head_branch") == "test"
        and item.get("event") == "push"
        and item.get("path") == ".github/workflows/ci-v2-fast.yml"
        and item.get("status") == "completed"
        and item.get("conclusion") == "success"
        and type(item.get("id")) is int and item["id"] > 0
        and type(item.get("run_attempt")) is int
        and item["run_attempt"] > 0
    ]
    require(len(selected) == 1, "Ambiguous or missing successful TEST run")
    run = selected[0]

    inventory = client.api_json(
        f"/actions/runs/{run['id']}/artifacts?per_page=100"
    )
    require(type(inventory) is dict
            and type(inventory.get("artifacts")) is list,
            "Invalid TEST artifact inventory")
    artifacts = [
        item for item in inventory["artifacts"]
        if type(item) is dict
        and item.get("name") == f"test-channel-{run['run_attempt']}"
        and item.get("expired") is False
        and type(item.get("workflow_run")) is dict
        and item["workflow_run"].get("id") == run["id"]
        and item["workflow_run"].get("head_sha") == head
        and type(item.get("id")) is int and item["id"] > 0
    ]
    require(len(artifacts) == 1, "Ambiguous or missing TEST artifact")
    artifact = artifacts[0]
    manifest = client.artifact_json(artifact["id"])

    validated = verify(
        request_hash, branch, run, artifact, manifest, shape
    )

    # Close the window where TEST branch HEAD changed during retrieval.
    current = client.api_json("/branches/test")
    require(type(current) is dict
            and current.get("protected") is True
            and type(current.get("commit")) is dict
            and current["commit"].get("sha") == head,
            "TEST branch moved during verification")

    return validated
