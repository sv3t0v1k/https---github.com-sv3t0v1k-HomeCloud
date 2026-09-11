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

CRITICAL_ISSUES = "CRITICAL"
WARNING_ISSUES = "WARNING"
OK = "OK"


def psql(query, db_user, db_name):
    """Run a SQL query against the DB container via docker compose."""
    cmd = [
        "docker", "compose", "exec", "-T", "db", "psql",
        "-U", db_user, "-d", db_name, "-tA", "-c", query,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def list_storage_files(storage_vol, backend_image):
    """List all regular files in the storage volume (excluding .tmp, .restore-*).
    Returns a dict: {relative_path: size_in_bytes}.
    """
    cmd = [
        "docker", "run", "--rm", "-v", f"{storage_vol}:/storage",
        backend_image, "sh", "-c",
        'find /storage -type f -not -path "*/.tmp/*" -not -path "*/.restore-*" '
        '-exec stat -c "%s %n" {} + 2>/dev/null',
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    files = {}
    for line in r.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        size_str, full_path = parts
        rel_path = full_path
        if rel_path.startswith("/storage/"):
            rel_path = rel_path[len("/storage/"):]
        elif rel_path == "/storage":
            continue
        try:
            files[rel_path] = int(size_str)
        except ValueError:
            files[rel_path] = 0
    return files


def get_file_size(storage_vol, backend_image, rel_path):
    """Get the size of a single file in the storage volume."""
    cmd = [
        "docker", "run", "--rm", "-v", f"{storage_vol}:/storage",
        backend_image, "sh", "-c",
        f'stat -c%s "/storage/{rel_path}" 2>/dev/null || stat -f%z "/storage/{rel_path}" 2>/dev/null || echo 0',
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    try:
        return int(r.stdout.strip())
    except (ValueError, TypeError):
        return 0


def main():
    parser = argparse.ArgumentParser(description="HomeCloud restore reconciliation")
    parser.add_argument("--db-user", required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--storage-volume", required=True)
    parser.add_argument("--backend-image", required=True)
    args = parser.parse_args()

    if os.environ.get("SKIP_RECONCILE") == "1":
        print("RECONCILE: skipped (SKIP_RECONCILE=1)")
        sys.exit(0)

    errors = []   # critical
    warnings = []  # non-critical

    # --- 1. Get DB file records ---
    db_rows = psql(
        """
        SELECT "storagePath", size, "userId"
        FROM files
        WHERE "isFolder" = false
          AND "isDeleted" = false
          AND "storagePath" IS NOT NULL
        """,
        args.db_user, args.db_name,
    )
    db_files = {}
    if db_rows:
        for line in db_rows.split("\n"):
            line = line.strip()
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 3:
                path = parts[0]
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
    phys_files = list_storage_files(args.storage_volume, args.backend_image)

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
    main()
