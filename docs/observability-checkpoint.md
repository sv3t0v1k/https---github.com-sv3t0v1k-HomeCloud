# Observability & Operations — проверенный checkpoint

Дата: 2026-09-30. Утверждённое ненумерованное направление backlog после документационного checkpoint `e74a7a803166190bda26b70e07d303dff00839df`. Новая Phase не вводится; Phase 13 остаётся COMPLETE. Production readiness не заявляется.

## Результат

- STRUCTURED_LOGGING: PASS — JSON stdout, безопасные статические operational messages и HTTP completion, отключены сырые SQL query logs.
- CORRELATION_CONTEXT: PASS — `X-Request-Id`, UUID fallback, консервативный входной формат, AsyncLocalStorage и concurrent tests.
- LIVENESS_READINESS: PASS — совместимый `/health`, `/health/live`, readiness PostgreSQL + storage root + `.tmp`, безопасный exclusive probe, bounded HTTP deadline и single-flight.
- METRICS_BASELINE: PASS — Prometheus text, request count/duration/in-flight, process memory/uptime, bounded labels. Endpoint выключен без `METRICS_TOKEN`, иначе требует отдельный Bearer token.
- RUNTIME_OBSERVABILITY_SMOKE: PASS.
- INDEPENDENT_REVIEW: APPROVE — независимый read-only reviewer; замечание о JSON envelope метрик исправлено и покрыто HTTP integration test. После исправления существующих privacy assertions и уточнения runbook approval подтверждён повторно.
- OBSERVABILITY_OPERATIONS_CHECKPOINT: PASS.

## Проверки

Focused gate: 4 suites, 64/64 tests PASS, включая existing critical file-deletion regression. Первоначально три assertions требовали path/raw Error в логе; они заменены безопасным static message и negative privacy checks, проверки транзакций и удаления сохранены.

Full backend: 51 suites PASS / 4 SKIPPED; 609 tests PASS / 15 SKIPPED. Это существующие пропущенные интеграционные группы, они не объявляются выполненными. Lint: 0 errors, 15 прежних `jest/expect-expect` warnings. Build/typecheck PASS. Compose config validation PASS. `git diff --check` PASS.

Prettier новых файлов и изменённых implementation-файлов PASS, за исключением двух HEAD-подтверждённых старых расхождений: несвязанная indentation в `auth.service.ts` и legacy formatting в `files.service.critical.spec.ts`. Их массовое форматирование вне scope не выполнялось. Frontend source не менялся; frontend gate не запускался.

## Изолированный runtime

Запущен собранный backend с `NODE_ENV=test`, новой PostgreSQL 16 БД без volumes, отдельным каноническим временным storage и искусственными credentials. Постоянные данные и существующие контейнеры не использовались. Это функциональный smoke, не проверка production topology или deployment.

| Проверка | Результат |
|---|---|
| Healthy liveness/readiness | 200 / 200, database/storage ok |
| Generated / accepted / unsafe request ID | UUID / точный accepted ID / UUID replacement |
| Metrics без/с dedicated Bearer | 401 / 200; Prometheus text, request count и histogram |
| Остановка только disposable PostgreSQL | readiness 503: database unavailable, storage ok; liveness 200 |
| Восстановление disposable PostgreSQL | readiness 200 |
| Временный storage root недоступен | readiness 503: database ok, storage unavailable; liveness 200 |
| Восстановление temporary storage | readiness 200 |
| Логи | 109 JSON lines, 0 non-JSON; completion с requestId/method/route/statusCode/durationMs |
| Privacy marker scan | 0 утечек password/access/share/query/metrics/DB/JWT markers |
| Cleanup | Disposable container удалён, отсутствие проверено |

Первый harness attempt был INCONCLUSIVE из-за унаследованного HTTP proxy в проверочном процессе. После его очистки harness повторён без proxy для loopback; все assertions PASS. Это исправление проверочной среды, не backend.

Локальное первичное runtime evidence: `/private/tmp/hc-observability-smoke-eiledwl_/result.json`; временные артефакты могут быть удалены ОС. Основное evidence, не зависящее от временных файлов: воспроизводимые source tests и таблица результатов выше.

## Границы

Redis package/config присутствуют, но backend не создаёт Redis-клиент и не использует Redis. Он не входит в readiness. Compose продолжает зависеть только от PostgreSQL и проверять backend readiness.

Storage I/O не отменяется таймером: HTTP timeout 3 s консервативно показывает обе зависимости unavailable, pending probe остаётся единственным до ответа ОС. Probe не доказывает доступность каждого файла, свободные bytes/inodes или успех будущей операции. Счётчики метрик локальны процессу и сбрасываются при restart. Domain metrics, централизованные scrape/alerting/log shipping и tracing не добавлены.

Production release gate, TLS, управление deployment/secrets, offsite/encrypted/incremental backup и полноценная failure/security campaign остаются backlog. Операционные действия описаны в [runbook](./operations-runbook.md).
