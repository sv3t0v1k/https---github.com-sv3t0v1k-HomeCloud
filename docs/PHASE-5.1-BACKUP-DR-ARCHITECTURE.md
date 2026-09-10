Phase 5.1 — Backup & Disaster Recovery Architecture

Status: ARCHITECTURE PLAN (no code implemented in this session)
Baseline: phase-1-4-baseline
Analysis commits reviewed: 8ea84d2, 3038b95, 5642569, 67d39ec

This document is the output of architectural analysis only. No code was written or
modified in this session. It defines the target state for HomeCloud backup and
disaster recovery and the boundaries for Phase 5.2+.
---

## 1. Current State

### Repository state
- Branch: `main`, 12 commits ahead of origin
- Working tree: clean before this document was created (this document is the only untracked file)
- Baseline tag: `phase-1-4-baseline`
- Later tags exist locally: `backup-phase-5`, `стабилизация-этапа-5-2`

### Commits analyzed (in order)
| Commit | What it did |
|--------|-------------|
| `8ea84d2` | Added backup/restore system (backup.sh, restore.sh, docs, data-source.ts) |
| `3038b95` | Strengthened integrity checks + security (SHA256, gzip/tar validation, path traversal guard, pre-validation phase) |
| `5642569` | Volume-aware restore into Docker named volume; staging extraction; fail-before-modification ordering |
| `67d39ec` | Fixed healthcheck in restore.sh (wget -> node-native) |
| `21fc42f` | Added isolated restore testing script (test-restore.sh) |

Note: these are the commits that created or modified the backup/restore system.

### Stack (verified from docker-compose.yml + source)
| Service | Image | Named volume | Backup? |
|---------|-------|--------------|---------|
| db | postgres:16-alpine | db_data | Yes (pg_dump) |
| redis | redis:7-alpine | redis_data | **No** |
| backend | homecloud-backend (NestJS) | storage_data -> /storage | Yes (tar) |
| frontend | nginx | (none) | Code only |

### Key architectural facts (verified)
- `backups/` lives on the HOST at project root, NOT inside any Docker volume.
- `.gitignore` excludes `backups/`, `*.sql.gz`, `*.tar.gz`, `*.meta`.
- `backup.sh` cannot reach `/storage` on the host (it is a named volume), so the
  `docker compose exec -T backend tar` branch is the one that actually executes.
- `restore.sh` restores storage into the Docker named volume via a throwaway
  container (`docker run -v <vol>:/storage`), never into a host path.
- `uploads_data` volume is declared in docker-compose.yml but mounted to NO service
  (dead config, looks like a missed backup target).
- `restore.sh` is interactive-only: `read -rp "Continue? (yes/no):"` with no `--yes` flag.


---

## 2. Existing Backup/Restore Analysis

### 2.1 backup.sh — what it actually does

**Phase 1: PostgreSQL dump** (lines 36-73)
- `docker compose exec -T db pg_dump -U homecloud -d homecloud --clean --if-exists | gzip > .sql.gz`
- Verifies: file exists, size > 0, `gzip -t`, dump contains `CREATE TABLE|CREATE EXTENSION`
- Computes SHA256 of the `.sql.gz`

**Phase 2: Storage archive** (lines 80-125)
- Runs `tar -czf` against `/storage` via `docker compose exec -T backend tar` (the branch that actually executes)
- Excludes: `.tmp` directory and any `*.tmp` files
- Verifies: file exists, `tar -tzf` integrity
- Computes SHA256 of the `.tar.gz`

**Phase 3-5: integrity re-check, metadata, retention**
- Writes `.meta` JSON with format_version, timestamp, filenames, sizes, SHA256s, file count
- Retention: `find ... -name "homecloud_db_*.sql.gz" -type f -mtime +7 -print -delete` + sibling cleanup

### 2.2 restore.sh — what it actually does

**Phase A (read-only pre-validation)** — all checks happen BEFORE any destructive action:
- Artifact existence (dump, archive, meta)
- SHA256 recompute vs meta (skips silently if meta value empty — WARNING logged)
- Size vs meta
- `gzip -t` on dump
- SQL structure grep (`CREATE TABLE`)
- `tar -tzf` on storage
- Security scan (python3: absolute paths, `..` traversal, symlink/hardlink escape; bash fallback: names only)
- Docker volume resolution + validation (3 fallback paths; fail-closed via `docker volume inspect`)

**Phase B**: interactive confirmation prompt

**Phase C (destructive)**:
1. `docker compose down` (volumes preserved — no `-v`)
2. `docker compose up -d db`, wait for pg_isready, `gunzip -c dump | psql`
3. Storage restore into volume via throwaway container: extract to `/storage/.restore-staging`, **delete old content**, `cp -a` staging to root, remove staging
4. `docker compose up -d`
5. `npm run migration:run` (warning on failure, continues)
6. Health check loop (node-native HTTP check)

### 2.3 test-restore.sh — what it actually does

Fully isolated: temp network, temp DB volume, temp storage volume, temp Postgres container, temp backend container. Trap cleanup on EXIT.

**Does NOT**: run `restore.sh` itself, run migrations, verify DB↔storage consistency, open/verify file bytes, verify checksums against meta, detect empty storage archives.

### 2.4 Verified gaps

| Gap | Evidence |
|-----|----------|
| `.meta` is unprotected | No checksum/signature on `.meta` itself; `restore.sh` never hashes it |
| `.meta` can be malformed JSON | `backups/homecloud_20260909_225124.meta` fails `json.load()` — `storage_file_count` value is `      0\n0` (BSD `wc -l` + pipefail interaction) |
| Dump is non-transactional | 0 `BEGIN`/`COMMIT` lines in `homecloud_db_20260909_230246.sql.gz` (verified) |
| `checksum` column dead | `file.entity.ts:37` declares `checksum text`; no service writes it (grep found zero writes) |
| `restore.sh` ignores `format_version` | `RESTORE_FORMAT_VERSION="1"` is a dead variable, never compared to meta |
| Health check proves nothing | `health.controller.ts` returns `{status:"ok"}` unconditionally — never touches DB/Redis |
| Migration failure is non-fatal | `restore.sh` logs warning and continues on `migration:run` failure |
| Empty storage = valid backup | `225124` set: 29-byte tar.gz, passes all checks, `storage_file_count: 0` |
| Orphan files exist in real backups | `230246` storage has `backup-test/random.bin` + `backup-test/test.txt` but DB `files` table is empty |
| Restore deletes-then-copies | `restore.sh` line 322 `rm -rf` runs BEFORE line 323 `cp -a` — if cp fails, old data already destroyed |
| Secrets in process env | `set -a; source .env` exports JWT_SECRET/DB_PASSWORD/REDIS_PASSWORD |
| Backup files world-readable | `-rw-r--r--` (644) on all backup artifacts |
| No offsite strategy | backups live only on host at `backups/` |
| No encryption | backups stored plaintext |
| No monitoring | stdout only, no status file, no alerting |
| No concurrency guard | two backup.sh runs in same second overwrite each other (1-second timestamp) |
| No disk-space pre-check | `df`/`free` absent from backup.sh |
| No "keep at least N" floor | if all backups > 7 days, retention deletes everything |
| `uploads_data` dead volume | declared but mounted to nothing |


---

## 3. Data Backup Scope

### 3.1 PostgreSQL — full schema (verified from migrations + entities)

| Table | Purpose | Sensitive columns | Backup decision |
|-------|---------|-------------------|-----------------|
| `users` | Accounts | `email` (PII), `password` (bcrypt cost 12) | **BACKUP** |
| `folders` | Folder hierarchy | — | **BACKUP** |
| `files` | File metadata + folder mirror rows | `name`, `storagePath`, `mimeType` | **BACKUP** |
| `share_links` | Public share links | `token`, `password` (bcrypt cost 10), `expiresAt` | **BACKUP** |
| `upload_sessions` | Transient upload state | `filename`, `tempPath` | **BACKUP** (see §3.3) |
| `refresh_tokens` | Active sessions | `token_hash` (bcrypt cost 10) | **BACKUP** |
| `migrations` | TypeORM history | — | **BACKUP** (required for restore) |

**Note**: `files` table contains BOTH file rows (`isFolder=false`) AND folder mirror rows
(`isFolder=true`, `storagePath=NULL`). A folder exists in two tables with the same `id`.
Both must be restored together.

**Note**: `users.storageUsed` is a cached aggregate, not derived on the fly. If DB and
storage disagree after restore, the counter is wrong and stays wrong (quota enforcement
is affected). See §6.

### 3.2 File Storage

**Structure** (from `StorageService` + `UploadsService`):
```
/storage/{userId}/<safeFilename>     <- user files (BACKUP)
/storage/.tmp/{uploadId}/{index}     <- upload chunks (EXCLUDE from backup)
/storage/.tmp/{uploadId}/{index}.tmp <- atomic write temp (EXCLUDE)
```

**What is backed up**: everything under `/storage` except `.tmp` and `*.tmp`.
**What is NOT backed up**: in-flight upload chunks, Redis cache, rate-limit state.

### 3.3 Classification

| Category | Items |
|----------|-------|
| **MUST be backed up** | PostgreSQL all tables; user files under `/storage/{userId}/`; folder structure |
| **Should be backed up** | `upload_sessions` rows (so operator can identify/clean orphaned sessions after restore) |
| **Must NOT be auto-backed up** | `.env` secrets (JWT_SECRET, DB_PASSWORD, REDIS_PASSWORD, JWT_REFRESH_SECRET) — see §13 |
| **Must be restored manually** | `.env` on new host; Docker images (build/pull); docker-compose.yml; `.env.example` |
| **Stored separately** | `.env` — record secret values in a password manager, NOT in the backup chain |
| **Explicitly excluded** | `.tmp/` upload chunks; Redis data; any local-only dev data |

### 3.4 What is lost in a full host disaster (and is acceptable)

- Redis state (cache, rate limits) — **acceptable**, it is transient
- In-flight upload chunks in `.tmp/` — **acceptable**, user re-uploads
- `.env` secrets — **NOT acceptable**, must be recorded separately
- `uploads_data` volume — **acceptable**, it is unused dead config


---

## 4. RPO / RTO

### 4.1 RPO (Recovery Point Objective)

**Recommended baseline: 24 hours** (one daily backup), with the following trade-offs.

| Factor | Effect on RPO |
|--------|---------------|
| Backup is sequential (pg_dump then tar) | A backup of 50 GB storage can take 10-40 min; the inconsistency window grows with storage size |
| No incremental backup exists | Every backup is full — longer window = larger risk |
| No write-quiesce during backup | Active uploads/deletes/moves during the window create DB↔storage drift |
| Retention = 7 days | If 7 days pass without a successful backup, the oldest recoverable point is 7+ days old |

**Why not smaller RPO:**
- Incremental backup of a Docker volume requires filesystem-level snapshots (LVM/ZFS/btrfs) or block-level tools — not available in a plain Docker setup.
- Running backup more often than daily multiplies the inconsistency window exposure and disk churn without solving the fundamental sequential-gap problem.
- For a self-hosted home cloud, 24-hour RPO is the pragmatic minimum that does not require new infrastructure.

**Acceptable loss**: files uploaded/modified in the last 24 hours. Redis state and in-flight
uploads are always lost on restore (acceptable).

### 4.2 RTO (Recovery Time Objective)

**Estimated for a 50 GB home cloud on consumer hardware** (restore.sh phases):

| Phase | Estimated time | Notes |
|-------|---------------|-------|
| docker compose down | 5-10 s | |
| Start db + wait | 5-15 s | |
| psql restore of dump | 10-60 s | dump is small (schema + metadata) |
| Storage extract into volume | 2-15 min | tar.gz of 50 GB; dominated by I/O |
| docker compose up -d | 10-30 s | services start in parallel |
| migration:run | 5-30 s | usually no-op |
| Health check | up to 40 s | 20 retries x 2 s |
| **Total (best case)** | **~5 min** | small storage |
| **Total (50 GB)** | **~15-25 min** | realistic |

**Recommended RTO baseline: 30 minutes** for a mid-size home cloud.

**Trade-offs**:
- RTO is dominated by storage extract time, which scales linearly with storage size.
- A full-tar restore of 500 GB+ would exceed 2 hours — this is the known scaling limit.
- RTO does NOT include time to recreate `.env`, rebuild images, or verify data consistency.
- The interactive confirmation prompt adds an unbounded human delay — see §11.


---

## 5. Backup Architecture

### 5.1 Core principle

A backup is a **pair** (PostgreSQL dump, storage archive) plus a **manifest** that
binds them together with a shared timestamp and checksums. The pair must be treated
as a single recoverable unit.

### 5.2 Backup format (version 1, current)

Per backup timestamp `YYYYMMDD_HHMMSS`:
- `homecloud_db_<TS>.sql.gz` — pg_dump output, gzip-compressed
- `homecloud_storage_<TS>.tar.gz` — tar of `/storage` (excluding `.tmp`), gzip-compressed
- `homecloud_<TS>.meta` — JSON manifest

**Manifest fields**: format_version, timestamp, created_at, db_dump, storage_archive,
db_name, storage_path, db_dump_size, storage_archive_size, db_dump_sha256,
storage_archive_sha256, storage_file_count, retention_days.

### 5.3 The consistency problem — and the fix

**Problem**: `pg_dump` runs first, then `tar` runs second. Any write between the two
creates a state where DB and storage disagree. Concrete cases:

| Event between dump and tar | Result after restore |
|---|---|
| File uploaded | Orphan physical file (no DB row) |
| File deleted/moved | DB row points to missing/wrong path |
| Upload session active | DB row references `.tmp/` dir that was excluded from backup |
| `users.storageUsed` changes | Counter drifts relative to actual file sizes |

**Current mitigation**: docs recommend a low-activity window. This is not sufficient.

**Recommended fix (Phase 5.2+)**: introduce a **consistency marker**.

The mechanism:
1. Before backup, set a flag in the DB (e.g., a row in a `backup_lock` table, or
   `SET default_transaction_read_only = on` for the backup session).
2. Run `pg_dump`.
3. Clear the flag.
4. Run `tar`.

This narrows the window but does not eliminate it. A truly consistent backup would
require filesystem snapshot (LVM/ZFS/btrfs) — out of scope for plain Docker.

**Alternative accepted approach for MVP**: accept the small window, but add a
**post-backup consistency report** that lists:
- files in storage with no DB row (orphans)
- DB rows with no physical file (dangling)
- `users.storageUsed` vs actual sum

This report is generated at backup time and stored alongside the backup. It lets the
operator detect drift before disaster, not after.

### 5.4 Compression

- gzip at default level. Adequate.
- Do NOT switch to zstd without testing — gzip is universally available in recovery environments.

### 5.5 Encryption

**Current state**: none. Backups are plaintext.

**Assessment** (from Security subagent):
- Backups contain: bcrypt password hashes, user emails (PII), share link tokens,
  refresh token hashes, file metadata, AND user file contents.
- For a self-hosted home cloud, an unencrypted backup on disk is a real privacy risk.

**Recommendation**: encrypt the storage archive and DB dump at rest.
- Use `gpg --symmetric` or `age` with a passphrase.
- **The key must never live in the same place as the backup.** Store it in a password
  manager or provide it interactively at restore time.
- Do NOT store the key in `.env` if `.env` and `backups/` are on the same host.

**MVP decision**: encryption is REQUIRED for production readiness but is deferred to a
later phase because key management is a separate design problem. Document the gap
clearly (already documented in `docs/backup-and-restore.md`).

### 5.6 Naming, timestamp, version

- Timestamp format `YYYYMMDD_HHMMSS` (UTC), 1-second resolution.
- **Known issue**: two backups in the same second overwrite each other. Fix: append a
  random suffix or use sub-second + PID.
- `format_version` in `.meta` MUST be checked by `restore.sh` before restore. Currently
  it is a dead variable — this is a Phase 5.2 fix.
- The manifest MUST record: application version, TypeORM migration version count,
  PostgreSQL version. Currently none of these are recorded — Phase 5.2 fix.


---

## 6. Consistency Strategy

### 6.1 What must be consistent

After restore, these relationships MUST hold:

| Relationship | Check |
|---|---|
| `files.storagePath` ↔ physical file exists | Every non-folder `files` row must point to a real file |
| `files.size` ↔ actual byte size | Row size must equal `stat().size` |
| `users.storageUsed` ↔ sum of that user's file sizes | Counter must match reality |
| `share_links.fileId` ↔ `files.id` | FK integrity |
| `upload_sessions.tempPath` ↔ `.tmp/<uploadId>/` dir | Or session must be marked expired/aborted |
| No orphan physical files | Every file under `/storage/{userId}/` must have a DB row |

### 6.2 Post-restore reconciliation (required, Phase 5.2+)

A reconciliation pass MUST run after restore and before the system is declared healthy.
It reports (does NOT auto-fix — operator decides):

1. **Orphan files**: physical files with no DB row → report count + sample paths
2. **Dangling rows**: DB rows with no physical file → report count + sample paths
3. **Size mismatch**: `files.size` != actual file size → report
4. **storageUsed drift**: `users.storageUsed` != actual sum → report per user
5. **Broken share links**: `share_links` referencing deleted files → report
6. **Stale upload sessions**: `upload_sessions` with missing `.tmp/` dir → report

**This is a REPORT, not an auto-healing engine.** Auto-fixing storage accounting is
dangerous (it can silently hide real data loss). The operator reviews the report and
decides.

### 6.3 Current state

No reconciliation exists. `restore.sh` health check (`health.controller.ts`)
returns `{status:"ok"}` unconditionally — it never touches the DB or storage.
A restore that leaves empty storage but a healthy DB reports success.


---

## 7. Integrity & Verification

### 7.1 The core rule

**"backup command exited 0" is NOT proof of a usable backup.** A backup is proven only
when it has been restored and verified.

### 7.2 Four verification levels

| Level | Meaning | Current HomeCloud status |
|-------|---------|--------------------------|
| **1** | Backup file created, exit 0 | Achieved by `backup.sh` |
| **2** | Backup internally valid (gzip -t, tar -tzf, SHA256 matches) | Achieved by `backup.sh` + `restore.sh` Phase A |
| **3** | Backup restores to a working DB (schema valid, data queryable) | **Partially** — `test-restore.sh` loads the dump but does NOT run `restore.sh`, does NOT run migrations, accepts zero data rows as valid |
| **4** | Full app restore tested (DB + storage + app + real file access + consistency) | **Not achieved** — no test opens a restored file or checks DB↔storage consistency |

**Current achieved level: 2.5.**

### 7.3 What is verified today (and what each check misses)

| Check | Catches | Misses |
|-------|---------|--------|
| File existence | Missing files | Empty-but-present files |
| Size > 0 | Zero-byte files | Non-zero garbage |
| `gzip -t` | Corrupt gzip container | Semantically empty dump |
| `grep CREATE TABLE` | Dump with no DDL | Truncated data section |
| `tar -tzf` | Corrupt tar central directory | Truncated file contents |
| SHA256 vs meta | Bit-rot of the artifact | `.meta` itself being corrupt |
| Path traversal scan | Malicious archive entries | Content-level corruption |
| Table/column names | Wrong schema | Zero data rows, wrong data |

### 7.4 What is NOT verified

- `.meta` integrity (no checksum on the manifest itself)
- `format_version` compatibility
- DB↔storage consistency
- File contents (test-restore only counts files, never opens them)
- `users.storageUsed` accuracy
- Migration history vs code migrations match
- Application version / schema version at backup time

### 7.5 Required minimum for production

**Level 3 is the production floor.** Level 4 is the target.

Phase 5.2 must achieve at minimum:
- `restore.sh` checks `format_version` and refuses unknown versions
- `restore.sh` runs the reconciliation pass (§6.2) and reports results
- `restore.sh` exit code reflects reconciliation findings, not just HTTP health
- A periodic `test-restore.sh` run (weekly) that actually restores into isolation


---

## 8. Retention

### 8.1 Current policy

`RETENTION_DAYS=7` (default). Cleanup: `find ... -name "homecloud_db_*.sql.gz" -mtime +7 -delete`,
then removes sibling `.meta` and `.tar.gz` by reconstructed timestamp.

### 8.2 Problems with current retention

| Problem | Detail |
|---------|--------|
| No "keep at least N" floor | If ALL backups are > 7 days old (e.g., backup stalled 8 days), retention deletes EVERYTHING — zero backups remain |
| Timestamp collision | 1-second resolution; two runs in the same second overwrite each other |
| Cleanup failure swallowed | `rm ... 2>/dev/null || true` — errors are silent |
| No disk-space guard | If the backup volume fills mid-tar, the new backup fails AND old backups may already be reaped |
| Orphan artifacts | If retention deletes the `.sql.gz` but sibling cleanup fails, leftover `.meta`/`.tar.gz` confuse restore.sh |

### 8.3 Recommended retention

| Tier | Count | Rationale |
|------|-------|-----------|
| Daily | 7 | One per day for the past week |
| Weekly | 4 | One per week for the past month |
| Monthly | 3 | One per month for the past quarter |

**Implementation note**: this requires renaming/archiving backups into tiered files or
a retention table. The current flat `find -mtime` scheme cannot express this.
A simple intermediate (Phase 5.2): keep at least 2 backups always, plus 7 days, plus
the newest regardless of age.

### 8.4 Rules

- **Never delete the newest valid backup** — even if it is older than the retention window.
- **On backup failure, do NOT run retention** — preserve the previous good backup.
- **On disk-space warning, stop creating new backups and alert** — do not silently fail.
- **Retention errors must be visible** — log and exit non-zero, do not swallow.


---

## 9. Storage Destinations

### 9.1 Options considered

| # | Destination | Pros | Cons | Verdict |
|---|-------------|------|------|---------|
| 1 | Local backup directory (`backups/`) | Simple, no new infra | Lost with host | **MVP primary** |
| 2 | Separate Docker volume | Isolated from app code | Still on same host | Optional |
| 3 | Second physical disk | Better host-failure protection | Requires spare disk | Recommended if available |
| 4 | Network storage / NAS | Centralized, accessible | Adds network dependency | Recommended for production |
| 5 | S3-compatible storage | Off-site, durable, cheap | Requires credentials, network | Future |
| 6 | Off-site (another physical location) | Best disaster protection | Operational complexity | Future |

### 9.2 MVP destination

**Local `backups/` directory on the host**, with the following mandatory additions:
- A documented off-site replication step (rsync/scp to a second host or NAS)
- The operator records `.env` secrets in a password manager (NOT in the backup chain)

### 9.3 Future destinations

- S3-compatible (MinIO / Cloudflare R2 / AWS S3) with versioning
- Direct-to-volume restore from off-site copy

### 9.4 Off-site requirement

The docs already state: "Локальный backup не защищает от потери самого сервера."
This is the single largest risk for a home cloud. **Off-site replication is not optional
for production** — it is the whole point of disaster recovery.


---

## 10. Restore Architecture

### 10.1 Correct restore order (verified against stack dependencies)

The current `restore.sh` order is mostly correct but has critical flaws (noted).

```
1.  Prepare target host
    - Install Docker + Docker Compose
    - Recreate project structure (git clone / copy)
    - Recreate .env with ORIGINAL secrets (see §13)
    - Build or pull images (docker compose build)
2.  Start infrastructure only
    - docker compose up -d db redis   (NOT backend/frontend yet)
    - Wait for db + redis health
3.  Validate backup artifacts (read-only)
    - Existence, SHA256, gzip, tar, security scan, format_version check
    - FAIL CLOSED: any mismatch -> stop, do not touch live data
4.  Restore PostgreSQL
    - gunzip -c dump | psql
    - MUST use ON_ERROR_STOP=1 (currently missing — silent partial restore)
5.  Validate restored DB
    - Table count, row counts, schema columns vs current entities
6.  Restore file storage
    - Extract into Docker named volume (current approach is correct: throwaway container)
    - ATOMIC: copy-new-before-delete-old (currently delete-then-copy — WRONG, see §10.2)
7.  Run migrations
    - npm run migration:run
    - FAIL if migration fails (currently non-fatal warning — WRONG)
8.  Start application
    - docker compose up -d
9.  Run reconciliation (§6.2)
    - Orphans, dangling rows, size mismatches, storageUsed drift, broken shares, stale sessions
    - Report results; exit non-zero if critical findings
10. Health checks
    - Backend /api/v1/health
    - Frontend http://localhost
11. Validate real data access
    - Pick a sample user, list files, download one file, verify bytes
12. Declare restore successful
```

### 10.2 Critical flaw: storage restore is delete-then-copy, not copy-then-delete

`restore.sh` lines 319-324:
```
mkdir -p "$STAGE"
tar -xzf - -C "$STAGE"                          # (1) extract to staging
find /storage ... -not -name ".restore-staging" -exec rm -rf {} +   # (2) DELETE OLD
cp -a "$STAGE/." /storage/                       # (3) copy new
rm -rf "$STAGE"                                  # (4) cleanup
```

Step (2) deletes old data BEFORE step (3) copies new data. If (3) fails (disk full,
signal, bug), the old data is already gone and only the staging dir remains.

**Fix**: swap (2) and (3). Copy new data alongside old, verify, THEN delete old.
Or: extract to a NEW empty volume, verify, then swap the mount. The staging-subdir
approach on the same volume cannot be made atomic without a second volume.

**Recommended**: extract to a second temporary volume, verify integrity, then
`docker compose stop backend && swap volume binding && start`. This is a real atomic swap.

### 10.3 Critical flaw: DB restore is non-transactional

The dump has 0 `BEGIN`/`COMMIT` lines (verified). `psql` runs statements individually.
A mid-stream error leaves a half-restored DB and `restore.sh` reports success.

**Fix**: pipe through `psql -ON_ERROR_STOP=1` and check the exit code.

### 10.4 Critical flaw: health check proves nothing

`health.controller.ts` returns `{status:"ok"}` unconditionally. The restore health
gate passes even when the DB is unreachable or storage is empty.

**Fix**: the health endpoint must actually probe DB and Redis (NestJS Terminus or a
custom probe). Until then, restore.sh must run the reconciliation pass (§6.2) as the
real success gate.

### 10.5 Critical flaw: migration failure is non-fatal

`restore.sh` logs a warning and continues if `migration:run` fails. A restore can
complete with a schema that does not match the code.

**Fix**: migration failure must abort the restore.

### 10.6 Critical flaw: interactive only

`read -rp "Continue? (yes/no):"` blocks forever in non-TTY environments. A disaster
restore must be runnable unattended.

**Fix**: add `--yes` / `--force` flag for scripted restore; keep the prompt as default.

### 10.7 Critical flaw: image absence

`restore.sh` runs `docker run ... "$BACKEND_IMAGE"` and `docker compose up -d` but
never builds or pulls images. On a fresh host these do not exist.

**Fix**: `restore.sh` must ensure images exist (build or pull) before restore, or the
runbook must document this step explicitly.


---

## 11. Disaster Scenarios

### Scenario A — PostgreSQL volume destroyed
- **Lost**: entire DB (all 7 tables, sequences, migration history)
- **Restored**: full pg_dump (`--clean --if-exists`, idempotent)
- **Backups needed**: the `.sql.gz` from latest valid `.meta`
- **Actions**: restore.sh handles this (fresh db_data volume auto-created)
- **Success**: row counts match; backend health 200; migrations no-op
- **Prevent further damage**: do NOT run backup.sh during outage (would overwrite good daily backup); if db_data exists but corrupt, `docker volume rm db_data` first

### Scenario B — Storage volume destroyed
- **Lost**: all user files; DB metadata still references missing paths
- **Restored**: storage `.tar.gz` into volume via throwaway container
- **Backups needed**: the `.tar.gz`
- **Actions**: restore.sh handles this (fresh storage_data auto-created by `docker run -v`)
- **Success**: file count matches meta; sample file opens
- **Prevent further damage**: staging pattern means failed extraction leaves original intact

### Scenario C — Both PostgreSQL and storage lost
- **Lost**: everything
- **Restored**: both artifacts, in order (DB first, then storage)
- **Backups needed**: both `.sql.gz` and `.tar.gz`
- **Actions**: restore.sh handles this
- **Success**: both row counts and file counts match

### Scenario D — Entire Docker host lost
- **Lost**: everything on host — both volumes, `.env`, `backups/` (if on same disk), Docker images
- **Restored**: nothing from this host
- **Backups needed**: OFF-SITE copy of `backups/` + a record of `.env` secrets
- **Actions**: on replacement host — git clone, recreate `.env` with ORIGINAL secrets, copy off-site backups, `docker compose build`, run restore.sh
- **Critical**: without `.env` secrets, restore succeeds but all JWT refresh tokens are invalidated and Redis auth breaks. Secrets must be recorded in a password manager, NOT in the backup chain.
- **Critical**: restore.sh is interactive-only — in non-TTY disaster it hangs. Needs `--yes` flag.

### Scenario E — Backup exists but is corrupted
- **Lost**: that backup set
- **Restored**: nothing from it — restore MUST NOT proceed
- **Backups needed**: an older healthy set
- **Actions**: restore.sh Phase A catches this BEFORE any destructive action (correct ordering)
- **Success**: Phase A passes on a different set, then restore completes

### Scenario F — Last backup corrupted, older ones fine
- **Lost**: only the most recent backup point
- **Problem**: restore.sh hard-wires "latest by timestamp" (`find | sort | tail -n1`) and does NOT fall back. It dies at Phase A.
- **Fix needed**: restore.sh must try backups in order until one passes Phase A, OR the operator triages manually (rename corrupted set out of BACKUP_DIR)

### Scenario G — Restore interrupted mid-way
- **Worst case**: interrupted during storage extraction after `rm -rf` old data (§10.2) — old data gone, new data not yet copied
- **DB state**: non-transactional dump leaves partial schema (some tables dropped, some recreated)
- **Recovery**: re-run restore.sh from the same backup (idempotent `--clean`); if interrupted during `rm -rf`, the staging dir holds the full extraction — recoverable manually
- **Prevention**: fix delete-then-copy to copy-then-delete (§10.2)

### Scenario H — Backup from old version, restore to new version
- **Risk**: old schema lacks columns the new code/migrations expect
- **Current behavior**: `restore.sh` does NOT read `format_version` (dead variable). No version gate.
- **After restore**: `migration:run` applies pending migrations. If purely additive, data survives. If destructive, data is lost. Migration failure is non-fatal (continues) — silent degradation.
- **Fix**: check format_version + app version in meta before restore; record migration version count in meta; fail if pending migrations are destructive

### Scenario I — Backup looks created but is unusable
- **Empty storage archive** (29 bytes, `storage_file_count: 0`): passes ALL checks. The backup of nothing is a valid backup.
- **Dump with no data**: `test-restore.sh` accepts zero rows as valid.
- **Detection**: run `test-restore.sh` periodically (weekly). Add a pre-flight check that storage_file_count > 0 and DB row counts are non-zero.

### Scenario J — Disk full during backup
- **No pre-check** (`df`/`free` absent from backup.sh)
- **Partial state**: `.sql.gz` may already be written; `.tar.gz` fails and is removed; `.meta` never written; retention may have already reaped old backups
- **Result**: zero recoverable backups — the worst outcome
- **Fix**: pre-check free space; on failure, do NOT run retention; alert

### Scenario K — Disk full during restore
- **Catastrophic**: storage extract fails after old data already deleted (§10.2)
- **Detection**: pre-check free space before restore (need at least 2x storage size for staging)

### Scenario L — Partial corruption undetected
- **Bit-rot after meta written**: SHA256 recompute at restore catches it (good)
- **Corrupt `.meta` itself**: no checksum on meta; grep/sed parser may silently skip a disabled checksum check (WARNING logged, restore proceeds)
- **Corrupt meta field that restore.sh consumes**: filenames wrong -> caught by existence check; checksum empty -> check DISABLED (dangerous)
- **Fix**: checksum the meta file; parse meta with a real JSON parser; fail if any consumed field is empty


---

## 12. Security

### 12.1 Secrets

| Item | Status |
|------|--------|
| `.env` in backup | **NOT backed up** (correct) |
| `.meta` contains secrets | **No** (verified) |
| DB dump contains secrets | Contains bcrypt password hashes, share password hashes, refresh token hashes — **acceptable** (one-way, not reversible) |
| Secrets in backup process env | `set -a; source .env` exports JWT_SECRET/DB_PASSWORD/REDIS_PASSWORD into process environment — **MEDIUM risk**, visible via `ps eww` on macOS |
| Secrets written to disk by restore | **No** |

**Rule**: `.env` secrets must be recorded in a password manager, NOT in the backup chain.
On a new host, recreate `.env` with the ORIGINAL secrets. If they are lost, all users
must reset passwords (DB restore still works because pg_dump stores hashes, not plaintext).

### 12.2 Backup storage security

- Backup directory permissions: `drwx------` (700) — good
- Backup file permissions: `-rw-r--r--` (644) — **WEAK**, world-readable. Fix: `chmod 600` on created files.
- Backups not web-served: verified (frontend nginx serves its own build; backend serves only `/api/v1/*`)
- Path traversal in API: **blocked** — `StorageService.ensureWithinStorageRoot` uses `path.resolve()` + `startsWith(root + sep)` check. Solid.

### 12.3 Restore security

- Security scan runs in Phase A BEFORE destructive operations — correct ordering
- Python3 scan: catches absolute paths, `..` traversal, symlink/hardlink escape
- Bash fallback: names only — misses symlink/hardlink targets. Acceptable if python3 is documented as a requirement.
- Confirmation prompt: real guard, requires exact `yes`. Bypassable by `echo yes | restore.sh`.

### 12.4 Encryption

**Current**: none. Backups are plaintext.

**Assessment**: backups contain PII (emails), password hashes, share tokens, AND user file
contents. For a self-hosted home cloud, unencrypted backups are a real privacy risk.

**Recommendation**: encrypt storage archive and DB dump at rest (gpg/age).
Key must NOT live in the same location as the backup.
**MVP decision**: deferred to later phase; gap is documented.

### 12.5 Top security findings

| # | Finding | Severity |
|---|---------|----------|
| 1 | Restore deletes live data before copy succeeds (§10.2) | HIGH |
| 2 | No encryption at rest for backups | HIGH |
| 3 | User files stored unencrypted on disk (no client-side or envelope encryption) | HIGH |
| 4 | Backup files world-readable (644) | MEDIUM |
| 5 | Secrets exported into process environment | MEDIUM |
| 6 | Bash fallback security scan misses symlink/hardlink targets | LOW |


---

## 13. Automation

### 13.1 Where backup runs

**Recommended: host-level cron.** This is the simplest reliable option.

```bash
# /etc/cron.d/homecloud-backup
0 2 * * * root cd /path/to/homecloud && ./scripts/backup.sh >> /var/log/homecloud-backup.log 2>&1
```

### 13.2 Why not other options

| Option | Verdict |
|--------|---------|
| cron (host-level) | **BEST** — simple, reliable, no new daemon |
| Docker container | Adds a new service with its own failure modes; unnecessary |
| Application service | Backup is an operational task, not an app feature; do not couple to app lifecycle |
| External scheduler | Adds a dependency; unnecessary for MVP |

**Decision**: host-level cron. No new daemon, no new service, no new failure surface.

### 13.3 Restore automation

Restore is NOT automated. It requires a human operator.
Add `--yes` flag for scripted/unattended restore in disaster scenarios.


---

## 14. Observability

### 14.1 Current state

**None.** Scripts print to stdout only. No status file, no marker, no alerting, no metrics.

An operator knows a backup failed only by checking exit codes or reading cron logs.
A silent `exit 1` piped to a log nobody reads = undetected outage.

### 14.2 Minimum viable observability

| Signal | Mechanism |
|--------|-----------|
| Backup started | stdout + log line with timestamp |
| Backup completed | stdout + log line with sizes + SHA256s |
| Backup failed | stdout + log line with error + **non-zero exit** |
| Backup size | recorded in `.meta` (already done) |
| Duration | compute from start/end timestamps, log it |
| Checksum | recorded in `.meta` (already done) |
| Retention cleanup | log how many removed |
| Last successful backup | `touch` a marker file `backups/.last-success` with timestamp |
| Last successful restore test | marker file from `test-restore.sh` |

### 14.3 Minimum for production

1. **Marker file**: `backups/.last-success` — timestamp of last successful backup. Cheap "did it run today?" check.
2. **Failure side-effect**: on failure, write failure reason + timestamp to `backups/.last-failure`.
3. **Cron `MAILTO`**: so non-zero exits produce an email.
4. **Structured one-line summary** (JSON) consumable by a log shipper.

Do NOT build a monitoring platform. These four are sufficient for a self-hosted home cloud.


---

## 15. Testing Strategy

### 15.1 Current state

`test-restore.sh` exists but is **not a production restore test**. It:
- Does NOT invoke `restore.sh` (inline reimplementation)
- Does NOT run migrations
- Does NOT verify DB↔storage consistency
- Does NOT open/verify file bytes
- Does NOT detect empty storage archives
- Accepts zero data rows as valid

**It is a test tool, not a production restore procedure.** Both must exist.

### 15.2 Required tests

| Test | Frequency | What it proves |
|------|-----------|----------------|
| Backup integrity check | Every backup | Level 2 (gzip/tar/SHA256) |
| Isolated restore test | Weekly | Level 3 (DB loads, schema valid) |
| Full restore test | Monthly | Level 4 (DB + storage + app + real file access) |
| Disaster simulation | Quarterly | End-to-end on fresh host |

### 15.3 Restore test must verify

- DB loads into isolated Postgres
- All 7 tables present with correct columns (vs current entities)
- Row counts non-zero (or expected)
- `migration:run` succeeds
- Storage extracts into isolated volume
- File count matches meta `storage_file_count`
- Sample file opens and bytes match expected size
- DB↔storage consistency (§6.2 reconciliation)
- Backend health after full restore
- A real file downloads correctly through the API

### 15.4 Success criteria for a restore test

A restore test is successful ONLY if:
1. The system is fully functional after restore
2. Data is consistent (reconciliation report has no critical findings)
3. A real user file can be opened and its bytes verified


---

## 16. Documentation Plan

### 16.1 Existing documents

| Document | Status |
|----------|--------|
| `docs/backup-and-restore.md` | Exists, describes current v1 format. **Needs update** for Phase 5.2+ architecture |
| `README.md` | Mentions backup, points to docs |
| `scripts/backup.sh` | Self-documenting via comments |
| `scripts/restore.sh` | Self-documenting via comments |

### 16.2 Required documents

| Document | Priority | Status |
|----------|----------|--------|
| Backup architecture | HIGH | This document |
| Backup configuration | HIGH | Update `docs/backup-and-restore.md` |
| Restore procedure (production) | HIGH | New — step-by-step, incl. fresh-host scenario |
| Disaster recovery runbook | HIGH | New — scenario-based (§11) |
| Testing procedure | MEDIUM | New — what `test-restore.sh` proves and its limits |
| Operational checklist | MEDIUM | New — daily/weekly/monthly tasks |

### 16.3 `docs/backup-and-restore.md` must be updated to reflect

- The consistency limitation (§5.3)
- The reconciliation requirement (§6.2)
- The `--yes` flag for unattended restore
- The format_version check requirement
- The encryption gap
- The off-site requirement
- The retention floor requirement
- The `test-restore.sh` limitations (it is NOT a production restore)


---

## 17. MVP Scope

### 17.1 What MVP must include

1. **Backup foundation** — `backup.sh` hardened:
   - Timestamp collision fix (sub-second + PID suffix)
   - Disk-space pre-check
   - `chmod 600` on created files
   - Marker file `backups/.last-success`
   - Failure marker file
   - Retention: keep-at-least-2 floor + 7 days
   - On backup failure, do NOT run retention
   - Record app version, migration count, PG version in `.meta`

2. **Restore improvements** — `restore.sh` hardened:
   - Check `format_version` against supported versions (fail closed)
   - `--yes` flag for unattended restore
   - `psql -ON_ERROR_STOP=1` (fail on partial DB restore)
   - Storage restore: copy-new-before-delete-old (atomic swap via second volume)
   - Migration failure ABORTS restore (not a warning)
   - Ensure images exist (build or pull) before restore
   - Post-restore reconciliation pass (§6.2) as real success gate
   - Exit code reflects reconciliation findings

3. **Manifest integrity** — `.meta`:
   - Checksum the `.meta` file itself (HMAC or SHA256 of meta content)
   - Parse with a real JSON parser (not grep/sed)
   - Fail if any consumed field is empty

4. **Observability** — marker files + structured logging

5. **Documentation** — restore procedure, DR runbook, testing procedure

### 17.2 What MVP must NOT include

- Encryption (deferred — documented gap)
- Off-site replication script (deferred — documented requirement)
- Incremental backup (out of scope for plain Docker)
- S3/remote storage (future)
- Redis backup (Redis is cache-only; acceptable loss)
- Frontend changes
- Auth changes
- Any unrelated refactoring


---

## 18. Future Scope

| Phase | Scope |
|-------|-------|
| 5.2 | Backup foundation (§17.1 items 1, 4) |
| 5.3 | Restore improvements (§17.1 item 2) |
| 5.4 | Manifest integrity + reconciliation (§17.1 items 3, part of 2) |
| 5.5 | Automated restore test / disaster simulation (§15) |
| 5.6 | Documentation + final verification + checkpoint |
| 5.7+ | Encryption at rest (gpg/age, key management design) |
| 5.8+ | Off-site replication (rsync/S3) |
| 5.9+ | Incremental backup (requires filesystem snapshot or block-level tools) |
| 5.10+ | Real health endpoint probes (DB + Redis) in NestJS |


---

## 19. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Restore deletes live data before copy succeeds (§10.2) | **CRITICAL** | Copy-new-before-delete-old; atomic volume swap |
| 2 | Non-transactional DB restore leaves partial schema on interruption | **HIGH** | `psql -ON_ERROR_STOP=1` |
| 3 | Health check proves nothing — restore can "succeed" with empty storage | **HIGH** | Reconciliation pass as real gate |
| 4 | No off-site backup — full host loss = total data loss | **HIGH** | Documented requirement; rsync/S3 in future |
| 5 | No encryption — backups contain PII + file contents | **HIGH** | Deferred; documented gap |
| 6 | `.env` secrets lost on host disaster — all users must reset | **HIGH** | Record in password manager, NOT in backup chain |
| 7 | Migration failure silently ignored — restore completes with wrong schema | **HIGH** | Abort on migration failure |
| 8 | `format_version` ignored — incompatible backup silently processed | **MEDIUM** | Check and fail closed |
| 9 | `.meta` unprotected — corrupt meta can disable checksum verification | **MEDIUM** | Checksum meta; JSON parser; fail on empty fields |
| 10 | Timestamp collision — two backups in same second overwrite | **MEDIUM** | Sub-second + PID suffix |
| 11 | Disk full during backup after retention reaped old backups — zero recoverable | **MEDIUM** | Pre-check free space; do not retain on failure |
| 12 | `restore.sh` interactive-only — hangs in non-TTY disaster | **MEDIUM** | `--yes` flag |
| 13 | Images absent on fresh host — restore fails after `docker compose down` | **MEDIUM** | Ensure images exist before restore |
| 14 | Empty storage archive passes all checks as "valid backup" | **MEDIUM** | Pre-flight check: storage_file_count > 0 |
| 15 | `uploads_data` volume is dead config — confusion | **LOW** | Remove from docker-compose.yml |


---

## 20. Technical Debt

Items discovered during analysis that are OUTSIDE the backup/DR scope but affect it.
**Do NOT fix these in Phase 5.2** — record and move on.

| # | Item | Location | Impact on Backup/DR |
|---|------|----------|---------------------|
| TD-1 | `checksum` column declared but never written | `file.entity.ts:37`; zero writes in services | No content-level integrity linkage between DB rows and physical files. Reconciliation cannot verify file contents. |
| TD-2 | `uploads_data` volume declared but mounted to nothing | `docker-compose.yml:97` | Dead config; looks like a missed backup target. Remove it. |
| TD-3 | `health.controller.ts` returns `{status:"ok"}` unconditionally — never probes DB/Redis | `health.controller.ts:5-8` | Restore health gate is meaningless. Blocks Level 4 verification. |
| TD-4 | `users.storageUsed` is a cached counter, not derived | `users.service.ts` | After restore with DB↔storage drift, counter is wrong and stays wrong. |
| TD-5 | Files written to disk BEFORE DB transaction in `completeUpload` | `uploads.service.ts:287` then `:311` | Crash between write and commit = orphan file on disk. Fundamental app design issue. |
| TD-6 | `restore.sh` parses `.meta` with grep/sed, not a JSON parser | `restore.sh:203-208` | Fragile; malformed fields silently produce empty strings. |
| TD-7 | `RESTORE_FORMAT_VERSION` dead variable | `restore.sh:32` | Never compared to meta. No version gate exists. |
| TD-8 | `test-restore.sh` does not invoke `restore.sh` | inline reimplementation | Bugs in restore.sh are never caught by the test. |
| TD-9 | No `ON_ERROR_STOP` in DB restore pipe | `restore.sh:304` | Silent partial DB restore. |
| TD-10 | `migration:run` failure is non-fatal | `restore.sh:336-338` | Restore can complete with wrong schema. |
| TD-11 | 1-second timestamp resolution | `backup.sh:11` | Collision overwrites backups. |
| TD-12 | No disk-space pre-check | `backup.sh` (no `df`/`free`) | Disk full can destroy all recoverable backups. |
| TD-13 | Retention has no "keep at least N" floor | `backup.sh:175-182` | Can delete all backups if all are > 7 days old. |
| TD-14 | Backup files world-readable (644) | `backups/` | Security weakness. |
| TD-15 | Secrets exported to process env via `set -a; source .env` | `backup.sh:17-19`, `restore.sh:36-38` | Temporary exposure via `ps eww`. |


---

## 21. Recommended Implementation Batches

### Phase 5.2 — Backup Foundation
**Goal**: make backup.sh reliable and observable.
- Timestamp collision fix (sub-second + PID suffix in filename)
- Disk-space pre-check before backup; abort + alert if insufficient
- `chmod 600` on created backup files
- Marker file `backups/.last-success` (timestamp of last successful backup)
- Failure marker file `backups/.last-failure`
- Retention: keep-at-least-2 floor + 7 days; do NOT run retention on backup failure
- Record in `.meta`: app version, TypeORM migration count, PostgreSQL version
- Structured one-line JSON summary to stdout/log
- cron `MAILTO` documented

### Phase 5.3 — Restore Improvements
**Goal**: make restore.sh safe, non-interactive, and version-aware.
- Check `format_version` against supported versions (fail closed)
- `--yes` / `--force` flag for unattended restore
- `psql -ON_ERROR_STOP=1` — fail on partial DB restore
- Storage restore: copy-new-before-delete-old (atomic via second temp volume, then swap)
- Migration failure ABORTS restore (remove the warning-continue)
- Ensure images exist (build or pull) before restore
- Pre-check free space before restore (need >= 2x storage size for staging)

### Phase 5.4 — Integrity & Consistency
**Goal**: prove the backup is restorable and consistent.
- Checksum the `.meta` file itself (HMAC or SHA256 of meta content)
- Parse `.meta` with a real JSON parser (replace grep/sed)
- Fail if any consumed field is empty (do not silently skip checksum)
- Post-restore reconciliation pass (§6.2): orphans, dangling rows, size mismatches,
  storageUsed drift, broken shares, stale sessions — REPORT, do not auto-fix
- Exit code reflects reconciliation findings, not just HTTP health

### Phase 5.5 — Automated Restore Test / Disaster Simulation
**Goal**: achieve Level 4 verification.
- Extend `test-restore.sh` to run the ACTUAL `restore.sh` into isolation
- Run `migration:run` as part of the test
- Verify DB↔storage consistency after restore
- Open a sample file and verify bytes
- Weekly automated run; marker file for last successful test
- Quarterly full disaster simulation on a fresh host

### Phase 5.6 — Documentation + Final Verification + Checkpoint
- Update `docs/backup-and-restore.md` for the new architecture
- Write `docs/restore-procedure.md` (production restore, step-by-step)
- Write `docs/disaster-recovery-runbook.md` (scenario-based, §11)
- Write `docs/backup-testing-procedure.md`
- Independent review
- Create checkpoint tag

### Phase 5.7+ (Future)
- Encryption at rest (gpg/age) with key management design
- Off-site replication (rsync / S3-compatible)
- Incremental backup (requires filesystem snapshot or block-level tools)
- Real health endpoint probes (DB + Redis) in NestJS


---

## 22. Independent Reviewer Findings

A separate independent review was performed. Key findings (paraphrased, consolidated):

### Confirmed critical defects
1. **Restore deletes live data before copy succeeds** (`restore.sh:322` runs before `:323`).
   The staging comment says "only remove old content after a successful extraction" — and
   the code does follow that (extraction at line 321 precedes deletion at 322). But the real
   problem is that **deletion precedes the copy-back** (322 before 323). If `cp -a` fails,
   old data is already destroyed and only the staging dir remains.
   **This is the single most dangerous defect in the system.**

2. **DB restore is non-transactional and silent.** The dump has 0 `BEGIN`/`COMMIT` lines
   (verified). `psql` runs statements individually. A mid-stream error leaves a
   half-restored DB and `restore.sh` reports "PostgreSQL restored." No `ON_ERROR_STOP`.

3. **Health check proves nothing.** `health.controller.ts` returns `{status:"ok"}`
   unconditionally. A restore that leaves empty storage but a healthy DB reports success.

4. **Migration failure is non-fatal.** `restore.sh` logs a warning and continues. A
   restore can complete with a schema that does not match the code.

5. **`format_version` is never checked.** `RESTORE_FORMAT_VERSION="1"` is a dead variable.
   An incompatible backup is silently processed as format 1.

6. **`.meta` is unprotected.** No checksum on the manifest itself. A corrupt `.meta` can
   produce an empty checksum value, which `restore.sh` treats as "skip checksum"
   (WARNING logged, restore proceeds). This DISABLES the integrity check rather than failing.

7. **Image absence on fresh host.** `restore.sh` runs `docker run ... "$BACKEND_IMAGE"`
   and `docker compose up -d` but never builds or pulls images. On a fresh host these
   do not exist → restore fails after `docker compose down`.

8. **python3 required but undocumented.** `restore.sh` volume-resolution fallback uses
   `docker compose config | python3 -c '...'`. No python3 → `die`. Not documented.

9. **`.env` secrets required with exact values.** On a fresh host, `JWT_SECRET` and
   `JWT_REFRESH_SECRET` must match the originals or all refresh tokens are invalidated.
   `DB_PASSWORD` must match or Postgres auth fails. This is not documented anywhere.

### Additional findings
- `uploads_data` volume is dead config (declared, mounted to nothing).
- `checksum` column declared but never written — no content-level integrity linkage.
- `users.storageUsed` is a cached counter that drifts and stays wrong after restore.
- Files are written to disk BEFORE the DB transaction in `completeUpload` — crash
  between write and commit produces orphan files (fundamental app design issue).
- `test-restore.sh` does not invoke `restore.sh` — bugs in restore.sh are never caught.
- Empty storage archive (29 bytes) passes all checks as a "valid backup".
- Orphan physical files already exist in real backups (`backup-test/random.bin` has
  no DB row).

### Reviewer's "must fix before Phase 5.2" priority list
1. Storage restore: copy-new-before-delete-old (atomic swap)
2. `psql -ON_ERROR_STOP=1`
3. Reconciliation pass as real success gate (replace the meaningless health check)
4. Migration failure must abort
5. `format_version` check (fail closed)
6. Manifest integrity (checksum + JSON parser + fail on empty fields)
7. `--yes` flag for unattended restore
8. Image build/pull before restore


---

## 23. Summary

### What this session did NOT do
- No code was written or modified (except this architecture document)
- No checkpoint tag was created
- No scripts were changed
- No Docker configuration was changed
- No database schema was changed

### What this session produced
- Complete analysis of the existing backup/restore implementation (commits
  `8ea84d2`, `3038b95`, `5642569`, `67d39ec`)
- 5 specialist subagent analyses (backup architecture, disaster recovery, security,
  reliability/QA, independent review)
- This architecture document defining the target state and Phase 5.2+ boundaries

### The three most important architectural decisions

1. **Consistency is a report, not an automatic fix.** The DB↔storage consistency
   problem is real and unavoidable without filesystem snapshots. The fix for MVP is a
   post-restore reconciliation REPORT (§6.2) that the operator reviews — not an
   auto-healing engine that could silently hide data loss.

2. **Restore must be made atomic and fail-closed.** The current delete-then-copy
   storage restore (§10.2), non-transactional DB restore (§10.3), and unconditional
   health check (§10.4) together mean a restore can "succeed" while destroying data.
   These three are the highest-priority Phase 5.2 fixes.

3. **Verification level must reach Level 3 minimum, Level 4 target.** Today the system
   achieves Level 2.5. A backup that has never been restored and verified is not a
   backup — it is a hope. `test-restore.sh` must be extended to actually exercise
   `restore.sh` and verify real file access.

### Next step
Phase 5.2 should begin only after this document is reviewed and the Phase 5.2 scope
(§21) is approved. No implementation should start without that sign-off.

---
*Document generated 2026-09-10. Analysis based on repository state at commit 67d39ec.*
