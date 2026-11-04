#!/usr/bin/env python3
"""VM 120 only: create and verify disposable HomeCloud API data.

Usage: register, then grant this exact synthetic user quota through a separately
reviewed SQL operation, then seed, then verify after every installer transition.
The state file contains identifiers and hashes, never credentials or tokens.
"""

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import stat
import sys
from urllib.parse import urlsplit


VM_IP = "192.168.3.117"
VM_PORT = 18443
PASSWORD_ENV = "HC_VM120_E2E_PASSWORD"
FORMAT = "homecloud-vm120-synthetic-v1"


class Refused(Exception):
    pass


class VmConnection(http.client.HTTPSConnection):
    """Pin the TCP peer to VM 120 while retaining TLS hostname validation."""

    def connect(self):
        sock = socket.create_connection((VM_IP, VM_PORT), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def origin_parts(raw):
    parsed = urlsplit(raw)
    require(parsed.scheme == "https" and parsed.hostname == VM_IP and
            parsed.port == VM_PORT and not parsed.username and
            not parsed.password and not parsed.path and not parsed.query and
            not parsed.fragment, "origin must be https://192.168.3.117:18443 with IP SAN")
    return VM_IP


def state_path(raw):
    path = Path(raw).expanduser().absolute()
    require(".." not in path.parts, "state path must be canonical")
    require(not path.is_symlink() and path.parent.is_dir(), "unsafe state path")
    canonical_parent = path.parent.resolve(strict=True)
    canonical_path = canonical_parent / path.name
    parent = canonical_parent.stat()
    require(parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700,
            "state parent must be owned by caller and mode 0700")
    require(not canonical_path.is_relative_to(Path(__file__).resolve().parents[1]) and
            not canonical_path.is_relative_to(Path("/home/hs/homecloud-test").resolve()),
            "state must be outside both project checkouts")
    return canonical_path


def save(path, state, create=False):
    encoded = (json.dumps(state, sort_keys=True, indent=2) + "\n").encode()
    if create:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, encoded)
            os.fsync(fd)
        finally:
            os.close(fd)
        return
    old = path.stat()
    require(old.st_uid == os.getuid() and stat.S_IMODE(old.st_mode) == 0o600 and
            old.st_nlink == 1 and path.is_file(), "unsafe existing state file")
    pending = path.with_name(path.name + ".pending")
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(pending, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def load(path):
    require(path.is_file() and not path.is_symlink(), "missing state file")
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and
            info.st_nlink == 1, "unsafe state file")
    value = json.loads(path.read_text())
    require(value.get("format") == FORMAT and value.get("vm_ip") == VM_IP,
            "state belongs to a different qualification")
    require(value.get("origin") == f"https://{VM_IP}:{VM_PORT}",
            "state origin differs from VM 120")
    nonce = value.get("nonce")
    require(isinstance(nonce, str) and re.fullmatch(r"[a-f0-9]{20}", nonce) and
            value.get("email") == f"vm120-{nonce}@example.test",
            "state account is not the exact synthetic fixture")
    user_id = value.get("user_id")
    require(type(user_id) is int and user_id > 0, "invalid synthetic user ID")
    stage = value.get("stage")
    require(stage in ("registered", "seeding", "seeded"), "invalid state stage")
    if stage == "seeded":
        folders = value.get("folders")
        require(isinstance(folders, list) and len(folders) == 2 and
                all(type(item) is int and item > 0 for item in folders) and
                folders[0] != folders[1], "invalid synthetic folder IDs")
        files = value.get("files")
        require(isinstance(files, list) and len(files) == 2,
                "invalid synthetic file inventory")
        ids = []
        for index, item in enumerate(files, 1):
            require(isinstance(item, dict) and
                    item.get("fixture_index") == index and
                    item.get("name") == f"vm120-{nonce}-{index}.bin" and
                    item.get("folder_id") == folders[1] and
                    type(item.get("id")) is int and item["id"] > 0 and
                    isinstance(item.get("upload_id"), str) and
                    bool(re.fullmatch(r"[a-f0-9-]{36}", item["upload_id"])) and
                    item.get("size") == len(fixture_bytes(nonce, index)) and
                    item.get("sha256") == hashlib.sha256(fixture_bytes(nonce, index)).hexdigest() and
                    isinstance(item.get("relative_object_key"), str) and
                    bool(item["relative_object_key"]) and
                    not item["relative_object_key"].startswith("/") and
                    ".." not in item["relative_object_key"].split("/"),
                    "invalid synthetic file checkpoint")
            ids.append(item["id"])
        require(ids[0] != ids[1], "duplicate synthetic file ID")
    return value


def request(host, context, method, route, body=None, token=None, content_type=None):
    require(route.startswith("/api/v1/") and ".." not in route, "unsafe API route")
    headers = {"Host": f"{VM_IP}:{VM_PORT}", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if content_type:
        headers["Content-Type"] = content_type
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    connection = VmConnection(host, VM_PORT, timeout=20, context=context)
    try:
        connection.request(method, route, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read(2 * 1024 * 1024 + 1)
        require(len(payload) <= 2 * 1024 * 1024, "response too large")
        require(response.status < 300, f"{method} {route} returned HTTP {response.status}")
        if route.endswith("/download"):
            return payload
        value = json.loads(payload)
        require(value.get("success") is True and "data" in value,
                "invalid API response")
        return value["data"]
    finally:
        connection.close()


def password():
    value = os.environ.get(PASSWORD_ENV, "")
    require(len(value) >= 20 and len(value) <= 128, "provide a unique secret through " + PASSWORD_ENV)
    return value


def login(host, context, state):
    auth = request(host, context, "POST", "/api/v1/auth/login",
                   {"email": state["email"], "password": password()})
    token = auth.get("accessToken")
    require(isinstance(token, str) and token, "login returned no access token")
    me = request(host, context, "GET", "/api/v1/users/me", token=token)
    require(me.get("email") == state["email"] and me.get("id") == state["user_id"],
            "synthetic account identity mismatch")
    return token, me


def upload(host, context, token, name, content, folder_id):
    digest = hashlib.sha256(content).hexdigest()
    session = request(host, context, "POST", "/api/v1/uploads/session",
                      {"filename": name, "totalSize": len(content),
                       "chunkSize": len(content), "parentId": folder_id,
                       "expectedSha256": digest}, token)
    upload_id = session.get("uploadId")
    require(isinstance(upload_id, str) and upload_id, "missing upload ID")
    boundary = "hcvm120" + secrets.token_hex(12)
    multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"chunkIndex\"\r\n\r\n0\r\n"
                 f"--{boundary}\r\nContent-Disposition: form-data; name=\"chunk\"; filename=\"fixture.bin\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    request(host, context, "POST", f"/api/v1/uploads/session/{upload_id}/chunk",
            multipart, token, f"multipart/form-data; boundary={boundary}")
    file = request(host, context, "POST", f"/api/v1/uploads/session/{upload_id}/complete",
                   {}, token)
    require(isinstance(file.get("id"), int) and file["id"] > 0,
            "upload did not create a file row")
    key = file.get("relativeObjectKey")
    require(isinstance(key, str) and key and not key.startswith("/") and
            ".." not in key.split("/"), "upload returned unsafe logical placement")
    return {"id": file["id"], "upload_id": upload_id, "name": name,
            "folder_id": folder_id, "size": len(content), "sha256": digest,
            "relative_object_key": key}


def fixture_bytes(nonce, index):
    return (f"VM 120 synthetic qualification {nonce} file {index}\n".encode() +
            bytes(range(1, 32)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("register", "seed", "verify"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--ca-cert", required=True)
    parser.add_argument("--state", required=True)
    args = parser.parse_args()
    host = origin_parts(args.origin)
    path = state_path(args.state)
    require(Path(args.ca_cert).is_file(), "missing test TLS CA")
    context = ssl.create_default_context(cafile=args.ca_cert)
    if args.action == "register":
        password()
        nonce = secrets.token_hex(10)
        state = {"format": FORMAT, "vm_ip": VM_IP, "origin": args.origin,
                 "stage": "prepared", "nonce": nonce,
                 "email": f"vm120-{nonce}@example.test"}
        save(path, state, create=True)
        try:
            request(host, context, "POST", "/api/v1/auth/register",
                    {"email": state["email"], "password": password(),
                     "name": "VM 120 synthetic E2E"})
        except Refused:
            # A lost HTTP acknowledgement can mean the account exists. Keep the
            # prepared state and require explicit reconciliation by login.
            raise
        auth = request(host, context, "POST", "/api/v1/auth/login",
                       {"email": state["email"], "password": password()})
        me = request(host, context, "GET", "/api/v1/users/me",
                     token=auth["accessToken"])
        require(me.get("email") == state["email"] and isinstance(me.get("id"), int),
                "registered account identity mismatch")
        state.update(stage="registered", user_id=me["id"])
        save(path, state)
        print(json.dumps({"stage": "registered", "user_id": me["id"],
                          "email": state["email"], "next": "grant exact synthetic account 1 MiB quota"}))
        return
    state = load(path)
    require(state.get("origin") == args.origin, "origin differs from saved state")
    if args.action == "seed":
        require(state.get("stage") == "registered", "seed requires registered state")
    else:
        require(state.get("stage") == "seeded", "verify requires seeded state")
    token, me = login(host, context, state)
    if args.action == "seed":
        require(int(me.get("storageQuota", 0)) >= 1048576,
                "synthetic quota is not provisioned")
        state["stage"] = "seeding"
        save(path, state)
        root = request(host, context, "POST", "/api/v1/files/folders",
                       {"name": "vm120-" + state["nonce"]}, token)
        root_id = root.get("folderId")
        require(isinstance(root_id, int), "missing root folder ID")
        child = request(host, context, "POST", "/api/v1/files/folders",
                        {"name": "nested-" + state["nonce"], "parentId": root_id}, token)
        child_id = child.get("folderId")
        require(isinstance(child_id, int), "missing nested folder ID")
        files = []
        for index in (1, 2):
            item = upload(host, context, token, f"vm120-{state['nonce']}-{index}.bin",
                          fixture_bytes(state["nonce"], index), child_id)
            item["fixture_index"] = index
            files.append(item)
        state.update(stage="seeded", folders=[root_id, child_id], files=files)
        save(path, state)
        print(json.dumps({"stage": "seeded", "user_id": state["user_id"],
                          "folders": state["folders"], "files": files}, sort_keys=True))
        return
    root_id, child_id = state["folders"]
    for folder_id, parent_id in ((root_id, None), (child_id, root_id)):
        folder = request(host, context, "GET", f"/api/v1/files/folders/{folder_id}", token=token)
        require(folder.get("id") == folder_id and folder.get("parentId") == parent_id,
                "folder tree differs from checkpoint")
    for item in state["files"]:
        metadata = request(host, context, "GET", f"/api/v1/files/{item['id']}", token=token)
        actual = request(host, context, "GET", f"/api/v1/files/{item['id']}/download", token=token)
        require(metadata.get("id") == item["id"] and
                metadata.get("parentId") == item["folder_id"] and
                metadata.get("name") == item["name"] and
                metadata.get("relativeObjectKey") == item["relative_object_key"] and
                len(actual) == item["size"] and
                hashlib.sha256(actual).hexdigest() == item["sha256"] and
                actual == fixture_bytes(state["nonce"], item["fixture_index"]),
                "file metadata or exact downloaded bytes differ from checkpoint")
    print(json.dumps({"stage": "verified", "user_id": state["user_id"],
                      "folders": state["folders"],
                      "file_sha256": {str(f["id"]): f["sha256"] for f in state["files"]}},
                     sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, TypeError, ssl.SSLError) as error:
        sys.exit(f"BLOCKER: {error}")
