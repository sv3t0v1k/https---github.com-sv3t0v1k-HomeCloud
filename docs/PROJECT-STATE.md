# HomeCloud — текущее состояние проекта

> Этот документ даёт краткую точку входа в подтверждённое состояние репозитория. План работ и статусы находятся в [`ROADMAP.md`](./ROADMAP.md). Детальные решения следует читать в профильных документах, ссылки на которые приведены ниже.

## Назначение

HomeCloud — самостоятельно размещаемое облачное хранилище файлов. Проект предоставляет REST API для пользователей, файлового дерева, возобновляемых загрузок, публичных ссылок и превью, а также процедуры резервного копирования и восстановления. Пользовательский web-интерфейс пока остаётся прототипом и не является полнофункциональным клиентом backend.

## Архитектура

- **Backend:** NestJS 10 и TypeScript; корневой модуль — `backend/src/app.module.ts`, запуск и глобальные middleware — `backend/src/main.ts`.
- **Данные:** PostgreSQL 16 через TypeORM. Схема изменяется последовательными миграциями из `backend/src/migrations`.
- **Хранилище:** локальная файловая система через `StorageService`; постоянные файлы находятся в `/storage`, временные части загрузок — в `/storage/.tmp`.
- **Аутентификация:** JWT access/refresh tokens, ротация и отзыв refresh-сессий, bcrypt для паролей.
- **Основные backend-модули:** `auth`, `users`, `files`, `uploads`, `sharing`, `previews`, `storage`, `common`.
- **Frontend:** React 18, Vite и Tailwind. `frontend/src/App.tsx` содержит каркас экранов; рабочая интеграция auth, файлов, uploads и sharing ещё не реализована.
- **Резервное копирование:** `scripts/backup.sh`, `scripts/restore.sh`, `scripts/reconcile.py`, тесты безопасности в `scripts/tests`.

## Runtime и deployment

`docker-compose.yml` описывает PostgreSQL, Redis, backend и frontend. Backend хранит файлы в volume `storage_data`; база и Redis используют отдельные volumes. PostgreSQL, Redis, backend и frontend имеют Compose healthchecks; backend endpoint `/api/v1/health` проверяет только состояние процесса (liveness), а `/api/v1/health/ready` — готовность: PostgreSQL (`SELECT 1`) и корень хранилища (существует, является директорией, запись доступна). Backend healthcheck в compose использует readiness-endpoint `/api/v1/health/ready`. Backend `depends_on` только на PostgreSQL (`service_healthy`); Redis не блокирует запуск backend.

Redis присутствует в runtime-конфигурации, но не имеет клиента и потребителей в коде backend — не является хранилищем сессий или кэшем приложения. Volume `uploads_data` объявлен, но не подключён. Production readiness, TLS, внешнее хранение резервных копий и управление секретами пока не подтверждены.

## Подтверждённые завершённые этапы

- **Phase 1–4 — security baseline.** Checkpoint-тег `security-phase-4-batch-1` указывает на `f37d323`. Детальная реконструкция содержания этих фаз не выполняется без отдельного источника.
- **Phase 5 — Backup & Disaster Recovery.** Checkpoint `phase-5-backup-dr-complete` (`1297051`). Архитектура и эксплуатационный контракт описаны в [`PHASE-5.1-BACKUP-DR-ARCHITECTURE.md`](./PHASE-5.1-BACKUP-DR-ARCHITECTURE.md) и [`backup-and-restore.md`](./backup-and-restore.md).
- **Phase 6 — Database Integrity & Performance.** Аудит и remediation подтверждены в [`phase-6.1-audit-report.md`](./phase-6.1-audit-report.md) и [`phase-6.2-remediation-report.md`](./phase-6.2-remediation-report.md).
- **Phase 7 — Storage & Filesystem Integrity.** Завершены транзакционные операции файлового дерева, проверки имён/циклов и безопасный порядок DB/filesystem изменений.
- **Phase 8 — Uploads & Large Files.** Завершены JSONB-учёт чанков, лимиты, idempotency, quota locking, reconciliation и очистка временных данных.
- **Phase 9 — Authentication & Sessions.** Завершены документирование модели угроз и жизненного цикла сессий, усиление refresh rotation/reuse/revocation и regression tests. Авторитетные документы: [`auth-threat-model.md`](./auth-threat-model.md) и [`session-lifecycle.md`](./session-lifecycle.md).
- **Phase 10.1–10.5 и последующий hardening Sharing & Access Control.** Помимо исходных этапов подтверждены единая fail-closed проверка public share, запрет выдачи soft-deleted объектов, безопасный streaming, `Cache-Control: no-store`, отдельные IP/token/attempt rate limits и блокировка перебора пароля.
- **Целостность папок и их файловых представлений.** `FileEntity` связан с `FolderEntity` через `folderId`; rename/move/soft-delete/restore/permanent-delete и очистка корзины синхронизируют обе сущности транзакционно и не предполагают равенство их ID.

## Стабильный checkpoint

Стабильный проверенный checkpoint — `08ea21f`. Он включает приёмку Phase 10.5 (`951cb2f`), public-sharing hardening (`1b09424`–`5257de9`), транзакционную целостность папок/зеркал (`4b4801f`–`9962192`), публичный просмотр папок и scoped download (`60ac7bd`) и потоковое ZIP-скачивание папки (`08ea21f`). Результаты приёмки исходной работы Kilo описаны в [`PHASE-10.5-REVIEW.md`](./PHASE-10.5-REVIEW.md).

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

Phase 10 завершена: все активные участники (listing, scoped download, ZIP) реализованы и проверены. Текущий следующий участок — изначальные направления из [`ROADMAP.md`](./ROADMAP.md): Backend/API hardening, performance & scalability, observability & operations, failure & security testing, frontend foundation и production readiness. Это не разрешение на публикацию или production deployment.

- **Phase 11 — Backend/API Hardening.** Завершена readiness-контракт: `GET /api/v1/health` — liveness состояния процесса без проверки зависимостей; `GET /api/v1/health/ready` — 200 только при успешном `SELECT 1` по PostgreSQL и существовании/директории/доступности на запись корня хранилища, иначе 503 с `{ status:"not_ready", checks:{ database, storage } }` без раскрытия ошибок, путей или секретов. Redis не инсталлируется, не запрашивается и не входит в readiness. Backend Docker healthcheck переключён на readiness; `depends_on` остался только на PostgreSQL. Итоговые коммиты: `6d065f2`, `919de64`, `39dc751`.
## Известный deferred backlog

- Folder-sharing: потоковое ZIP-скачивание папки реализовано (`08ea21f`); listing потомков и scoped download также реализованы.
- Автоматический retry для serialization/deadlock конфликтов в транзакционных folder operations, если появится эксплуатационная необходимость.
- Наблюдаемость, performance/load baseline и failure/security testing.
- Полноценный frontend и его автоматические тесты.
- Production deployment: TLS, secrets, offsite/encrypted/incremental backup и проверенный rollback/DR.

Подробные статусы и критерии приёмки находятся только в [`ROADMAP.md`](./ROADMAP.md); этот раздел не заменяет roadmap.

## Правила использования документации

1. Начинать знакомство с этим документом, затем читать только профильные authoritative документы.
2. Проверять `git status`, текущий commit и статус активной работы перед изменениями.
3. Не выводить завершённость этапа из названия ветки или коммита без подтверждённого результата и обновления roadmap.
4. Не дублировать детальные контракты backup, auth или sharing в этом файле.
