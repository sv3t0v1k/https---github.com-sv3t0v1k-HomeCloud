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
| Phase 11 — Backend/API Hardening | `COMPLETE` | 11.1–11.5; checkpoint `39dc751` |
| Phase 12 — Performance & Scalability | `COMPLETE` | 12.1–12.6; checkpoint `e408425` |
| Phase 13 — Frontend | `COMPLETE` | 13.1–13.7; checkpoint `0147a4c` |
| Observability & Operations — ненумерованный operational baseline | `COMPLETE` | checkpoint `cefff50`; [evidence](./observability-checkpoint.md) |
| Failure & Security Testing — ненумерованный checkpoint | `COMPLETE` | [evidence и границы](./failure-security-checkpoint.md) |

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

- **Production readiness — INCOMPLETE:** production offsite/operator qualification, final recovery/production deployment acceptance и public certificate lifecycle; TLS/proxy baseline см. checkpoint выше; incremental strategy — отдельное решение. Architecture & Release Gate см. checkpoint выше.

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
