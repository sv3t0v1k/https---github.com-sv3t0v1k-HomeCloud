# Production: контракт топологии

Это минимальный контракт одного узла, а не подтверждение готовности к публичному запуску. Phase 13, Observability и Failure/Security остаются COMPLETE; новая Phase не создаётся.

## Реальность и границы

| Компонент | Реализовано | Контракт / пробел |
|---|---|---|
| frontend | nginx, статические файлы, proxy `/api/` и `/socket.io/`, публикация `80:80` | Только за внешним TLS proxy; текущий порт доступен на всех интерфейсах и требует ограничения до открытия трафика |
| backend | NestJS, внутренний 3000, `unless-stopped` | Один экземпляр; readiness требует PostgreSQL и доступный storage; напрямую в интернет не публиковать |
| PostgreSQL | postgres:16-alpine, volume `db_data`, pg_isready | Внутренняя сеть; метаданные, пользователи и migrations; резервировать совместно со storage |
| storage | volume `storage_data`, `/storage` | Файлы и временные uploads; mount должен быть доступен UID 1001 и переживать замену образа |
| Redis | redis:7-alpine, volume `redis_data` | Настроен, но не требуется readiness/backend; не считать распределённым rate limiter или обязательным dependency |
| health/metrics | live, ready, защищённый Bearer metrics или 404 без токена | nginx сейчас проксирует весь API, включая health/metrics; внешний proxy должен ограничить служебные маршруты |
| migrations | отдельный TypeORM CLI, synchronize=false в production | Startup не запускает migrations; порядок задаёт release runbook |
| rollback | backup/restore, отдельного orchestration нет | Предыдущие immutable images и совместимость схемы обязательны для app rollback |
| secrets/config | production validator перед DB connect; startup storage check | Это baseline; ротация, доставка и хранение секретов остаются незавершёнными |

`uploads_data` объявлен, но не смонтирован. Только frontend публикует порт; db/redis/backend доступны в Docker bridge. DB/Redis не имеют явной restart policy; до запуска нужен операционный механизм восстановления после перезапуска узла и проверка этого сценария. Docker healthcheck сам по себе не перезапускает unhealthy service.

## Поддерживаемая схема

Интернет → внешний TLS reverse proxy → frontend nginx → backend → PostgreSQL + storage. Redis остаётся опциональным настроенным сервисом. Backup/restore запускается оператором на том же Docker host с доступом к Compose, DB и volume; backup нельзя считать offsite копией.

Frontend зависит от healthy backend; backend — от healthy db. Liveness подтверждает ответ процесса, readiness проверяет запрос к DB и чтение/запись storage. Readiness не проверяет версию схемы и не заменяет миграционный gate. После смены образа readiness и smoke обязательны; restart process-local метрик и лимитов ожидаем.

## Внешний proxy: обязательный следующий блок

TLS сертификат и его обновление, HTTP→HTTPS redirect, границы trusted proxy и очистка клиентских forwarded headers должны быть реализованы и проверены до публичного запуска. Сейчас nginx выставляет X-Real-IP, но Express trust proxy не настроен; доказательств корректного client IP за proxy нет. Нельзя считать process-local rate limits корректно привязанными к клиенту через proxy без отдельного теста.

Proxy должен пропускать uploads (51 MiB для chunk с multipart framing) и WebSocket, ограничивать прямой доступ к frontend HTTP и backend, закрывать metrics от публики. Health доступен оператору; public policy должна исключить ненужное раскрытие состояния dependencies. Secure headers частично задаёт backend middleware; TLS proxy отвечает за HTTPS/HSTS и проверку итоговых заголовков. Не доверять произвольным X-Forwarded-* от интернета.

## Конфигурация

Production отвергает отсутствующие/очевидно слабые JWT_SECRET и JWT_REFRESH_SECRET (разные, минимум 32 символа), DB password в DATABASE_URL (минимум 16), несогласованный DB_PASSWORD, слабый заданный METRICS_TOKEN (минимум 32), относительный STORAGE_PATH, неверный FRONTEND_URL (HTTPS origin без credentials, query/path и localhost). Ошибки validator содержат имена параметров, не значения. Это эвристика, а не доказательство энтропии; секреты генерирует CSPRNG. Без METRICS_TOKEN endpoint намеренно отключён. Dev/test удобства не являются production контрактом.

Compose собирает DATABASE_URL из DB_PASSWORD без URL encoding: для этой сборки пароль должен быть URL-safe, либо deployment override должен задавать корректно encoded DATABASE_URL. Не печатать `docker compose config` с resolved secrets в общедоступный лог; для проверки использовать `config --quiet`.

## Непокрытые условия go-live

TLS/proxy и client IP trust; жизненный цикл секретов (доставка, доступ, ротация, отзыв, recovery); encrypted/offsite backup; retention и alerting; проверка recovery узла; реальный rollback между двумя версиями и smoke через окончательный public ingress. JWT access после logout действителен до TTL; rate limits и metrics process-local; post-commit unlink может оставить orphan. Эти ограничения должны быть приняты владельцем, а не скрыты статусом checkpoint.
