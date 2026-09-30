# Production: контракт топологии

Это минимальный контракт одного узла, а не подтверждение готовности к публичному запуску. Phase 13, Observability и Failure/Security остаются COMPLETE; новая Phase не создаётся.

## Реальность и границы

| Компонент | Реализовано | Контракт / пробел |
|---|---|---|
| frontend | nginx, статические файлы, proxy `/api/` и `/socket.io/`, публикация `80:80` | В standalone production Compose без published port, только за ingress; исходный docker-compose.yml остаётся development/legacy конфигурацией с 80:80 |
| backend | NestJS, внутренний 3000, `unless-stopped` | Один экземпляр; readiness требует PostgreSQL и доступный storage; напрямую в интернет не публиковать |
| PostgreSQL | postgres:16-alpine, volume `db_data`, pg_isready | Внутренняя сеть; метаданные, пользователи и migrations; резервировать совместно со storage |
| storage | volume `storage_data`, `/storage` | Файлы и временные uploads; mount должен быть доступен UID 1001 и переживать замену образа |
| Redis | redis:7-alpine, volume `redis_data` | Настроен, но не требуется readiness/backend; не считать распределённым rate limiter или обязательным dependency |
| health/metrics | live, ready, защищённый Bearer metrics или 404 без токена | Production ingress и frontend возвращают 404 для health/metrics; probes/scrape обращаются непосредственно к backend из приватной сети, metrics дополнительно требует Bearer |
| migrations | отдельный TypeORM CLI, synchronize=false в production | Startup не запускает migrations; порядок задаёт release runbook |
| rollback | backup/restore, отдельного orchestration нет | Предыдущие immutable images и совместимость схемы обязательны для app rollback |
| secrets/config | production validator перед DB connect; startup storage check | Это baseline; ротация, доставка и хранение секретов остаются незавершёнными |

В исходном docker-compose.yml `uploads_data` объявлен, но не смонтирован; только frontend публикует порт. В отдельном docker-compose.production.yml публикуется только ingress 80/443; db/backend/frontend без host ports. Production backend/db и frontend/backend используют internal Docker networks, ingress не подключён к backend network. DB/Redis не имеют явной restart policy; до запуска нужен операционный механизм восстановления после перезапуска узла и проверка этого сценария. Docker healthcheck сам по себе не перезапускает unhealthy service.

## Поддерживаемая схема

Интернет → внешний TLS reverse proxy → frontend nginx → backend → PostgreSQL + storage. Redis остаётся опциональным настроенным сервисом. Backup/restore запускается оператором на том же Docker host с доступом к Compose, DB и volume; backup нельзя считать offsite копией.

Frontend зависит от healthy backend; backend — от healthy db. Liveness подтверждает ответ процесса, readiness проверяет запрос к DB и чтение/запись storage. Readiness не проверяет версию схемы и не заменяет миграционный gate. После смены образа readiness и smoke обязательны; restart process-local метрик и лимитов ожидаем.

## Исполняемая TLS / proxy граница

Production запускается отдельным `docker-compose.production.yml`, а не merge override исходного файла. Интернет → nginx ingress TLS → frontend nginx HTTP → backend HTTP. Ingress публикует только 80/443; HTTP возвращает 308 на канонический HTTPS hostname. `PUBLIC_HOST` — только lowercase bare DNS hostname без port/path, валидируется entrypoint до envsubst. HTTPS с чужим Host возвращает 421. TLS 1.2/1.3; оператор предоставляет `TLS_CERT_DIR/fullchain.pem` и `privkey.pem`, доступные nginx read-only. Выдача публичного CA сертификата, безопасная доставка private key и renewal остаются deployment obligations; self-signed smoke их не доказывает.

| Переход | Доверенный socket source | Что передаётся |
|---|---|---|
| ingress → frontend | `172.29.0.10` в `ingress_frontend` (`172.29.0.0/24`) | Ingress полностью перезаписывает XFF socket IP клиента, XFP=https, XFH/Host=PUBLIC_HOST |
| frontend → backend | `172.30.0.10` в `backend_proxy` (`172.30.0.0/24`) | Frontend real_ip доверяет только ingress; передаёт один вычисленный client IP, authoritative proto/host |
| direct → backend | любой иной адрес | Forwarded authority удаляется; client IP/protocol берутся из socket; RFC7239 Forwarded не используется |

Backend `TRUSTED_PROXY_IP` допускает только один literal IP; unset означает no trust. `true`, hop count, CIDR и private subnet trust не используются. В production Compose значение равно точному адресу frontend. Config валидируется до DB initialization. Multi-hop/malformed XFF от trusted socket не принимается: весь forwarded authority сбрасывается. Добавление CDN/другого proxy требует отдельного пересмотра контракта. Сети и статические адреса должны быть свободны на host; root/Docker administrator и контроль deployment config входят в доверенную границу. Docker internal network не защищает от администратора Docker.

Все существующие IP лимиты используют общий `clientIp`: IPv4-mapped IPv6 объединяется с IPv4, IPv6 canonicalized. Process-local stores сохранены. IP logging раньше не было и не добавлено; request ID проходит оба proxy. IP labels/forwarded chains в metrics/logs не добавлены. Frontend использует same-origin `/api/v1`, share URL строится от HTTPS window origin; production build не должен задавать cross-origin VITE_API_URL.

HSTS max-age=31536000 выставляется только HTTPS ingress, без includeSubDomains/preload. Backend HTTP HSTS отключён. Ingress задаёт nosniff, strict-origin-when-cross-origin, DENY/frame-ancestors none, Permissions-Policy camera/microphone/geolocation disabled. CSP: same-origin JS/CSS/connect, fonts self+data (встроенные Vite subsets), data/blob images и blob media, inline styles для текущего UI; object-src none, base-uri/form-action self. Policy не объявляется защитой от всех XSS. Secure headers распространяются на HTTPS ошибки; HTTP redirect не содержит HSTS.

Оба nginx закрывают case-insensitive health/metrics и нормализованные slash/path варианты. Public liveness в этом контракте отсутствует; external monitor проверяет HTTPS `/`, а internal orchestrator проверяет `/api/v1/health/live` и `/api/v1/health/ready` напрямую. Metrics не маршрутизируется наружу даже с token; internal scrape сохраняет METRICS_TOKEN, 401 без/с неверным token и 404 при disabled token. Доступ к internal network ограничивается operator/orchestrator, readiness dependency details наружу не выходят.

## Конфигурация

Production отвергает отсутствующие/очевидно слабые JWT_SECRET и JWT_REFRESH_SECRET (разные, минимум 32 символа), DB password в DATABASE_URL (минимум 16), несогласованный DB_PASSWORD, слабый заданный METRICS_TOKEN (минимум 32), относительный STORAGE_PATH, неверный FRONTEND_URL (HTTPS origin без credentials, query/path и localhost). Ошибки validator содержат имена параметров, не значения. Это эвристика, а не доказательство энтропии; секреты генерирует CSPRNG. Без METRICS_TOKEN endpoint намеренно отключён. Dev/test удобства не являются production контрактом.

Оба Compose файла собирают DATABASE_URL из DB_PASSWORD без URL encoding: для этой сборки пароль должен быть URL-safe, либо deployment override должен задавать корректно encoded DATABASE_URL. Не печатать `docker compose config` с resolved secrets в общедоступный лог; для проверки использовать `config --quiet`.

## Непокрытые условия go-live

Жизненный цикл секретов (доставка, доступ, ротация, отзыв, recovery); encrypted/offsite backup; retention и alerting; проверка recovery узла; реальный rollback между двумя версиями и smoke через окончательный public ingress. JWT access после logout действителен до TTL; rate limits и metrics process-local; post-commit unlink может оставить orphan. Эти ограничения должны быть приняты владельцем, а не скрыты статусом checkpoint.
