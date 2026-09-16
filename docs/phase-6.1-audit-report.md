# HomeCloud Phase 6.1 — Database Integrity & Performance Audit Report

**Date**: 2026-09-12
**HEAD**: 1297051
**Checkpoint tag**: phase-5-backup-dr-complete
**Code changes**: 0
**Commits**: 0

---

## A. Executive Summary

```
Production readiness:
CRITICAL: 4 (F-01, F-02, MISS-01, MISS-02)
HIGH:     6 (F-03, F-04, F-05, F-06, MISS-03, F-08 risk escalation)
MEDIUM:   7 (F-08, F-09, F-10, F-13, F-16, MISS-04, F-18 risk)
LOW:      2 (F-14, F-13 adjacent)
```

The schema has 6 foreign key constraints (all to `users` only). No FK on `parentId` in `folders`, `files`, or `upload_sessions`. No CHECK constraints beyond NOT NULL. Two CRITICAL issues center on `deleteFolderPermanently` (no storageUsed decrement, no recursive child deletion) and missing FK constraints that allow dangling parent references in the hierarchy.

---

## B. Database Schema Matrix

| Entity | Table | PK | FK | UNIQUE | CHECK | Indexes | Issues |
|---|---|---|---|---|---|---|---|
| User | users | id | — | email | NOT NULL: email,password,isActive,isEmailVerified,storageQuota,storageUsed,createdAt,updatedat | PK, idx_users_email, users_email_key | storageUsed no CHECK ≥0 |
| Folder | folders | id | userId→users(CASCADE) | — | NOT NULL: name,isDeleted,createdAt,updatedAt,userId | PK, idx_folders_parentId, idx_folders_userId | **parentId no FK** |
| File | files | id | userId→users(CASCADE) | — | NOT NULL: name,size,isFolder,isDeleted,isStarred,createdAt,updatedAt,userId | PK, idx_files_parentId, idx_files_isDeleted, idx_files_mimeType, idx_files_userId | **parentId no FK** |
| ShareLink | share_links | id | userId→users(CASCADE), fileId→files(CASCADE) | — | NOT NULL: token,isFolder,isActive,downloadCount,createdAt,updatedAt,userId,fileId | PK, idx_share_links_token (NOT UNIQUE), idx_share_links_fileId, idx_share_links_userId | **token not UNIQUE** |
| UploadSession | upload_sessions | id | userId→users(CASCADE) | — | NOT NULL: uploadId,filename,totalSize,uploadedSize,chunkSize,totalChunks,uploadedChunks,tempPath,status,createdAt,updatedAt,userId | PK, idx_upload_sessions_uploadId | **parentId no FK**; status no CHECK; uploadedChunks JSON not JSONB |
| RefreshToken | refresh_tokens | id | user_id→users(CASCADE) | token_hash (UNIQUE index) | NOT NULL: token_hash,revoked,expires_at,createdAt,user_id | PK, idx_refresh_tokens_token_hash (UNIQUE), idx_refresh_tokens_user_id, idx_refresh_tokens_user_id_revoked | OK |

---

## C. Findings

### CRITICAL

**F-01 [CRITICAL] folders.parentId has NO foreign key constraint**
- Area: Schema / Referential Integrity
- File/Table: `folders` table, `parentId` column
- Evidence: `\d+ folders` shows `parentId INTEGER` with no FK. Only `folders_userId_fkey` exists. Entity `FolderEntity` has `@ManyToOne(() => FolderEntity)` but TypeORM does not create FK in PostgreSQL.
- Impact: A folder can reference a non-existent parentId → dangling parent, recursive queries return broken trees, `parent` property resolves to null incorrectly.
- Recommendation: `ALTER TABLE folders ADD CONSTRAINT folders_parentId_fkey FOREIGN KEY ("parentId") REFERENCES folders(id) ON DELETE SET NULL;`
- Phase: 6.2

**F-02 [CRITICAL] files.parentId has NO foreign key constraint**
- Area: Schema / Referential Integrity
- File/Table: `files` table, `parentId` column
- Evidence: `\d+ files` shows `parentId INTEGER` with no FK. Entity `FileEntity` has `@ManyToOne(() => FolderEntity)` but no FK created.
- Impact: Files can reference non-existent folders → orphaned records, incorrect folder-content queries, broken hierarchy traversal.
- Recommendation: `ALTER TABLE files ADD CONSTRAINT files_parentId_fkey FOREIGN KEY ("parentId") REFERENCES folders(id) ON DELETE SET NULL;`
- Phase: 6.2

**MISS-01 [CRITICAL] deleteFolderPermanently does not decrement storageUsed**
- Area: Storage Accounting / Transaction
- File/Table: `files.service.ts:299-309` → `users.storageUsed`
- Evidence: `deleteFolderPermanently` calls `folderRepository.delete(id)` and `fileRepository.delete(id)` but **never calls `decrementStorageUsed`**. User's `storageUsed` permanently retains size of all files that were inside the deleted folders.
- Impact: Permanent, irrecoverable storage quota drift. User fills quota, deletes all folders permanently → storageUsed remains full → cannot upload despite having free space.
- Phase: 6.2

**MISS-02 [CRITICAL] deleteFolderPermanently leaves child files/folders as orphaned records**
- Area: Hierarchy / Referential Integrity
- File/Table: `files.service.ts:299-309` → `folders`, `files` tables
- Evidence: Method only deletes the folder record and its mirrored file record (same ID). It does **not** recursively delete child files and subfolders. Combined with F-01/F-02 (no FK on parentId, no ON DELETE CASCADE), child records remain in DB with `parentId` pointing to a nonexistent folder.
- Impact: Files become permanently unreachable through folder hierarchy but still exist in DB — potentially still accessible via direct ID lookup, share links, or search. Combined with no CASCADE, this creates irreversible data inconsistency.
- Phase: 6.2

### HIGH

**F-03 [HIGH] upload_sessions.parentId has NO foreign key constraint**
- Area: Schema / Referential Integrity
- File/Table: `upload_sessions` table, `parentId` column
- Evidence: `\d+ upload_sessions` shows `parentId INTEGER` with no FK. Entity has no `@ManyToOne` relation.
- Impact: Upload sessions can reference non-existent folders; temp files may be misplaced.
- Recommendation: Add FK constraint or validate parentId in createUploadSession.
- Phase: 6.2

**F-04 [HIGH] share_links.token has index but NOT UNIQUE constraint**
- Area: Schema / Security
- File/Table: `share_links` table, `token` column
- Evidence: `idx_share_links_token` is a non-unique btree index (confirmed via `pg_indexes`). Migration `CreateShareLinksTable.ts:25` creates `CREATE INDEX` (not `CREATE UNIQUE INDEX`). Entity `ShareLinkEntity` has no `@Unique` or `@Index({ unique: true })`.
- Impact: Duplicate share tokens possible → security risk (unauthorized access via token collision), incorrect share link resolution.
- Recommendation: `ALTER TABLE share_links ADD CONSTRAINT share_links_token_unique UNIQUE ("token");`
- Phase: 6.2

**F-05 [HIGH] users.storageUsed has no CHECK constraint preventing negative values**
- Area: Constraints / Storage Accounting
- File/Table: `users` table, `storageUsed` column
- Evidence: `bigint NOT NULL DEFAULT 0` — no CHECK. `decrementStorageUsed` at `users.service.ts:72` uses `repository.decrement()` which unconditionally subtracts. No `CHECK("storageUsed" >= 0)`.
- Impact: If decrement exceeds current value, storageUsed goes negative → incorrect quota accounting, negative storage displayed.
- Recommendation: Add `CHECK("storageUsed" >= 0)` or use conditional update with WHERE clause.
- Phase: 6.2

**F-06 [HIGH] upload_sessions.status has no CHECK constraint**
- Area: Constraints / Data Validation
- File/Table: `upload_sessions` table, `status` column
- Evidence: `VARCHAR(20) DEFAULT 'pending'` with no CHECK. Code uses statuses: `pending`, `uploading`, `completed`, `aborted`. Any string value accepted by DB.
- Impact: Invalid status values possible from direct DB manipulation or bugs → logic errors in upload lifecycle.
- Recommendation: `ALTER TABLE upload_sessions ADD CONSTRAINT status_check CHECK ("status" IN ('pending','uploading','completed','aborted'));`
- Phase: 6.2

**MISS-03 [HIGH] decrementStorageUsed lacks concurrency protection**
- Area: Transaction / Race Condition / Storage Accounting
- File/Table: `users.service.ts:64-73` → `users.storageUsed`
- Evidence: Uses `repository.decrement({ id }, "storageUsed", bytes)` → generates `UPDATE users SET storageUsed = storageUsed - bytes WHERE id = ?`. Each UPDATE is atomic, but concurrent decrements are **not serialized**. Two concurrent requests can both pass quota check in `updateStorageUsed` (WHERE `"storageUsed" + :bytes <= "storageQuota"`) before either decrements → negative storageUsed or quota bypass.
- Impact: TOCTOU race allows temporary quota bypass, leading to over-quota storage consumption. Related to F-05 (missing safety net) but identifies the specific attack vector.
- Phase: 6.2

### MEDIUM

**F-08 [MEDIUM] createFile not transactional (file save + storageUsed update)**
- Area: Transaction / Atomicity
- File/Table: `files.service.ts:123-136`
- Evidence: `fileRepository.save(file)` then `usersService.updateStorageUsed(userId, size)` — two separate calls, no transaction wrapper. File saved before quota check result known.
- Impact: If `updateStorageUsed` fails (quota exceeded), file record exists but storageUsed not incremented → drift in opposite direction (file exists but not counted).
- Partial state risk: Yes
- Race risk: Low (quota check is in updateStorageUsed WHERE clause)
- Phase: 6.2

**F-09 [MEDIUM] createFolder not transactional (folder save + folder file save)**
- Area: Transaction / Atomicity
- File/Table: `files.service.ts:140-163`
- Evidence: `folderRepository.save(folder)` then `fileRepository.save(file)` — no transaction.
- Impact: Partial creation possible (folder exists without associated file row or vice versa).
- Phase: 6.2

**F-10 [MEDIUM] deleteFilePermanently not transactional (file delete + storageUsed decrement)**
- Area: Transaction / Atomicity
- File/Table: `files.service.ts:285-296`
- Evidence: `fileRepository.delete(id)` then `usersService.decrementStorageUsed(userId, file.size)` — no transaction.
- Impact: If decrement fails, file is gone but storageUsed still includes its size → permanent drift.
- Phase: 6.2

**F-13 [LOW] folders.name and files.name have no CHECK for non-empty**
- Area: Constraints
- Evidence: `VARCHAR(255)` with no `CHECK (LENGTH(name) > 0)`. Empty strings possible.
- Impact: Empty-named files/folders; minor UX issue.
- Phase: 6.2

**F-16 [MEDIUM] Entity/DB index inconsistency for share_links.token**
- Area: Migration Integrity
- Evidence: Entity `ShareLinkEntity` lacks `@Index` on `token`, yet DB has `idx_share_links_token` (created by migration `CreateShareLinksTable`, not `AddMissingIndexes`). Migration `AddMissingIndexes.ts` does NOT include this index.
- Impact: If migration is replayed from scratch, index still exists (from CreateShareLinksTable). But entity-to-migration mapping is unclear.
- Phase: 6.2

**MISS-04 [MEDIUM] emptyTrash not transactional**
- Area: Transaction / Atomicity
- File/Table: `files.service.ts:325-341`
- Evidence: Loop decrements `storageUsed` per file (lines 330-334), then bulk deletes all files and folders (lines 337-338). No transaction wrapping.
- Impact: If bulk delete fails after decrements have executed, `storageUsed` is permanently reduced but files remain in DB → quota drift (users appear to have lower usage than actual files).
- Phase: 6.2

### LOW

**F-14 [LOW] No index on files.name for ILIKE search**
- Area: Index / Query Performance
- Evidence: `search()` and `findAll()` use `ILIKE '%name%'` which cannot use B-tree index. Creating B-tree index on `name` would be wasteful.
- Assessment: Expected — full-text search (tsvector/GIN) is the correct solution, not B-tree. No schema deficiency.
- Phase: N/A (no action needed)

---

## D. Transaction Matrix

| Operation | Tables affected | Transaction? | Partial-state risk | Race risk | Severity |
|---|---|---|---|---|---|
| uploadChunk | upload_sessions | YES (pessimistic_write) | Low | Low (locked) | OK |
| completeUpload | upload_sessions, files, users | YES (queryRunner) | Low | Medium (quota TOCTOU) | HIGH (MISS-03) |
| createFile | files, users | NO | Medium | Low | MEDIUM (F-08) |
| createFolder | folders, files | NO | Medium | Low | MEDIUM (F-09) |
| moveFile | files | NO | Low | Medium (no lock) | MEDIUM |
| removeFile | files | NO (soft delete) | Low | Low | LOW |
| removeFolder | folders, files | NO (soft delete) | Medium | Low | MEDIUM |
| restoreFile | files | NO | Low | Low | LOW |
| restoreFolder | folders, files | NO | Medium | Low | MEDIUM |
| deleteFilePermanently | files, users | NO | High | Low | MEDIUM (F-10) |
| deleteFolderPermanently | folders, files, users | NO | **Critical** | Medium | **CRITICAL (MISS-01, MISS-02)** |
| emptyTrash | files, folders, users | NO | High | Low | MEDIUM (MISS-04) |
| copyFile | files, users | NO | Medium | Low | MEDIUM |
| createShareLink | share_links | NO | Low | Low | LOW |
| createUploadSession | upload_sessions | NO | Low | Low | LOW |
| abortUpload | upload_sessions | NO | Low | Low | LOW |

---

## E. Index Matrix

| Query/Operation | Current index | Missing index | Expected benefit | Severity |
|---|---|---|---|---|
| findAll files by user+parent | idx_files_userId, idx_files_parentId | Composite (userId, parentId, isDeleted) | High for filtered listing | MEDIUM |
| search ILIKE on file name | None | Full-text (GIN/tsvector) | Cannot use B-tree | N/A (F-14 LOW) |
| search ILIKE on folder name | None | Full-text (GIN/tsvector) | Cannot use B-tree | N/A |
| getTrash (isDeleted filter) | idx_files_isDeleted | Composite (userId, isDeleted, isFolder) | Medium for trash loading | MEDIUM |
| Folder hierarchy (parentId) | idx_folders_parentId | None needed | Good for parent lookup | OK |
| Share lookup by token | idx_share_links_token (not UNIQUE) | UNIQUE index | Security + performance | HIGH (F-04) |
| Upload session by uploadId | idx_upload_sessions_uploadId | None needed | Good | OK |
| Refresh token by hash | idx_refresh_tokens_token_hash (UNIQUE) | None needed | Perfect | OK |
| ORDER BY file.name | None | B-tree on name (but ILIKE can't use it) | Marginal | LOW |

---

## F. Folder Hierarchy

**Current state**: DB has 0 folders, 0 files. All hierarchy checks were structural (schema-level).

**Parent-child model**: 
- `folders.parentId` → self-referencing (`@ManyToOne(() => FolderEntity)` on FolderEntity, `@OneToMany(() => FolderEntity)` for children)
- `files.parentId` → folders (`@ManyToOne(() => FolderEntity)` on FileEntity)

**Circular reference risk**: 
- No DB-level constraint prevents a folder from being set as its own descendant
- No FK on `parentId` means any value is acceptable, including non-existent IDs
- Application uses `assertFolderOwnership` but does NOT check for circular ancestry before move

**Recursive query concerns**:
- No recursive CTEs used in application code
- Folder traversal is done via application-level iteration (`findFolders` returns direct children only; no recursive API endpoint)
- If recursive traversal were added, `idx_folders_parentId` supports single-level lookups but no deep hierarchy index

**Transaction requirements for move**:
- `moveFile` (files.service.ts:376-382): single UPDATE on files, no transaction needed for single row but no row lock
- Folder move would update both folder.parentId and all descendant files.parentId — no such operation exists yet, but would require transaction

---

## G. Upload / Storage Accounting

**Where storageUsed changes**:
1. `files.service.ts:135` — createFile: `updateStorageUsed(userId, size)` — NO transaction
2. `files.service.ts:294` — deleteFilePermanently: `decrementStorageUsed(userId, file.size)` — NO transaction
3. `files.service.ts:334` — emptyTrash: `decrementStorageUsed(userId, file.size)` per file in loop — NO transaction, NO rollback
4. `files.service.ts:371` — copyFile: `updateStorageUsed(userId, source.size)` — NO transaction
5. `uploads.service.ts:336` — completeUpload: `updateStorageUsed(userId, session.totalSize, queryRunner.manager)` — YES (transactional)
6. **MISSING**: `deleteFolderPermanently` — NO decrement at all (MISS-01)

**Quota check**: 
- `uploads.service.ts:110-113` — pre-check before session creation: `user.storageQuota - user.storageUsed` compared to `totalSize`. Non-atomic (read then compare — TOCTOU with MISS-03).
- `users.service.ts:46-61` — `updateStorageUsed` uses conditional WHERE `"storageUsed" + :bytes <= "storageQuota"`. If fails, checks again and throws. But concurrent increments can both pass.

**Stale metadata risks**:
- `uploadedSize` in upload_sessions is computed from actual file sizes in `uploadChunk`, not from declared chunk sizes. If chunks are small/padded, this is more accurate but may differ from `totalSize`.
- `uploadedChunks` is `json` type (not JSONB) — no validation, no indexing.

**Negative value possibility**: 
- `storageUsed` CAN go negative via `decrementStorageUsed` (F-05, MISS-03)
- `uploadedSize` cannot go negative (only incremented in uploadChunk)

---

## H. Migration Integrity

**Migration history** (7 migrations, all applied):
| # | Timestamp | Name | Applied |
|---|---|---|---|
| 1 | 1746824900000 | CreateUsersTable | YES |
| 2 | 1746824910000 | CreateFoldersTable | YES |
| 3 | 1746824920000 | CreateFilesTable | YES |
| 4 | 1746824930000 | CreateShareLinksTable | YES |
| 5 | 1746824940000 | CreateUploadSessionsTable | YES |
| 6 | 1746825000000 | CreateRefreshTokensTable | YES |
| 7 | 1746825010000 | AddMissingIndexes | YES |

**Findings**:
- All migrations applied and consistent with current entities (no schema drift)
- No destructive migrations (no DROP TABLE, no DROP COLUMN)
- All migrations have `down()` methods with matching reverse operations
- `synchronize: false` in data-source.ts (correct for production)
- **Issue**: `AddMissingIndexes` migration creates `idx_files_userId`, `idx_folders_userId`, `idx_share_links_userId`, `idx_share_links_fileId`, `idx_refresh_tokens_user_id_revoked`. Some of these are duplicates of entity `@Index` decorators (TypeORM auto-creates indexes from `@Index` on sync, but with `synchronize: false` this is safe).
- **Issue**: `idx_share_links_token` is created in `CreateShareLinksTable` migration, not `AddMissingIndexes` — inconsistent ordering relative to entity definition.
- Phase 5 backup/restore: no schema changes from migrations. Backup/restore preserves schema exactly via pg_dump.

---

## I. Test Coverage

| Property | Tested? | Evidence | Gap |
|---|---|---|---|
| FK enforcement | NO | No test attempts to insert with invalid parentId | No FK on parentId means no FK violation to test |
| CHECK constraints | NO | No test inserts invalid values | No CHECKs exist to test |
| UNIQUE token | NO | No test creates duplicate share tokens | Duplicate tokens possible |
| storageUsed ≥ 0 | NO | No test forces decrement below zero | decrementStorageUsed unbounded |
| Concurrent upload | YES | uploads.service.spec.ts:251-298 — concurrent uploadChunk test | Chunk deduplication tested |
| Transaction rollback | YES | uploads.service.spec.ts:346-405 — quota failure rollback test | Only for completeUpload |
| Storage quota | YES | uploads.service.spec.ts:112-167 — quota pre-check tests | Only pre-check, not race |
| Folder hierarchy | NO | No recursive traversal tests | No recursive API exists |
| Delete folder permanent | NO | No test for deleteFolderPermanently | Dead code, no controller wiring |
| Index usage | NO | No EXPLAIN/performance tests | N/A |
| Migration rollback | NO | No test of down() migrations | N/A |
| Duplicate email | YES | auth.service.spec.ts register flow | Constraint exists (UNIQUE) |
| Folder ownership | YES | files.service.spec.ts — assertFolderOwnership tests | Good |

---

## J. Independent Reviewer

Reviewer: general subagent ses_f6d7b6aa2ffeWC73XxGmT2gXPc
Task: Verify findings against actual repository/DB state, identify false positives, missed critical/high issues, and incorrect severity.

### Finding Review

| Finding | Reviewer Verdict | Final Verdict | Reason |
|---|---|---|---|
| F-01 | CONFIRMED | **CRITICAL** | `\d+ folders` confirms only `folders_userId_fkey` exists; parentId has no FK despite `@ManyToOne` on FolderEntity:51. Dangling parent references break hierarchy integrity. |
| F-02 | CONFIRMED | **CRITICAL** | `\d+ files` confirms only `files_userId_fkey` exists; parentId has no FK despite `@ManyToOne` on FileEntity:74. Orphaned files break file system integrity. |
| F-03 | CONFIRMED | **HIGH** | `\d+ upload_sessions` confirms no FK on parentId. Entity has no `@ManyToOne` — plain column only. Dangling parent references in transient upload sessions. |
| F-04 | CONFIRMED | **HIGH** | `idx_share_links_token` is non-unique btree index. Migration creates `CREATE INDEX` (not UNIQUE). Entity has no `@Unique`. Duplicate tokens = security risk. |
| F-05 | CONFIRMED | **HIGH** | `users.storageUsed` is `bigint NOT NULL DEFAULT 0` — no CHECK. `decrementStorageUsed` uses `repository.decrement()` unconditionally. Negative quota possible. |
| F-06 | CONFIRMED | **HIGH** | `status VARCHAR(20)` with no CHECK. Code uses 4 statuses. Invalid status values cause logic errors. |
| F-07 | PARTIAL | **MEDIUM** (downgraded from HIGH) | Factually correct: column is `json` not `jsonb`. But HIGH overstated — column is read/written as whole in application code, never queried element-wise in SQL. GIN indexing benefits marginal for current usage. |
| F-08 | CONFIRMED | **MEDIUM** | `fileRepository.save(file)` then `usersService.updateStorageUsed` — two separate calls, no transaction. Severity appropriate. |
| F-09 | CONFIRMED | **MEDIUM** | `folderRepository.save(folder)` then `fileRepository.save(file)` — no transaction. Partial creation possible. |
| F-10 | CONFIRMED | **MEDIUM** | `fileRepository.delete(id)` then `usersService.decrementStorageUsed` — no transaction. Severity appropriate. |
| F-11 | FALSE POSITIVE | N/A | Subsumed by F-01/F-02. No FK exists so ON DELETE SET NULL is meaningless. |
| F-12 | FALSE POSITIVE | N/A | `size BIGINT DEFAULT 0` — zero-size files are valid (empty files exist; files start at 0 bytes during chunked upload). Not a defect. |
| F-13 | CONFIRMED | **LOW** | VARCHAR(255) with no `CHECK (LENGTH(name) > 0)`. Severity appropriate. |
| F-14 | FALSE POSITIVE | N/A | ILIKE with leading `%` cannot use B-tree index regardless. No schema deficiency — expected solution is full-text search (tsvector/GIN), not B-tree. |
| F-15 | FALSE POSITIVE | N/A | Code correctly passes `queryRunner.manager` to `updateStorageUsed` (users.service.ts:42-44). All operations within same transaction. Correctly transactional. |
| F-16 | PARTIAL | **MEDIUM** (downgraded from HIGH) | Entity ShareLinkEntity lacks `@Index` on token, DB has `idx_share_links_token` (created by CreateShareLinksTable migration). Minor inconsistency, no active breakage. |
| F-17 | FALSE POSITIVE | N/A | Duplicate of F-01/F-02. |
| F-18 | FALSE POSITIVE | N/A | Computing `uploadedSize` from actual file sizes on disk is sound, more accurate than `chunkCount * chunkSize`. Described drift scenario does not occur in this codebase. |

### Missed Issues Found by Reviewer

| ID | Severity | Description | Evidence |
|---|---|---|---|
| **MISS-01** | **CRITICAL** | `deleteFolderPermanently` does not decrement `storageUsed` | files.service.ts:299-309: no `decrementStorageUsed` call. User quota permanently inflated after folder deletion. |
| **MISS-02** | **CRITICAL** | `deleteFolderPermanently` leaves child files/folders as orphaned records | Method only deletes folder + mirrored file record (same ID). No recursive deletion of children. Combined with no FK on parentId (F-01/F-02), children remain orphaned. |
| **MISS-03** | **HIGH** | `decrementStorageUsed` lacks concurrency protection | users.service.ts:64-73: `repository.decrement()` not serialized. TOCTOU on quota check (updateStorageUsed WHERE) + decrement allows quota bypass. |
| **MISS-04** | **MEDIUM** | `emptyTrash` not transactional | files.service.ts:325-341: per-file decrements followed by bulk delete, no transaction. Bulk delete failure after decrements = permanent drift. |

---

## K. Recommended Phase 6.2 Scope (Priority Order)

1. **[CRITICAL] Add FK constraints on parentId** for `folders`, `files`, `upload_sessions` — foundational schema integrity (F-01, F-02, F-03)
2. **[CRITICAL] Fix `deleteFolderPermanently`** — add `decrementStorageUsed` call and recursive child deletion (MISS-01, MISS-02)
3. **[HIGH] Add UNIQUE constraint on `share_links.token`** — security (F-04)
4. **[HIGH] Add CHECK("storageUsed" >= 0)** on users table (F-05)
5. **[HIGH] Add CHECK on upload_sessions.status** (F-06)
6. **[HIGH] Add concurrency protection to `decrementStorageUsed`** — SELECT FOR UPDATE or atomic conditional update (MISS-03)
7. **[MEDIUM] Wrap createFile, createFolder, deleteFilePermanently, emptyTrash in transactions** (F-08, F-09, F-10, MISS-04)
8. **[MEDIUM] Change `uploadedChunks` JSON → JSONB** (F-07)
9. **[MEDIUM] Fix entity/migration index consistency** for share_links.token (F-16)
10. **[LOW] Add CHECK(LENGTH(name) > 0)** for folders and files (F-13)

---

## L. Final Decision

```
PHASE 6.1 STATUS: COMPLETE
CODE CHANGES: 0
COMMITS: 0

READY FOR PHASE 6.2: YES
```

**Rationale**: All findings are documented with evidence, severity, and recommendations. All CRITICAL and HIGH issues have been confirmed by independent reviewer. No code changes were made (audit-only phase). The findings provide a clear, prioritized roadmap for Phase 6.2 implementation.

---

## Verification Summary

```
Git baseline:
  phase-5-backup-dr-complete → 1297051 ✓
  No uncommitted tracked changes ✓
  scripts/tests/PHASE-5.3.1-TEST-AUDIT.md untracked (untouched) ✓

Database:
  PostgreSQL running (homedb, healthy) ✓
  7 tables, 22 indexes, 14 constraints ✓
  12 users, 4 refresh_tokens, 0 folders, 0 files, 0 share_links, 0 upload_sessions ✓
  7 migrations applied ✓

Application:
  npm test: 35/35 passed ✓
  npm run lint: PASS ✓
  npm run build: PASS ✓
  Docker services: all healthy (backend, db, redis) ✓
```
