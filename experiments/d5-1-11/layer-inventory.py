"""Inventory exact layer entries without extracting or executing image content."""
import hashlib
import tarfile

def inventory(archive, layers):
    entries = []
    with tarfile.open(archive) as store:
        for layer in layers:
            seen = set()
            with tarfile.open(fileobj=store.extractfile("blobs/sha256/" + layer["digest"][7:]), mode="r|*") as stream:
                for member in stream:
                    name = member.name.removeprefix("./").rstrip("/")
                    assert name and not name.startswith("/") and ".." not in name.split("/")
                    assert name not in seen, "duplicate layer member"
                    seen.add(name)
                    assert member.isfile() or member.isdir() or member.issym(), "unexpected member type"
                    data = stream.extractfile(member).read() if member.isfile() else None
                    entry = dict(layer=layer["digest"], path=name, type=member.type.decode(),
                                 mode=member.mode, uid=member.uid, gid=member.gid,
                                 uname=member.uname, gname=member.gname, size=member.size,
                                 linkname=member.linkname, mtime=member.mtime, pax=member.pax_headers,
                                 sha256=hashlib.sha256(data).hexdigest() if data is not None else None)
                    if name == "var/log/apk.log":
                        assert member.isfile() and not member.linkname
                        entry["text"] = data.decode("utf-8")
                    entries.append(entry)
    return entries


def verify(archive, layers, lock, previous_log):
    entries = inventory(archive, layers)
    logs = [e for e in entries if e["path"] == "var/log/apk.log"]
    assert len(logs) == 1
    assert hashlib.sha256(previous_log).hexdigest() == lock["apk_log_previous_sha256"]
    assert logs[0].pop("text").encode() == previous_log + lock["apk_log_append"].encode()
    assert entries == lock["entries"], "exact layer paths/content/metadata mismatch"
    for entry in entries:
        if entry["type"] == "5":
            assert {k:entry[k] for k in ("mode", "uid", "gid", "type", "linkname")} == lock["previous_metadata"][entry["path"]]
    return entries
