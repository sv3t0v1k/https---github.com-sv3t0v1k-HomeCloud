# HomeCloud — текущее состояние проекта

> Этот документ даёт краткую точку входа в подтверждённое состояние репозитория. План работ и статусы находятся в [`ROADMAP.md`](./ROADMAP.md). Детальные решения следует читать в профильных документах, ссылки на которые приведены ниже.

## Назначение

HomeCloud — самостоятельно размещаемое облачное хранилище файлов. Проект предоставляет REST API для пользователей, файлового дерева, возобновляемых загрузок, публичных ссылок и превью, а также процедуры резервного копирования и восстановления. Пользовательский web-интерфейс — рабочий аутентифицированный клиент backend; его функциональный runtime smoke подтверждён в изолированном окружении.

## Архитектура

- **Backend:** NestJS 10 и TypeScript; корневой модуль — `backend/src/app.module.ts`, запуск и глобальные middleware — `backend/src/main.ts`.
- **Данные:** PostgreSQL 16 через TypeORM. Схема изменяется последовательными миграциями из `backend/src/migrations`.
- **Хранилище:** локальная файловая система через `StorageService`; постоянные файлы находятся в `/storage`, временные части загрузок — в `/storage/.tmp`.
- **Аутентификация:** JWT access/refresh tokens, ротация и отзыв refresh-сессий, bcrypt для паролей.
- **Основные backend-модули:** `auth`, `users`, `files`, `uploads`, `sharing`, `previews`, `storage`, `common`.
- **Frontend:** React 18, Vite и Tailwind; аутентификация и защищённая навигация, файловый браузер, небольшие upload/download, sharing/preview, корзина и файловые операции интегрированы с backend. После Phase 13 выполнен адаптивный редизайн с русским UI, локальными Manrope/JetBrains Mono, списком/плиткой, контекстными меню и доступными drawer/диалогами. Browser-scale upload/download и resume не подтверждены.
- **Резервное копирование:** `scripts/backup.sh`, `scripts/restore.sh`, `scripts/reconcile.py`, тесты безопасности в `scripts/tests`.

## Runtime и deployment

`docker-compose.yml` описывает PostgreSQL, Redis, backend и frontend. Backend хранит файлы в volume `storage_data`; база и Redis используют отдельные volumes. PostgreSQL, Redis, backend и frontend имеют Compose healthchecks; backend endpoint `/api/v1/health` проверяет только состояние процесса (liveness), а `/api/v1/health/ready` — готовность: PostgreSQL (`SELECT 1` через отдельное ограниченное соединение) и реальное чтение/запись storage root и `.tmp` через собственные эксклюзивные probe-артефакты. Совместимый `/api/v1/health/live` также доступен. Readiness объединяет параллельные проверки, кэширует результат на 1 s и ограничивает HTTP-ожидание 3 s; filesystem I/O не отменяется таймером. При общем timeout dependency status консервативно unavailable. Backend healthcheck в compose использует readiness-endpoint `/api/v1/health/ready`. Backend `depends_on` только на PostgreSQL (`service_healthy`); Redis не блокирует запуск backend.

Redis package и runtime-конфигурация присутствуют, но backend не создаёт Redis-клиент и не обращается к Redis — не является хранилищем сессий или кэшем приложения. Volume `uploads_data` объявлен, но не подключён. Общая production readiness, внешнее хранение резервных копий и управление секретами пока не подтверждены. TLS/proxy baseline см. отдельный checkpoint ниже.

Backend пишет структурированные JSON-логи с безопасными operational messages и HTTP completion. `X-Request-Id` принимается только в консервативном формате и возвращается в response; AsyncLocalStorage сохраняет request context. Сырые SQL query logs отключены. `/api/v1/metrics` выдаёт Prometheus text с bounded HTTP labels и runtime signals; endpoint выключен без `METRICS_TOKEN`, иначе требует отдельный Bearer token. Текущие frontend/production ingress nginx закрывают metrics от публичного маршрута; private scrape обращается напрямую к backend и сохраняет Bearer protection. [Runbook](./operations-runbook.md) описывает triage и ограничения.

## Подтверждённые завершённые этапы

- **Phase 1–4 — security baseline.** Checkpoint-тег `security-phase-4-batch-1` указывает на `f37d323`. Детальная реконструкция содержания этих фаз не выполняется без отдельного источника.
- **Phase 5 — Backup & Disaster Recovery.** Checkpoint `phase-5-backup-dr-complete` (`1297051`). Архитектура и эксплуатационный контракт описаны в [`PHASE-5.1-BACKUP-DR-ARCHITECTURE.md`](./PHASE-5.1-BACKUP-DR-ARCHITECTURE.md) и [`backup-and-restore.md`](./backup-and-restore.md).
- **Phase 6 — Database Integrity & Performance.** Аудит и remediation подтверждены в [`phase-6.1-audit-report.md`](./phase-6.1-audit-report.md) и [`phase-6.2-remediation-report.md`](./phase-6.2-remediation-report.md).
- **Phase 7 — Storage & Filesystem Integrity.** Завершены транзакционные операции файлового дерева, проверки имён/циклов и безопасный порядок DB/filesystem изменений.
- **Phase 8 — Uploads & Large Files.** Завершены JSONB-учёт чанков, лимиты, idempotency, quota locking, reconciliation и очистка временных данных.
- **Phase 9 — Authentication & Sessions.** Завершены документирование модели угроз и жизненного цикла сессий, усиление refresh rotation/reuse/revocation и regression tests. Авторитетные документы: [`auth-threat-model.md`](./auth-threat-model.md) и [`session-lifecycle.md`](./session-lifecycle.md).
- **Phase 10 — Sharing & Access Control.** Помимо исходных этапов подтверждены единая fail-closed проверка public share, запрет выдачи soft-deleted объектов, безопасный streaming, `Cache-Control: no-store`, отдельные IP/token/attempt rate limits и блокировка перебора пароля.
- **Связанная целостность папок и их файловых представлений.** `FileEntity` связан с `FolderEntity` через `folderId`; rename/move/soft-delete/restore/permanent-delete и очистка корзины синхронизируют обе сущности транзакционно и не предполагают равенство их ID.

- **Phase 11 — Backend/API Hardening.** Границы API, validation/error contracts, private cache policy и readiness для PostgreSQL и storage проверены; Compose healthcheck использует readiness. Redis не входит в readiness. Checkpoint `39dc751`.
- **Phase 12 — Performance & Scalability.** Подтверждены database cleanup/N+1 fixes, асинхронные файловые пути, disk-backed multipart ingress, streaming/backpressure и authenticated Range download; 30 GiB end-to-end qualification PASS. Checkpoint `e408425`; 50 GiB не квалифицированы, O(N²)-style upload chunk reconciliation остаётся риском.
- **Phase 13 — Frontend.** Подэтапы 13.1–13.7 COMPLETE: auth, файловый браузер, upload/download, sharing/preview, корзина и файловые операции, финальная регрессия. Checkpoint `0147a4c`. Последующий redesign (`3f94b54`) и quota fix (`743b47e`) — отдельная работа без новых номеров Phase.

## Стабильный checkpoint

Текущий проверенный backend operational checkpoint — `cefff5094d9824c924afe06bb06ed9281e4056d1`: ненумерованный Observability & Operations baseline. Full backend 609 PASS / 15 SKIPPED, build и lint gate пройдены; изолированный runtime подтвердил health/degradation/recovery, logs/request ID и защищённые metrics. Independent review APPROVE. [Evidence и ограничения](./observability-checkpoint.md). Это не production release gate и не повторная полная browser qualification.

Предыдущий проверенный product checkpoint — `743b47e544b114970c777d3ca27222738e1aab11`. Он включает завершённые backend Phase 11 (`39dc751`) и Phase 12 (`e408425`), frontend Phase 13 (`0147a4c`), owner-directed redesign (`3f94b54`) и исправление расчёта квоты (`743b47e`). Последующий изолированный runtime verification подтвердил download при каноническом storage root, основные пользовательские сценарии, Chromium 1440/768/390 и accessibility spot-check (`POST_FIX_CHECKPOINT: PASS`); это историческое product evidence, выполненное до последующего observability checkpoint. Это не подтверждение production readiness.

## Phase 10 — завершена

Цель Phase 10 — сделать публичные ссылки управляемой границей доступа с явной политикой владельца, token/password, срока действия, отзыва, скачивания и folder semantics.

Подтверждено завершены:

- **10.1:** access-control matrix и целевая folder-sharing semantics — [`PHASE-10.1-ACCESS-CONTROL.md`](./PHASE-10.1-ACCESS-CONTROL.md), commit `22651e6`.
- **10.2:** fail-closed expiry check в password verification, commit `d23f793`.
- **10.3:** null-safe expiry enforcement в lookup и download count, commit `a51ff17`.
- **10.4:** single-range HTTP streaming и path confinement, commit `f45a00a`.
- **10.5:** атомарный лимит скачиваний и HTTP validation, исходный commit Kilo `9753c97`, исправления и приёмка `951cb2f`.
- **Последующий hardening без новых номеров Phase:** единая public policy и soft-delete enforcement (`1b09424`), `no-store` и dedicated IP/token throttling (`1b09424`, `635985a`, `13ea42e`), password-attempt lockout (`5257de9`).
- **Связанный integrity prerequisite:** явная связь folder mirror через `folderId` (`4b4801f`), транзакционная синхронизация (`dc1d341`) и рекурсивное permanent-delete/empty-trash с PostgreSQL regression coverage (`9962192`).

- **10.6:** публичный просмотр потомков общей папки — `60ac7bd`;
- **10.7:** безопасный scoped download потомка по `fileId` — `60ac7bd`;
- **10.8:** потоковое ZIP-скачивание папки, один слот на архив — `08ea21f`;

Phase 10 завершена: listing, scoped download и ZIP реализованы и проверены. Актуальные завершённые этапы и незавершённые направления указаны в [`ROADMAP.md`](./ROADMAP.md); публикация и production deployment не подтверждены.

## Failure & Security Testing

Ненумерованный checkpoint завершён: реальный disposable restore с проверкой целостности, DB/storage failure-recovery, representative security/ownership/session/rate-limit regressions и privacy signals. Full backend 57 suites / 651 tests PASS без skipped integrations; independent review APPROVE. [Подробное evidence и границы](./failure-security-checkpoint.md). Production readiness не подтверждена; Phase 13 и observability baseline сохранены.

## Известный deferred backlog

- Автоматический retry для serialization/deadlock конфликтов в транзакционных folder operations, если появится эксплуатационная необходимость.
- Внешние scrape/alerts/log shipping и дополнительные сценарии отказов и нагрузочные проверки за пределами завершённой Phase 12. Базовый ненумерованный Observability & Operations checkpoint завершён; централизованный мониторинг не установлен.
- Production deployment: public certificate provisioning/renewal, production offsite/operator qualification и финальный recovery/acceptance; incremental strategy — отдельное решение.

Подробные статусы и критерии приёмки находятся только в [`ROADMAP.md`](./ROADMAP.md); этот раздел не заменяет roadmap.

## Правила использования документации

1. Начинать знакомство с этим документом, затем читать только профильные authoritative документы.
2. Проверять `git status`, текущий commit и статус активной работы перед изменениями.
3. Не выводить завершённость этапа из названия ветки или коммита без подтверждённого результата и обновления roadmap.
4. Не дублировать детальные контракты backup, auth или sharing в этом файле.

## Production Architecture & Release Gate

Добавлены ранняя fail-closed production config validation до DB initialization и release helpers config/artifact/migrations/runtime. Redis production startup больше не требует, readiness остаётся DB+storage. [Topology](./production-topology.md), [release/rollback](./release-and-rollback.md), [evidence](./production-readiness-checkpoint.md): full backend 674 PASS и production same-artifact recovery drill PASS. Независимый review APPROVE. Общая production readiness NOT_READY; previous-version/schema/frontend rollback этим drill не доказаны. Никакой TLS/secrets/offsite rollout не выполнен.


## Production TLS / Proxy Boundary & Private Operational Exposure

Ненумерованный checkpoint: COMPLETE после full gates, runtime evidence и independent review APPROVE. Добавлены standalone production Compose и TLS ingress HTTP308/secure headers; frontend/backend не публикуются, trusted forwarding ограничен точными socket IP двух отдельных сетей. Общий clientIp применяется к существующим process-local лимитам; spoofed headers не меняют client/proto/host от untrusted socket и не обходят budgets. Health/readiness/metrics закрыты обоими nginx, internal metrics сохраняет Bearer. Full backend 59 suites / 686 tests PASS; focused 54 PASS; lint/build/typecheck/config validation PASS. Реальный nginx self-signed TLS smoke и Chromium login/files/fonts/CSP PASS. [Evidence и ограничения](./production-readiness-checkpoint.md). Public CA provisioning/renewal и конечный production deployment не заявляются. Общая готовность NOT_READY: secret lifecycle, encrypted/offsite backup и final recovery/acceptance остаются блокерами. Предыдущие COMPLETE checkpoints сохранены; новая Phase не создана, следующий блок автоматически не начинается.

## Production Readiness — Secret Lifecycle

Ненумерованный checkpoint: COMPLETE; independent review APPROVE. Инвентарь actual secrets, strengthened fail-closed validation, external-only CSPRNG generation, Docker context exclusions и vendor-neutral environment delivery завершены. JWT planned maintenance cutover явно инвалидирует старые tokens; DB/metrics rotation и rollback проверены на isolated compiled runtime. Focused106, full backend702 (59 suites, без skipped), generator1, lint/build/typecheck/Compose gates PASS. [Контракт](./secret-lifecycle.md), [evidence и ограничения](./production-readiness-checkpoint.md). Автоматическая JWT ротация не добавлена. OVERALL_PRODUCTION_READINESS: NOT_READY; encrypted/offsite backup, public certificate lifecycle и final recovery/acceptance остаются блокерами. Предыдущие COMPLETE checkpoints сохранены; новая Phase не создана. Рекомендуемый следующий блок — encrypted/offsite backup, автоматически не начинается.


## Production Readiness — Backup Productionization

Ненумерованный checkpoint: COMPLETE в границах реализации и isolated qualification; independent review APPROVE. Standard age encrypted full backups, verified vendor-neutral filesystem replication, atomic generation sets, retention7/30d (minimum2), safe failure signals и encrypted offsite restore поверх существующего v1 tooling. Focused34, legacy backup27, restore validation15 PASS; real offsite-authoritative disposable DB/storage drill и readiness200 PASS. [Контракт, evidence и ограничения](./backup-productionization.md). Production физический offsite mount/failure domain, schedule/alerts, key custody и full-volume RPO/RTO требуют operator validation. Incremental engine не добавлен. OVERALL_PRODUCTION_READINESS: NOT_READY; public certificate lifecycle, final recovery/acceptance и remaining operator/release checks остаются блокерами. Новая Phase не создана; следующий блок автоматически не начинается.
