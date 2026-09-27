# HomeCloud — единый roadmap

> Единственный источник истины по статусам и последовательности работ. Архитектурный обзор находится в [`PROJECT-STATE.md`](./PROJECT-STATE.md). Статус `COMPLETE` присваивается только после проверки результата и фиксации подтверждающего commit/checkpoint.

## Правила ведения

1. Перед началом работы проверить этот документ, `git status` и текущий commit.
2. Работать только в границах явно утверждённой задачи.
3. Не начинать следующий этап самостоятельно.
4. Не считать название commit или наличие незакоммиченных файлов доказательством завершения.
5. Сначала проверить acceptance criteria, затем обновить roadmap.
6. Новые номера Phase вводятся только отдельным решением владельца проекта. Ненумерованные задачи остаются backlog.

## Сводка статусов

| Область | Статус | Подтверждение |
|---|---|---|
| Phase 1–4 — security baseline | `COMPLETE` | `security-phase-4-batch-1` → `f37d323` |
| Phase 5 — Backup & Disaster Recovery | `COMPLETE` | `phase-5-backup-dr-complete` → `1297051` |
| Phase 6 — Database Integrity & Performance | `COMPLETE` | отчёты Phase 6.1/6.2/6.3 |
| Phase 7 — Storage & Filesystem Integrity | `COMPLETE` | commits серии Phase 7, итог зафиксирован в `c877829` |
| Phase 8 — Uploads & Large Files | `COMPLETE` | commits серии Phase 8 и Remediation B, итог зафиксирован в `c877829` |
| Phase 9 — Authentication & Sessions | `COMPLETE` | `83adfa1`, `11b27f2`, `744b27c`, `09dea37` |
| Phase 10 — Sharing & Access Control | `COMPLETE` | 10.1–10.8 подтверждены; checkpoint `08ea21f` |
| Phase 11 — Backend/API Hardening | `COMPLETE` | 11.1–11.5 COMPLETE |
| Phase 12 — Performance & Scalability | `COMPLETE` | 12.1–12.6 COMPLETE |

## Completed

### Phase 1–4 — Security baseline

Подтверждён только общий checkpoint `f37d323`. Детальный состав не восстанавливается по догадке.

### Phase 5 — Backup & Disaster Recovery

Реализованы fail-closed backup/restore, checksum и metadata sidecar, безопасное переключение storage, reconciliation, retention и health check после восстановления.

Авторитетные документы:

- [`PHASE-5.1-BACKUP-DR-ARCHITECTURE.md`](./PHASE-5.1-BACKUP-DR-ARCHITECTURE.md)
- [`backup-and-restore.md`](./backup-and-restore.md)

Acceptance criteria подтверждены checkpoint-тегом `phase-5-backup-dr-complete` (`1297051`) и профильными safety tests.

### Phase 6 — Database Integrity & Performance

Завершены аудит, transactional remediation и final DB hardening: FK, индексы, ограничения целостности и атомарный учёт квоты.

Авторитетные документы:

- [`phase-6.1-audit-report.md`](./phase-6.1-audit-report.md)
- [`phase-6.2-remediation-report.md`](./phase-6.2-remediation-report.md)

### Phase 7 — Storage & Filesystem Integrity

Завершены:

- транзакционные `createFile` и `createFolder`;
- безопасный порядок физического удаления после commit;
- защита от циклов папок;
- проверки непустых имён и соответствующая миграция;
- критические regression/failure tests.

Acceptance criteria: закрыты F-08, F-09 и F-13; ownership/path/name/cycle и DB/filesystem invariants покрыты тестами; итог зафиксирован в истории Phase 7 и commit `c877829`.

### Phase 8 — Uploads & Large Files

Завершены:

- JSON → JSONB для `uploadedChunks`;
- лимиты file/chunk/session;
- idempotent upload и completion;
- pessimistic quota locking;
- DB ↔ disk reconciliation;
- атомарная запись чанков и cleanup stale/orphan temp data;
- memory-safe MIME detection.

Acceptance criteria: F-07 закрыт; migration/entity/tests согласованы; quota, retry, stale cleanup и failure scenarios покрыты тестами; итог зафиксирован в `c877829` и последующих Remediation B commits.

### Phase 9 — Authentication & Sessions

Завершены threat model, session lifecycle, refresh rotation/reuse/revocation/concurrency hardening, cleanup истёкших токенов и синхронизация README/API.

Авторитетные документы:

- [`auth-threat-model.md`](./auth-threat-model.md)
- [`session-lifecycle.md`](./session-lifecycle.md)

Acceptance criteria: lifecycle и threat model документированы; expiry/reuse/revocation/concurrency покрыты regression tests; production-like startup/security configuration проверена.

### Phase 10 — подтверждённая часть

- **10.1:** access-control matrix и folder-sharing semantics — `22651e6`, документ [`PHASE-10.1-ACCESS-CONTROL.md`](./PHASE-10.1-ACCESS-CONTROL.md).
- **10.2:** fail-closed expiry check в password verification — `d23f793`.
- **10.3:** null-safe expiry enforcement в public lookup и download count — `a51ff17`.
- **10.4:** HTTP single-range streaming, ответы 200/206/416 и confinement storage path — `f45a00a`.

- **10.5:** `maxDownloads` — работа Kilo `9753c97`, исправления и приёмка `951cb2f`; [`отчёт`](./PHASE-10.5-REVIEW.md). 217 backend tests PASS, включая реальную PostgreSQL concurrency и migration up/down; lint/build PASS.

- **10.6:** публичный просмотр потомков общей папки — `60ac7bd`;
- **10.7:** безопасное scoped download потомка по `fileId` — `60ac7bd`;
- **10.8:** потоковое ZIP-скачивание папки, один слот на архив — `08ea21f`;
- dedicated IP/token/attempt rate limiting — `1b09424`, `635985a`, `13ea42e`;
- атомарная блокировка перебора password-protected share — `5257de9`;
- явная связь folder mirror через `folderId` и транзакционная синхронизация жизненного цикла папок — `4b4801f`, `dc1d341`, `9962192`.

Стабильный checkpoint активной работы: `08ea21f`.

Общий acceptance criteria Phase 10 — все пункты соблюдены и подтверждены commit `08ea21f`:

- access-control matrix и folder semantics документированы;
- все public endpoints применяют согласованную проверку состояния ссылки, password, expiry, ownership и file/folder policy;
- streaming, Range, download policy и revocation покрыты тестами;
- удалённый или недоступный объект не выдаёт содержимое;
- README/API reference соответствуют фактической реализации;
- итоговый commit проверен и roadmap обновлён.

## Phase 11 — Backend/API Hardening — COMPLETE

11.1 API Boundary Inventory — COMPLETE
- auth/users/health;
- files/folders/uploads/previews;
- sharing boundary;
- no confirmed authz/IDOR defects;
- no Phase 10 sharing regression.

11.2 Validation & Error Contracts — COMPLETE
- Auth: RefreshTokenDto/LogoutDto gained `@IsString`+`@IsNotEmpty`+`@MaxLength(1024)` (`abdc9f3`); valid `refreshToken` reaches handler → 200; missing/non-string/empty/over-limit/unknown → 400; global ValidationPipe unchanged (behavior verified empirically).
- Users: GET/PATCH `/users/me`, authenticated-but-absent, now `404` via `NotFoundException` instead of HTTP 200 `{error}` / 500; successful responses still strip `password` (`b258056`).
- Input bounds: `CreateShareDto.password` ≤1024, `CreateSessionDto.filename` ≤255, `UpdateProfileDto.avatar` ≤255; at-limit accepted, above-limit rejected (`f79666b`).
Regression: `auth.validation.spec.ts`, `users.controller.contract.spec.ts`, `dto-input-bounds.spec.ts`; `tsc --noEmit` clean.

11.3 HTTP Cache Boundary — COMPLETE
- Authenticated `GET /previews/:id/thumbnail` (JwtGuard) now serves `Cache-Control: private, max-age=86400` + `Vary: Authorization`; `public` directive removed (`259148b`). Preview generation/storage and public-sharing no-store policy unchanged.
- Regression: `previews.controller.spec.ts` asserts private policy, absent `public`, `Vary: Authorization`, and unauthenticated → 403 without reaching the service; `previews.service.spec.ts` unchanged.

11.4 Health Readiness Contract — COMPLETE
- 11.4A inventory: PostgreSQL required at startup (TypeOrmModule pool), storage root required (StorageService constructor `ensureDirectories`), Redis UNUSED (no client/import/consumer in `src/`).
- 11.4B implementation: `GET /api/v1/health` unchanged as process liveness; new `GET /api/v1/health/ready` returns 200 only when PostgreSQL `SELECT 1` succeeds **and** storage root exists + is directory + process has `W_OK`; otherwise 503 with `{ status:"not_ready", checks:{ database, storage } }`. No raw errors, credentials, filesystem paths or stack traces exposed. Redis not instantiated, not queried, not in readiness result.
- 11.4C orchestration alignment: backend Docker healthcheck switched from liveness `/api/v1/health` to readiness `/api/v1/health/ready` (interval 10s, timeout 5s, retries 5, start_period 30s). No startup cycle introduced — DB already `depends_on service_healthy` before the healthcheck runs; `storage_data` volume mounted before healthcheck executes. Redis removed from backend `depends_on` — zero runtime consumers; Redis service itself stays in compose (deferred separately). Frontend depends only on backend.
- Smoke verification (Docker available): rebuilt image `homecloud-backend:11.4b`; container on `homecloud_app_network` with `storage_data` mounted and `homeredis` **exited** → `/health` 200, `/health/ready` 200 `{"checks":{"database":"ok","storage":"ok"}}`. DB-unreachable container exits fail-closed during TypeORM bootstrap (expected). Smoke containers removed; production stack intact.
- Tests: `backend/src/common/health.controller.spec.ts` 7/7 — liveness unchanged/no-probe; ready→200; DB fail→503; storage missing→503; not-directory→503; not-writable→503; error/path/credential non-exposure. `tsc --noEmit` clean.
- Commit: `6d065f2` (11.4B), `919de64` (11.4C compose).

11.5 Final Gate & Documentation — COMPLETE
- focused regressions: `health.controller.spec` 7/7;
- full backend suite: 354 passed, 10 skipped, 0 failed (2 suites skipped — real-Postgres, gated by `HOMECLOUD_TEST_DATABASE_URL`);
- tsc: clean;
- lint: 0 errors (15 pre-existing warnings in `security.config.spec.ts`, outside Phase 11 scope);
- build: `nest build` clean, `dist/` gitignored;
- documentation reconciliation: roadmap updated, Phase 11 marked COMPLETE.
- Final Phase 11 checkpoint: `919de64`, `6d065f2`, `2c56709` chain verified; `git diff` scoped to Phase 11 only.

Phase 11 acceptance:
1. confirmed boundary validation gaps closed;
2. users error contracts normalized;
3. authenticated thumbnail cannot be publicly cached;
4. approved readiness contract implemented and tested;
5. no authz/IDOR or Phase 10 sharing regression;
6. full final gate PASS.

Explicitly deferred / not Phase 11 defects:
- dedicated per-user upload-chunk rate limiting pending evidence/policy;
- broad rate-limit redesign;
- performance/load testing;
- observability;
- frontend;
- production deployment/TLS/secrets;
- Phase 10 sharing redesign.

## Phase 12 — Performance & Scalability — COMPLETE

Goal: establish measurable backend performance characteristics, identify evidence-backed bottlenecks, remediate only confirmed critical issues, and verify improvements without weakening correctness/security guarantees.

### 12.1 Performance Baseline & Hot-Path Inventory — COMPLETE
- reproducible baseline scenarios and measurement methodology;
- DB/query hot-path inventory;
- filesystem/streaming hot-path inventory;
- uploads/downloads/listing/search/previews/sharing/ZIP;
- distinguish structural risks from measurement candidates;
- no optimization during inventory.

Accepted DB/query structural risks:
- unbounded list/search/trash/upload-session/share result sets;
- `cleanupExpiredSessions` materializes all active sessions globally then filters in JS;
- `cleanupOrphanedTempDirs` performs one DB lookup per temp directory (N+1).

Accepted filesystem/request-path structural risks:
- `completeUpload` whole-chunk synchronous `readFileSync`, bounded by configured chunk size;
- `uploadChunk`/`completeUpload` run O(totalChunks) synchronous `existsSync`/`statSync` reconciliation loops;
- thumbnail/image preview synchronous whole-file read, bounded to 5 MB;
- `StorageService` synchronous `existsSync`/`mkdirSync` on file-creation paths.

Already-streaming paths (no whole-file or archive buffering confirmed):
- public download/Range streams via `createReadStream` → `pipe(res)`;
- folder ZIP streams via `archiver` → `res`, members streamed individually.

Accepted measurement contract:
12.2: listing/search scaling; cleanup DB query count/timing; PostgreSQL query plans where justified.
12.3: upload reconciliation/assembly scaling; preview latency vs bounded input size; download/Range/ZIP baseline verification.
12.4: concurrent upload/locking behavior.

Methodology: fixed/reproducible environment; comparative before/after evidence; no invented production SLOs or arbitrary universal thresholds.

Policy: structural evidence may justify placement in remediation backlog; when practical, obtain baseline BEFORE implementation so 12.5 can verify before/after effect; indexes, full-text/trigram and lock redesign require measurement evidence; already-streaming download/Range/ZIP must not be redesigned without evidence.

### 12.2 Database Query Performance — COMPLETE

**Query/listing evidence**
- trusted 1k/10k/100k measurements established proportional growth for unbounded listing/search paths;
- search leading-wildcard `ILIKE` has confirmed scan-bound behavior;
- `findAll` at 100k showed parallel scan/external sort, while service-level cost is strongly affected by TypeORM hydration/result volume;
- `listUploadSessions` and `listUserShares` scale proportionally with returned cardinality.

**Remediation**
- `cleanupOrphanedTempDirs()` N+1 classification removed;
- production now loads referenced `tempPaths` once and performs in-memory set membership;
- DB failure remains fail-safe: delete nothing.

**Trusted AFTER evidence (committed harness, isolated benchmark DB, storage guard)**
- 1k: median 6.67 ms, 1 classification query, 900 referenced / 100 orphan / 100 deleted;
- 10k: median 45.36 ms, 1 classification query, 9000 referenced / 1000 orphan / 1000 deleted;
- DB/storage residual = 0;
- benchmark isolation PASS;
- normal resources untouched.
- Speedup against old cleanup timings NOT calculated.

**Evidence caveat**
- old cleanup timings are NOT trusted baseline because earlier harness had storage-isolation and wiring defects;
- old 1000/10000 query counts may be retained only as structural diagnostic evidence of the former N+1 algorithm.

**Explicit deferred / no-change decisions**
- pagination for `findAll`/`findFolders`/`listUploadSessions`/`listUserShares` deferred because it changes existing API/frontend contracts;
- search pagination deferred for the same contract reason;
- trigram/full-text search deferred: no evidence sufficient to justify that redesign in 12.2;
- `cleanupExpiredSessions` unbounded materialization deferred; FS side effects prevent unsafe bulk-delete shortcut;
- no additional DB index added because current evidence did not justify one.

**Final Gate**
- focused regressions: cleanupOrphanedTempDirs 7/7, bench cleanup 19/19;
- full backend suite: 379 passed, 10 skipped;
- typecheck PASS;
- lint PASS: 0 errors, 15 pre-existing test warnings;
- build PASS;
- diff-check PASS.

### 12.3 Filesystem & Streaming Performance — COMPLETE

**Findings and final decisions**
- A — `uploadChunk` reconciliation: `DEFER`. The real request path remains O(totalChunks): 100/1000/5000 chunks caused 101/1001/5001 `existsSync` calls and one `statSync`. Safe removal requires per-chunk schema/recovery and observable progress/API redesign; the current scan repairs arbitrary FS ↔ DB drift, while JSONB `uploadedChunks` remains O(N). The risk remains open.
- B — `completeUpload` backpressure: `FIX_CONFIRMED`. Before, `write(false)` was ignored and writable buffering grew to the full upload size. Since `2cfc61a5`, assembly awaits `drain`; trusted multi-chunk evidence bounded `maxWritableLength` to one 5 MiB chunk, drains matched false writes, and correctness was preserved.
- B-extra — `completeUpload` synchronous chunk read: `DEFER`. With the default 50 MiB `MAX_CHUNK_SIZE`, trusted one-chunk direct `readFileSync` median was 2.827 ms (range 2.733–2.998 ms), immediate delay 3.927 ms, and callback maximum about 4.073 ms. At 1 MiB the direct/immediate medians were 0.144/0.173 ms; at 5 MiB, 0.375/0.443 ms. The synchronous risk has not disappeared; it is accepted under the current cap and must be re-evaluated if the cap, storage, or runtime assumptions change (`4e612364`).
- C1 — physical file copy: `FIX_CONFIRMED`. The 100 MiB immediate delay changed from about 47.95 ms to about 0.019 ms, callbacks before service return from 0/20 to 20/20, synchronous copy calls from 1 to 0, with one async copy attempt; SHA, metadata, and quota remained correct (`3bf48fc9`, benchmark adaptation `16572dcb`). This confirms restored event-loop responsiveness, not a faster physical copy.
- C2 — copy metadata/quota consistency: `FIX_CONFIRMED`. The async physical copy precedes a short DB transaction; quota reservation and metadata save use the same transaction manager, with compensation and an explicit ambiguous-commit policy. In the PostgreSQL race, two 100-byte copies with quota 150 produced exactly one committed copy, `storageUsed = 100`, and consistent metadata/filesystem state (`e30536f7`).
- D — permanent deletion: `FIX_CONFIRMED`. For 1000 files, immediate delay changed from median 36.744 ms to 0.023 ms, callbacks before service return from 0/20 to 20/20; after remediation synchronous unlink calls were 0, async attempts equalled N, and maximum in-flight unlink was 1 (`5aec6c95`, benchmark adaptation `cd16f3c3`). Event-loop responsiveness was fixed; deletion remains sequential O(N), and no claim is made that total O(N) latency disappeared.

**Verified no-change streaming/preview paths**
- public download and single-Range responses stream file contents through `createReadStream`; HTTP regressions cover 200/206/416 and range boundaries;
- folder ZIP passes each member to `archiver` as a file stream; no whole-file or full archive payload buffering was found, although metadata, entry names, and library buffers still exist;
- text preview is streamed and truncated using a nominal 5 MiB threshold; image preview and thumbnail generation retain known synchronous whole-file reads only after rejecting files above 5 MiB;
- no new numeric latency, throughput, or RSS baseline is claimed for these paths. Phase 12.3 introduced no change here because inventory, code inspection, and regressions did not establish a critical remediation target.

**Final Gate**
- full backend suite, including isolated PostgreSQL tests and Phase 12.3 benchmark/harness suites: 43/43 suites, 491/491 tests passed;
- typecheck (`tsc --noEmit`), backend build, benchmark TypeScript compile, and compiled CommonJS `file-type` runtime regression: PASS;
- lint: 0 errors, 15 pre-existing `jest/expect-expect` warnings in `security.config.spec.ts`;
- `git diff --check`: PASS;
- independent review found no unresolved MUST_FIX in the agreed 12.3 scope; production code was unchanged by closure work.

**Scope boundary**
- deferred technical debt remains A and B-extra; neither is presented as fixed;
- startup/maintenance sync I/O is not automatically a defect;
- Phase 12 exclusions remained unchanged; Phase 12.4 was outside the 12.3 closure scope.

### 12.4 Large-file & Concurrency Baseline — COMPLETE
- shipped nginx verified for 32 KiB, 2 MiB, 25 MiB and 50 MiB chunks; the exact chunk endpoint required body-limit alignment and disabled proxy request buffering, while the backend remained authoritative above 50 MiB;
- controlled 25/50 MiB concurrency scenarios confirmed linear whole-memory multipart ingress growth, including about 509.59 MiB RSS growth at 50 MiB x4;
- full-file HTTP baseline confirmed 200 MiB healthy and 500 MiB correct for assembly, hash, accounting and cleanup, while exposing `MaxListenersExceededWarning` and O(N) listener accumulation at the shared destination;
- the observed about 200 ms event-loop maxima were attributed to benchmark lifecycle before upload; an upload-path production event-loop risk was not confirmed.

### 12.5 Evidence-based Remediation — COMPLETE
- nginx chunk-ingress alignment is fixed in `c1e908f`; disk-backed bounded multipart ingress is fixed in `94b60fc`, with 50 MiB x4 AFTER RSS growth about 64.36 MiB and cleanup/error/abort/boundary semantics preserved;
- completion uses one pipeline in `6429914`; the 600-small-chunk regression and 500 MiB requalification confirmed bounded listeners, absent warning, correct hash/accounting/cleanup and healthy event loop;
- macOS memory safety accounting is corrected in `36e100c`; the 15% reserve and swap/throttling fail-closed gate remain intact, with the Linux/cgroup path unchanged;
- first-class authenticated original-byte streaming with single-range resume is implemented and tested in `eaac6c4` with 200/206/416 behavior;
- the verified 30 GiB checkpoint associated with benchmark expansion `a7010f7` passed 615/615 HTTP chunks, assembly, exact 32,212,254,720-byte authenticated download, streaming SHA-256 `ac30e93301e9888820584f1f9819120bce53688bb950a77b78b17acb520a6ace`, late 206 resume, session/accounting, bounded-memory/event-loop safety and complete DB/filesystem/temp cleanup. The benchmark path was canonicalized for the macOS `/var` -> `/private/var` alias before the clean full rerun. Result: `READY_FOR_30GIB_PRODUCT_SUPPORT=YES`.

Known limits and deferred risks:
- 50 GiB has not been qualified;
- `uploadChunk` reconciliation retains O(N²)-style scaling and remains a deferred redesign risk; the successful 30 GiB qualification does not remove that architectural limitation;
- tracked operative defaults in the service, Compose and `.env.example` remain `MAX_FILE_SIZE=1 GiB` and `MAX_TOTAL_SIZE=10 GiB`; the 30 GiB qualification used runtime-only overrides, so deployment configuration is required to expose that limit;
- frontend/browser upload workflow was outside this backend qualification.

### 12.6 Performance Regression & Final Gate — COMPLETE

**Fresh final regression evidence**
- database orphan cleanup remained at one classification query for 1000 directories (6.07 ms median); the historical N+1 behavior did not return;
- multipart 50 MiB x4 passed the unchanged macOS safety gate with four overlapping requests, exact hashes/accounting, zero DB/filesystem residuals and 66,961,408-byte (~63.86 MiB) peak RSS growth, versus about 509.59 MiB before disk-backed ingress and about 64.36 MiB in the trusted remediation run;
- the canonical 500 MiB end-to-end cell passed 10/10 HTTP chunks, assembly, exact 524,288,000-byte authenticated full download (200), streaming SHA-256 `2c72cdc80600b910a6cad0a66a37fa6d4f3a86b7a14a31b23d582150ab9c052e`, late 1 MiB Range (206), accounting, session state and complete DB/filesystem/temp cleanup;
- the 500 MiB event-loop window was reset after session setup and covered upload through authenticated retrieval: p99 11.518 ms, maximum 15.663 ms. No `MaxListenersExceededWarning` returned, and focused high-chunk/backpressure regressions passed;
- the first diagnostic HTTP attempt used the macOS `/var` alias and correctly failed storage-root validation after `realpath` resolved `/private/var`; a canonical `/private/var` 200 MiB confirmation and the fresh canonical 500 MiB final cell both passed. This was a benchmark invocation error, not a production regression;
- the existing 30 GiB qualification record from 12.5 remains the product-scale evidence and was not redundantly repeated.

**Final gates**
- focused regressions: 22/22 suites, 238/238 tests passed;
- full backend suite: 46 suites passed, 4 skipped; 546 tests passed, 15 skipped;
- typecheck, backend build, benchmark TypeScript compile and `git diff --check`: PASS;
- lint: 0 errors, 15 pre-existing `jest/expect-expect` warnings in `security.config.spec.ts`;
- independent review: APPROVE; no production regression or unresolved MUST_FIX remained in the Phase 12 scope;
- disposable final-gate and diagnostic resources were removed after exact label verification; old unowned containers and the normal HomeCloud stack were not used or modified.

Phase 12 is complete. The known 50 GiB, O(N²) reconciliation, deployment-limit and frontend/browser boundaries recorded in 12.5 remain unchanged.

OUT OF SCOPE:
- observability/metrics infrastructure;
- broad security/failure injection;
- frontend performance;
- production deployment/TLS/secrets;
- backup performance redesign;
- Redis redesign/removal;
- unrelated refactoring.

## Planned

Эти направления подтверждены как необходимая будущая работа, но новые номера Phase им не назначены:

- **Backend/API hardening:** inventory endpoints/guards/DTO/errors, validation, authorization, CORS/headers/rate limits, dependency-aware health.
- **Observability & operations:** structured logs, correlation context, metrics, readiness/liveness и operational runbooks.
- **Failure & security testing:** failure injection, restore drill, IDOR/token/password/rate-limit abuse cases и dependency/container checks.
- **Frontend foundation и функции:** архитектура клиента, auth, file browser, uploads, sharing, previews, UX/accessibility, resilience и tests.
- **Production readiness:** topology, TLS, secrets, deployment/migration/rollback procedure, encrypted/offsite/incremental backup и release gate.

Ни одно planned-направление не разрешено начинать автоматически.

## Deferred

- Шифрование backup at rest.
- Offsite replication и incremental backup.
- Полноценное использование Redis либо удаление неподтверждённой зависимости.
- Удаление или подключение `uploads_data`.
- Full-text search вместо leading-wildcard `ILIKE` после появления performance evidence.
- Email verification, password reset и автоматическая ротация JWT secrets — не реализованы и не должны заявляться как готовые возможности.

Закрытые исторические findings F-07, F-08, F-09 и F-13 не возвращаются в deferred backlog.
