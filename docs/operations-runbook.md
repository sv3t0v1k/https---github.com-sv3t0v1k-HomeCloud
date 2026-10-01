# HomeCloud — эксплуатационная диагностика

Этот runbook описывает наблюдаемость одного backend-процесса. Реализованные TLS/secrets/backup checkpoints и их boundaries перечислены в production-readiness-checkpoint.md. Финальный launch gate и operator checklist: [Final Production Acceptance](./final-production-acceptance.md); overall readiness NOT_READY.

## Запуск и health

Используйте действующие инструкции запуска проекта; для Compose проверяйте `docker compose ps`, затем `docker compose logs --tail=100 backend`. Не удаляйте volumes и не выполняйте restore как первый ответ на ошибку.

- `GET /api/v1/health` и `/api/v1/health/live` — совместимый liveness: процесс отвечает; доступность зависимостей не проверяется.
- `GET /api/v1/health/ready` — readiness: PostgreSQL и storage должны быть доступны. HTTP 200 означает готовность, HTTP 503 — деградацию; поле `checks` показывает `database` и `storage` без credentials и путей. Успешные JSON-ответы API сохраняют существующую обёртку `success/data`.
- Compose healthcheck backend использует readiness. `unhealthy` само по себе не перезапускает контейнер; `restart: unless-stopped` относится к завершению процесса. Startup зависит только от PostgreSQL.
- Redis настроен в Compose, но backend не создаёт Redis-клиент и не обращается к Redis. Он не входит в readiness и не хранит сессии/кэш приложения. Существующая startup-проверка `REDIS_PASSWORD` сохраняется как проверка конфигурации, а не проверка доступности Redis.

Readiness использует отдельное PostgreSQL-соединение: connection timeout 1 s, server statement timeout 1 s, client query timeout 1.5 s. Результат кэшируется на 1 s; параллельные запросы объединяются в одну проверку. HTTP-ожидание ограничено 3 s. При общем timeout оба dependency status консервативно возвращаются как `unavailable`; это не доказывает одновременный отказ БД и диска. Probe storage создаёт собственный эксклюзивный `.health-*` каталог и файл, проверяет чтение/запись и удаляет только эти артефакты в root и `.tmp`. Зависшее файловое I/O нельзя отменить этим deadline: один probe остаётся pending до ответа ОС, новые probe не накапливаются.

Readiness является моментальным ограниченным пробником, а не доказательством доступности каждого пользовательского файла, свободной квоты или восстановления backup. Не повышайте нагрузку частыми опросами; для обычного мониторинга достаточно текущего Compose-интервала 10 секунд.

## Корреляция и логи

Заголовок `X-Request-Id` возвращается для каждого HTTP-запроса. Клиент может передать ID из 1–64 символов `[A-Za-z0-9_-]`; отсутствующий, повторный/составной или недопустимый ID заменяется UUID. Заголовок разрешён и доступен через CORS. Используйте ID из ответа для поиска события запроса и связанных сообщений в `docker compose logs backend`. ID задаёт клиент и поэтому не является идентификатором пользователя или доказательством подлинности запроса.

Backend пишет JSON по одной записи на строку в stdout: timestamp, level, service, context, event/message, requestId при наличии контекста. Завершение HTTP содержит method, route/path, statusCode и durationMs; route является шаблоном, а неизвестный URL заменяется фиксированным маркером. Тела, query, заголовки Authorization/cookies, токены, passwords, содержимое файлов и сырые exception messages/stacks не записываются. Шаблон маршрута помогает диагностике без публикации имён файлов и share tokens. Сообщения вне запроса могут не иметь requestId.

Ожидаемые 4xx диагностируются как предупреждения; 5xx — как ошибки. Ищите рост групп ошибок, а не отдельный 401 при неверном логине. Продолжительность запроса включает передачу ответа; обрыв клиента учитывается отдельно от успешного завершения.

## Метрики

`GET /api/v1/metrics` выдаёт текст Prometheus. Без `METRICS_TOKEN` endpoint выключен; при включении требуется `Authorization: Bearer <METRICS_TOKEN>`. Не используйте JWT пользователя или share token как metrics credential. Передавайте секрет через действующий механизм конфигурации, не через URL и не в команды, попадающие в публичные отчёты. Endpoint проксируется обычным `/api/`, поэтому backend-защита обязательна; это не разрешение публично публиковать credentials.

Основные имена: `homecloud_http_requests_total`, `homecloud_http_request_duration_seconds_{bucket,sum,count}`, `homecloud_http_requests_in_flight`, `homecloud_process_uptime_seconds`, `homecloud_process_resident_memory_bytes`, `homecloud_process_heap_used_bytes`.

Смотрите HTTP request count по method/route/status class, duration histogram, in-flight requests, process uptime и память. Labels не содержат userId, fileId, токены, сырой URL или filesystem path. Счётчики локальны одному процессу и сбрасываются при перезапуске; внешнее хранение, scrape/alerts и vendor integrations не устанавливаются этим checkpoint. Автоматические domain counters не добавляются без отдельного обоснования.

## Первый ответ на инцидент

| Симптом | Безопасная проверка и действие |
|---|---|
| Рост 5xx | Сохраните время и requestId; сопоставьте JSON completion и error class/code, readiness, status и latency metrics. Проверьте последние изменения и зависимости. Не включайте логирование тел/секретов. |
| PostgreSQL unavailable | Проверьте status/logs только нужного DB-сервиса, доступность сети и правильность конфигурации без печати connection string. Liveness может оставаться 200, readiness должен быть 503. Не выполняйте миграции/restore вслепую. |
| Storage unavailable | Проверьте подключение нужного volume, права service user, доступность root и `.tmp`, свободные bytes/inodes. Не удаляйте пользовательские файлы или probe-каталоги другого процесса для освобождения места. |
| Квота/upload | Разделите ожидаемый quota/validation 4xx и серверный 5xx. Сопоставьте requestId, route, status, readiness и пользовательский API-ответ. Не меняйте вручную `storageUsed`, записи upload session или chunks; используйте существующие процедуры reconciliation/backup только по их контракту. |
| Рост latency/in-flight | Сравните маршруты, классы статуса и память. Длинный download естественно включает transfer time. Проверьте DB/storage; не делайте вывод о N+1 или утечке памяти по одному снимку. |

После устранения причины дождитесь readiness 200 и здорового Compose status, повторите безопасный небольшой запрос и проверьте его requestId/completion, status и метрики. Liveness 200 сам по себе недостаточен. Restore требует отдельных доказательств целостности согласно [backup-and-restore.md](./backup-and-restore.md).

## Ограничения

Нет распределённого tracing, централизованного log shipping, внешнего Prometheus/alerting, multi-replica aggregation или production readiness. Проверка storage не гарантирует отсутствие последующего отказа. Проверка БД не гарантирует успешность следующей транзакции. Runtime smoke проводится только на disposable data; destructive failure testing нормального окружения сюда не входит.


## Production encrypted/offsite backup

Использовать [Backup Productionization](./backup-productionization.md): maintenance write barrier → `backup-production.sh` → verified offsite success. Проверять JSON job events и `last-backup-success.json` (timestamp/generation/offsite_verified); restore marker не сбрасывает backup freshness. Nonzero job exit требует incident response; retention warning требует отдельной проверки cleanup и capacity. Initial daily stale alert >26h — proposed threshold, требуется утверждение RPO. Scheduler, внешний alert routing, реальный mount/failure domain, recovery key custody и full-volume RPO/RTO проверяются на production узле.

Для recovery сначала `restore-offsite.sh GENERATION --validate-only`, затем restore в закрытом maintenance target, reconciliation и readiness200. Wrong key/corruption до decrypt/validation не меняют target. Не удалять последний verified restore point для освобождения места. Stale `.production.lock`, `.plaintext_*`, `.restore_*`, `.partial_*`, `.expired_*` исследовать только после подтверждения отсутствия job; plaintext staging требует encrypted filesystem, unlink не гарантирует secure erase.


## Public Certificate Lifecycle

[Исполняемый контракт выдачи, bootstrap, renewal, permissions, rollback и expiry](./certificate-lifecycle.md). Production ingress читает external lifecycle root через read-only mount и `current/` symlink; обновление flat PEM directory больше не является актуальным activation contract. Для migration нужен validated bootstrap install и maintenance recreate mount. ACME account/private material вне repo/image.

Дважды в сутки запускается `certificate-lifecycle.py renew`; ежедневно независимо запускается `check`. Любой nonzero renew/install, warning/critical/invalid check требует operator signaling; alert delivery и scheduler квалифицируются на целевом host. Failed renewal не повод останавливать valid ingress. При config/reload/probe failure проверить current, nginx config и served fingerprint, затем выполнить validated rollback/install по linked runbook. Не публиковать keys/ACME account/resolved env в диагностике.

HTTP01 challenge exception не содержит HSTS; HTTPS policy сохранена. Initial HTTP01 issuance использует standalone на свободном port80 до запуска ingress. DNS01 automation/provider plugins не реализованы. Local CA smoke не доказывает public CA issuance. Общая Production Readiness остаётся NOT_READY до final recovery/acceptance и remaining operator/release checks.


## Privacy proxy logs и финальный operator gate

Ingress/frontend access logs содержат только status, bytes и duration, без URI/query/headers/share tokens. Raw nginx error logs подавлены, поскольку nginx может включать request/upstream URI. Диагностика proxy: `nginx -t`, aggregate statuses/time, private health и безопасные backend JSON logs с request ID; отсутствие raw proxy errors ограничивает диагностику и должно учитываться оператором. Не передавать secrets в request ID. [Final acceptance/checklist](./final-production-acceptance.md) фиксирует обязательные scheduler/alert/offsite/public CA и release blockers; скрипты и exit codes сами по себе не являются alert delivery.


## Scheduler / delivered alerts — bounded remediation

Расписание, external-only config, maintenance-wrapper, retry/dedup/recovery и delivery boundary: [scheduler-alerting](./scheduler-alerting.md). Backup retention/integrity остаются в existing transaction, cert lifecycle/reload contract сохранён. Production recipient и target host не квалифицированы; общий **NOT_READY / NO_GO**.
