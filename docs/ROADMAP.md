# HomeCloud — единый roadmap

> **Источник истины:** этот документ описывает подтверждённое состояние проекта и утверждённую последовательность дальнейших фаз. Детальная реализация каждой фазы определяется отдельным промптом.
>
> **Текущий checkpoint:** `edf1d14` (`main`), 2026-09-12.
>
> **Важно:** создание этого roadmap не является разрешением на запуск Phase 7 или любой другой будущей фазы.

## Правила работы с roadmap

1. Перед началом любой фазы прочитать этот документ целиком.
2. Проверить актуальный `HEAD`, статус Git и статус нужной фазы.
3. Работать только в пределах явно утверждённой фазы и её DoD.
4. После завершения фазы обновить этот roadmap, добавить подтверждающие commit/tag и только затем менять статус на `COMPLETE`.
5. Не начинать следующую фазу самостоятельно.
6. `PLANNED` означает кандидата из backlog, а не автоматическое разрешение на старт. `BLOCKED` означает наличие явного блокера. `DEFERRED` означает намеренно отложенный finding или объём.

## Подтверждённое текущее состояние

### Git и этапы

- Phase 1–4 зафиксированы checkpoint-тегом `security-phase-4-batch-1`, указывающим на `f37d323` («Закрыты фазы безопасности 1–4, пакет 1»). В репозитории нет отдельной детальной документации по каждой из фаз 1–4; состав этих фаз не восстанавливается по догадке.
- Phase 5 Backup & Disaster Recovery завершена: checkpoint `phase-5-backup-dr-complete` указывает на `1297051`; подтверждение — `docs/PHASE-5.1-BACKUP-DR-ARCHITECTURE.md`, `docs/backup-and-restore.md`, `scripts/backup.sh`, `scripts/restore.sh` и последующие commits серии Phase 5.
- Phase 6 Database Integrity & Performance завершена:
  - **6.1 Audit — COMPLETE:** `docs/phase-6.1-audit-report.md`; аудит выполнен на baseline `1297051`.
  - **6.2 Transactional Remediation — COMPLETE:** `docs/phase-6.2-remediation-report.md`; отчёт зафиксирован в `e3cc126` и обновлён в `d492350`.
  - **6.3 Final DB Hardening — COMPLETE:** раздел Phase 6.3 в `docs/phase-6.2-remediation-report.md`; завершение зафиксировано в `edf1d14`.

### Архитектура и данные

- Backend: NestJS/TypeScript, TypeORM, PostgreSQL и Redis. Корневой модуль — `backend/src/app.module.ts`; точка входа и глобальные middleware — `backend/src/main.ts`.
- Основные backend-модули: `auth`, `users`, `files`, `uploads`, `sharing`, `previews`, `storage`, `common`.
- Хранилище: локальная файловая система через `StorageService`; пользовательские файлы находятся в `/storage`, временные файлы chunk upload — в `/storage/.tmp`.
- В репозитории 6 TypeORM entities и 11 migrations. Phase 6 добавила FK/индексы/check/unique-ограничения и атомарный учёт квоты.
- Тесты backend находятся в `backend/src/**/*.spec.ts`; Phase 6.2 документирует 62 пройденных теста. Frontend-тесты в текущем checkpoint отсутствуют.
- Docker Compose описывает `db`, `redis`, `backend`, `frontend`; для PostgreSQL, Redis и backend настроены healthchecks. Volume `uploads_data` объявлен, но к сервисам не подключён.
- Frontend в `frontend/src/App.tsx` остаётся placeholder-интеграцией: формы не отправляют запросы, список файлов не интегрирован с API.

### Backup, restore и безопасность

- Backup/restore реализованы как отдельные fail-closed скрипты с проверкой checksum, metadata sidecar, safe storage switch, reconciliation, retention и health check.
- Текущий backup локальный: шифрование at-rest, offsite replication и incremental backup не реализованы и явно отложены документацией Phase 5.
- Security baseline подтверждён commits серии Phase 1–4: startup validation secrets/credentials, JWT/refresh-token rotation, rate limiting, validation, CORS/Helmet, container hardening и healthchecks.
- Известные подтверждённые разрывы документации: README заявляет Socket.IO и resumable upload, тогда как в текущей архитектуре нет gateway/module и сквозного resume API; `uploads_data` не используется; health endpoint не проверяет зависимости.

## Deferred findings

Эти finding не считаются забытыми. Их статус и будущая фаза меняются только через обновление этого roadmap.

| Finding | Статус | Будущая фаза | Краткая причина |
|---|---|---|---|
| F-07 | DEFERRED | Phase 8 | `upload_sessions.uploadedChunks` использует JSON вместо JSONB. |
| F-08 | DEFERRED | Phase 7 | `createFile` имеет неатомарный DB/filesystem сценарий. |
| F-09 | DEFERRED | Phase 7 | `createFolder` имеет неатомарный DB/filesystem сценарий. |
| F-13 | DEFERRED | Phase 7 | Для имён файлов и папок отсутствует CHECK на non-empty name. |

F-04, F-06 и F-16 закрыты в Phase 6.3 и не входят в deferred backlog.

## Будущие фазы

### Почему такой порядок

1. **Phase 7** сначала устраняет фундаментальный контракт DB ↔ filesystem; без него небезопасно менять uploads, sharing и backup/restore.
2. **Phase 8** использует этот контракт для больших загрузок, quota и cleanup.
3. **Phase 9** утверждает identity/session модель, после чего можно вводить доступ по ссылкам.
4. **Phase 10** строит sharing поверх ownership, storage и session policy.
5. **Phase 11** закрепляет security/API invariant для всех уже определённых сценариев.
6. **Phase 12–14** оптимизируют, наблюдают и проверяют систему только после исправления корректности и безопасности.
7. **Phase 15** является production gate и не начинается без evidence предыдущих фаз.

## Phase 7 — Storage & Filesystem Integrity

**Статус:** `PLANNED`

**Цель:** сделать операции файлового дерева и метаданных согласованными, безопасными и проверяемыми; закрыть deferred findings по атомарности и ограничениям имён.

**Основные задачи:**
- Определить единый контракт DB ↔ filesystem для создания, переименования, перемещения, копирования и удаления.
- Реализовать rollback/compensation или транзакционный протокол для `createFile` и `createFolder`.
- Добавить проверки владельца, безопасного пути и non-empty name; запретить циклы папок.
- Сверить checksum, `storageUsed`, физические файлы и DB-записи; описать обработку orphaned/missing файлов.

**Исходные проблемы/findings:** F-08, F-09, F-13; open technical debts `TD-1`, `TD-4`. `MISS-01`, `MISS-02` и `MISS-04` закрыты в Phase 6.2; F-04, F-06 и F-16 закрыты в Phase 6.3 и не являются входом этой фазы.

**Зависимости:** завершённые Phase 5 и Phase 6; контракт backup/restore не должен нарушаться. Phase 8 зависит от результата Phase 7.

**Definition of Done:**
- F-08, F-09 и F-13 закрыты или явно переопределены в этом roadmap.
- Критические операции проходят failure/concurrency-тесты без расхождения DB и storage.
- Проверены ownership/path/name/cycle invariants, checksum и quota reconciliation.
- Добавлены миграции/тесты/документация в утверждённом scope; ROADMAP обновлён подтверждающим commit.

## Phase 8 — Uploads & Large Files

**Статус:** `PLANNED`

**Цель:** сделать загрузку больших файлов ограниченной, возобновляемой и безопасной для storage, quota и DB.

**Основные задачи:**
- Перевести `uploadedChunks` на JSONB и определить схему/индекс для надёжного учёта чанков (F-07).
- Ввести явные лимиты файла и chunk, проверку диапазона и итоговой суммы размеров.
- Реализовать очистку stale/pending temp-файлов и завершение сессии после сбоя.
- Уточнить API resumable upload: idempotency, повторная отправка chunk, completion и отмена.
- Согласовать upload completion с контрактом Phase 7 и файловыми операциями.

**Исходные проблемы/findings:** F-07; audit findings `TD-5`, `TD-2`; текущий `MAX_CHUNK_SIZE_BYTES = 100 MB`, `MAX_FILE_SIZE` по умолчанию не ограничен, temp cleanup отсутствует, сквозной resume API не подтверждён.

**Зависимости:** Phase 7 (storage/DB contract и quota); Phase 6 (DB constraints и tests). Phase 10 использует устойчивый file/storage контракт.

**Definition of Done:**
- F-07 закрыт; JSONB migration, entity и тесты согласованы.
- Лимиты, idempotency, stale-session cleanup и failure scenarios покрыты тестами.
- Загрузка не создаёт orphaned temp/final files и не обходит quota.
- API и README описывают фактическое поведение; ROADMAP обновлён подтверждающим commit.

## Phase 9 — Authentication & Sessions

**Статус:** `PLANNED`

**Цель:** привести жизненный цикл identity/session к явному безопасному контракту и подтвердить его тестами.

**Основные задачи:**
- Провести targeted security audit текущих login/register/refresh/logout/change-password сценариев.
- Унифицировать refresh-token rotation, reuse detection, revocation и обработку concurrency.
- Определить политики token lifetime, secret rotation, brute-force/rate limiting и invalid session cleanup.
- Явно зафиксировать, какие возможности не реализованы (например email verification/password reset), вместо расширения README без реализации.
- Добавить API и regression-тесты для повторного использования, отзыва, истечения и параллельных запросов.

**Исходные проблемы/findings:** baseline security Phase 1–4 уже реализован; отдельного актуального auth audit в репозитории нет. Подтверждённый код содержит refresh-token rotation и startup validation, но scope email verification/password reset не описан как готовая возможность.

**Зависимости:** Phase 6 (DB constraints и тестовая инфраструктура); Phase 10 зависит от утверждённой identity/session модели.

**Definition of Done:**
- Threat model и session lifecycle документированы.
- Refresh reuse/revocation/concurrency сценарии покрыты тестами.
- Секреты, CORS/rate limits и token lifecycle проверены в production-like конфигурации.
- README/API reference не заявляют нереализованные возможности; ROADMAP обновлён подтверждающим commit.

## Phase 10 — Sharing & Access Control

**Статус:** `PLANNED`

**Цель:** сделать public sharing управляемым механизмом доступа с явными правами, сроком действия, отзывом и безопасной выдачей содержимого.

**Основные задачи:**
- Определить модель доступа для файлов и папок: owner, public link, password, expiry, download policy.
- Уточнить semantics folder sharing и доступ к вложенным объектам.
- Проверить ownership при создании/отзыве ссылки и исключить доступ по чужому ID.
- Реализовать безопасный streaming/range download, rate limiting и корректный учёт download count.
- Добавить authorization/security-тесты для истёкших, отозванных, password-protected и folder links.

**Исходные проблемы/findings:** текущий sharing поддерживает token/password/expiry/download count и folder flag, но audit подтверждает отсутствие dedicated authorization model и полноценной folder traversal semantics; public download использует filesystem stream без единого access-policy слоя.

**Зависимости:** Phase 7 (ownership/path/storage contract), Phase 8 (large-file streaming), Phase 9 (identity/session policy).

**Definition of Done:**
- Access-control matrix и folder-sharing semantics документированы.
- Все public endpoints проверяют link state, password, expiry, ownership и file/folder policy.
- Streaming/range/download-count сценарии покрыты tests; revocation действует без перезапуска.
- README/API reference соответствуют реализации; ROADMAP обновлён подтверждающим commit.

## Phase 11 — Backend/API Hardening

**Статус:** `PLANNED`

**Цель:** устранить разрывы между заявленным API/security baseline и фактической runtime-поверхностью backend.

**Основные задачи:**
- Провести inventory всех endpoints, guards, DTO, error responses и external boundaries.
- Усилить validation, authorization, CORS/CSRF, security headers и rate-limit semantics для auth/upload/sharing.
- Реализовать dependency-aware health checks (PostgreSQL, Redis, storage) и согласовать readiness/liveness.
- Удалить или документировать неиспользуемые возможности и зависимости (включая `uploads_data` и Socket.IO claims).
- Синхронизировать README/API reference с фактическим контрактом; добавить regression tests для security-sensitive routes.

**Исходные проблемы/findings:** audit `TD-2`, `TD-3`; README заявляет Socket.IO/resumable upload, но gateway/module и resume endpoint не подтверждены; health endpoint возвращает только `ok`; frontend не имеет healthcheck.

**Зависимости:** Phase 9 (auth/session policy); Phase 10 (sharing access policy); Phase 6 (migration/test baseline).

**Definition of Done:**
- Endpoint/security inventory и threat model утверждены.
- Health checks отражают реальные зависимости; security-sensitive routes имеют tests.
- CORS/headers/rate limits/validation/error contract проверены в production-like среде.
- Документация не содержит неподтверждённых возможностей; ROADMAP обновлён подтверждающим commit.

## Phase 12 — Performance & Scalability

**Статус:** `PLANNED`

**Цель:** обеспечить предсказуемую производительность на растущем числе файлов, пользователей и операций без нарушения инвариантов Phase 7–11.

**Основные задачи:**
- Измерить baseline для list/search/upload/download, DB query time, filesystem operations и backup/restore.
- Оптимизировать индексы и запросы для user/parent/trash/search сценариев; рассмотреть full-text search вместо leading-wildcard `ILIKE`.
- Устранить синхронные filesystem операции из critical path там, где требуется streaming/backpressure.
- Проверить connection pool, concurrency, quota contention и large-file memory behaviour.
- Добавить performance/load tests и критерии деградации.

**Исходные проблемы/findings:** audit `F-14` отметил отсутствие full-text index как future improvement; текущий search использует `%query%`, recursive folder traversal отсутствует, filesystem вызовы синхронны, performance/load baseline не зафиксирован.

**Зависимости:** Phase 7 (storage contract), Phase 8 (large-file path), Phase 10 (sharing/download), Phase 11 (API/health contract).

**Definition of Done:**
- Утверждены измеримые performance budgets и baseline.
- Query plans, load tests и large-file scenarios не показывают критической деградации.
- Оптимизации не меняют authorization, quota, checksum или transaction semantics.
- Результаты и operational limits документированы; ROADMAP обновлён подтверждающим commit.

## Phase 13 — Observability & Operations

**Статус:** `PLANNED`

**Цель:** сделать состояние приложения, хранилища, базы и backup/restore наблюдаемым и операционно воспроизводимым.

**Основные задачи:**
- Определить readiness/liveness/metadata endpoints и проверку PostgreSQL, Redis, storage и backup state.
- Ввести структурированные logs с correlation/request context и едиными security/operation event categories.
- Добавить metrics для upload/session, storage/quota, sharing, backup age/failure и API latency/error rate.
- Настроить Docker healthchecks для frontend и operational services; удалить мёртвые volume/config claims.
- Описать runbooks для backup, restore, reconciliation failure, quota exhaustion, stale uploads и incident response.

**Исходные проблемы/findings:** audit `TD-3`; health endpoint не проверяет зависимости; backup имеет markers, но нет operational monitoring; frontend healthcheck отсутствует; `uploads_data` объявлен, но не подключён.

**Зависимости:** Phase 5 (backup/restore contract), Phase 7 (storage state), Phase 8 (upload state), Phase 11 (API/health contract).

**Definition of Done:**
- Health/readiness/metrics покрывают критические зависимости и имеют определённые alert thresholds.
- Logs/metrics не раскрывают secrets; operational events имеют владельца и runbook.
- Backup/restore/stale-upload/quota сценарии воспроизводятся по документации.
- Docker Compose и README отражают фактические volumes/healthchecks; ROADMAP обновлён подтверждающим commit.

## Phase 14 — Failure & Security Testing

**Статус:** `PLANNED`

**Цель:** доказать отказоустойчивость и security-инварианты на сценариях, которые не покрываются обычными unit/API tests.

**Основные задачи:**
- Провести failure injection для DB, Redis, storage, upload completion, sharing download и backup/restore.
- Выполнить restore drill на изолированной среде с проверкой checksum, reconciliation, migrations и health.
- Протестировать auth/session/sharing abuse cases: token reuse, expiry, revocation, IDOR, password guessing и rate-limit bypass.
- Проверить dependency/container/image security, secrets leakage, path traversal и archive/file handling.
- Зафиксировать security test matrix, known limitations и regression gates.

**Исходные проблемы/findings:** текущие backend tests в основном unit/API; audit отмечает отсутствие disk-failure/signal/retention-failure coverage для backup и отсутствие full restore/migration execution в `test-restore.sh`; security baseline Phase 1–4 не заменяет adversarial testing.

**Зависимости:** Phase 7–13 должны дать стабильные contracts, observability и runbooks; Phase 5 backup/restore является обязательным объектом drill.

**Definition of Done:**
- Критические failure/security сценарии воспроизводятся автоматически или по утверждённому runbook.
- Restore drill завершается успешно на clean environment и фиксирует evidence.
- Не осталось Critical/High findings без принятого mitigation/deferment в ROADMAP.
- Security/failure results и residual risk документированы; ROADMAP обновлён подтверждающим commit.

## Phase 15 — Production Readiness

**Статус:** `BLOCKED`

**Цель:** пройти production gate: безопасный деплой, управляемые секреты, TLS, отказоустойчивый backup и подтверждённый rollback/DR.

**Основные задачи:**
- Зафиксировать production topology, environment promotion, migration/deploy/rollback procedure и release checklist.
- Настроить TLS/reverse proxy, production CORS, secret management и запрет development exposure.
- Реализовать и проверить encrypted at-rest backup, offsite replication и incremental backup, отложенные Phase 5.
- Утвердить capacity/quota limits, SLO/error budgets, RPO/RTO и incident escalation.
- Провести production-like smoke/UAT, restore drill и security sign-off перед release.

**Исходные проблемы/findings:** Phase 5 явно отложила encryption at-rest, offsite replication и incremental backup; текущий Docker Compose описывает local/dev topology, а production deployment evidence в репозитории отсутствует.

**Зависимости:** Phase 5 и Phase 7–14; явные production target, backup policy, RPO/RTO и credentials должны быть утверждены до старта.

**Definition of Done:**
- Production topology, secrets, TLS, deploy/rollback и release gate документированы и проверены.
- Encrypted/offsite/incremental backup соответствует утверждённой policy; restore drill подтверждает RPO/RTO.
- Smoke/UAT, security review, capacity checks и operational runbooks имеют evidence.
- ROADMAP обновлён production checkpoint/tag; без этого статус остаётся `BLOCKED`.
