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

`docker-compose.yml` описывает PostgreSQL, Redis, backend и frontend/nginx. Backend хранит файлы в volume `storage_data`; база и Redis используют отдельные volumes. PostgreSQL, Redis, backend и frontend имеют Compose healthchecks, однако backend endpoint `/api/v1/health` пока сообщает только состояние процесса и не проверяет зависимости.

Redis присутствует в runtime-конфигурации, но не является хранилищем сессий или кэшем приложения. Volume `uploads_data` объявлен, но не подключён. Production readiness, TLS, внешнее хранение резервных копий и управление секретами пока не подтверждены.

## Подтверждённые завершённые этапы

- **Phase 1–4 — security baseline.** Checkpoint-тег `security-phase-4-batch-1` указывает на `f37d323`. Детальная реконструкция содержания этих фаз не выполняется без отдельного источника.
- **Phase 5 — Backup & Disaster Recovery.** Checkpoint `phase-5-backup-dr-complete` (`1297051`). Архитектура и эксплуатационный контракт описаны в [`PHASE-5.1-BACKUP-DR-ARCHITECTURE.md`](./PHASE-5.1-BACKUP-DR-ARCHITECTURE.md) и [`backup-and-restore.md`](./backup-and-restore.md).
- **Phase 6 — Database Integrity & Performance.** Аудит и remediation подтверждены в [`phase-6.1-audit-report.md`](./phase-6.1-audit-report.md) и [`phase-6.2-remediation-report.md`](./phase-6.2-remediation-report.md).
- **Phase 7 — Storage & Filesystem Integrity.** Завершены транзакционные операции файлового дерева, проверки имён/циклов и безопасный порядок DB/filesystem изменений.
- **Phase 8 — Uploads & Large Files.** Завершены JSONB-учёт чанков, лимиты, idempotency, quota locking, reconciliation и очистка временных данных.
- **Phase 9 — Authentication & Sessions.** Завершены документирование модели угроз и жизненного цикла сессий, усиление refresh rotation/reuse/revocation и regression tests. Авторитетные документы: [`auth-threat-model.md`](./auth-threat-model.md) и [`session-lifecycle.md`](./session-lifecycle.md).
- **Phase 10.1–10.4 — подтверждённая часть Sharing & Access Control.** Зафиксированы access-control/folder semantics, fail-closed expiry checks, HTTP Range streaming и confinement пути хранилища.

## Стабильный checkpoint

Стабильный принятый checkpoint для продолжения работ — `f45a00a` (`Phase 10.4: HTTP Range streaming и path confinement для SharingController.downloadShare`).

Коммит `9753c97` с изменениями Phase 10.5 появился во время актуализации документации, но до отдельного подтверждения handoff не включается в завершённое состояние и не меняет стабильный checkpoint.

## Phase 10 — текущее состояние

Цель Phase 10 — сделать публичные ссылки управляемой границей доступа с явной политикой владельца, token/password, срока действия, отзыва, скачивания и folder semantics.

Подтверждено завершены:

- **10.1:** access-control matrix и целевая folder-sharing semantics — [`PHASE-10.1-ACCESS-CONTROL.md`](./PHASE-10.1-ACCESS-CONTROL.md), commit `22651e6`.
- **10.2:** fail-closed expiry check в password verification, commit `d23f793`.
- **10.3:** null-safe expiry enforcement в lookup и download count, commit `a51ff17`.
- **10.4:** single-range HTTP streaming и path confinement, commit `f45a00a`.

Phase 10 в целом остаётся активной до закрытия оставшегося backlog и выполнения общего Definition of Done из [`ROADMAP.md`](./ROADMAP.md).

## Активная работа

**Phase 10.5 (`maxDownloads`) выполняется Kilo.** Её файлы и коммиты нельзя изменять, переоформлять или включать в completed state до подтверждённого handoff. Текущий кандидат-коммит: `9753c97`; его наличие само по себе не является приёмкой результата.

## Известный deferred backlog

- Полная folder-sharing реализация: listing потомков, scoped download и решение по recursive ZIP.
- Dedicated rate limiting public sharing и защита password verification от перебора.
- Политика soft-delete/revocation и гарантия, что удалённый объект никогда не выдаётся.
- `Cache-Control: no-store` и единый public access-policy слой.
- Dependency-aware readiness/liveness для PostgreSQL, Redis и storage.
- Наблюдаемость, performance/load baseline и failure/security testing.
- Полноценный frontend и его автоматические тесты.
- Production deployment: TLS, secrets, offsite/encrypted/incremental backup и проверенный rollback/DR.

Подробные статусы и критерии приёмки находятся только в [`ROADMAP.md`](./ROADMAP.md); этот раздел не заменяет roadmap.

## Правила использования документации

1. Начинать знакомство с этим документом, затем читать только профильные authoritative документы.
2. Проверять `git status`, текущий commit и статус активной работы перед изменениями.
3. Не выводить завершённость этапа из названия ветки или коммита без подтверждённого результата и обновления roadmap.
4. Не дублировать детальные контракты backup, auth или sharing в этом файле.
