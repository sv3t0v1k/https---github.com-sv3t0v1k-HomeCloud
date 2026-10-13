# Запуск HomeCloud через Docker Compose

На Mac основной файл — `docker-compose.yml`. Он запускает PostgreSQL, backend и
frontend на http://localhost:8080. Redis отключён; TLS для ежедневной работы не нужен.
`docker-compose.local.yml` — только opt-in API port для Vite HMR.
`docker-compose.production.yml` — Linux override с TLS и SSD DB/HDD files.
Это подготовка конфигурации: mini-PC и физические диски не квалифицированы,
production **NOT_READY / NO_GO**, SSD uploads **OFF**. COMPLETE не установлен.

## Первый запуск на новом Mac

Docker Compose >=2.24.4 нужен для production `!override` ([правила merge](https://docs.docker.com/reference/compose-file/merge/)).
Выполнять из корня репозитория. Следующая подготовка предназначена для **новой** БД;
при существующем `.env`/БД не заменять DB credentials новыми.

```sh
# Команда не перезаписывает существующий .env.
(umask 077; test -e .env || cp .env.example .env)
python3 - <<'PYENV'
from pathlib import Path
import secrets
p = Path('.env')
s = p.read_text()
for key in ('DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'REDIS_PASSWORD'):
    s = s.replace(key + '=\n', key + '=' + secrets.token_hex(32) + '\n')
p.write_text(s)
p.chmod(0o600)
PYENV
# Никогда не публиковать вывод config без --quiet: он содержит секреты.
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose ps
```

Новые named volumes автоматически получают `/storage` и `.tmp` UID1001/mode0700
через copy-up из image. Existing volumes не chown'ятся и не очищаются. Нет `VOLUME`
в Dockerfile, fixed container names и fixed external volume names. С project
`homecloud-preview` используются прежние `homecloud-preview_db_data` и
`homecloud-preview_storage_data`; смена project выбирает другую БД/storage.
Docker Desktop сохраняет данные внутри своей Linux VM, а не на отдельном HDD.

Image собирает native addon внутри Linux под текущую архитектуру. Не переносить
Mac `node_modules` или `.node` в Linux; bind source code поверх `/app` не нужен.
Backend entrypoint выполняет `migration:run --transaction all` перед API только
при стандартной команде `node dist/main.js`. Ошибка останавливает startup. Helper
команды `sh`, `node -e`, `npm run migration:run` не запускают скрытых миграций.
На startup приложение выполняет штатную cleanup expired/orphaned legacy sessions.

## Обновление и ежедневная работа

```sh
# При изменении кода/config: writers остановить ДО migration и build/up.
docker compose stop frontend backend
docker compose up -d --build --wait --wait-timeout 180
# Сохранить контейнеры/volumes и штатно перезапустить процесс:
docker compose restart backend frontend
# Штатная остановка/возобновление:
docker compose stop
docker compose start --wait
# Readiness внутри backend, закрыта снаружи nginx:
docker compose exec -T backend node docker/healthcheck.cjs
docker compose logs --tail=80 backend
```

`restart` не применяет новую env/config/image. Не запускать два backend writers
или миграцию параллельно API. Перед destructive migration/restore или удалением
volumes требуется отдельное разрешение владельца и согласованный backup contract.
`down -v`, `prune`, удаление/пересоздание БД и чужих ресурсов не входят в эти команды.

Для **существующего Mac baseline** использовать прежние DB_NAME/DB_USER/password
и JWT из защищённого runtime env; dev требует дополнительно непустой
REDIS_PASSWORD (генератор выше, приложение Redis не использует). Не менять пароль
PostgreSQL только через env: existing PG volume не сбрасывает credentials.
Старый TLS ingress после перехода на HTTP не нужен; если он запущен, отдельно
остановить только `homecloud-preview-ingress-1`. Старые networks/volumes не prune.
Завершённые датированные TLS/50GiB checkpoints остаются историей, не текущим стартом.

## Vite HMR и Redis — опционально

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Vite http://localhost:5173 проксирует `/api` и `/socket.io` в localhost:3000.
API port3000 согласован с Vite proxy; конфигурируемый port отдельно не объявляется.
Вернуться к одному основному Compose — `docker compose up -d --wait`, затем проверить
отсутствие backend опубликованного порта. Публичные health/metrics routes nginx закрыты.
Mac не доверяет forwarded client headers; IP rate-limit за nginx общий для локального
пользователя. Production ниже доверяет одному exact frontend peer.

```sh
# Redis не хранит sessions приложения, не входит в readiness, не обязателен.
docker compose --profile redis up -d --wait redis
```

Пароль Redis должен быть hex минимум32символа. Его лимит256MiB включает контейнер;
не использовать этот опциональный сервис как неограниченный production cache.

## Первый пользователь и квота

Экран поддерживает login, регистрация выполняется API. Новому пользователю
назначается **нулевая квота**; upload заработает только после назначения оператором.

```sh
# Ввод пароля без сохранения literal в shell history (>=8символов).
read -r HC_EMAIL
read -rs HC_PASSWORD; echo
export HC_EMAIL HC_PASSWORD
python3 - <<'PYUSER' | curl -fsS http://localhost:8080/api/v1/auth/register \
  -H 'Content-Type: application/json' --data-binary @- -o /dev/null
import json, os
print(json.dumps(dict(email=os.environ['HC_EMAIL'], password=os.environ['HC_PASSWORD'], name='Local test')))
PYUSER
unset HC_PASSWORD
# Выбрать ровно свою строку по email; пример квоты1GiB.
# Не менять password hashes, storageUsed, чужие users или upload journal.
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh \
  -v ON_ERROR_STOP=1 -v user_email="$HC_EMAIL" <<'SQL'
SELECT id AS hc_user_id FROM users WHERE email=:'user_email' \gset
UPDATE users SET "storageQuota"=1073741824
WHERE id=:'hc_user_id' AND email=:'user_email';
SQL
unset HC_EMAIL
```

Для назначения квоты удобно открыть интерактивный `psql`, проверить выбранную строку
и выполнить UPDATE с точными id+email. Quota API/администраторские роли отсутствуют.
Login UI: http://localhost:8080/login. Из браузера upload/download используют тот же origin.

## Подготовка Linux mini-PC: SSD DB → HDD permanent storage

Основной Compose + production override, env вне repo, mode0600:

```sh
hcp() {
  docker compose --project-name homecloud --env-file /etc/homecloud/runtime.env \
    -f docker-compose.yml -f docker-compose.production.yml "$@"
}
hcp config --quiet
# Дальнейшие команды только ПОСЛЕ отдельного разрешения и host enrollment:
hcp build backend frontend
hcp run --rm --no-deps backend node dist/storage/bootstrap-storage-identity.js
hcp up -d --wait --wait-timeout 180
hcp ps
```

Это инструкция для будущего оператора; на mini-PC в этой задаче ничего не выполняется.
`SSD_DB_DIR` — existing directory на фактическом SSD; `HDD_STORAGE_DIR` — existing
exclusive HDD directory с `.tmp`. Проверить host filesystem/mount source/failure domain,
Docker daemon host, доступ backend UID1001 и root/.tmp mode0700. Bind mounts имеют
`create_host_path:false`, чтобы не создать пустой fallback на системном диске.
Но **наличие каталога не доказывает смонтированный HDD**: оператор проверяет mount и
источник перед каждым запуском. Контейнерный marker не доказывает физическую identity.
PostgreSQL image сам готовит права PGDATA; не назначать DB directory UID1001 backend.

Production bootstrap marker — отдельная команда от UID1001 только на уже проверенном
mount, только при отсутствии marker; existing correct marker не переписывать. Код
никогда не auto-chown/auto-enroll'ит HDD. После restore marker/source проверяются отдельно.
TLS lifecycle directory содержит `current/fullchain.pem` и `current/privkey.pem`;
внешний оператор обеспечивает выдачу/renewal, DNS и сертификаты. См.
[certificate lifecycle](certificate-lifecycle.md) и [registry](storage-registry-operations.md).
TLS healthcheck не квалифицирует CA/DNS. Frontend host port полностью удалён prod override.

Exact trust chain: ingress → frontend → backend. BACKEND_PROXY_SUBNET/FRONTEND_PROXY_IP
и INGRESS_SUBNET/INGRESS_PROXY_IP должны быть согласованы и не пересекать host/VPN/Docker.
Не заменять exact trust на wildcard/CIDR/hop count. Внутренние health/metrics не публикуются.

Migration520 enroll'ит immutable DB legacy temp root `/storage/.tmp` и optional SSD path
**при первом выполнении**. Здесь SSD path не передаётся, admission остаётся legacy-only.
517 registry row сама по себе не включает SSD uploads. Позднее добавить env+ON и повторить
`migration:run` недостаточно: 520 уже применена. Нужен отдельный проверенный enrollment
procedure/migration, Linux native source identity и recovery qualification.
UPLOAD_SSD_RECOVERY_MODE=manual, SSD mapping отсутствует, feature OFF в обоих вариантах.
HDD хранит и chunks, и готовые files; SSD→HDD upload pipeline пока не активируется.

RAM8GiB: конфигурационные ceilings backend4GiB + DB1GiB + frontend256MiB + ingress128MiB,
optional Redis256MiB. Это не измеренные RSS и не гарантия50GiB/параллельных uploads.
Остаётся headroom для OS/page cache/daemon; на Docker Desktop отдельно выделить VM RAM.
Не менять лимиты или параллельность по догадке; требуется измерение на target.

## D1 backup/restore

D1 scripts используют **external** absolute env file mode0600, COMPOSE_FILE absolute
colon-separated список и COMPOSE_PROJECT_NAME. Репозиторный `.env` ими не принимается.
Скопировать env во внешнее защищённое место. Изменить существующий COMPOSE_PROJECT_NAME
(не добавлять второй ключ); добавить COMPOSE_FILE и STORAGE_PATH (paths под свой checkout):

```dotenv
COMPOSE_FILE=/Users/aleksejkozemakin/Desktop/HomeCloud/docker-compose.yml
COMPOSE_PROJECT_NAME=homecloud-preview
STORAGE_PATH=/storage
```

Для Linux COMPOSE_FILE включает main:production. Recovery allowlist расширен canonical
Compose knobs; реальные values должны совпадать с активными контейнерами. Явный
backend.image, image ID/config hash и фактический mount source проверяет D1; external
volume names и STORAGE_VOLUME не являются альтернативными restore targets.
[Backup contracts](backup-and-restore.md), [D1 evidence](evidence/d1-backup-restore-20261013/report.md).
Backup/restore требует maintenance write barrier; pending SSD recovery отвергается.
В этой задаче destructive restore не запускается.


Production release qualification не переносится с прежних standalone manifests.
Новый release helper учитывает canonical main+production checksum; старые checksums
с новым helper не проходят source-qualified validation даже на прежнем source root.
Формат/schema/image-only validation сохраняются; исторические archives требуют своего
старого helper либо отдельной адаптации и requalification. `release-pair-runtime.py`
и `final-production-e2e.py` не квалифицированы для новой topology. Daily Mac smoke
проверяет dev images; immutable production pair, deployment/rollback/offsite остаются
отдельным gate, production NO_GO. Для будущего Linux rollout использовать проверенные
неизменяемые release images вместо Mac `:dev` tags.
