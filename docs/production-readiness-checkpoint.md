# Production Readiness — Architecture & Release Gate

Дата: 2026-09-30, Asia/Vladivostok. Ненумерованный owner-approved checkpoint после Failure & Security Testing. Исходный HEAD `b77e8162e32c06be949884d69a3a29773d30138c`; status — только запрещённый untracked audit. Audit не читался, не изменялся и не включается в commit.

## Контракт и границы

[Фактическая topology/gap matrix](./production-topology.md) и [исполняемый порядок release/migration/rollback](./release-and-rollback.md). Поддерживаемый контракт — один backend, один PostgreSQL, постоянный storage, frontend nginx, внешний TLS ingress с maintenance barrier. Redis optional, не runtime/readiness dependency. Zero downtime, HA и previous-version schema compatibility не заявляются.

Production config валидируется ConfigModule до TypeORM initialization: разные access/refresh secrets ≥32 символов; PostgreSQL URL с credential ≥16, совпадение DB_PASSWORD при его наличии; optional metrics token ≥32; абсолютный storage root; явный HTTPS frontend origin. Очевидные placeholders и повторяющиеся secrets отклоняются; это baseline, не измерение entropy. Errors содержат только названия settings. Пустой metrics token означает disabled endpoint. Production startup не требует неиспользуемого Redis; старые development/test validators сохранены.

Release helper имеет независимые режимы config/artifact/migrations/runtime. Он не разрешает public traffic: отдельно blocking build provenance/immutable digests, reviewed migration inventory, consistent backup, rollback inputs, auth/file smoke, acceptance window и go-live TLS/secrets/backup requirements. Artifact проверяет наличие dist и отсутствие tracked diff, а не reproducible build или untracked files; запрещённый audit не читается.

## Проверки

- Focused configuration: 2 suites / 40 tests PASS.
- Release helper negative/runtime policy: 6 tests PASS.
- Full backend с disposable PostgreSQL: 58 suites / 674 tests PASS, без skipped integrations.
- Backend lint: 0 errors / 15 прежних warnings; build и typecheck PASS.
- Frontend build/typecheck PASS; source/config не менялись, frontend suite не запускался.
- Compose config quiet PASS, без вывода секретов. Script syntax и diff-check PASS.
- Backup/restore implementation не менялся; повторные backup safety suites не требуются. Реальный paired restore evidence остаётся в завершённом [Failure/Security checkpoint](./failure-security-checkpoint.md).

## Drill

Harness `scripts/tests/release-rollback-runtime.py` использует production mode, чистую временную PostgreSQL, явные synthetic settings, canonical temporary storage и минимальный inherited env; deployment .env не читается. CLI show/apply transaction all исполняются до старта приложения, затем gate подтверждает отсутствие pending migrations. Новый synthetic account получает fixture quota 1 MiB SQL provisioning (default quota нового пользователя 0), загружает поддерживаемый PNG; download сравнивается по точным bytes. Приложение останавливается, контролируемый bad process завершается exit42; возврат того же compiled artifact должен восстановить readiness и неизменные DB snapshot/download bytes. Свой container удаляется.

Это ограниченный same-artifact recovery drill. Не доказывает откат на предыдущую версию, frontend rollback, destructive schema rollback, production TLS или offsite restore. Изначальные harness ошибки TCP readiness race, chunk HTTP201 вместо фактического200, неподдерживаемый text MIME и отсутствие fixture quota исправлены по текущим контрактам; product behavior не менялся.

## Блокеры go-live и следующий блок

OVERALL_PRODUCTION_READINESS: NOT_READY. Внешний TLS/HTTPS redirect и exposure policy отсутствуют; nginx client IP forwarding и backend trust proxy требуют совместного проверенного контракта (сейчас лимитеры видят proxy IP). Production listener frontend ещё 80:80, health/metrics проксируются общим /api/. Не реализованы secret lifecycle/защищённая доставка, encrypted/offsite backup, утверждённые retention/RPO/RTO, backup alerts и scheduler с write barrier. Immutable image manifest — обязательный input будущего deployment, в реальный registry здесь не публиковался. DB restart/recovery policy и storage UID1001 provisioning требуют operator validation. Existing restore стартует app до migrations: внешний traffic barrier обязателен.

Сохранены access JWT до TTL после logout, process-local rate limits/metrics, post-commit unlink orphan risk, optional unused Redis. Phase 11–13, redesign/quota fix, Observability и Failure/Security COMPLETE сохранены. Общий Production Readiness остаётся INCOMPLETE. Новая Phase не создана.

Минимальный следующий owner-approved блок: TLS ingress + sanitised forwarding/trusted proxy + private metrics/health exposure и тест client-IP rate limiting. Автоматически не начинается.

Drill итог: PASS в указанных границах. Evidence `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-release-drill-_yzban9v/result.json`: no pending migrations, auth/upload/download, exit42, readiness recovery, unchanged DB+bytes, own container cleanup — true. PNG SHA256 `f3ec9e14b9c085b55edc96155f7bd26b6fdeda2462f02af4e0279d8319b365e3`. Temporary artifacts могут удаляться ОС; воспроизводимый harness сохранён.

## Итоговая классификация

INDEPENDENT_REVIEW: APPROVE. Reviewer проверил фактические diff, scripts, evidence и документы; найденная неоднозначность deployment cwd/.env исправлена одним bounded correction cycle. Неразрешённых MUST_FIX нет.

- PRODUCTION_TOPOLOGY_CONTRACT: PASS
- MIGRATION_RELEASE_POLICY: PASS
- CONFIG_VALIDATION_BASELINE: PASS
- RELEASE_GATE: PASS (детерминированный checklist + узкие helpers; не go-live допуск)
- ROLLBACK_DRILL: PASS (ограниченный same-artifact recovery)
- PRODUCTION_READINESS_ARCH_RELEASE_CHECKPOINT: PASS
- OVERALL_PRODUCTION_READINESS: NOT_READY
