# HomeCloud — единый roadmap

**Текущее состояние на 2026-10-13:** полный 50 ГиБ Browser E2E — **PASS** в IAB/localhost ([доказательства](./evidence/browser-50gib-qualification-20261006/report.md)); универсальное хранение и очередь с докачкой подтверждены; единственный Mac тестовый стек — `homecloud-preview`, основной `docker-compose.yml`, HTTP localhost:8080 и постоянные volumes; TLS не требуется для ежедневной работы. Safari 50 ГиБ — **UNQUALIFIED**, production — **NOT_READY / NO_GO**. Предпроизводственная версия `v0.9.0-local.1` не вводит новую Phase. [Контракт версии](./local-release-baseline.md).

Разделы выполненных Phase и датированные checkpoints ниже — история на соответствующую дату. Старые 1/10 ГиБ, Blob/100 МиБ, O(N²), BLOCKED/FAIL и временные TLS paths сохраняются как исторические границы; актуальное состояние задают позднейшие ненумерованные checkpoints и эта сводка.

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
| Phase 11 — Backend/API Hardening | `COMPLETE` | 11.1–11.5; checkpoint `39dc751` |
| Phase 12 — Performance & Scalability | `COMPLETE` | 12.1–12.6; checkpoint `e408425` |
| Phase 13 — Frontend | `COMPLETE` | 13.1–13.7; checkpoint `0147a4c` |
| Observability & Operations — ненумерованный operational baseline | `COMPLETE` | checkpoint `cefff50`; [evidence](./observability-checkpoint.md) |
| Failure & Security Testing — ненумерованный checkpoint | `COMPLETE` | [evidence и границы](./failure-security-checkpoint.md) |
| Универсальное хранение и докачка — ненумерованный checkpoint | `COMPLETE` | [IAB/Safari functional evidence](./evidence/universal-storage-upload-ux-20261005/report.md) |
| Единый локальный Docker baseline — ненумерованный checkpoint | `COMPLETE` | `bf97bef` / `f578030`; [runbook и preservation boundaries](./operations-runbook.md) |
| Полный 50 ГиБ IAB Browser E2E — ненумерованный checkpoint | `PASS` | `167498d`; [scope/evidence](./evidence/browser-50gib-qualification-20261006/report.md); Safari 50 ГиБ UNQUALIFIED |

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

Стабильный checkpoint Phase 10: `08ea21f`.

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
- Final Phase 11 checkpoint: `39dc751`; readiness и Compose changes подтверждены `6d065f2` и `919de64`.

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

Phase 12 is complete at checkpoint `e4084256b4c34053a4d74b27764b92d348a9a10d`. The known 50 GiB, O(N²) reconciliation, deployment-limit and frontend/browser boundaries recorded in 12.5 remain unchanged.

OUT OF SCOPE:
- observability/metrics infrastructure;
- broad security/failure injection;
- frontend performance;
- production deployment/TLS/secrets;
- backup performance redesign;
- Redis redesign/removal;
- unrelated refactoring.

## Phase 13 — Frontend — COMPLETE

Goal: превратить исходное React/Vite-приложение в минимальный рабочий клиент к подтверждённым backend-контрактам без преждевременной смены стека, усложнения state management или заявления неподтверждённой browser-scale поддержки.

Phase 13 начат отдельным решением владельца и завершён после итоговой регрессии 13.7, checkpoint `0147a4c0f846a4bb977b1153d8f52587215528d6`. Позднее отдельно выполнен owner-directed redesign; он не является новой Phase.

### Подтверждённые ограничения backend-контрактов

- дефект эффективного logout устранён в 13.2: refresh token находится через bcrypt comparison, а активный потомок rotation-chain отзывается транзакционно;
- authenticated original download использует bearer-token transport. Первый frontend-срез ограничивается небольшим файлом через контролируемый `Blob`-путь; поддержка 30 GiB в браузере, надёжный resume и прямой browser download не заявляются до отдельного решения по безопасному transport;
- `GET /uploads/sessions` не возвращает сессии в состоянии `uploading`; поэтому восстановление незавершённой загрузки после reload не входит в acceptance criteria 13.4 до исправления backend-контракта;
- httpOnly cookie transport отсутствует. Персистентное хранение refresh token в JavaScript-доступном storage имеет XSS-компромисс и не принимается молча: в 13.1 должен быть зафиксирован минимальный security-aware lifecycle, согласованный с текущим bearer/refresh API, без ослабления backend-модели.

### 13.1 Frontend Architecture & API Foundation — COMPLETE

Objective: сформировать минимальный клиентский фундамент поверх существующего React/Vite-приложения и реальных API-контрактов.

In scope:
- сохранить React Router и Axios, уже присутствующие в проекте;
- определить route shell и guards, единый API client, environment/base-URL contract и нормализацию ошибок;
- определить владельца auth/session state, refresh coordination и явную политику хранения токенов с учётом отсутствия httpOnly cookies;
- использовать React state/context для небольшого client state; production state library или cache layer вводить только при подтверждённой необходимости;
- зафиксировать базовые loading/error/empty patterns и test tooling для последующих подэтапов.

Out of scope:
- пользовательские file/upload/sharing features;
- визуальная полировка и новая design system;
- миграция framework/build tooling или добавление библиотек «на будущее»;
- изменение backend-контрактов.

Acceptance criteria:
- приложение конфигурируемо обращается к реальному API через один boundary;
- auth refresh/error handling не дублируются по компонентам, исключают бесконечные retry loops и различают network, validation, authorization и session-expiry cases;
- token-storage решение и его XSS/CSRF-компромиссы документированы в кодовой архитектуре и тестируемы;
- routing, API boundary и базовые состояния покрыты целевыми unit/component tests;
- новые зависимости добавлены только при доказанной необходимости.

Dependencies: текущие backend auth/error contracts и отдельное явное разрешение начать Phase 13; решение logout-блокера не требуется для старта 13.1, но требуется для закрытия 13.2.

Implemented and verified:
- единый Axios boundary использует same-origin `/api/v1` по умолчанию; неработающая runtime-передача build-time `VITE_API_URL` через Compose удалена;
- backend success envelope распаковывается централизованно, ошибки нормализуются в network/validation/authentication/authorization/rate-limit/server categories;
- access token хранится только в памяти, refresh token — в `sessionStorage`; XSS-риск, отсутствие httpOnly cookies и граница multi-tab явно зафиксированы;
- refresh rotation координируется single-flight, защищённые запросы повторяются не более одного раза, auth endpoints исключены из interceptor recursion;
- session epoch предотвращает запись токенов из устаревшего in-flight refresh после local session termination или замены сессии;
- SessionProvider выполняет bootstrap через refresh и `/users/me`; guard различает bootstrapping, anonymous, authenticated и временную недоступность без redirect flicker;
- добавлены Vitest, Testing Library и рабочая ESLint 9 flat configuration без production state/cache library.

Evidence: 3 frontend test files, 12/12 tests PASS; production build PASS; lint PASS; `git diff --check` PASS; independent review APPROVE после одного bounded correction cycle.

### 13.2 Authentication UX — COMPLETE

Objective: реализовать понятный login/session/logout lifecycle поверх foundation 13.1.

In scope:
- login, восстановление допустимой сессии после reload, access-token refresh и route protection;
- session expiry/revocation/401 handling без циклов и потери диагностируемости;
- logout UX после исправления эффективного backend logout;
- meaningful loading и error states.

Out of scope:
- регистрация, email verification, password reset и социальный вход;
- ослабление token transport ради удобства клиента;
- обход или frontend-маскировка дефекта backend logout.

Acceptance criteria:
- валидный пользователь входит и попадает в защищённую область;
- допустимая сессия восстанавливается после reload в пределах утверждённой token-storage модели;
- refresh rotation, истечение, revocation и 401 приводят к одному предсказуемому состоянию;
- после backend-исправления logout реально инвалидирует ожидаемую сессию и подтверждён интеграционным тестом;
- auth contract tests и ключевые component/e2e сценарии проходят.

Dependencies: 13.1; backend-исправление эффективного logout обязательно для статуса `COMPLETE`.

Implemented and verified:
- login подключён к реальному `/auth/login`, после выдачи token pair пользователь подтверждается через `/users/me` и попадает в защищённую область;
- invalid credentials, network/rate-limit/backend failures отображаются без создания фиктивной сессии; неуспешный `/users/me` атомарно очищает только что выданные токены;
- bootstrap после reload, single-flight rotation, terminal expiry/revocation и защищённые routes используют единый session lifecycle; expiry сопровождается явным сообщением на login screen;
- logout сначала получает согласованную актуальную access/refresh пару, затем вызывает backend без interceptor replay; локальная сессия очищается только после подтверждённой ревокации, а transient failure сохраняет её для повторной попытки;
- backend logout исправлен: raw token сопоставляется через `bcrypt.compare`, row блокируется в транзакции, rotation-chain проходится по user-scoped `replacedBy`, активный потомок отзывается conditional update;
- registration, email verification, password reset, social auth и file features не реализовывались.

Evidence: backend auth 24/24 tests PASS; full backend suite 46 passed / 4 skipped, 549 tests passed / 15 skipped; frontend 4 test files, 18/18 tests PASS; backend/frontend build PASS; frontend lint PASS; backend lint 0 errors и 15 pre-existing test warnings; `git diff --check` PASS; independent security review APPROVE.

### 13.3 File Browser — COMPLETE

Objective: дать аутентифицированному пользователю минимальную навигацию по собственному root и папкам.

In scope:
- root listing, folder navigation и отображение фактических file/folder metadata;
- loading, empty, not-found, forbidden и recoverable error states;
- обновление списка после операций первого вертикального среза;
- минимальные доступные keyboard/focus semantics, необходимые для функционального UX.

Out of scope:
- sharing, previews, trash и расширенные file operations;
- виртуализация, бесконечная прокрутка и frontend pagination до появления согласованного backend-контракта;
- косметическая полировка сверх функциональной читаемости.

Acceptance criteria:
- пользователь видит только собственный root, открывает вложенную папку и возвращается назад;
- empty/loading/error состояния различимы и не подменяют друг друга;
- navigation и access failures проверены component/integration tests против реальных response shapes;
- отсутствие backend pagination явно не маскируется неподтверждённой client-side масштабируемостью.

Dependencies: 13.1 и защищённая сессия из 13.2; существующие files/folders endpoints.

Implemented and verified:
- root и вложенные папки загружаются из реальных раздельных `GET /files` и `GET /files/folders` contracts; для navigation используется числовой `FolderEntity.id`, а bigint metadata обрабатывается как `string | number`;
- маршруты `/files` и `/files/folders/:folderId`, browser history и breadcrumbs поддерживают навигацию вперёд/назад; direct reload восстанавливает именную цепочку предков;
- добавлен узкий authenticated `GET /files/folders/:id`: только активная owned folder metadata, одинаковый 404 для отсутствующей/недоступной папки и строгая проверка положительного safe-integer id;
- loading, empty, recoverable error/retry, not-found и forbidden states разделены; частичный результат двух listing requests не показывается как полный каталог;
- stale navigation requests отменяются через `AbortController`; таблица, breadcrumbs, folder buttons и status/error states имеют базовую semantic/keyboard accessibility;
- file mutations, search, trash, sharing, previews, upload и download не реализовывались; pagination/scaling claims не заявлялись.

Evidence: backend folder/service targeted tests 52/52 PASS; full backend suite 47 passed / 4 skipped, 557 tests passed / 15 skipped; frontend 5 test files, 24/24 tests PASS; backend/frontend build PASS; frontend lint PASS; backend lint 0 errors и 15 pre-existing test warnings; `git diff --check` PASS; independent review APPROVE после одного bounded correction cycle.

### 13.4 Upload & Download — COMPLETE

Objective: замкнуть первый реальный file workflow: небольшая session/chunk/complete загрузка и authenticated original download.

In scope:
- create session → upload chunk(s) → complete с реальными limit/chunk/error contracts;
- retry/idempotency только в пределах подтверждённого backend behavior;
- отображение прогресса текущей вкладки и обновление browser listing после completion;
- небольшой authenticated original download через bearer request и контролируемый `Blob`-путь;
- обработка 401, 4xx validation/conflict, network interruption и отмены UI-операции.

Out of scope:
- reload-resume незавершённой загрузки, пока `GET /uploads/sessions` не возвращает `uploading` sessions;
- заявление 30 GiB browser support, large-download resume или универсального прямого download до transport decision;
- параллельный scheduler, offline queue и premature worker architecture;
- sharing/public download.

Acceptance criteria:
- небольшой файл загружается через реальный session/chunk/complete API, появляется в текущей папке и совпадает при обратном скачивании;
- повтор запроса обрабатывается согласно backend idempotency contract без ложного успеха;
- session expiry и значимые backend errors видны пользователю и не оставляют UI в фиктивном success state;
- интеграционный/e2e тест покрывает первый вертикальный срез без требования reload upload resume;
- browser-scale ограничения явно сохранены и не экстраполируются из backend 30 GiB qualification.

Dependencies: 13.1–13.3; transport decision нужен для расширения download beyond small `Blob`; backend contract change нужен для reload-resume.

Implemented and verified:
- однопоточная загрузка создаёт backend session для текущей папки, последовательно отправляет 10 MiB `File.slice()` chunks и вызывает completion без чтения всего файла в память;
- progress агрегируется по фактически переданным байтам и остаётся ниже 100% до успешного completion; отдельные состояния показывают подготовку, передачу и финализацию;
- chunk retry ограничен тремя попытками только для network/5xx; 4xx и completion автоматически не повторяются, а terminal failure и user cancel выполняют best-effort abort server session без подмены исходной ошибки;
- смена папки отменяет активную загрузку; успешный completion обновляет оба listing endpoint текущей папки и показывает новый файл;
- quota, size/chunk limit, MIME validation, session expiry, auth, network и server failures преобразуются в краткие пользовательские состояния;
- authenticated original download использует существующий bearer-aware Axios boundary и контролируемый `Blob`-путь с жёстким лимитом 100 MiB до запроса; 30 GiB browser support, resume и универсальный native streaming download не заявляются;
- backend не изменялся; runtime max chunk size по-прежнему не публикуется API, поэтому клиентский 10 MiB chunk явно согласован с текущим deployment contract и ошибки меньшего deployment limit остаются видимыми.

Evidence: frontend focused transfer tests 26/26 PASS; full frontend suite 7 files / 44 tests PASS; production build PASS; lint PASS; `git diff --check` PASS; independent review APPROVE после одного bounded correction cycle. Real-API smoke не выполнялся против постоянного normal stack без изолированных credentials/cleanup lifecycle; вертикальный workflow подтверждён Axios contract/component integration tests, а backend upload/download contracts ранее покрыты backend suites.

### 13.5 Sharing & Previews — COMPLETE

Objective: подключить существующие sharing и preview contracts после стабилизации основного приватного workflow.

In scope:
- создание/просмотр/отзыв доступных share links в пределах backend policy;
- authenticated previews/thumbnails с соблюдением cache/auth boundary;
- public share flows только по фактическим password/expiry/download-limit contracts.

Out of scope:
- redesign backend sharing policy;
- новые preview formats или обход существующих size limits;
- включение sharing/previews в первый вертикальный срез.

Acceptance criteria:
- owner/public states, expiry/password/revocation и preview access проверены интеграционными сценариями;
- приватные preview не получают публичное кеширование;
- ошибки политики не маскируются generic success/empty states.

Dependencies: 13.1–13.4 и стабильные sharing/preview backend contracts.

Delivered:
- file/folder share links создаются через owner-authenticated contract; доступны active-list, copy/open и revoke с expiry/password/max-download controls ровно в пределах backend DTO;
- owner share responses больше не сериализуют password hash, user record или storage path; folder listing/detail публикуют owner-scoped mirror `shareFileId`, необходимый существующей folder-sharing модели;
- authenticated text/image previews используют существующий 5 MiB backend boundary; unsupported MIME, too-large, missing, forbidden, auth и network/server states отображаются явно;
- preview requests отменяются при смене/закрытии, а image object URLs освобождаются детерминированно; публичное кеширование не добавлялось.

Evidence: focused frontend sharing/preview/browser tests 35/35 PASS; full frontend suite 9 files / 66 tests PASS; focused backend files/sharing tests 53/53 PASS; full backend suite 47 passed / 4 skipped, 562 passed / 15 skipped tests; frontend/backend production builds PASS; frontend lint PASS; backend lint PASS с 15 прежними `jest/expect-expect` warnings; `git diff --check` PASS; independent review APPROVE. Real-API smoke не выполнялся против постоянного normal stack без гарантированно disposable credentials/data и полного cleanup lifecycle.

### 13.6 Trash, File Operations & UX Resilience — COMPLETE

Objective: завершить повседневные file operations и устойчивость интерфейса без расширения backend scope.

In scope:
- доступные create/rename/move/copy/delete/restore/permanent-delete operations по фактическим endpoints;
- подтверждение необратимых действий, stale-state recovery и повторная синхронизация списка;
- accessibility essentials, responsive functional layout и согласованные error/loading/empty states.

Out of scope:
- новые backend operations;
- offline-first режим, realtime synchronization и визуальная полировка как самостоятельная цель;
- production observability infrastructure.

Acceptance criteria:
- поддерживаемые операции сохраняют корректную навигацию и обновляют server state;
- destructive flows требуют явного подтверждения и отображают частичные/полные failures;
- основные keyboard/focus/responsive paths проходят regression checks.

Dependencies: 13.1–13.4; фактические files/trash contracts; 13.5 не является обязательной зависимостью.

Delivered:
- добавлены отдельная корзина с датой удаления, restore, permanent delete и empty trash, а также create folder, rename/move/delete файлов и папок и copy файлов по фактическим backend-контрактам;
- folder lifecycle HTTP routes и operation DTO validation закрывают ранее недоступные backend-сервисы; restore файла или папки безопасно возвращает объект в root, если прежний parent больше не активен;
- listing state привязан к загрузившему его `folderId` и request generation: после A→B stale-строки немедленно неактивны, late A response не заменяет B, а mutation handlers используют явные item IDs и загруженный folder context;
- успешное удаление отражается локально до refetch, поэтому transient повторная загрузка не воскрешает удалённый элемент; ошибки остаются безопасными и доступны для retry;
- destructive actions требуют подтверждения, повторные мутации блокируются, terminal mutation 401 проходит через единый session-expiry lifecycle.

Evidence: focused frontend operations/trash/API/auth tests 34/34 PASS; full frontend suite 11 files / 81 tests PASS; focused backend lifecycle/DTO tests 54/54 PASS; full backend suite 48 passed / 4 skipped, 567 passed / 15 skipped tests; frontend/backend production builds PASS; frontend lint PASS; backend lint 0 errors и 15 прежних `jest/expect-expect` warnings; changed backend files formatted штатным Prettier; `git diff --check` PASS; independent review APPROVE после bounded remediation cycle.

### 13.7 Frontend Regression & Final Gate — COMPLETE

Objective: подтвердить рабочий frontend-срез без завышенных product/performance claims.

In scope:
- unit/component/integration/e2e regression matrix для auth, navigation, small upload/download и реализованных later features;
- production build/runtime configuration, nginx fallback/base-URL и browser smoke checks;
- security review token lifecycle, error leakage и private caching;
- сверка документации и roadmap с фактическим результатом.

Out of scope:
- объявление production readiness, TLS/secrets/deployment release gate;
- 30/50 GiB browser qualification без отдельного утверждённого harness и transport решения;
- backend performance requalification, не вызванная frontend-контрактом.

Acceptance criteria:
- agreed frontend suites, production build и browser smoke scenarios проходят;
- первый вертикальный срез воспроизводим в чистой сессии;
- logout и reload-resume claims делаются только после устранения соответствующих backend-блокеров;
- independent review подтверждает отсутствие contract mismatch, security regression и незаявленной реализации;
- roadmap обновляется по фактическим evidence, после чего Phase 13 может быть закрыт отдельным checkpoint.

Dependencies: завершённые применимые подэтапы 13.1–13.6 и устранение блокеров для заявляемых возможностей.

Delivered:
- итоговая регрессия повторно подтвердила auth/session, browser navigation, transfer, sharing/preview и trash/file-operation сценарии без расширения функционального scope;
- `PreviewModal` и `ShareDialog` получили минимальный modal focus lifecycle: начальный фокус, Escape, двунаправленный focus trap, восстановление trigger и безопасное поведение при исчезновении trigger или изменении доступных controls во время async mutation;
- production build/typecheck, lint, runtime/base-URL/nginx configuration и согласованность security/contracts подтверждены; прежние ограничения browser download/upload, MIME, anonymous sharing, search/bulk/drag-drop и 30 GiB browser support сохранены;
- real-API smoke не выполнялся без disposable credentials и безопасного изолированного cleanup lifecycle; постоянные данные и старые контейнеры не затрагивались.

Evidence: focused modal tests 27/27 PASS; frontend regression groups 19/19, 21/21, 13/13, 27/27 и 6/6 PASS; full frontend suite 11 files / 86 tests PASS; targeted backend contract gate 14 suites / 194 tests PASS; full backend suite 48 passed / 4 skipped, 567 passed / 15 skipped tests; frontend/backend production builds PASS; frontend lint PASS; backend lint 0 errors и 15 прежних `jest/expect-expect` warnings; `git diff --check` PASS; independent accessibility/consistency review APPROVE.

### Первый вертикальный срез

Целевой сценарий: пользователь открывает приложение → проходит bootstrap/login → допустимая сессия восстанавливается после reload → пользователь видит собственный root, открывает папку → загружает небольшой файл через реальный session/chunk/complete API → скачивает тот же оригинал через authenticated small-file path → получает понятные expiry/error states.

Ownership по подэтапам:
- 13.1: bootstrap, routing, API/error/session foundation;
- 13.2: login, session restore, refresh/expiry и защищённые routes;
- 13.3: root/folder listing и navigation states;
- 13.4: small upload/download и сквозной e2e scenario.

Границы первого среза были историческим scope 13.1–13.4: позднее в 13.5–13.6 добавлены sharing/previews/trash, а эффективный logout подтверждён в 13.2. Reload-resume upload, large browser download и 30 GiB browser support по-прежнему не заявляются.

После Phase 13 выполнен owner-directed redesign (`3f94b54dab41bfdf6b68921be847fd2e927e90b1`): русский UI, единая система токенов, локальные Manrope и JetBrains Mono, доступный drawer, список/плитка, контекстные меню, унифицированные диалоги и компактный менеджер загрузок. CSS compatibility-layer удалён. Frontend gate: 96/96 tests, lint и build PASS; independent review APPROVE. Backend quota arithmetic fix (`743b47e544b114970c777d3ca27222738e1aab11`) устранил строковую конкатенацию PostgreSQL BIGINT/SUM с проверкой недопустимых и небезопасных значений при сохранении транзакционной защиты; focused 178 PASS / 5 skipped, full backend 597 PASS / 15 skipped, build PASS, lint 0 errors, independent review APPROVE. Изолированный runtime подтвердил две загрузки по 125 bytes (`storageUsed = 250`), границы квоты и download 125 bytes (HTTP 200, точное совпадение байтов) при каноническом storage root `/private/tmp/...`. Auth, файлы/папки, upload/download, preview, sharing, trash/restore, Chromium 1440/768/390 и accessibility spot-check PASS; Safari/Firefox SKIPPED. `POST_FIX_CHECKPOINT: PASS`. Это проверка продукта в изолированном runtime, не production release gate.

### Observability & Operations — ненумерованный operational baseline

Статус: `COMPLETE`. Owner-approved направление существующего backlog, без новой Phase. Checkpoint `cefff5094d9824c924afe06bb06ed9281e4056d1`.

Добавлены JSON backend logs без сырых URLs/токенов/SQL parameters, `X-Request-Id` и изолированный async context, completion/error severity, bounded dependency-aware readiness для PostgreSQL и реального read/write storage root + `.tmp`. Redis остаётся некритичным и не используется backend. Prometheus metrics включают HTTP count/duration/in-flight и process memory/uptime; endpoint выключен без dedicated token, иначе Bearer protected. Compose продолжает проверять readiness; добавлена только необязательная metrics config. Frontend не менялся.

Evidence: focused 64/64 PASS; full backend 609 PASS / 15 SKIPPED (51 suites PASS / 4 SKIPPED); lint 0 errors / 15 прежних warnings; build/typecheck, Compose config, изменённое implementation formatting и `git diff --check` PASS с двумя задокументированными legacy formatting exceptions. Изолированный runtime: healthy 200, DB/storage degradation 503 при live 200, recovery 200, request IDs, защищённая text exposition и privacy marker scan PASS. Independent review APPROVE. `OBSERVABILITY_OPERATIONS_CHECKPOINT: PASS`.

[Эксплуатационный runbook](./operations-runbook.md) и [подробное evidence/ограничения](./observability-checkpoint.md). Внешние scrape/alerts/log shipping, distributed tracing и domain metrics не добавлены; production readiness не заявляется.

### Failure & Security Testing — ненумерованный checkpoint

Статус: `COMPLETE`. Owner-approved направление после Observability & Operations, без новой Phase. Реальные disposable backup/restore с проверкой строк/байтов/квоты, DB/storage failure и recovery, representative ownership/share/session/rate-limit abuse gates пройдены. Focused 34 suites / 453 tests и full 57 suites / 651 tests PASS без пропусков; build/typecheck/lint PASS. Independent review APPROVE. [Evidence, команды и ограничения](./failure-security-checkpoint.md). Phase 13 и observability checkpoint сохраняются COMPLETE; production readiness не заявляется.

### Production Readiness — Architecture & Release Gate

Ненумерованный checkpoint: COMPLETE; independent review APPROVE. Production topology contract, maintenance release/migration/rollback policy, early production config validation и narrow release helpers добавлены. Full backend 674 PASS; limited same-artifact recovery drill PASS. [Evidence и пределы](./production-readiness-checkpoint.md). Общий Production Readiness INCOMPLETE; на момент Architecture checkpoint TLS/proxy, secret lifecycle и offsite/encrypted backup оставались blocking follow-up; актуальное состояние TLS/proxy см. следующий ненумерованный checkpoint. Phase 13 и предыдущие operational checkpoints COMPLETE сохранены.

### Production Readiness — TLS / Proxy Boundary & Private Operational Exposure

Ненумерованный checkpoint: COMPLETE; independent review APPROVE. Standalone production ingress завершает TLS, HTTP308 и secure headers, не публикует frontend/backend; exact trusted socket peers и общий normalized clientIp защищают существующие process-local лимиты от forwarded spoofing. Health/readiness/metrics приватны, internal metrics дополнительно Bearer. Focused 54 PASS; full backend 59 suites / 686 tests PASS без skipped integrations; lint/build/typecheck/config gates PASS. Реальные два nginx, self-signed TLS, auth/upload/download/public share, rate-limit spoofing и Chromium fonts/CSP PASS. [Evidence и пределы](./production-readiness-checkpoint.md). Public CA lifecycle/конечный deployment не подтверждены. OVERALL_PRODUCTION_READINESS: NOT_READY; secret lifecycle, encrypted/offsite backup и final recovery/acceptance остаются blocking follow-up. Предыдущие COMPLETE checkpoints сохранены; новая Phase не создана.

## Planned

Эти направления остаются будущей работой без новых номеров Phase; завершённые backend hardening и frontend здесь не дублируются:

- **Многотомное хранение — OWNER_APPROVED; Schema & Legacy Compatibility COMPLETE (2026-10-10):** ненумерованный workstream перед deployment. [Архитектура](./multi-storage-architecture.md) и [evidence](./evidence/multi-storage-schema-20261010/report.md): minimal StorageLocation, logical File placement, fail-closed legacy backfill и resolver текущего `/storage`; 6 File сохранены, 5 физических backfilled, **0 bytes moved**. Backup/isolated migration/restore, full backend real PostgreSQL 65 suites / 858 tests, lint/typecheck/build и runtime smoke PASS; A/B/C reviews ACCEPT. Второй storage, workspace/finalizer/policy/admin/UI и mount changes не реализованы; дальнейшие checkpoints требуют отдельного разрешения. Production NOT_READY / NO_GO; true SSD→HDD 50 GiB qualification остаётся будущим gate.

- **Production readiness — INCOMPLETE:** production offsite/operator qualification, final recovery/production deployment acceptance и public CA/domain qualification; TLS/proxy baseline см. checkpoint выше; incremental strategy — отдельное решение. Architecture & Release Gate см. checkpoint выше.

Ни одно planned-направление не разрешено начинать автоматически.

## Deferred

- Incremental backup — отдельное решение после full-volume RPO/RTO qualification; encrypted/offsite baseline завершён ниже.
- Полноценное использование Redis либо удаление неподтверждённой зависимости.
- Удаление или подключение `uploads_data`.
- Full-text search вместо leading-wildcard `ILIKE` после появления performance evidence.
- Email verification, password reset и автоматическая ротация JWT secrets — не реализованы и не должны заявляться как готовые возможности.

Закрытые исторические findings F-07, F-08, F-09 и F-13 не возвращаются в deferred backlog.

## Production Readiness — Secret Lifecycle

Ненумерованный checkpoint: COMPLETE; independent review APPROVE. Инвентарь actual secrets, strengthened fail-closed validation, external-only CSPRNG generation, Docker context exclusions и vendor-neutral environment delivery завершены. JWT planned maintenance cutover явно инвалидирует старые tokens; DB/metrics rotation и rollback проверены на isolated compiled runtime. Focused106, full backend702 (59 suites, без skipped), generator1, lint/build/typecheck/Compose gates PASS. [Контракт](./secret-lifecycle.md), [evidence и ограничения](./production-readiness-checkpoint.md). Автоматическая JWT ротация не добавлена. OVERALL_PRODUCTION_READINESS: NOT_READY; encrypted/offsite backup, public certificate lifecycle и final recovery/acceptance остаются блокерами. Предыдущие COMPLETE checkpoints сохранены; новая Phase не создана. Рекомендуемый следующий блок — encrypted/offsite backup, автоматически не начинается.


## Production Readiness — Backup Productionization

Ненумерованный checkpoint: COMPLETE в границах реализации и isolated qualification; independent review APPROVE. Standard age encrypted full backups, verified vendor-neutral filesystem replication, atomic generation sets, retention7/30d (minimum2), safe failure signals и encrypted offsite restore поверх существующего v1 tooling. Focused34, legacy backup27, restore validation15 PASS; real offsite-authoritative disposable DB/storage drill и readiness200 PASS. [Контракт, evidence и ограничения](./backup-productionization.md). Production физический offsite mount/failure domain, schedule/alerts, key custody и full-volume RPO/RTO требуют operator validation. Incremental engine не добавлен. OVERALL_PRODUCTION_READINESS: NOT_READY; public certificate lifecycle, final recovery/acceptance и remaining operator/release checks остаются блокерами. Новая Phase не создана; следующий блок автоматически не начинается.


## Production Readiness — Public Certificate Lifecycle

Ненумерованный checkpoint: COMPLETE в границах native Linux lifecycle mechanics; independent review APPROVE. Certbot issuance/HTTP01 renewal contract, external-only snapshots/key0600, atomic activation, nginx validation/graceful reload/served fingerprint/rollback, configurable expiry JSON signaling завершены. Focused10/10 и native Linux daemon-side bind runtime PASS; public ACME protocol/CA issuance не упражнялись. Docker Desktop/macOS host shared bind не поддерживается из-за stale atomic symlink. [Контракт](./certificate-lifecycle.md), [evidence/ограничения](./production-readiness-checkpoint.md). OVERALL_PRODUCTION_READINESS: NOT_READY. Production CA/domain/bind/scheduler/alerts qualification, final recovery/acceptance и remaining operator/release checks остаются gates. Новая Phase не создана; предыдущие COMPLETE сохранены. Следующий рекомендуемый блок — final acceptance/go-live gate; автоматически не начинается.


## Final Production Acceptance / Go-Live Gate — 2026-10-01

Ненумерованная финальная кампания; новая Phase не создана. **OVERALL_PRODUCTION_READINESS: NOT_READY**. Fresh backend702/702 и frontend96/96, locked Docker builds, previous-backend compiled rollback и encrypted same-host offsite recovery PASS в явно ограниченных границах. Полный production deployment/TLS E2E остановлен occupied fixed proxy subnets; существующее preview не менялось. Public DNS/CA/target bind, operational scheduler/alert delivery, independent offsite/key custody/approved measured budgets и полный previous backend/frontend immutable-pair/operator acceptance остаются BLOCKING. Исправлен подтверждённый raw-URI/token logging дефект обоих nginx; raw proxy error diagnostics исключены, status/time и backend безопасные logs сохранены. [Матрица, raw evidence, классификации и operator checklist](./final-production-acceptance.md). Предыдущие COMPLETE checkpoints сохранены; запуск не разрешён, следующий workstream автоматически не начинается.

Independent final review: **NO_GO** по raw evidence. Дополнительно unresolved external-only secret input path legacy backup/restore versus checkout .env; workaround не применён. Dependency audit finding/exposure см. final acceptance.

## Universal Storage & Upload UX — ненумерованный checkpoint

Контракт HomeCloud — универсальное хранение файлов. Расширение, MIME и содержимое определяют возможность превью, но не допуск к хранению. В коде реализованы приём произвольных бинарных файлов, пакетный выбор, перетаскивание файлов в текущую папку и общая очередь. Передача ограничена двумя файлами одновременно, по одной части на файл. Доступны отдельные Pause / Resume / Cancel и продолжение после перезагрузки с повторным выбором исходного файла.

Историческое отложение докачки после перезагрузки в разделе 13.4 описывает прежний контракт. Теперь реализованы сведения о сессии и принятых частях с проверкой владельца, а также обнаружение неистёкших сессий в состояниях `pending/uploading`. Отпечаток локального файла рассчитывается по выборке до 3 × 64 КиБ; это не полный хеш файла. При продолжении проверяется SHA-256 каждой принятой части. Обычный выбор файла остаётся корректным вариантом для Safari; проверка хешей требует HTTPS или защищённого localhost.

Свежая браузерная приёмка — **PASS** в IAB и отдельном Safari; [доказательства и ограничения](evidence/universal-storage-upload-ux-20261005/report.md) зафиксированы в ненумерованном checkpoint. Произвольные типы и точные скачивания, batch, file DnD, Pause / Resume / Cancel, reload с повторным выбором, контролируемые429/503 runtime проверены. Backend825/825, PostgreSQL68/68 без пропусков, frontend218/218; независимые review ACCEPT. Перетаскивание папок, пустые файлы, автоматическое восстановление файловых дескрипторов и постраничное обнаружение сессий остаются будущими возможностями. Предел 1 ТиБ на файл является настраиваемым инфраструктурным ограничением.

Исторически, на дату checkpoint 2026-10-05, сертификат и ключ TLS-превью оставались под `/private/tmp`. Consolidation 2026-10-06 перенесла их в постоянный внешний operations root; полный 50 ГиБ IAB PASS выполнен позднее. В том checkpoint расположение не менялось. `50_GIB_BROWSER_E2E_STATUS = FAIL / REQUALIFICATION_REQUIRED`; повторный 50 GiB Browser E2E здесь не запускается.


## Docker Preservation + Consolidation + Auth Baseline (2026-10-06)

Ненумерованный owner-directed checkpoint; новая Phase не создаётся. Обычная локальная
разработка использует только `homecloud-preview`, production Compose + tracked local
override, existing external preview DB/storage volumes и durable runtime/TLS/challenge
paths вне repo и `/private/tmp`. Runtime frontend/ingress проверены и совпадают с принятыми
streaming/privacy конфигурациями. Local self-signed TLS не является public CA или
macOS atomic-rotation qualification. Не запускать legacy Compose и 50 GiB автоматически.

Все uncertain legacy/acceptance/bench volumes сохранены локальными readable архивами
с SHA256 и удерживаются `UNKNOWN/PRESERVE`; release/rollback images сохраняются.
До первого изменения все известные HomeCloud containers/networks уже отсутствовали;
исторические writable layers недоступны, их сохранность не доказана. Это отдельный
preservation gap, который работающий canonical stack не устраняет. Полный factual
report и manifest хранятся во внешнем operations path; secrets/passwords в Git отсутствуют.

Фактическая приёмка: четыре canonical services healthy; Compose/config и runtime
Nginx equality PASS; controlled force-recreate сохранил SQL/storage fingerprints,
существующих пользователей/файлы/папки/shares/20 миграций, новый dev account и pending
upload. Binary 2,097,289 bytes HTTP/HTTPS exact SHA256, разрешённый public text,
API pause/resume/cancel и cleanup PASS; storage снова5files/37021bytes. Dev account
обычный; квота100GiB назначена только ему оператором, registration default0/no quota
API остаётся ограничением. Backend757 + isolated PostgreSQL68 =825, frontend218,
lint/build, certificate10, hostname/Compose/diff checks PASS. Удалены только3
empty/unreferenced verification volumes. Независимый review: runtime и remaining
volumes ACCEPT; full historical preservation REJECT/UNVERIFIABLE. Полный checkpoint
не получает безусловный PASS из-за недоступных прежних writable layers.


## Полный 50 ГиБ Browser E2E — 2026-10-06

Ненумерованная квалификация по прямому разрешению владельца. 50_GIB_BROWSER_E2E_STATUS = PASS в границах IAB/localhost: фактическая загрузка 5120 частей через IAB, Pause/точечный обрыв/reload/reselect с сохранением 479 частей, скачивание всех 53687091200 байт менеджером браузера, три SHA-256 совпали. Cancel и cleanup подтвердили сохранность исходных данных. Независимый review ACCEPT; нерешённых CRITICAL/HIGH нет. [Доказательства и ограничения](evidence/browser-50gib-qualification-20261006/report.md). Единственный локальный стек homecloud-preview. Safari50 ГиБ, public CA/production и старые writable layers этим прогоном не квалифицированы.


## Multi-Storage — Storage Registry & Secure Resolver (MS-2)

Ненумерованный owner-directed checkpoint **COMPLETE** в разрешённом ограниченном
профиле. Immutable approved bindings, explicit marker bootstrap, exact Linux mountinfo,
process identity pin с retained marker FD и capability diagnostics интегрированы в legacy
consumers. Новые user storage locations заблокированы. **secureOpen=false**: Node20
path-based legacy операции сохраняют trusted exclusive-directory/check→open TOCTOU
ограничение; openat2 protection не заявляется. Container mount identity не доказывает
physical host disk; NFS/Desktop/host disappearance требуют отдельной qualification.

Final Linux backend66/884 с real PostgreSQL без skipped, lint/typecheck/build/bench compile,
canonical preview identity и API smoke PASS. Original10 tables и5files/37021bytes сохранились,
перенос0bytes; mounts и DB/frontend/ingress не менялись. Production **NOT_READY / NO_GO**.
[Архитектура](multi-storage-architecture.md), [операторский контракт](storage-registry-operations.md),
[MS-2 evidence](evidence/multi-storage-registry-20261010/report.md). MS-3 Workspace abstraction
не начинается автоматически; расширение доверия/user locations требует secure-open и host
identity qualification. 50 GiB здесь не запускался.


## Multi-Storage — Upload Workspace Architecture & Session Binding (MS-3A)

Ненумерованный checkpoint: **COMPLETE, 2026-10-10**, только legacy `/storage/.tmp`.
Minimal UploadWorkspace, immutable session FK/bridge и backfill21/21, schema11 tables/
22 migrations. Ingest/status/reconcile/finalize/cancel/expiry/recovery/cleanup используют
binding; missing/swapped workspace fail closed без fallback. Ingress/chunks одна legacy FS,
rename/EXDEV зависимость сохранена, bytes moved0. Проверенный fenced backup + `.tmp`
supplement, isolated DB migration/old-new restore, canonical counts/row/FS invariants PASS.
Full backend68 suites/917 tests, PostgreSQL9 suites без skips, lint/typecheck/build и runtime
pause/reload/resume/429/quota/expiry/recovery PASS; scoped independent reviews ACCEPT.
Обычный auth startup удалил12 подтверждённо expired refresh tokens; прочие source rows
сохранены. Процессное нарушение запрета чтения одной audit matching строки зафиксировано
в evidence; файл не изменён/staged/committed, три исходных untracked сохранены.

[Архитектура](multi-storage-architecture.md), [операторский контракт](upload-workspace-operations.md),
[evidence](evidence/upload-workspace-20261010/report.md). **secureOpen=false**, legacy TOCTOU
и `.tmp` anchor only process lifetime. Production NOT_READY / NO_GO. MS-3B Secure Workspace
Activation — следующий отдельный checkpoint; второй диск/cross-FS/политики/admin/UI,
50GiB run, push/tag/release не выполнялись. После MS-3A работа остановлена.


## Multi-Storage — Secure Workspace Activation (MS-3B)

Ненумерованный checkpoint: **BLOCKED / activation disabled, 2026-10-10**.
Actual Node20 Linux qualification подтверждает отсутствие callable descriptor adapter;
Multer ancestor swap записал5 test bytes через symlink, restart принимает replacement
workspace. **secureOpen=false**. tmpfs namespace/empty-dir refusal/EXDEV доказаны; physical
SSD/NVMe/removal/remount, Docker Desktop host disk и NFS/SMB **UNQUALIFIED**.

Production code/config/schema/mounts неизменны; only legacy workspace,21/21 bindings,
11tables/22migrations, original5files/37021bytes сохранены,0bytes moved. Full backend
68/921 real PostgreSQL без skips, targeted7/197, lint/typecheck/build PASS; EXDEV no-copy
rollback/retry и original `.tmp` return+explicit restart regression PASS. Four independent
reviews ACCEPT только disabled outcome, read-only canonical runtime identity/live200,
preview healthy; rollout не выполнялся.

[Architecture](multi-storage-architecture.md), [operator contract](upload-workspace-operations.md),
[MS-3B evidence/platform matrix/blockers](evidence/secure-workspace-activation-20261010/report.md).
Next gate: reviewed descriptor-safe lifecycle adapter, durable operator identity/recovery,
actual target mount qualification, secure ingress и DB admission. MS-4 cross-FS finalizer
не начат. Production **NOT_READY / NO_GO**. Остановились после MS-3B; no50GiB/push/tag/release.


## Multi-Storage — Secure Filesystem Boundary (MS-3B-R)

Отдельный remediation checkpoint **BLOCKED**, 2026-10-11. Standalone openat2/FD probe
прошёл 2000 попыток открытия при symlink swaps без записи вне root. Production ingress
race и restart `.tmp` substitution **не исправлены**. Native Node adapter и внешний
enrollment не внедрены. Реальные isolated tmpfs unmount/remount показали reuse полного
обычного mountID/dev/ino tuple; unique mount IDs различились. Физическая identity не доказана.

Полный backend: 68 suites / 921 tests, 9 real PostgreSQL suites без skips;
targeted 7/178, lint/typecheck/build PASS. Canonical hashes 11 таблиц и FS inventory
совпали, 21/21 bindings сохранены, исходные bytes не перемещались; runtime live HTTP200.
Два независимых scoped reviews приняли только blocked outcome. **secureOpen=false**,
additional activation disabled; physical SSD/NVMe, Desktop, NFS/SMB UNQUALIFIED.
[Design, probes и итоговый report](evidence/secure-filesystem-boundary-20261011/report.md).

Production **NOT_READY/NO_GO**; MS-3B не COMPLETE, MS-4 не начат. Остановились после MS-3B-R.
Следующий gate: реально используемый descriptor lifecycle, доверенный внешний enrollment,
workspace generation и qualification целевой физической платформы.
50GiB/push/tag/release/deploy не выполнялись.

## Multi-Storage — MS-3B-R1: остановка до реализации (2026-10-11)

**R1_GATE=BLOCKED**, preliminary STOP; adapter не реализован и новых test PASS нет.
Оба независимых scoped reviewer-запуска отклонены платформенной проверкой безопасности;
review verdict отсутствует. Доступная среда подтверждена как macOS + Docker Desktop
LinuxKit; native Linux target для обязательной отдельной qualification не определён.
Это внешние prerequisites, а не вывод о невозможности реализации adapter.
По owner stop-условию R2 не начат; MS-4 не начат. `secureOpen=false`, extras disabled,
Production NOT_READY / NO_GO. Production source/schema/config/runtime/data не изменены.
Исторические 68/921 и 21/21 не выдаются за новый прогон.
[Факты остановки, ограничения и варианты владельцу](evidence/secure-filesystem-adapter-r1-20261011/report.md).


## MS-3B-R1 — реализация сохранена, qualification BLOCKED (2026-10-11)

Прежняя остановка до кода снята решением владельца: разработка macOS/Docker Desktop,
целевой image Linux amd64, ARM64 не обязателен, ARMv7/32-bit исключены. Реальный
Linux Node-API descriptor adapter подключён к production Multer и upload lifecycle,
включая staging/chunks/read/hash/rename/delete/cleanup/recovery; finalizer publication
не переписан. Native LinuxKit arm64: ingress FAIL_CLOSED/outside0,2000concurrent attempts,
actual EXDEV без fallback, two-process UploadsService+PostgreSQL SIGKILL recovery PASS;
69suites/931tests с9PG suites PASS, lint0errors/15existing warnings, typecheck/build PASS.
Независимый scoped review завершён с limitations, все выявленные P1/P2 исправлены.

Docker linux/amd64 BUILD PASS, но Desktop amd64 RUNTIME FAIL_CLOSED/ENOSYS до upload
bytes. Точная причина ENOSYS не установлена; syscall downgrade или изменение Docker
не выполнялись. Владелец выбрал сохранить implementation/evidence до native amd64
host qualification. **R1_GATE=BLOCKED**, native Linux amd64 host UNQUALIFIED,
secureOpen=false, additional activation disabled, production NOT_READY/NO_GO.
R2 не начат; переход только после полного R1 PASS и отдельного решения. MS-4 не начат.
Durable enrollment/restart substitution остаются вне R1; canonical data/21bindings
сохранены. [Текущий R1 report/design/evidence](evidence/secure-filesystem-adapter-implementation-r1-20261011/report.md).


## MS-3B-R1Q — диагностика ENOSYS / native AMD64 qualification (2026-10-11)

**R1Q_GATE=BLOCKED / BLOCKED_ENVIRONMENT, R1_GATE=BLOCKED.** Локальный ENOSYS
экспериментально локализован в Rosetta guest→host syscall path до native openat2:
x86 raw/libc437→ENOSYS, ARM437 работает в том же контейнере; дополнительный
inherited deny437-filter меняет native результат на EACCES, guest остаётся ENOSYS.
Fresh AMD64 Docker build/ELF addon PASS; production Multer FAIL_CLOSED до bytes.
Настоящий Linux AMD64 host/VM в доступных local contexts отсутствует, qualification
UNQUALIFIED. Fresh ARM64 boundary10/10 PASS не заменяет target qualification.
Независимый scoped review COMPLETED_WITH_LIMITATIONS; canonical11table/FS hashes
и21/21bindings сохранены,4services healthy. secureOpen=false, extra workspaces disabled;
production NOT_READY/NO_GO. R2/MS-4 не начаты. Следующий owner action — разрешённый
existing native x86-64 host с disposable FS/PG для полного qualification; остановка после R1Q.
[Отдельный отчёт, evidence и требования](evidence/secure-filesystem-adapter-native-amd64-r1q-20261011/report.md).


## MS-3B-R1Q — native Linux AMD64 квалификация PASS (2026-10-11)

**Текущий статус: R1Q_GATE=PASS; R1_GATE=PASS в утверждённом descriptor-safe R1 scope.**
Прежние BLOCKED записи выше — история отдельных попыток. На Intel N100/Ubuntu22.04.5/
kernel6.8 обычный Docker builtin seccomp пропускает openat2; native rebuilt addon byte-identical,
production runner UID1001 PASS. Own ext4/PG: targeted10/194, persistent10/10,
full69/932 с9PG suites, lint0errors/15existing warnings, src typecheck/build/runtime PASS.
Symlink after-guard outside0;2000descriptor attempts с ancestor swaps outside0;actual EXDEV,
cleanup,100FDcycles, SIGKILL UploadsService+PG recovery и production Multer success HTTP PASS.
Единственный source delta — environment-independent cgroup unit test; production adapter
и collector неизменны. Полная image build выполнялась на Mac под AMD64 эмуляцией из-за
server DNS; addon rebuild и весь qualification runtime — native AMD64.
Canonical11table/FS hashes,21/21bindings,4canonical services и26server containers сохранены.
Own stand остановлен: контейнеры/сети/PGvolume удалены; source/config/logs/fixtures/imagecache оставлены.
Observed available RAM>=4.157GiB, OOM0; shared swap вырос~197MiB, zero-impact claim отсутствует.
Power loss, auth/controller adversarial HTTP и durable enrollment/R2 вне доказанного scope.
**secureOpen=false; additional activation disabled; production NOT_READY/NO_GO.**
R2/MS-4 не начаты; остановка после R1Q, продолжение только по отдельному решению владельца.
[Native qualification report/evidence](evidence/secure-filesystem-adapter-home-server-native-r1q-20261011/report.md).


## MS-3B-R2.1 — Persistent Identity Qualification, только исследование (2026-10-11)

**R2.1_GATE=BLOCKED.** Утверждённое владельцем исследование выполнено на домашнем
native Linux сервере. R1/R1Q PASS сохраняется в descriptor-safe scope. name_to_handle_at
из O_PATH и O_RDONLY FD работает на ext4 и read-only XFS root под штатным Docker
seccomp без capabilities. На ext4 подтверждены сохранение handle при process/container
restart/recreation, различение копии marker и replacement directory, фактический reuse
inode с изменившимся handle. Nested bind того же объекта сохраняет handle; NO_XDEV
возвращает EXDEV при crossing. Обычный mount ID повторён, unique ID изменился при restart.
Overlayfs root возвращает EOPNOTSUPP95; fallback не вводился. UID1001 проверен только
на raw capability; production ownership/enrollment не проверен. XFS writable workspace,
FS remount/reboot, physical replacement, stacked/live mutation и доверенная host→container
attestation остаются UNQUALIFIED. Full FS clone/same-UID/root adversary не закрыты;
process restart не доказывает power-loss durability.

Оба native research runner завершились rc0, 35 offline evidence checks PASS. Независимый
узкий review ACCEPT только BLOCKED/disabled outcome. Сведения о 26 исходных контейнерах
и полный host mountinfo совпали до/после, включая финальный follow-up; 10 собственных
probe-контейнеров удалены. В новых approved subdirs оставлены только собственные
project artifacts около 2.1 MiB и ext4 fixtures 40 KiB. Записей на XFS не было. Реальные
mounts/services/config/data не изменялись; resource snapshots не доказывают zero-impact.
Production code/schema/runtime/bindings неизменны.
**secureOpen=false; additional activation disabled; production NOT_READY/NO_GO.**
R2.2/MS-4 не начаты; integration/release/tag/push не выполнялись. Следующий предлагаемый
checkpoint — отдельно разрешённое продолжение R2.1: disposable ext4/XFS remount и
host attestation qualification. Privileged namespace tests требуют отдельного прямого
разрешения; реальные диски не размонтировать.
[Матрица, evidence, scope, ограничения и review](evidence/persistent-identity-r2-1-20261011/report.md).


## MS-3B-R2.1B — Mount Identity Qualification: ожидает ручного запуска (2026-10-11)

**R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.** Preflight подтвердил отдельную user/mount
namespace с UID0→host1000, но не initial-userns права для ext4/XFS. Обычный mountns
вход EPERM; sudo требует пароль. Пользователь отдельно разрешил собственные disposable
loop allocations и ручной однократный root-вход владельцем. Подготовлен проверенный
isolated-helper, source/launcher переданы в exclusive server test project; ещё не выполнен.
18 offline consistency checks PASS не являются filesystem qualification PASS.
26 исходных container records, полный host mountinfo и прежние R2.1 fixture metadata/content
равны в preflight; после загрузки source container records и mountinfo SHA прежние.
Новых loops/FS mounts/containers0. Независимый scoped AI review ACCEPT только historical
preflight BLOCKED; исправленный helper допускает manual run с явными ограничениями
trusted quiescent hs/root writers и own-loop identity/cleanup. Матрица ext4/XFS и
rprivate/attestation trust boundary design-only; fresh experiment evidence ещё нет.
**secureOpen=false; additional workspaces disabled; production NO_GO.** R2.2/MS-4
не начаты; production code/config неизменны, suites/lint/build не запускались.
[Отчёт, raw evidence, helper и независимые reviews](evidence/mount-identity-r2-1b-20261011/report.md).


## MS-3B-R2.1B — первый ручной отказ, recovery/v2 подготовлен (2026-10-11)

**R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.** Владелец выполнил первый root launcher.
Доказаны отдельная mount namespace и rprivate propagation до allocation. Создан
только own fresh regular ext4 image64MiB, mkfs на pinned FD rc0; loop8 allocation
осталась после guard отказа до первого FS mount. XFS и identity/remount/bind tests
NOT_RUN. Вероятная причина — literal BACK-MAJ:MIN guard против padded util-linux
output; actual root raw row первого RUN не сохранён. Cleanup ещё не завершён.
Исправленный numeric guard/raw journaling, fixed own-loop8 recovery и fresh v2
launcher прошли independent scoped review; source-only upload SHA совпал.
Recovery принимает лишь verified old image/loop mapping, отсутствие users и kernel
ENXIO после detach; mismatch/unknown→STOP. Owner manual root нужен повторно; агент
не получает пароль и не выполняет root вход. Recovery/v2 NOT_RUN, loop8 pending.
26 selected container records/full host mountinfo и old R2.1 fixtures равны; upload
records/mountinfo SHA прежние. 41 offline consistency/mock checks PASS не gate PASS.
Docker rprivate supplier mapping/attestation/reboot/physical uniqueness UNQUALIFIED.
**secureOpen=false; additional workspaces disabled; production NO_GO.** R2.2/MS-4
не начаты, production code/config неизменны, suites/lint/build не запускались.
Предыдущая запись о неисполненном helper — historical preflight, заменена follow-up:
[Отказ, raw evidence, pending cleanup, v2 и reviews](evidence/mount-identity-r2-1b-20261011/failed-run/report.md).


## MS-3B-R2.1B — изолированные ext4/XFS и источник Docker (2026-10-12)

**R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.** Ручной v2 helper завершился rc0.
Оставшийся собственный loop8 очищен; ошибка первого guard подтверждена: util-linux
возвращал BACK-MAJ:MIN с пробелами. В отдельной private mount namespace проверены
последовательно ext4 64MiB и XFS 384MiB. Подтверждены opaque handles из O_RDONLY FD
через новый процесс, различение копии marker и замены каталога, фактический inode
recycling (ext4: итерация1; XFS:120), nested/stacked bind и EXDEV, live replacement
с сохранённым FD, rw→ro→rw и чистый unmount/re-mount. После re-mount handle прежний,
unique mount instance новый. Обычные mount ID, namespace inode и st_dev повторяются.
Эти результаты относятся к root-пробнику; профиль обычного приложения на FS не квалифицирован.

Отдельный non-root пробник использовал новую user/mount namespace, tmpfs 4MiB и два
последовательных обычных контейнера: cap-drop ALL, NNP, Seccomp2, read-only, UID1000,
network none, memory96MiB, CPU0.1. Default rprivate consumer увидел исходный ext4 source
из namespace daemon при private supplier bind replacement, restart и recreation.
Docker client работал в initial host namespace; live mutation в namespace daemon не испытывалась.
Оба пробных контейнера удалены, tmpfs и bind stacks сняты. Собственные loop associations
освобождены с kernel ENXIO6; сохранены sparse images512MiB logical и source/evidence.
95 FS/runtime evidence checks,36 mapping checks,5 offline guard checks PASS.
Независимые scoped AI reviews принимают только BLOCKED и отключённую активацию.
Исходные26 container records, полный host mountinfo, boot/self namespaces и17 прежних
fixtures совпали с baseline, включая12октября07:50 Asia/Vladivostok. Собственных
контейнеров с test label нет; ещё7 checkpoint checks PASS. Zero-impact не заявлен.

Не квалифицированы XFS container continuity, live disposable remount в namespace
Docker daemon, доверенная attestation с lifetime/freshness/replay/anti-rollback и
reboot/clone/physical uniqueness. Numeric namespace inode+boot не доказывает lifetime;
нужен удерживаемый namespace FD или trusted observer epoch. Следующий исследовательский
checkpoint — эти blockers, с прежним запретом на physical host mount mutations и
production привилегии. **secureOpen=false; additional workspaces disabled; production NO_GO.**
R2.2/MS-4 не начаты. Production code/dependencies/config неизменны; suites/lint/build
не запускались. [Матрица, изоляция, cleanup, raw evidence и reviews](evidence/mount-identity-r2-1b-20261011/runtime-v2/report.md).


## MS-3B-R2.1C — Trusted Attestation Bridge, research-only (2026-10-12)

**R2.1C_GATE=BLOCKED; R2.1_GATE=BLOCKED.** Standalone ephemeral Ed25519 host signer
и обычный native AMD64 consumer подтверждают signed challenge/lease, fresh process
nonce/epoch, previous-epoch refusal при restart/recreation, replay refusal, revoke и
expiry с отказом следующего cooperative admission. Same-FD opaque identity ext4 own
directory и read-only XFS root сохраняется через3lifetimes; writable disposable XFS
workspace/remount не квалифицированы. Host directory substitution/ABA измеряет host
pinned FD и показывает ограниченность samples, не live daemon-host mount mutation.

32protocol model checks local/native,3native lifetimes rc0,126offline evidence checks
PASS, включая4Ed25519 envelopes. Independent scoped AI review принимает только
BLOCKED/disabled outcome. Signer authority-context overwrite устранён strict factory;
failed compiler/stdin attempts и historical V3 sources/evidence сохранены отдельно.
Trusted daemon/container namespace lifetime/topology/source→capability binding не доказан:
daemon namespace read EACCES; signed workload field consumer не проверяет. Durable
protected enrollment/revision/revocation/key distribution, TOCTOU serialization,
in-flight I/O/publication fencing и suspend-inclusive freshness остаются blockers.
Live daemon-host remount требует отдельного owner consent и не выполнялся.

Исходные26service records/full host mountinfo/17fixtures/boot/user/mount namespaces
равны precise baseline;9own CIDs удалены,4RUN labels пусты. Ручных mount/umount/loop
операций0; Docker временно создавал own mounts, host mountinfo после cleanup byte-equal.
Сохранены только own source/binaries/evidence и tiny fixtures (~4856KiB+80KiB allocated).
Zero-impact/power-loss/physical uniqueness/privileged-host guarantees не заявляются.
Production code/schema/dependencies/config не менялись; production suites/lint/build
не запускались. **secureOpen=false; additional workspaces disabled; production NO_GO.**
R1/R1Q historical PASS сохранён; R2.2/MS-4 не начаты, push/tag/release отсутствуют.
Остановиться после R2.1C. Следующий предлагаемый отдельно разрешаемый checkpoint —
disposable native AMD64 VM с собственным daemon для writable FS/live source mapping/
trusted observer/fencing, без передачи реальных host roots.
[Report, design, raw evidence, verification и review](evidence/trusted-attestation-r2-1c-20261012/report.md).


## SSD→HDD — подготовка Storage Registry и Upload Workspace, этап 1 (2026-10-12)

Отдельно разрешённая владельцем подготовка в рамках существующего multi-storage
workstream; новая Phase не создана. База: `4ba373275baf98344596176658c5ae54a3ca4b0b`.
Владелец подтвердил: обычные новые загрузки остаются legacy до согласования этапа 2.

Добавлены reserved SSD workspace identity и транзакционная additive migration
`1746825170000`, опциональный operator mount mapping и `trusted-upload` admission,
отдельная prepared SSD descriptor capability. Постоянные File placement/download
сохраняют только legacy storage (целевой HDD); старые sessions, chunks, paths,
quota и shares не перепривязаны. DB session guard остаётся legacy-only.

Никаких новых full-file RAM buffers, фоновых переносов или неограниченной
параллельности. Streaming/backpressure существующего upload пути не изменены.
RAM/RSS для 50+ ГБ и физический SSD→HDD цикл не квалифицированы.

Проверки: targeted 55/55 PASS; full backend 879 PASS / 71 FAIL. На исходном HEAD
861 PASS / те же 71 FAIL, статусы всех 932 старых тестов совпали. Lint 0 errors /
15 прежних warnings; build/typecheck PASS. Independent review: blockers отсутствуют
после исправления и PostgreSQL-проверки rollback migration.
[Отчёт и границы доказательств](evidence/ssd-hdd-stage1-20261012/report.md).
**Этап не помечается COMPLETE; production NOT_READY / NO_GO сохраняется.**
На macOS нельзя подтвердить Linux descriptor boundary и реальные mount.
Live сервер, Docker/VM, реальные диски, persistent volumes и данные не изменялись.
Операторский контракт: [Workspace](upload-workspace-operations.md#подготовка-ssd-workspace-этап-1-2026-10-12),
[Registry](storage-registry-operations.md#два-назначения-на-доверенном-сервере-подготовка-этапа-1).

После отчёта остановиться. Cross-FS finalizer, recovery, перенос данных и реальные
50 GiB испытания требуют отдельного разрешения владельца; автоматически не начинать.


## SSD→HDD — изолированный finalizer, только этапы 2.1–2.2 (2026-10-12)

Отдельно разрешённая реализация после этапа 1, база `84c6974`.
Добавлены internal unwired finalizer, bounded64KiB последовательная SSD chunk
assembly во temporary HDD file, manifest/chunk/whole SHA-256/size verification,
fsync и native no-overwrite HDD publication. Короткая PostgreSQL transaction
атомарно фиксирует File/quota/session; immutable durable operation journal и
sealed paginated manifest сохраняют intent/bindings для будущего recovery.
Все source chunks удерживаются; незавершённая операция блокирует новые finalizations.

Обычные uploads/API/session admission остаются legacy; SSD ingress не включён.
Новый runtime не зарегистрирован в providers/controllers/schedulers. Existing
legacy guards/rows сохранены; новая additive migration `1746825180000` проверена
up/down на populated isolated PostgreSQL schema. Live сервер, Docker/VM,
реальные диски/данные/volumes не затрагивались.

Targeted107/107, actual PostgreSQL25/25 PASS. Full947PASS/71FAIL; exact base
879PASS/те же71FAIL. Статусы всех950исходных test instances совпадают, новых
падений нет. Lint0errors/15прежних warnings, typecheck/build PASS.
Independent review: unresolved MUST_FIX в изолированном scope отсутствуют.
[Отчёт, crash windows, checks и review](evidence/ssd-hdd-stage2-20261012/report.md).

Crash около rename/fsync и ambiguous commit требуют дальнейшего recovery;
DB guards не заменяют API filesystem fencing. Portable doubles не квалифицируют
Linux native boundary/physical cross-FS/power loss/RSS на8GiB host/50+GiB.
Implementation/test checkpoint `daf4c94`; финальный documentation HEAD/status
записан в отдельном closure-state, ссылка в отчёте.
**COMPLETE не установлен; production NOT_READY / NO_GO сохраняется.**
Этап2.3 recovery/cleanup, SSD admission/routing и реальные испытания не начаты;
продолжение только после отдельного согласования. После2.1–2.2 работа остановлена.


## SSD→HDD — Recovery + Cleanup, только этап 2.3 (2026-10-12)

Отдельно разрешённый checkpoint на базе `70c6887`; implementation/test HEAD `8612f0d`.
Добавлены internal unwired replay persisted journal, authoritative primary DB outcome,
immutable HDD inode checkpoint, exact size/whole SHA-256 и повторная approved mount/source/
marker проверка, cooperative nonblocking kernel worker fence. Повторяемая очистка удаляет
только проверенные manifest-owned SSD chunks после committed DB receipt и HDD fsync;
затем атомарно освобождает reserved chunk rows/lifecycle guards/pending singleton.
Unknown artifacts и ambiguous outcomes сохраняют копии/barriers. Journal/manifest retained.

Targeted186/186PASS (actual PostgreSQL42/42); exact base full947PASS/71FAIL.
Первый candidate1025PASS/72FAIL: дополнительная timing race неизменённого legacy cleanup
воспроизведена на base диагностическим delayed-open test и не скрыта. Один повтор
неизменённого final candidate1026PASS/71FAIL; все1018 старых instances совпали сbase,
79новыхPASS. Lint0errors/15прежних warnings;typecheck/buildPASS. Независимый critical
review после исправлений: unresolved MUST_FIX нет. [Отчёт и crash windows](evidence/ssd-hdd-stage23-20261012/report.md).

Обычные API/session admission legacy, SSD ingress/routing выключен; runtime/startup/
scheduler wiring не добавлен. LiveDocker/VM/сервер, реальные диски/данные/volumes не менялись.
Linux native/reboot/power loss/50+ГБ RSS на8ГБ host не квалифицированы. Старые journal
без recorded inode fail-closed; несколько retained committed требуют reconciliation до
новой migration. API lifecycle fencing, admission/routing и реальные испытания отдельно.
**COMPLETE не установлен; production NOT_READY / NO_GO сохраняется.**
Работа остановлена после2.3; следующий этап не начат. Ждать согласования владельца.

## SSD→HDD — ограниченная API Integration и legacy race (2026-10-12)

Отдельно разрешённый checkpoint на базе `dcd6986b`; implementation HEAD `71cdc88`.
Legacy async-open cleanup race исправлена отдельно (`baaf67b`); durable hash/MIME contract
(`26ca22e`) и Nest DI/API runtime (`71cdc88`) подключены. New SSD sessions только при
явном flag ON с immutable expected whole SHA256; flag OFF по умолчанию, старые sessions legacy.
Bounded payload I/O вне DB transactions; shared kernel fence complete/chunk/cancel/expiry,
one-attempt replay и управляемый startup recovery, capacity/quota и MIME/preview metadata.

Native ARM64 Docker exact baseline1097/1097 и candidate1148/1148 PASS,0 skipped;
все1097 исходных statuses совпали,51 новых PASS. Full lint0errors/15 прежних warnings,
typecheck/build PASS. Real compiled JWT/Multer API15/15 checkpoints PASS: ext4 SSD fixture
→ disposable overlay HDD, response loss, startup recovery, exact download/Range, PNG/text preview,
оба capacity branches, реальный disconnect с удержанием fence, wrong-hash preservation.
Первый full compile failure benchmark fixture и amd64 ENOSYS diagnostic сохранены.
Independent review ACCEPT, unresolved MUST_FIX0. [Отчёт и ограничения](evidence/ssd-hdd-integration-20261012/report.md).

Mac baseline71 FAIL из2.3 здесь не объявляется исправленным; свежий native Linux полный
набор зелёный. Persistent config/preview DB/volumes не менялись, ON только внутри disposable
fixture process; mini-PC/physical disks/deployment не использованы. Activation отдельно:
client whole SHA256, historical journal reconciliation, target Linux/writer fencing/native rebuild,
реальные SSD/HDD/mount outages/SIGKILL/power loss/50+ГиБ/RSS на8ГБ остаются gates.
Global SSD writer serialization и one-process Nest restart оговорены в evidence.
**COMPLETE не установлен; SSD activation OFF / production NO_GO. Работа остановлена;
следующий шаг только после согласования владельца.**


## Frontend SSD Integration — ограниченный браузерный checkpoint (2026-10-13)

Отдельно разрешённый этап на exact `cbeca1d04ab543def8273bd7749d3458f3e5a362`.
Инкрементальный browser whole SHA256 с read cap2MiB, BigInt length/task yields/abort;
GET limits и lowercase64 expectedSha256 до SSD admission, legacy OFF без whole hash.
UI hash/upload/HDD finalization/completed, durable progress, pause/cancel/reselect/resume;
bounded503 jitter/Retry-After и capacity distinction, без ambiguous admission replay.
GET completed receipt не завершает финализацию сам: bounded idempotent complete POST
освобождает pending cleanup barrier, включая resume после lost response; отмена ограничена.

Final frontend targeted114/114, full278/278 PASS; exact baseline218/218, все218
старых statuses совпали,60 новыхPASS. Lint0, TypeScript/Vite buildPASS. Real Chromium
in isolated ARM64 Docker14/14: whole hash→SSD→HDD→exact UI download/Range, reload/resume,
cancel, bounded busy503/capacity, OFF legacy, baselineON400; postcommitHTTP500→2POST/
oneFile/onequota/cleaned receipt→следующая обычная SSD-загрузка PASS. Промежуточный
12-check gate и failed barrier audit сохранены; независимый review unresolved MUST_FIX0.
[Отчёт и точные ограничения](evidence/frontend-ssd-integration-20261013/report.md).

Backend production/config/migrations и постоянный preview stack не менялись. ON только
в disposable fixture process; mini-PC не использовался. Небольшие файлы не квалифицируют
50+ГиБ/RSS/физические диски/power loss; startup recovery и target enrollment отдельно.
Неаттестированные ранние anonymous volumes сохранены; blanket prune не выполнялся.
**COMPLETE не установлен; SSD activation OFF / production NO_GO. Работа остановлена
после этого checkpoint; следующий gate только по отдельному согласованию.**


## D1 — Backup & Restore Hardening (2026-10-13)

Отдельно разрешённый checkpoint на exact `5279d25a2c0c798f546e346a95d89c2f4c99ef4f`;
implementation/test HEAD `e8fd368`. Actual backend mount identity, external name/bind,
RO helpers/no implicit volumes; private SQL+migration preflight current13/historical
7–11 и13@518/519; pending SSD fail-closed, retained swap/staging, error/signal shell
fencing и owned migration cleanup, bounded readiness. Deployment/backend/migrations/
frontend/SSD activation не менялись. [Отчёт и ограничения](evidence/d1-backup-restore-20261013/report.md).

72 offlinePASS/3 explicit baseline-onlySKIP; current disposable12/12 и historical/
additional9/9PASS. Original scripts9 expected regression assertionFAIL;25 прежних
offline instances сохранилиPASS. Mac backend exact source956PASS/38FAIL/154SKIP;
backend src byte-equal, failures не исправлялись. Lint0errors/15 прежнихwarnings,
TypeScript/NestbuildPASS. Independent critical review unresolvedMUST_FIX0.

Final canonical records13existingcontainers/76volumes/10networks равны before/after;
12own fixtures cleanupPASS/residue0. Preview/live contents/DB/mini-PC не использованы.
Первый mixed-script runtime и tmpfs1777 historical failure сохранены, не gate.
Нет полного rollback/atomic whole switch/daemon bind inode proof; maintenancebarrier
обязателен, largeDB/payload/physicalSSD/HDD/reboot/powerloss/50+GiB не квалифицированы.
**COMPLETE не установлен; production NOT_READY/NO_GO и SSD activationOFF сохраняются.**
Работа остановлена послеD1. D2/D3 не начаты; следующий gate только по отдельному
согласованию владельца. Запрещённый audit file и чужие untracked не включены в работу.


## Рабочий Compose Mac/dev и подготовка Linux (2026-10-13)

По прямому уточнению владельца текущий Mac Docker — тестовый, важных данных нет;
вторая тестовая инфраструктура не создавалась. Exact base `c2edc270`.
Main Compose + optional Vite local override + Linux production override, рабочий env
шаблон, русские YAML comments, migrations-before-API, native Linux build, parsed
healthcheck и D1 env/mount/image compatibility. Existing DB/storage volumes сохранены.

Build/config/3healthy PASS; API22/22 (upload/download/Range/native/pending persistence),
IAB native download exactSHA256 PASS; Vite5173→API3000 PASS; probe7/7; offline73PASS/
3expectedSKIP (добавлен1config regression); frontend278/278; lint0errors/15existing
backendwarnings. Recovery/config и release fingerprint совместимость проверены; operator preflight13/13
и manifest31/31 PASS. Исторические release harnesses не requalified.
Два независимых review: unresolved MUST_FIX0. Backend full baseline
38FAIL/154SKIP не исправлен и не выдаётся за PASS. Stopped old TLS ingress и собственные
малые smoke данные сохранены; unrelated containers unchanged.
[Runbook](docker-compose.md), [отчёт и границы](evidence/compose-20261013/report.md).

Linux SSD DB/HDD storage — только подготовка. Физические disks/mini-PC/TLS/50+GiB/RSS,
SSD enrollment/recovery и destructive restore не проверены; SSD mapping отсутствует,
feature OFF. 520 seals legacy-only admission; будущий ON требует отдельного enrollment.
**COMPLETE не установлен; production NOT_READY/NO_GO. Остановиться после этапа.**


## D3 — подготовка Linux mini-PC (2026-10-13)

Разрешена только подготовка на Mac, исходный HEAD `69959de`. Production override:
SSD PostgreSQL/HDD `/storage` и `.tmp`, SSD upload OFF/manual/mapping absent.
Host preflight UUID/serial/exact mount/UID-GID/capacity/native architecture, restart=no
и systemd mount dependencies; DB placement/nested WAL guard, D1 recovery config и
операторская инструкция. 520 legacy-only не расширяется через env: reviewed forward
path отдельно, migration520 не менялась/не повторялась/не откатывалась.

30/30 isolated D3 fixtures, actual Compose merge/config, 12/12 D1 config regressions,
read-only native ARM64 scratch command и Python syntax PASS. Два независимых scoped
reviews: unresolved MUST_FIX0. Mac main/local Compose, backend Dockerfile, migration520
и данные сохранены; работающие Mac сервисы не менялись. Hardware/systemd Linux,
actual target architecture/build, SSD→HDD/recovery, offsite target restore, reboot/
powerloss/50+GiB/RSS на8GiB не проверены.
[Инструкция оператора и STOP](linux-mini-pc.md), [evidence](evidence/d3-preparation-20261013/report.md).
**COMPLETE не установлен; SSD OFF; production NOT_READY/NO_GO.** Подготовка D3
закончена; остановиться. Следующие аппаратные/SSD действия требуют отдельного задания.
