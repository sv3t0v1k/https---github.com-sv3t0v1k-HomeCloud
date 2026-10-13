#!/usr/bin/env python3
"""
HomeCloud Restore Reconciliation — Phase 5.2

Reports DB ↔ storage consistency AFTER a restore.
Does NOT auto-heal; exits non-zero only if CRITICAL discrepancies are found.

Usage:
  python3 scripts/reconcile.py \
    --db-user homecloud \
    --db-name homecloud \
    --storage-volume homecloud_storage_data \
    --backend-image homecloud-backend

Environment:
  SKIP_RECONCILE=1  — skip reconciliation entirely (for testing)
"""

import argparse
import subprocess
import sys
import os
from recovery_config import load_config, compose_command, ConfigError
from recovery_storage import resolve_storage, checked_storage, storage_command, StorageError
import json

CRITICAL_ISSUES = "CRITICAL"
WARNING_ISSUES = "WARNING"
OK = "OK"


def validate_storage_path(rel_path):
    """Reject paths that can escape the storage root."""
    if not isinstance(rel_path, str) or not rel_path or rel_path in {".", "/storage"}:
        return False
    if rel_path.startswith("/") or "\\" in rel_path:
        return False
    parts = rel_path.split("/")
    if any(part in {"", ".", ".."} for part in parts) or parts[0] in {".tmp", ".homecloud-storage-identity"} or parts[0].startswith(".hc-probe-") or parts[0].startswith(".restore-") or "\x00" in rel_path:
        return False
    return True


def sanitize_storage_path(rel_path):
    """Validate and return storage path, or None if invalid."""
    if validate_storage_path(rel_path):
        return rel_path
    return None


def psql(query, db_user, db_name):
    """Run a SQL query against the DB container via docker compose."""
    cmd = [
        *compose_command(), "exec", "-T", "db", "psql",
        "-U", db_user, "-d", db_name, "-tA", "-c", query,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise StorageError("database reconciliation query failed")
    return r.stdout.strip()


def list_storage_files(snapshot, backend_image):
    """Read actual backend storage; inspection or archive errors fail closed."""
    target = snapshot['target']
    cmd = storage_command(snapshot, 'ro', backend_image, [
        'sh', '-c',
        'find "$1" -type f -not -path "*/.tmp/*" -not -path "*/.restore-*" '
        '-exec stat -c "%s %n" {} +', 'reconcile-storage', target,
    ])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise StorageError('storage reconciliation enumeration failed')
    files = {}
    for line in r.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[1].startswith(target + '/'):
            raise StorageError('invalid storage reconciliation enumeration')
        size_str, full_path = parts
        rel_path = full_path[len(target) + 1:]
        if not validate_storage_path(rel_path):
            continue
        try:
            size = int(size_str)
            if size < 0:
                raise ValueError()
            files[rel_path] = size
        except ValueError:
            raise StorageError('invalid storage reconciliation file size') from None
    return files


def get_file_size(snapshot, backend_image, rel_path):
    """Read one validated path without interpolating it into shell source."""
    if not validate_storage_path(rel_path):
        raise StorageError('invalid reconciliation object key')
    cmd = storage_command(snapshot, 'ro', backend_image, [
        'python3', '-c',
        'import os, sys; p = os.path.join(sys.argv[1], sys.argv[2]); '
        'print(os.path.getsize(p) if os.path.isfile(p) else 0)',
        snapshot['target'], rel_path,
    ])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode:
        raise StorageError('storage reconciliation stat failed')
    try:
        return int(r.stdout.strip())
    except (ValueError, TypeError):
        raise StorageError('invalid reconciliation stat result') from None


def file_records_query(snapshot):
    # The selected root is validated by recovery_storage, then SQL-quoted.
    # PostgreSQL concatenation checks the same root sealed by migration 515.
    root = snapshot['target'].replace("'", "''")
    return f"""
        SELECT CASE WHEN location."machineKey" = 'legacy-storage'
                         AND location."mountKey" = 'legacy-storage'
                         AND file."storagePath" = '{root}/' || file."relativeObjectKey"
                    THEN file."relativeObjectKey" ELSE '' END,
               file.size, file."userId"
        FROM files file
        LEFT JOIN storage_locations location ON location.id = file."storageLocationId"
        WHERE "isFolder" = false
          AND "isDeleted" = false
        """


def main():
    parser = argparse.ArgumentParser(description="HomeCloud restore reconciliation")
    parser.add_argument("--db-user", required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--storage-volume", help="optional assertion; must match the actual backend mount")
    parser.add_argument("--backend-image", required=True)
    args = parser.parse_args()

    try:
        os.environ.update(load_config())
        if args.db_user != os.environ["DB_USER"] or args.db_name != os.environ["DB_NAME"]:
            raise ConfigError("CLI DB identifiers must match recovery configuration")
    except ConfigError as exc:
        print("ERROR: recovery configuration: " + str(exc), file=sys.stderr)
        return 2

    if os.environ.get("SKIP_RECONCILE") == "1":
        print("RECONCILE: skipped (SKIP_RECONCILE=1)")
        sys.exit(0)

    try:
        if args.storage_volume:
            configured = os.environ.get('STORAGE_VOLUME', '')
            if configured and configured != args.storage_volume:
                raise StorageError('CLI volume assertion conflicts with recovery configuration')
            os.environ['STORAGE_VOLUME'] = args.storage_volume
        prior = os.environ.get('RECOVERY_STORAGE_SNAPSHOT')
        snapshot = checked_storage(json.loads(prior)) if prior else resolve_storage()
    except (StorageError, ValueError, KeyError):
        print('RECONCILE: storage identity validation failed', file=sys.stderr)
        return 1

    errors = []   # critical
    warnings = []  # non-critical

    # --- 1. Get DB file records ---
    db_rows = psql(file_records_query(snapshot), args.db_user, args.db_name)
    db_files = {}
    if db_rows:
        for line in db_rows.split("\n"):
            line = line.strip()
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 3:
                raw_path = parts[0]
                path = sanitize_storage_path(raw_path)
                if path is None:
                    errors.append("  INVALID_PLACEMENT: DB row has unsafe or inconsistent logical placement")
                    continue
                size_str = parts[1]
                uid_str = parts[2]
                try:
                    size = int(size_str) if size_str else 0
                except ValueError:
                    size = 0
                try:
                    uid = int(uid_str) if uid_str else 0
                except ValueError:
                    uid = 0
                db_files[path] = (size, uid)

    # --- 2. Get physical files with sizes ---
    try:
        phys_files = list_storage_files(snapshot, args.backend_image)
    except (StorageError, OSError, subprocess.TimeoutExpired):
        print('RECONCILE: storage enumeration failed', file=sys.stderr)
        return 1

    # --- 3. Build sets for comparison ---
    db_paths = set(db_files.keys())
    phys_paths = set(phys_files.keys())

    # --- 4. Dangling rows: DB records without physical file (CRITICAL) ---
    dangling = []
    for path in sorted(db_paths - phys_paths):
        size, uid = db_files[path]
        dangling.append("  DANGLING: DB row for '%s' (user %s, size %d) has no physical file" % (path, uid, size))
    if dangling:
        errors.extend(dangling[:10])

    # --- 5. Orphan files: physical files without DB row (WARNING) ---
    orphans = []
    for path in sorted(phys_paths - db_paths):
        orphans.append("  ORPHAN: physical file '%s' (size %d) has no DB record" % (path, phys_files[path]))
    if orphans:
        warnings.extend(orphans[:10])

    # --- 6. Size mismatch: DB size != actual file size (CRITICAL) ---
    size_mismatch = []
    for path in sorted(db_paths & phys_paths):
        db_size, _ = db_files[path]
        actual_size = phys_files.get(path, 0)
        if actual_size != db_size:
            size_mismatch.append(
                "  SIZE_MISMATCH: '%s' db_size=%d actual_size=%d" % (path, db_size, actual_size)
            )
    if size_mismatch:
        errors.extend(size_mismatch[:10])

    # --- 7. storageUsed drift per user (WARNING) ---
    usage_rows = psql(
        """
        SELECT u.id AS user_id,
               COALESCE(SUM(f.size), 0) AS actual_usage,
               u."storageUsed" AS reported_usage
        FROM users u
        LEFT JOIN files f ON f."userId" = u.id
            AND f."isFolder" = false
            AND f."isDeleted" = false
        GROUP BY u.id, u."storageUsed"
        """,
        args.db_user, args.db_name,
    )
    drift_count = 0
    if usage_rows:
        for line in usage_rows.split("\n"):
            line = line.strip()
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 3:
                try:
                    actual = int(parts[1]) if parts[1] else 0
                    reported = int(parts[2]) if parts[2] else 0
                except ValueError:
                    continue
                if actual != reported:
                    drift_count += 1
                    if drift_count <= 5:
                        warnings.append(
                            "  USAGE_DRIFT: user %s actual=%d reported=%d" % (parts[0], actual, reported)
                        )

    # --- 8. Broken share links (WARNING) ---
    broken_shares = psql(
        """
        SELECT count(*) FROM share_links s
        LEFT JOIN files f ON f.id = s."fileId"
        WHERE f.id IS NULL
        """,
        args.db_user, args.db_name,
    )
    broken_shares_count = 0
    if broken_shares and broken_shares.strip().isdigit():
        broken_shares_count = int(broken_shares.strip())
    if broken_shares_count > 0:
        warnings.append("  BROKEN_SHARE_LINKS: %d share links reference non-existent files" % broken_shares_count)

    # --- 9. Stale upload sessions (WARNING) ---
    stale_sessions = psql(
        """
        SELECT count(*) FROM upload_sessions
        WHERE status != 'completed'
        """,
        args.db_user, args.db_name,
    )
    stale_count = 0
    if stale_sessions and stale_sessions.strip().isdigit():
        stale_count = int(stale_sessions.strip())
    if stale_count > 0:
        warnings.append("  STALE_UPLOAD_SESSIONS: %d incomplete upload session(s) in DB" % stale_count)

    # --- 10. Summary statistics ---
    total_tables = psql(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
        args.db_user, args.db_name,
    )
    total_users = psql("SELECT count(*) FROM users", args.db_user, args.db_name)
    total_files_db = psql("SELECT count(*) FROM files WHERE \"isFolder\"=false AND \"isDeleted\"=false", args.db_user, args.db_name)

    # --- Output report ---
    print("Reconciliation Report")
    print("=" * 60)
    print("Database tables:    %s" % (total_tables or "N/A"))
    print("DB users:           %s" % (total_users or "N/A"))
    print("DB file records:    %s" % (total_files_db or "N/A"))
    print("Physical files:     %d" % len(phys_files))
    print()
    print("DB file paths with no physical file: %d  [CRITICAL]" % len(dangling))
    print("Physical files with no DB record:    %d  [WARNING]" % len(orphans))
    print("Size mismatches:                    %d  [CRITICAL]" % len(size_mismatch))
    print("Storage usage drift:                %d  [WARNING]" % drift_count)
    print("Broken share links:                 %d  [WARNING]" % broken_shares_count)
    print("Stale upload sessions:              %d  [WARNING]" % stale_count)
    print()
    if errors:
        print("Critical issues:")
        for e in errors:
            print(e)
    if warnings:
        print("Warnings:")
        for w in warnings:
            print(w)

    if errors:
        print()
        print("RECONCILE_STATUS: CRITICAL")
        sys.exit(1)
    else:
        print()
        print("RECONCILE_STATUS: OK")
        sys.exit(0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (StorageError, OSError, subprocess.TimeoutExpired):
        print('RECONCILE: required database/storage inspection failed', file=sys.stderr)
        sys.exit(1)
