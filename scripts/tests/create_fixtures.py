#!/usr/bin/env python3
"""
Test fixture generator for HomeCloud Phase 5.2 restore tests.

Creates backup sets with various properties in a target directory:
  -- valid              — valid backup (copy of real backup)
  -- malformed-meta     — .meta JSON is malformed
  -- missing-checksum   — .meta lacks checksum fields
  -- invalid-checksum   — .meta has wrong SHA256
  -- unsupported-version— .meta has format_version "2"
  -- corrupted-archive  — tar.gz is truncated/corrupted
  -- corrupted-dump     — sql.gz is truncated/corrupted
  -- malicious-archive  — tar.gz with path traversal + device files
  -- empty-storage      — valid tar.gz with 0 files
  -- file-count-mismatch— .meta says 5 files but archive has 2
  -- partial-dump       — sql.gz with SQL errors mid-stream

Usage: python3 scripts/tests/create_fixtures.py <output_dir>
"""

import gzip
import hashlib
import json
import os
import shutil
import sys
import tarfile
import io


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def create_meta_sidecar(meta_path):
    """Create a .meta.sha256 sidecar with the exact-byte SHA256 of the .meta file."""
    sha256 = sha256_file(meta_path)
    sidecar_path = meta_path + ".sha256"
    with open(sidecar_path, "w") as f:
        f.write(f"{sha256}  {os.path.basename(meta_path)}\n")


def file_size(path):
    return os.path.getsize(path)


def create_meta(out_path, db_dump_name, storage_archive_name,
                db_dump_sha256, storage_archive_sha256,
                db_dump_size, storage_archive_size,
                storage_file_count, format_version="1"):
    """Write a valid .meta JSON file."""
    with open(out_path, "w") as f:
        json.dump({
            "format_version": format_version,
            "timestamp": "20260101_000000",
            "created_at": "2026-01-01T00:00:00Z",
            "db_dump": db_dump_name,
            "storage_archive": storage_archive_name,
            "db_name": "homecloud",
            "storage_path": "/storage",
            "db_dump_size": db_dump_size,
            "storage_archive_size": storage_archive_size,
            "db_dump_sha256": db_dump_sha256,
            "storage_archive_sha256": storage_archive_sha256,
            "storage_file_count": storage_file_count,
            "retention_days": 7,
        }, f, indent=2)


def create_valid_tar(path, files):
    """Create a valid tar.gz archive with the given files dict {arcname: content}."""
    with tarfile.open(path, "w:gz") as tf:
        for arcname, content in files.items():
            info = tarfile.TarInfo(name=arcname)
            info.size = len(content)
            info.mode = 0o644
            import io
            tf.addfile(info, io.BytesIO(content))


def create_malicious_tar(path):
    """Create a tar.gz with path traversal and device file entries."""
    with tarfile.open(path, "w:gz") as tf:
        # Path traversal entry
        content = b"evil"
        info = tarfile.TarInfo(name="../etc/evil")
        info.size = len(content)
        info.mode = 0o644
        tf.addfile(info, io.BytesIO(content))
        # Absolute path entry
        content = b"bad"
        info = tarfile.TarInfo(name="/etc/malicious")
        info.size = len(content)
        info.mode = 0o644
        tf.addfile(info, io.BytesIO(content))
        # Symlink pointing to absolute path
        info = tarfile.TarInfo(name="evil_link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        tf.addfile(info)


def create_safe_dump():
    """Create a minimal valid SQL dump with CREATE TABLE."""
    return (
        b"--\n"
        b"-- PostgreSQL database dump\n"
        b"--\n\n"
        b"SET statement_timeout = 0;\n"
        b"SET client_encoding = 'UTF8';\n\n"
        b"CREATE TABLE public.users (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b"  email VARCHAR(255) UNIQUE NOT NULL\n"
        b");\n\n"
        b"CREATE TABLE public.files (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b"  name VARCHAR(255) NOT NULL,\n"
        b'  "storagePath" VARCHAR(500)\n'
        b");\n\n"
        b"CREATE TABLE public.folders (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b"  name VARCHAR(255) NOT NULL\n"
        b");\n\n"
        b"CREATE TABLE public.share_links (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b"  token VARCHAR(255) NOT NULL\n"
        b");\n\n"
        b"CREATE TABLE public.upload_sessions (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b"  filename VARCHAR(255) NOT NULL\n"
        b");\n\n"
        b"CREATE TABLE public.refresh_tokens (\n"
        b"  id SERIAL PRIMARY KEY,\n"
        b'  "token_hash" VARCHAR(255) NOT NULL\n'
        b");\n\n"
        b"CREATE TABLE public.migrations (\n"
        b'  "id" SERIAL PRIMARY KEY,\n'
        b'  "timestamp" BIGINT NOT NULL,\n'
        b'  "name" VARCHAR NOT NULL\n'
        b");\n\n"
        b"--\n"
        b"-- PostgreSQL database dump complete\n"
        b"--\n"
    )


def create_bad_dump():
    """Create a SQL dump with an intentional error."""
    return (
        b"--\n"
        b"-- PostgreSQL database dump (CORRUPTED)\n"
        b"--\n\n"
        b"CREATE TABLE public.users (\n"
        b"  id SERIAL PRIMARY KEY\n"
        b");\n\n"
        b"THIS IS NOT VALID SQL AND WILL CAUSE AN ERROR\n\n"
        b"CREATE TABLE public.files (\n"
        b"  id SERIAL PRIMARY KEY\n"
        b");\n"
    )


def make_fixture(base_dir, name, db_dump_content=None, storage_files=None,
                 meta_override=None, format_version="1",
                 corrupted_archive=False, corrupted_dump=False,
                 malformed_meta=False, missing_checksum=False,
                 invalid_checksum=False, empty_storage=False,
                 file_count_mismatch=False, malicious=False,
                 partial_dump=False):
    """Create a backup fixture directory with .meta, .sql.gz, and .tar.gz."""
    ts = "20260101_000000"
    db_name = f"homecloud_db_{ts}.sql.gz"
    stor_name = f"homecloud_storage_{ts}.tar.gz"
    meta_name = f"homecloud_{ts}.meta"

    # DB dump
    if corrupted_dump:
        with open(f"{base_dir}/{db_name}", "wb") as f:
            f.write(b"\x1f\x8b\x08\x00corrupted data not a real gzip stream")
    elif partial_dump:
        dump = create_bad_dump()
        with gzip.open(f"{base_dir}/{db_name}", "wb") as f:
            f.write(dump)
    else:
        dump = db_dump_content or create_safe_dump()
        with gzip.open(f"{base_dir}/{db_name}", "wb") as f:
            f.write(dump)

    # Storage archive
    if corrupted_archive:
        with open(f"{base_dir}/{stor_name}", "wb") as f:
            f.write(b"\x1f\x8b\x08\x00corrupted tar.gz data")
    elif malicious:
        create_malicious_tar(f"{base_dir}/{stor_name}")
    elif empty_storage:
        create_valid_tar(f"{base_dir}/{stor_name}", {})
    else:
        files = storage_files or {
            "backup-test/test.txt": b"test content",
            "backup-test/random.bin": b"\x00" * 1024,
        }
        create_valid_tar(f"{base_dir}/{stor_name}", files)

    db_path = f"{base_dir}/{db_name}"
    stor_path = f"{base_dir}/{stor_name}"

    db_sha = sha256_file(db_path)
    stor_sha = sha256_file(stor_path)
    db_sz = file_size(db_path)
    stor_sz = file_size(stor_path)

    # Compute actual file count in archive (always try, even for malicious)
    if not corrupted_archive:
        try:
            with tarfile.open(stor_path, "r:gz") as tf:
                fc = sum(1 for m in tf.getmembers() if m.isfile())
        except Exception:
            fc = 0
    else:
        fc = 0

    if file_count_mismatch:
        meta_fc = 5
    else:
        meta_fc = fc

    if malformed_meta:
        with open(f"{base_dir}/{meta_name}", "w") as f:
            f.write('{"format_version": "1", "timestamp": "broken"\n')
            f.write('  this is not valid json\n')
            f.write('  "db_dump": "%s",' % db_name)
            f.write('  "storage_file_count": 0\n0,')  # BSD wc -l corruption
        create_meta_sidecar(f"{base_dir}/{meta_name}")
    elif missing_checksum:
        with open(f"{base_dir}/{meta_name}", "w") as f:
            json.dump({
                "format_version": format_version,
                "timestamp": ts,
                "db_dump": db_name,
                "storage_archive": stor_name,
                "db_name": "homecloud",
                "storage_path": "/storage",
                "db_dump_sha256": "",
                "storage_archive_sha256": "",
                "db_dump_size": db_sz,
                "storage_archive_size": stor_sz,
                "storage_file_count": meta_fc,
                "retention_days": 7,
            }, f, indent=2)
        create_meta_sidecar(f"{base_dir}/{meta_name}")
    elif invalid_checksum:
        with open(f"{base_dir}/{meta_name}", "w") as f:
            json.dump({
                "format_version": format_version,
                "timestamp": ts,
                "db_dump": db_name,
                "storage_archive": stor_name,
                "db_name": "homecloud",
                "storage_path": "/storage",
                "db_dump_size": db_sz,
                "storage_archive_size": stor_sz,
                "db_dump_sha256": "0" * 64,
                "storage_archive_sha256": "0" * 64,
                "storage_file_count": meta_fc,
                "retention_days": 7,
            }, f, indent=2)
        create_meta_sidecar(f"{base_dir}/{meta_name}")
    else:
        create_meta(
            f"{base_dir}/{meta_name}",
            db_name, stor_name,
            db_sha if not meta_override or "db_sha" not in meta_override else meta_override["db_sha"],
            stor_sha if not meta_override or "stor_sha" not in meta_override else meta_override["stor_sha"],
            db_sz, stor_sz,
            meta_fc,
            format_version=format_version,
        )
        create_meta_sidecar(f"{base_dir}/{meta_name}")

    return base_dir


def create_all_fixtures(output_dir):
    """Create all test fixture directories."""
    fixtures = {}

    # 1. Valid backup
    d = f"{output_dir}/valid"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "valid")
    fixtures["valid"] = d

    # 2. Malformed .meta
    d = f"{output_dir}/malformed-meta"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "malformed-meta", malformed_meta=True)
    fixtures["malformed-meta"] = d

    # 3. Missing checksum
    d = f"{output_dir}/missing-checksum"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "missing-checksum", missing_checksum=True)
    fixtures["missing-checksum"] = d

    # 4. Invalid checksum
    d = f"{output_dir}/invalid-checksum"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "invalid-checksum", invalid_checksum=True)
    fixtures["invalid-checksum"] = d

    # 5. Unsupported format version
    d = f"{output_dir}/unsupported-version"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "unsupported-version", format_version="2")
    fixtures["unsupported-version"] = d

    # 6. Corrupted archive
    d = f"{output_dir}/corrupted-archive"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "corrupted-archive", corrupted_archive=True)
    fixtures["corrupted-archive"] = d

    # 7. Corrupted dump
    d = f"{output_dir}/corrupted-dump"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "corrupted-dump", corrupted_dump=True)
    fixtures["corrupted-dump"] = d

    # 8. Malicious archive
    d = f"{output_dir}/malicious-archive"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "malicious-archive", malicious=True)
    fixtures["malicious-archive"] = d

    # 9. Empty storage (0 files)
    d = f"{output_dir}/empty-storage"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "empty-storage", empty_storage=True)
    fixtures["empty-storage"] = d

    # 10. File count mismatch
    d = f"{output_dir}/file-count-mismatch"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "file-count-mismatch", file_count_mismatch=True)
    fixtures["file-count-mismatch"] = d

    # 11. Partial dump (SQL error)
    d = f"{output_dir}/partial-dump"
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    make_fixture(d, "partial-dump", partial_dump=True)
    fixtures["partial-dump"] = d

    return fixtures


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 create_fixtures.py <output_dir>")
        sys.exit(1)
    output_dir = sys.argv[1]
    os.makedirs(output_dir, exist_ok=True)
    fixtures = create_all_fixtures(output_dir)
    print(f"Created {len(fixtures)} test fixture directories in {output_dir}:")
    for name, path in sorted(fixtures.items()):
        print(f"  {name:25s} -> {path}")
