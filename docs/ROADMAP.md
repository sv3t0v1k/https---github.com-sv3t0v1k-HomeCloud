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
| Phase 12 — Performance & Scalability | `IN PROGRESS` | 12.1–12.6 PLANNED |

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

## Phase 12 — Performance & Scalability — IN PROGRESS

Goal: establish measurable backend performance characteristics, identify evidence-backed bottlenecks, remediate only confirmed critical issues, and verify improvements without weakening correctness/security guarantees.

12.1 Performance Baseline & Hot-Path Inventory — PLANNED
- reproducible baseline scenarios and measurement methodology;
- DB/query hot-path inventory;
- filesystem/streaming hot-path inventory;
- uploads/downloads/listing/search/previews/sharing/ZIP;
- distinguish structural risks from measurement candidates;
- no optimization during inventory.

12.2 Database Query Performance — PLANNED
- investigate query paths justified by 12.1;
- query shape, N+1, pagination and indexes;
- PostgreSQL query-plan evidence where appropriate;
- no speculative indexes;
- leading-wildcard ILIKE/full-text remains deferred unless evidence justifies remediation.

12.3 Filesystem & Streaming Performance — PLANNED
- synchronous filesystem operations on actual request hot paths;
- streaming/memory behavior for upload/download/Range/preview/ZIP;
- remediate only confirmed critical request-path bottlenecks;
- startup/maintenance sync I/O is not automatically a defect.

12.4 Large-file & Concurrency Baseline — PLANNED
- controlled large-file/concurrent scenarios;
- upload/download/Range/ZIP and relevant DB/quota contention;
- establish limits/degradation/failure behavior using reproducible methodology.

12.5 Evidence-based Remediation — PLANNED
- scope determined ONLY by confirmed 12.1–12.4 findings;
- no predetermined optimizations;
- preserve security/integrity/transaction/access-control contracts;
- focused regression/performance verification required.

12.6 Performance Regression & Final Gate — PLANNED
- repeat relevant baseline after remediation;
- before/after evidence;
- focused regressions;
- full backend suite;
- tsc, lint, build;
- documentation reconciliation;
- final Phase 12 checkpoint.

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
