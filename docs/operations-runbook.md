Актуальная последовательность deploy/rollback/recovery: [операторский пакет](./go-live-checklist.md). Единственный текущий список внешних входов: [master checklist](./external-input-master-checklist.md). Overall **NOT_READY / NO_GO**.

## Единственный локальный baseline HomeCloud

Для обычной работы используется project **`homecloud-preview`**. Канонический
Compose: `docker-compose.production.yml` + `docker-compose.local.yml`; legacy
`docker-compose.yml` не запускать. Compose >= 2.24.4 обязателен для `!override`.
Production topology сохранена; local override публикует только loopback
`127.0.0.1:8080` (frontend), `127.0.0.1:80/443` (ingress) и явно использует external
`homecloud-preview_db_data` → `/var/lib/postgresql/data`,
`homecloud-preview_storage_data` → `/storage`. Redis выключен и не требуется
текущим application modules. Не включать профиль без отдельной необходимости.

Из корня repo:

```sh
hc() {
  docker compose --project-name homecloud-preview \
    --env-file "$HOME/Library/Application Support/HomeCloud/config/runtime.env" \
    -f docker-compose.production.yml -f docker-compose.local.yml "$@"
}
hc config --quiet                   # Не выводит resolved secrets.
hc up -d --build --wait             # Первый запуск / обновление из repo.
hc ps
hc stop                            # Остановка с сохранением данных.
hc start                           # Возобновление существующих контейнеров.
hc up -d --force-recreate --wait    # Проверяемое пересоздание, те же volumes.
# При предусмотренной миграции: сначала verified DB + storage backup.
hc stop ingress frontend backend
hc up -d db
hc run --rm --no-deps backend npm run migration:run
hc up -d --build --wait
```

`restart` не применяет изменения Compose/env/image; используйте `up`.
Не выполнять `down -v`, volume/system prune или переключение на project `homecloud`.
Изолированные временные стеки допускаются для действительно destructive
restore/rollback/migration/release qualification; удалить их сразу после проверки.
Обычные smoke-проверки выполняются на canonical stack с отдельным dev-аккаунтом
и полным удалением их файлов/резервов/временных частей.

Durable operations root на этом Mac:
`/Users/aleksejkozemakin/Library/Application Support/HomeCloud/`.
`config/runtime.env` (0600, parent0700) содержит восстановленный DB_NAME/DB_USER,
сильный DB_PASSWORD, независимые JWT secrets, `PUBLIC_HOST=homecloud.localhost`,
`TLS_CERT_DIR` и `ACME_WEBROOT_DIR`. Никогда не печатать файл или `hc config`
без `--quiet`. JWT secrets после утраты предыдущего runtime env заменены;
старые access/refresh tokens больше не валидны. Пользовательские password hashes
не меняются. Dev login хранится отдельно в защищённом local config, не в Git.
Штатная регистрация создаёт storageQuota=0; quota API/role model отсутствуют.
Только dev@homecloud.local получила operator provisioning квоты100GiB в PostgreSQL;
её password hash создан штатной регистрацией. Новые аккаунты с нулевой квотой
не могут загружать файлы, пока оператор не назначит квоту. Это существующее
ограничение, application source в этом checkpoint не менялся.

HTTP UI: http://localhost:8080. HTTPS: https://homecloud.localhost (loopback).
При отсутствии resolver support проверять CLI с
`--resolve homecloud.localhost:443:127.0.0.1`; не перенаправлять запрос на внешний DNS.
HTTP ingress даёт308; `challenges/.well-known/acme-challenge` содержит только public
challenge tokens. `tls/current` — поколение, установленное существующим
`scripts/certificate-lifecycle.py`; key0600, state0700. Новая локальная self-signed
pair имеет matching SAN, но не установлена в системное доверие и не подтверждает
public CA issuance. CLI проверка без `-k`:

```sh
curl --noproxy '*' --resolve homecloud.localhost:443:127.0.0.1 \
  --cacert "$HOME/Library/Application Support/HomeCloud/config/local-development-fullchain.pem" \
  https://homecloud.localhost/
```

Локальное переиздание: OpenSSL RSA3072/SHA256, срок365 дней, SAN
`DNS:homecloud.localhost,DNS:localhost,IP:127.0.0.1`; private key писать только
в защищённый external config. Проверить matching key/SAN/expiry и установить
через `certificate-lifecycle.py install --hostname homecloud.localhost
--state-dir .../tls --cert ... --key ... --ca-file <явно доверенный local cert>`.
После смены поколения на Docker Desktop/macOS **пересоздать ingress**, проверить
`nginx -t`, served fingerprint и trust с явным local CA. Atomic symlink rotation
на macOS не является production qualification; Linux/public CA runbook остаётся
[отдельным контрактом](certificate-lifecycle.md). Healthcheck ingress проверяет
локальный HTTPS listener/UI без CA trust; внешняя trust/SAN проверка обязательна
отдельно.

Preservation checkpoint: `preservation/2026-10-06-consolidation/manifest.json`
и per-volume `.tar`/contents/SHA256. Архивы содержат private data и защищены0700/0600;
они являются локальным сохранением, не encrypted/offsite production backup.
Все uncertain legacy/acceptance/bench volumes удерживаются `UNKNOWN/PRESERVE`.
По текущей проверке старые container shells отсутствовали **до начала изменений**;
их прежние writable layers восстановить/сохранить невозможно, причины отсутствия
не установлены. Manifest не утверждает сохранность этих layers.

Backup/restore: для работающей БД использовать consistent logical dump или
существующий [backup production workflow](backup-productionization.md), вместе со
storage и выбранным maintenance/quiesce contract. Не делать live PG tar backup.
Cold preservation archives сделаны с полностью остановленных volumes и проверены
на отдельной PG16 copy. Restore сначала квалифицировать на disposable copy; никогда
не запускать SQL inspection прямо на остановленном оригинале. Не накатывать старый
PG archive поверх canonical volume. Перед approved recovery остановить application,
сохранить текущее состояние, восстановить согласованные DB/storage в целевые
существующие preview volumes и вернуть `hc up -d --wait`. DB credential и JWT из
external config должны соответствовать восстановленной БД/принятому token cutover.

# HomeCloud — эксплуатационная диагностика

Этот runbook описывает наблюдаемость одного backend-процесса. Реализованные TLS/secrets/backup checkpoints и их boundaries перечислены в production-readiness-checkpoint.md. Финальный launch gate и operator checklist: [Final Production Acceptance](./final-production-acceptance.md); overall readiness NOT_READY.

## Запуск и health

Используйте действующие инструкции запуска проекта; для Compose проверяйте `hc ps`, затем `hc logs --tail=100 backend`. Не удаляйте volumes и не выполняйте restore как первый ответ на ошибку.

- `GET /api/v1/health` и `/api/v1/health/live` — совместимый liveness: процесс отвечает; доступность зависимостей не проверяется.
- `GET /api/v1/health/ready` — readiness: PostgreSQL и storage должны быть доступны. HTTP 200 означает готовность, HTTP 503 — деградацию; поле `checks` показывает `database` и `storage` без credentials и путей. Успешные JSON-ответы API сохраняют существующую обёртку `success/data`.
- Compose healthcheck backend использует readiness. `unhealthy` само по себе не перезапускает контейнер; `restart: unless-stopped` относится к завершению процесса. Startup зависит только от PostgreSQL.
- Redis настроен в Compose, но backend не создаёт Redis-клиент и не обращается к Redis. Он не входит в readiness и не хранит сессии/кэш приложения. Существующая startup-проверка `REDIS_PASSWORD` сохраняется как проверка конфигурации, а не проверка доступности Redis.

Readiness использует отдельное PostgreSQL-соединение: connection timeout 1 s, server statement timeout 1 s, client query timeout 1.5 s. Результат кэшируется на 1 s; параллельные запросы объединяются в одну проверку. HTTP-ожидание ограничено 3 s. При общем timeout оба dependency status консервативно возвращаются как `unavailable`; это не доказывает одновременный отказ БД и диска. Probe storage создаёт собственный эксклюзивный `.health-*` каталог и файл, проверяет чтение/запись и удаляет только эти артефакты в root и `.tmp`. Зависшее файловое I/O нельзя отменить этим deadline: один probe остаётся pending до ответа ОС, новые probe не накапливаются.

Readiness является моментальным ограниченным пробником, а не доказательством доступности каждого пользовательского файла, свободной квоты или восстановления backup. Не повышайте нагрузку частыми опросами; для обычного мониторинга достаточно текущего Compose-интервала 10 секунд.

## Корреляция и логи

Заголовок `X-Request-Id` возвращается для каждого HTTP-запроса. Клиент может передать ID из 1–64 символов `[A-Za-z0-9_-]`; отсутствующий, повторный/составной или недопустимый ID заменяется UUID. Заголовок разрешён и доступен через CORS. Используйте ID из ответа для поиска события запроса и связанных сообщений в `hc logs backend`. ID задаёт клиент и поэтому не является идентификатором пользователя или доказательством подлинности запроса.

Backend пишет JSON по одной записи на строку в stdout: timestamp, level, service, context, event/message, requestId при наличии контекста. Завершение HTTP содержит method, route/path, statusCode и durationMs; route является шаблоном, а неизвестный URL заменяется фиксированным маркером. Тела, query, заголовки Authorization/cookies, токены, passwords, содержимое файлов и сырые exception messages/stacks не записываются. Шаблон маршрута помогает диагностике без публикации имён файлов и share tokens. Сообщения вне запроса могут не иметь requestId.

Ожидаемые 4xx диагностируются как предупреждения; 5xx — как ошибки. Ищите рост групп ошибок, а не отдельный 401 при неверном логине. Продолжительность запроса включает передачу ответа; обрыв клиента учитывается отдельно от успешного завершения.

## Метрики

`GET /api/v1/metrics` выдаёт текст Prometheus. Без `METRICS_TOKEN` endpoint выключен; при включении требуется `Authorization: Bearer <METRICS_TOKEN>`. Не используйте JWT пользователя или share token как metrics credential. Передавайте секрет через действующий механизм конфигурации, не через URL и не в команды, попадающие в публичные отчёты. Production ingress/frontend запрещают публичные health/metrics endpoints. Scrape выполняется только по внутреннему backend HTTP из operator network; backend token-защита также обязательна. Backend port не публиковать.

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

## Независимое offsite / custody / measured budgets — 2026-10-02

Ненумерованная bounded remediation: [контракты, operator sequence и recovery objectives](./recovery-objectives.md), [raw qualification](./evidence/offsite-recovery/qualification.json). Local isolated target не является физическим внешним offsite. Раздельные итоговые статусы и фактические измерения фиксируются в qualification; overall **NOT_READY / NO_GO**. REAL_EXTERNAL_OFFSITE и REAL_CUSTODIAN_PROCESS остаются NOT_QUALIFIED, OWNER_APPROVED_RECOVERY_BUDGETS — NOT_AVAILABLE.

## Передача больших файлов

Backend authoritative limits: MAX_FILE_SIZE=1099511627776, MAX_TOTAL_SIZE=2199023255552 (active reservations per user), MAX_UPLOAD_CHUNKS=100000. Explicit0 для file/aggregate означает отсутствие отдельного cap; storageQuota0 остаётся нулевой ёмкостью. При увеличении MAX_CHUNK_SIZE согласовать оба proxy body limits (default51m для50МиБ). Перед обновлением выполнить additive migrations; legacy progress сохраняется и гидратируется один раз.

Планируйте server disk≈2S+concurrent ingress, source/download отдельно, и host backing Docker VM без предположения о немедленном reclaim. Browser download должен идти в native manager через same-origin HttpOnly cookie, production Secure/HTTPS; body/Authorization/cookies не логировать. На обоих proxy streaming download/complete response buffering off и max temp file0; read idle3600s, send/client idle300s. Native GET one-time/TTL120s; при возобновлении нужен fresh prepare.

Finalization bounded RAM, но удерживает transaction/session lock и делаетO(N) DB round trips; MIME text classifier может читать файл ещё раз. Session TTL default24h абсолютный. .tmp содержит working directories; terminal session DB records — history, не orphan chunks. После cleanup проверять отсутствие файлов внутри .tmp и правильную quota.

[Умеренный128МиБ E2E в IAB/Safari и ограничения](evidence/large-file-remediation-20261004/report.md): remediationPASS, `50_GIB_QUALIFICATION_STATUS = BLOCKED / UNQUALIFIED`. Этот результат не меняет production NO_GO и не заменяет полный50ГиБ qualification.

## Универсальное хранение и докачка

Список разрешённых MIME или расширений больше не управляет допуском к хранению. `ALLOWED_UPLOAD_MIME_TYPES` не ограничивает загрузку; определение содержимого используется для метаданных и выбора превью. Авторизация, принадлежность файла и папки, допустимость имени и пути, квота, пределы размера и числа частей, а также SHA-256 остаются обязательными проверками. Инфраструктурные ограничения настраиваются независимо от типов файлов.

Пауза сохраняет резерв квоты и принятые части до продолжения, отмены или истечения срока сессии. Приостановленную сессию не следует считать осиротевшими данными. `GET /uploads/session/:uploadId` возвращает проверенные по владельцу сведения о сессии и принятых частях без внутренних путей хранилища. Обнаружение сессий возвращает до 200 неистёкших загрузок в состояниях `pending/uploading`; постраничной выдачи пока нет. Локальные метаданные сохраняют все известные сессии в пределах доступной ёмкости localStorage; восстановление этих записей не создаёт HTTP-запросов или чтений файлов. Ограничение выдачи относится к серверным сессиям, отсутствующим в локальном списке.

Повторный выбор файла проверяет имя и размер, отпечаток выборки до 3 × 64 КиБ при его наличии и хеш каждой принятой части. Выборка не заменяет полный хеш исходного файла. WebCrypto требует защищённого контекста HTTPS или localhost. Safari использует обычный выбор файла. В метаданных загрузки нельзя хранить JWT, пароли или содержимое файлов.

Ошибка отмены остаётся неподтверждённой отменой с возможностью повторить запрос. Очистку проверяют по конкретным идентификаторам тестовых загрузок: отсутствие активного резерва, строк частей и временных файлов. Терминальные записи сессий в БД сохраняются как история. Если ответ финализации потерян, сначала сверяют состояние сессии: уже сохранённый файл не следует удалять через отмену загрузки.

Исторический Universal Storage & Upload UX checkpoint оставлял TLS-превью под `/private/tmp`. В Docker consolidation (2026-10-06) локальные TLS/env/challenges перенесены в постоянный operations root по началу этого runbook; публичная CA и macOS atomic rotation по-прежнему не квалифицированы. Исторический статус до повторного прогона: FAIL / REQUALIFICATION_REQUIRED. По отдельному разрешению владельца 2026-10-06 выполнены загрузка и скачивание полного файла 50 ГиБ через IAB с совпавшими SHA-256, восстановлением и очисткой; независимый review ACCEPT. [Отчёт и границы](evidence/browser-50gib-qualification-20261006/report.md). Для обычной работы 50 ГиБ автоматически не повторять; Safari50 ГиБ и public CA/production этим результатом не квалифицированы.
