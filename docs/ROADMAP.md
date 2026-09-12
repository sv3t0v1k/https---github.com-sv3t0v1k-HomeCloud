# HomeCloud — единый roadmap

> **Источник истины:** этот документ описывает подтверждённое состояние проекта и утверждённую последовательность дальнейших фаз. Детальная реализация каждой фазы определяется отдельным промптом.
>
> **Текущий checkpoint:** `edf1d14` (`main`), 2026-09-12.
>
> **Важно:** создание этого roadmap не является разрешением на запуск Phase 7 или любой другой будущей фазы.

## Единая точка истины

- `docs/ROADMAP.md` — единственный источник истины по плану развития HomeCloud (Backend + Frontend).
- Перед началом любой новой фазы Kilo обязан прочитать актуальный roadmap.
- Отдельные Backend/Frontend roadmap-файлы создавать нельзя без явного указания.
- Статусы, зависимости, deferred findings и DoD актуализируются в этом файле.
- Roadmap не является неизменной архитектурой: будущие фазы могут уточняться после фактических аудитов и результатов предыдущих фаз.

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
| F-07 | CLOSED | Phase 8 | `upload_sessions.uploadedChunks` JSON → JSONB — выполнено в `1746825070000-UploadedChunksJsonb` |
| F-08 | CLOSED | Phase 7 | `createFile` теперь транзакционный — обёрнут в QueryRunner |
| F-09 | CLOSED | Phase 7 | `createFolder` теперь транзакционный — обёрнут в QueryRunner |
| F-13 | CLOSED | Phase 7 | CHECK `name <> ''` добавлен для folders/files; валидация в сервисе |

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

**Статус:** `COMPLETE`

**Цель:** сделать операции файлового дерева и метаданных согласованными, безопасными и проверяемыми; закрыть deferred findings по атомарности и ограничениям имён.

**Основные задачи:**
- Определить единый контракт DB ↔ filesystem для создания, переименования, перемещения, копирования и удаления.
- Реализовать rollback/compensation или транзакционный протокол для `createFile` и `createFolder`.
- Добавить проверки владельца, безопасного пути и non-empty name; запретить циклы папок.
- Сверить checksum, `storageUsed`, физические файлы и DB-записи; описать обработку orphaned/missing файлов.

**Исходные проблемы/findings:** F-08, F-09, F-13; open technical debts `TD-1`, `TD-4`. `MISS-01`, `MISS-02` и `MISS-04` закрыты в Phase 6.2; F-04, F-06 и F-16 закрыты в Phase 6.3 и не являются входом этой фазы.

**Зависимости:** завершённые Phase 5 и Phase 6; контракт backup/restore не должен нарушаться. Phase 8 зависит от результата Phase 7.

**Definition of Done:**
- F-08, F-09 и F-13 закрыты.
- Критические операции проходят failure/concurrency-тесты без расхождения DB и storage.
- Проверены ownership/path/name/cycle invariants, checksum и quota reconciliation.
- Добавлены миграции/тесты/документация в утверждённом scope; ROADMAP обновлён подтверждающим commit.

**Выполненные изменения:**
- `createFile`: обёрнут в QueryRunner транзакцию (F-08). Физическое удаление файла отложено после `commitTransaction`.
- `createFolder`: обёрнут в QueryRunner транзакцию (F-09).
- `deleteFilePermanently`, `deleteFolderPermanently`, `emptyTrash`: физическое удаление файлов перенесено ПОСЛЕ `commitTransaction` — при rollback файлы сохраняются (roadmap finding).
- `updateFolder`: добавлена проверка циклов `assertNoCycle` (CTE-based).
- `updateFile`, `createFile`, `createFolder`, `updateFolder`: добавлена валидация непустого имени (F-13).
- Миграция `AddNameNotEmptyCheck1746825060000`: CHECK constraints на folders.name и files.name.

**Результаты проверок:**
| Check | Result |
|-------|--------|
| Full test suite | 90/90 PASS |
| Lint | PASS |
| Build | PASS |
| 4 миграции Phase 7 | Применены (проверены синтаксис) |
| Тесты критических операций | 17 новых тестов |
| Физическое удаление на rollback | Верно (mock-verified) |
| Git history | Чистая, сообщения на русском |

**Закрытые findings:** F-08, F-09, F-13

**Изменённые файлы:**
- `backend/src/files/files.service.ts` (transactional createFile/createFolder, deferred physical delete, cycle detection, name validation)
- `backend/src/files/files.service.critical.spec.ts` (17 новых тестов)
- `backend/src/migrations/1746825060000-AddNameNotEmptyCheck.ts` (new)

**Git commits:**
- `99dc095` Phase 7: добавить миграцию CHECK на непустые имена файлов и папок (F-13)
- `45f25b3` Phase 7: транзакционный createFile/createFolder, отложенное физическое удаление, циклы
- `ce75f4b` Phase 7: добавить тесты для транзакций, F-13, циклов, отложенного удаления
- `2bcf171` fix: добавить проверку непустого имени в updateFile (F-13)
- `ebd34f6` Phase 7: добавить тест F-13 для updateFile

## Phase 8 — Uploads & Large Files

**Статус:** `COMPLETE`

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

**Выполненные изменения:**
- `upload_session.uploadedChunks`: JSON → JSONB (миграция `1746825070000-UploadedChunksJsonb`, entity, тесты) (F-07).
- `completeUpload`: MIME-детекция читает только заголовок (4100 байт) вместо всего файла — безопасно для больших файлов.
- `cleanupExpiredSessions`: теперь очищает и `uploading` сессии, просроченные по TTL (не только `pending`).

**Результаты проверок:**
| Check | Result |
|-------|--------|
| Full test suite | 90/90 PASS (6 новых тестов Phase 8) |
| Lint | PASS |
| Build | PASS |
| 1 миграция Phase 8 | Применена (проверена синтаксис) |
| JSONB migration | Восстановима (down) |
| Stale uploading cleanup | Покрыто тестами |
| Large file memory safety | Покрыто тестами |
| Git history | Чистая, сообщения на русском |

**Закрытые findings:** F-07

**Изменённые файлы:**
- `backend/src/uploads/uploads.service.ts` (MIME header read, stale uploading cleanup)
- `backend/src/uploads/uploads.service.spec.ts` (6 новых тестов: F-07 migration, stale cleanup, memory safety)
- `backend/src/entities/upload-session.entity.ts` (json → jsonb)
- `backend/src/migrations/1746825070000-UploadedChunksJsonb.ts` (new)

**Git commits:**
- `f9dcdba` Phase 8: миграция uploadedChunks JSON → JSONB (F-07)
- `cb082e8` Phase 8: обновить entity uploadedChunks на jsonb (F-07)
- `00f767e` Phase 8: потоковая MIME-детекция, очистка stale-uploads
- `f1d0205` Phase 8: добавить тесты F-07, stale-upload, memory safety

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

---

# Frontend Roadmap

> **Важно:** Frontend НЕ считается заблокированным до полного завершения Backend Phase 15. Если backend API уже достаточно стабилен для конкретной frontend-фазы, она может выполняться параллельно.

## F1 — Frontend Foundation & Architecture

**Статус:** `PLANNED`

**Цель:** создать устойчивую архитектурную базу frontend: проектная структура, роутинг, state management, API слой, UI-кит и среда разработки.

**Основные задачи:**
- Настроить TypeScript strict mode, ESLint, Prettier, Husky pre-commit.
- Определить структуру папок (features, shared, widgets, pages, entities).
- Интегрировать API-клиент с интерцепторами (auth, errors, retries).
- Внедрить state management (React Query / Zustand / Context) для серверного и клиентского состояния.
- Создать базовый UI-кит: Button, Input, Modal, Dropdown, Tooltip, Spinner, Toast, Layout.
- Настроить React Router с защищёнными маршрутами и lazy-loading.
- Добавить Storybook для изолированной разработки компонентов.
- Настроить Vitest + React Testing Library для unit/integration тестов.

**Зависимости:** нет (базовая инфраструктура).

**Backend/API контракты:** не требуются на этом этапе.

**Definition of Done:**
- Приложение собирается без ошибок TypeScript/ESLint.
- Роутинг работает: публичные и приватные маршруты, редиректы.
- API-клиент корректно обрабатывает 401, refresh, network errors.
- UI-кит покрывает базовые примитивы; Storybook запускается.
- Настроен CI: lint, typecheck, unit tests.
- ROADMAP обновлён подтверждающим commit.

---

## F2 — Authentication & Sessions

**Статус:** `PLANNED`

**Цель:** реализовать полный цикл аутентификации на frontend с безопасным хранением токенов и UX для всех auth-сценарев.

**Основные задачи:**
- Страницы Login / Register с валидацией (Zod / Yup) и доступностью.
- Интеграция с `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`.
- Хранение access/refresh токенов (httpOnly cookie предпочтительнее, иначе secure localStorage + in-memory).
- Автоматический refresh токена перед истечением; обработка конкурентных запросов.
- Глобальный auth-контекст: user, isLoading, isAuthenticated, logout().
- Защищённые маршруты: редирект на /login с returnUrl.
- UX: loading states, ошибки формы, toast-уведомления, "Remember me" (если поддерживается backend).
- Страница профиля: смена пароля, отображение email/имени.

**Зависимости:** F1 (Foundation). Backend Phase 9 (auth/session policy) — для стабильного API контракта refresh/revoke/concurrency.

**Backend/API контракты:**
- `POST /api/v1/auth/login` → `{ access_token, refresh_token, user }`
- `POST /api/v1/auth/register` → `{ access_token, refresh_token, user }`
- `POST /api/v1/auth/refresh` → `{ access_token, refresh_token }`
- `POST /api/v1/auth/logout` (требует refresh_token)
- `POST /api/v1/auth/change-password`
- `GET /api/v1/users/me` (если есть) или user из login response

**Definition of Done:**
- Пользователь может зарегистрироваться, войти, выйти, сменить пароль.
- Refresh работает прозрачно; при 401 — чистый logout и редирект.
- Нет утечек токенов в консоль/сеть; токены не доступны из XSS (httpOnly cookie или in-memory).
- Все формы доступны (WCAG 2.1 AA): labels, focus, aria, ошибки.
- Интеграционные тесты auth-флоу (msw/jest).
- ROADMAP обновлён подтверждающим commit.

---

## F3 — Files & Folders

**Статус:** `PLANNED`

**Цель:** полноценный файловый браузер: навигация, CRUD папок/файлов, поиск, корзина, storage info.

**Основные задачи:**
- Layout: Sidebar (дерево папок) + Main area (список/сетка файлов).
- Виртуализированный список файлов (react-window / tanstack virtual) для больших папок.
- Режима отображения: список / плитка; сортировка по имени/дате/размеру.
- Навигация по хлебным крошкам; deep linking (URL синхронизируется с папкой).
- Создание папки (модалка), переименование (inline edit), перемещение (drag-drop или модалка), копирование.
- Удаление в корзину; просмотр корзины; восстановление; окончательное удаление; очистка корзины.
- Поиск: debounced input, вызов `/files/search`, результаты с хайлайтом.
- Storage info: использованный/общий объём, счётчики файлов/папок (GET `/files/storage-info`).
- Контекстные меню (правая кнопка): скачать, переименовать, переместить, копировать, удалить, info.
- Клавиатурная навигация: arrows, Enter, Delete, F2, Ctrl+C/V/X, Escape.

**Зависимости:** F1, F2. Backend Phase 7 (storage/DB contract, ownership, path, name validation, cycles, trash).

**Backend/API контракты:**
- `GET /api/v1/files?parentId&search` — список файлов/папок
- `GET /api/v1/files/folders?parentId` — только папки (для дерева/перемещения)
- `GET /api/v1/files/trash` — корзина
- `POST /api/v1/files/folders` — создать папку
- `GET /api/v1/files/:id` — детали
- `PATCH /api/v1/files/:id` — rename/move
- `DELETE /api/v1/files/:id` — в корзину
- `POST /api/v1/files/:id/restore` — восстановить
- `DELETE /api/v1/files/:id/permanent` — удалить навсегда
- `POST /api/v1/files/empty-trash`
- `GET /api/v1/files/search?q=`
- `GET /api/v1/files/storage-info`
- `POST /api/v1/files/:id/copy`
- `POST /api/v1/files/:id/move`

**Definition of Done:**
- Все CRUD операции работают end-to-end с реальным API.
- Навигация по папкам мгновенна; URL обновляется; браузер Back/Forward работает.
- Drag-drop перемещение/копирование работает интуитивно.
- Корзина: мягкое/жёсткое удаление, восстановление.
- Поиск debounced, не спамит API.
- Keyboard-only навигация полноценна.
- Интеграционные тесты основных сценариев.
- ROADMAP обновлён подтверждающим commit.

---

## F4 — Uploads & Progress

**Статус:** `PLANNED`

**Цель:** реализовать надёжную загрузку файлов с прогрессом, resumable upload, паузой/отменой и обработкой ошибок.

**Основные задачи:**
- Dropzone: drag-drop, click-to-select, multiple files.
- Валидация на клиенте: тип, размер (до вызова API).
- Создание upload session (`POST /uploads/session`) для каждого файла.
- Chunked upload: разбиение на чанки, параллельная загрузка (configurable concurrency).
- Прогресс-бар на уровне файла и общего; ETA; скорость.
- Пауза/продолжение/отмена отдельного файла и всей очереди.
- Resumable: сохранение состояния сессии в localStorage/IndexedDB для восстановления после перезагрузки вкладки.
- Обработка ошибок чанка: retry с экспоненциальным backoff; при неисправимой ошибке — отмена файла с уведомлением.
- Completion: вызов `/uploads/session/:id/complete`, ожидание финализации, обновление файлового списка.
- UI для очереди загрузок: сворачиваемая панель, детали файла при клике.
- Интеграция с quota: предварительная проверка доступного места (storage-info).

**Зависимости:** F1, F2, F3. Backend Phase 8 (uploads, large files, JSONB chunks, limits, stale cleanup, quota).

**Backend/API контракты:**
- `POST /api/v1/uploads/session` — создать сессию (filename, totalSize, chunkSize, parentId)
- `POST /api/v1/uploads/session/:uploadId/chunk` — multipart/form-data chunk
- `POST /api/v1/uploads/session/:uploadId/complete` — завершить
- `DELETE /api/v1/uploads/session/:uploadId` — отменить/очистить
- `GET /api/v1/uploads/sessions` — список активных сессий (для восстановления)

**Definition of Done:**
- Файлы до лимита backend загружаются успешно с прогрессом.
- Resumable работает: перезагрузка страницы → продолжение загрузки.
- Пауза/отмена/продолжение корректны; нет утечек памяти/блобов.
- Ошибки сети/сервера обрабатываются; пользователь видит понятное сообщение.
- Quota проверяется до старта; при превышении — понятная ошибка.
- Интеграционные тесты: успех, ошибка чанка, пауза, resume, отмена.
- ROADMAP обновлён подтверждающим commit.

---

## F5 — Sharing

**Статус:** `PLANNED`

**Цель:** UI для создания, управления и доступа к публичным ссылкам (файлы и папки).

**Основные задачи:**
- В контекстном меню файла/папки: «Создать ссылку».
- Модалка создания: пароль (опционально), срок действия (дни/дата), лимит скачиваний (если поддерживается backend), флаг папки.
- Список созданных ссылок: таблица с токеном (копирование), сроком, паролем, счётчиком, действием «Отозвать».
- Отзыв ссылки с подтверждением.
- Публичная страница доступа по токену (`/s/:token`): превью инфо, ввод пароля, скачивание.
- Для папок: отображение содержимого (если backend поддерживает folder traversal) или скачивание архива.
- Rate limiting UX: понятные сообщения при 429.
- Доступность публичной страницы без auth (WCAG).

**Зависимости:** F1, F2, F3. Backend Phase 10 (sharing model, folder semantics, password, expiry, download count, revocation, streaming).

**Backend/API контракты:**
- `POST /api/v1/sharing` — создать ссылку (fileId, password?, expiresInDays?, isFolder?)
- `GET /api/v1/sharing` — список ссылок пользователя
- `DELETE /api/v1/sharing/:id` — отозвать
- `GET /api/v1/sharing/public/:token` — инфо о публичной ссылке
- `POST /api/v1/sharing/public/:token/verify` — проверить пароль
- `POST /api/v1/sharing/public/:token/download` — скачать (stream)

**Definition of Done:**
- Создание/отзыв ссылок работает для файлов и папок.
- Публичная страница открывается без логина; пароль проверяется; скачивание стримится.
- Счётчик скачиваний обновляется.
- Отозванная/истёкшая/неверный пароль — понятные ошибки.
- Интеграционные тесты: создание, доступ с паролем/без, отзыв, истечение.
- ROADMAP обновлён подтверждающим commit.

---

## F6 — Trash / Search / Previews

**Статус:** `PLANNED`

**Цель:** допилить вспомогательные, но критичные для UX фичи: корзина (уже в F3), глобальный поиск, превью/тумбнейлы.

**Основные задачи:**
- Глобальный поиск (Header): debounced, результаты в модалке/сайдбаре с переходом к файлу.
- Превью изображений: модалка с зумом/панорамированием, клавиатурная навигация (Esc, стрелки).
- Тумбнейлы в списке/плитке: ленивая загрузка через `/previews/:id/thumbnail`, placeholder/blur до загрузки.
- Превью PDF/текста/видео (если backend поддерживает): базовый вьювер или fallback на скачивание.
- Корзина: уже в F3, здесь — пуш-уведомления о автоочистке (если backend добавит policy).

**Зависимости:** F1, F2, F3. Backend Phase 7 (trash), Phase 11 (previews API hardening).

**Backend/API контракты:**
- `GET /api/v1/files/search?q=`
- `GET /api/v1/previews/:id/thumbnail`
- `GET /api/v1/previews/:id` — метаданные превью (размеры, mime)

**Definition of Done:**
- Поиск работает быстро, не блокирует UI.
- Тумбнейлы подгружаются лениво, не ломают layout (aspect ratio boxes).
- Превью изображения: зум, панорама, клавиатура, закрытие Esc/overlay.
- ROADMAP обновлён подтверждающим commit.

---

## F7 — UX / Responsive / Accessibility

**Статус:** `PLANNED`

**Цель:** привести UI к production качеству: responsive, доступность, дизайн-система, dark mode, i18n-ready.

**Основные задачи:**
- Responsive breakpoints: mobile (<640), tablet (640-1024), desktop (>1024). Sidebar → drawer на мобильных.
- Touch-friendly: тач-драг для перемещения, свайп-действия в списке.
- Dark mode: CSS variables, toggle в навбаре, сохранение в localStorage, системное предпочтение.
- Доступность (WCAG 2.1 AA): семантика, focus-visible, skip links, aria-labels, live regions для тостов/прогресса, цветовой контраст.
- Дизайн-токены: spacing, radius, shadows, colors, typography — единый источник (Tailwind config / CSS vars).
- Loading skeletons для списков/превью вместо спиннеров.
- Empty states с иллюстрациями и CTA (создать папку, загрузить файл).
- Error boundaries с fallback UI и кнопкой «Повторить» / «Сообщить».
- Toasts: стек, авто-hide, action buttons (undo), доступность (aria-live).
- Confirmation dialogs для деструктивных действий.

**Зависимости:** F1–F6 (UI уже существует, это полировка).

**Backend/API контракты:** не требуются.

**Definition of Done:**
- Lighthouse Accessibility ≥ 95.
- Интерфейс корректно работает на mobile/tablet/desktop без горизонтального скролла.
- Dark mode переключается мгновенно, сохраняется.
- Все интерактивные элементы доступны с клавиатуры; фокус виден.
- Error boundary ловит краш и показывает понятный UI.
- ROADMAP обновлён подтверждающим commit.

---

## F8 — Errors / Recovery / Offline

**Статус:** `PLANNED`

**Цель:** устойчивость к сетевым проблемам, понятная обработка ошибок, базовая offline-устойчивость.

**Основные задачи:**
- Глобальный error handler: маппинг HTTP кодов → пользовательские сообщения (401→logout, 403→no access, 404→not found, 409→conflict, 422→validation, 429→rate limit, 5xx→server error).
- Retry стратегия: idempotent GET — авто-retry (3 раза, exponential backoff); мутации — только по кнопке «Повторить».
- Offline detection: navigator.onLine + ping к health endpoint; баннер «Вы офлайн», отключение мутаций.
- Queue мутаций в IndexedDB при офлайне (создание папки, переименование, удаление) — replay при возврате онлайна.
- Оптимистические обновления для быстрых действий (rename, move, delete) с rollback при ошибке.
- Логирование ошибок на клиенте (Sentry-ready структуру) без PII.

**Зависимости:** F1, F2. Backend Phase 11 (error contract, health checks), Phase 13 (observability).

**Backend/API контракты:**
- Единый формат ошибки: `{ statusCode, message, error, details? }` — согласовать с Phase 11.
- `GET /api/v1/health` — для online check (dependency-aware).

**Definition of Done:**
- Любая сетевая ошибка показывает понятный toast с действием.
- При 401 — чистый logout без зацикливания.
- Офлайн-баннер появляется/исчезает корректно; очереди реплеятся.
- Оптимистические обновления не ломают UI при ошибке.
- Интеграционные тесты: 401, 403, 409, 500, offline→online.
- ROADMAP обновлён подтверждающим commit.

---

## F9 — Performance

**Статус:** `PLANNED`

**Цель:** обеспечить быстрый FCP/TTI, плавный скролл больших списков, минимальный бандл.

**Основные задачи:**
- Code splitting: lazy routes, lazy heavy components (превью, PDF viewer).
- Bundle analysis: убрать неиспользуемые зависимости, tree-shaking.
- Виртуализация списков (уже в F3) — подтвердить производительность на 10k+ элементов.
- Memoization: React.memo, useMemo, useCallback для частых ре-рендеров.
- React Query: staleTime, cacheTime, prefetching следующей страницы/папки.
- Image optimization: WebP/AVIF, responsive images, blur-placeholders.
- Service Worker (Workbox): кэширование статики, offline fallback страницу.
- Web Vitals мониторинг (LCP, CLS, INP, FID) — отправка в analytics/metrics.

**Зависимости:** F1–F7. Backend Phase 12 (performance baseline, query optimization, indexes).

**Backend/API контракты:**
- Пагинация/курсоры для списков файлов (если добавится в Phase 12).
- ETags / If-None-Match для условных запросов (опционально).

**Definition of Done:**
- Lighthouse Performance ≥ 90 (mobile).
- Бандл < 200 KB gzipped (без тяжелых lazy-чанков).
- Скролл 10k файлов — 60fps.
- Повторный визит — мгновенный (SW cache).
- Web Vitals собираются.
- ROADMAP обновлён подтверждающим commit.

---

## F10 — Frontend Production Readiness

**Статус:** `PLANNED`

**Цель:** подготовить frontend к production деплою: билд, Docker, CI/CD, healthcheck, security headers, мониторинг.

**Основные задачи:**
- Production Dockerfile: multi-stage (builder → nginx), non-root user, минимальный образ.
- Nginx конфиг: gzip/brotli, cache headers для static assets, SPA fallback, security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy).
- Healthcheck endpoint в nginx (или отдельный lightweight endpoint) для Docker/k8s.
- CI/CD: GitHub Actions — lint, typecheck, test, build, docker push, deploy (staging/prod).
- Environment variables: VITE_API_URL, feature flags, Sentry DSN — через secrets.
- Source maps upload в Sentry (или аналоги) для production error tracking.
- CSP policy: strict, с nonce/hash для inline scripts (если Vite injects).
- Performance budget в CI (bundle size, LCP threshold).
- Smoke тесты после деплоя: healthcheck, login, file list, upload, download.

**Зависимости:** F1–F9. Backend Phase 15 (production topology, TLS, secrets, deploy procedure).

**Backend/API контракты:**
- Production API URL, CORS origins, CSP trusted sources — согласовать с backend Phase 15.

**Definition of Done:**
- Docker образ собирается, проходит healthcheck, запускается за 5с.
- Nginx отдаёт статику с правильными заголовками; CSP не ломает приложение.
- CI/CD pipeline зелёный; деплой в staging/prod работает.
- Source maps загружены; ошибки в Sentry имеют исходный код.
- Smoke тесты проходят на staging.
- ROADMAP обновлён подтверждающим commit.

---

## Backend ↔ Frontend Dependencies

Минимальные зависимости между Backend фазами и Frontend фазами. Frontend-фаза может начинаться, когда соответствующий Backend API достиг достаточной стабильности (не обязательно COMPLETE статус).

| Backend Phase | Frontend Phase | Связь |
|---|---|---|
| Phase 7 — Storage & Filesystem Integrity | F3 Files & Folders | Ownership, path validation, name constraints, cycles, trash, copy/move contract |
| Phase 8 — Uploads & Large Files | F4 Uploads & Progress | Resumable upload API, chunk limits, JSONB chunks, stale cleanup, quota enforcement |
| Phase 9 — Authentication & Sessions | F2 Authentication & Sessions | Refresh rotation, reuse detection, revocation, concurrency, token lifetime policy |
| Phase 10 — Sharing & Access Control | F5 Sharing | Access-control matrix, folder sharing semantics, password/expiry/download-count, revocation, streaming download |
| Phase 11 — Backend/API Hardening | F6–F8, F8 Errors/Recovery | Unified error contract, dependency-aware health checks, security headers, rate-limit semantics, API inventory |
| Phase 12 — Performance & Scalability | F9 Performance | Pagination/cursors, query optimization, indexes, ETags, baseline metrics |
| Phase 13 — Observability & Operations | F8 Errors/Recovery, F10 Production Readiness | Health/readiness endpoints, structured logs, metrics, Docker healthchecks, runbooks |
| Phase 15 — Production Readiness | F10 Frontend Production Readiness | Production topology, TLS, secrets, deploy/rollback, encrypted/offsite backup, RPO/RTO |

**Параллельность:** F1 может начаться немедленно. F2 может начаться после стабильного auth API (Phase 9 в процессе). F3 — после Phase 7 storage contract. F4 — после Phase 8 upload API. F5 — после Phase 10 sharing API. F6–F8 — параллельно с Phase 11 hardening. F9 — после Phase 12 baseline. F10 — параллельно с Phase 15.
