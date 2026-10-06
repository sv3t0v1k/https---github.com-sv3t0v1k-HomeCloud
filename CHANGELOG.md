# Изменения HomeCloud

## v0.9.0-local.1 — 6 октября 2026

Первая нумерованная предпроизводственная локальная версия. Предыдущие теги — тематические checkpoints. Это не production-ready release; GitHub помечает версию prerelease.

- Универсальное хранение произвольных файлов; тип влияет на превью, квота и инфраструктура — на размер.
- Durable chunk metadata, потоковая финализация и native browser download; очередь batch/file DnD, Pause/Resume/Cancel и reload с повторным выбором.
- Полные 50 ГиБ через IAB/localhost: три SHA-256, восстановление той же сессии, отмена и очистка — PASS 2026-10-06.
- Аутентификация и refresh lifecycle, sharing/password/expiry/download budgets, streamed public folder ZIP, access/security hardening и функциональный frontend baseline.
- JSON logs/private metrics/readiness, encrypted backup/DR, TLS lifecycle, scheduler/alerts и immutable-pair rollback квалифицированы локально в документированных границах.
- Docker consolidation: один `homecloud-preview`, постоянные external data volumes и внешний config/TLS; исторические данные/volumes сохраняются.
- Исправлен fail-closed restore schema gate для известных поколений из 7/8/9 таблиц; неизвестные/неполные схемы отклоняются до смены storage.
- Актуализированы README, roadmap/state, auth/session, operations, recovery и qualification index; исторические неудачи сохранены с явными границами.

Ограничения: production NOT_READY / NO_GO (реальные host/DNS/CA/registry/offsite/custody/alerts/RPO/RTO/operator gates); Safari полный 50 ГиБ UNQUALIFIED; folder DnD/empty-file/automatic File access recovery не реализованы; discovery без pagination; quota provisioning оператором; local TLS требует явного доверия и recreate на Mac.

[Контракт версии](docs/local-release-baseline.md), [50 ГиБ evidence](docs/evidence/browser-50gib-qualification-20261006/report.md), [финальный gate](docs/evidence/local-release-20261006/report.md).
