# Релиз, migrations и rollback

Контракт: один узел, maintenance window, без обещания zero downtime. Публичный трафик закрыт на внешнем ingress до окончательного acceptance. Команды ниже — runbook для назначенного deployment, не инструкция запускать их на пользовательских данных в рамках checkpoint.

## Входы и immutable artifacts

Оператор фиксирует commit, результаты full gates, новый и предыдущий backend/frontend image digest, конфигурацию без раскрытия секретов, schema compatibility decision и пару DB/storage backup. Образы уже собраны/проверены; target registry availability требует отдельной qualification. Исполняемый локальный контракт и guarded override: [неизменяемый manifest](./release-manifest.md). На deployment не пересобирать их из меняющегося checkout.

Рабочий deployment каталог — защищённый checkout выбранного release commit: здесь находятся docker-compose.production.yml, deploy/ingress/, scripts/backup.sh, scripts/restore.sh, scripts/reconcile.py, backend/package.json и release-images.yml. Production secrets находятся только во внешнем файле. Release команды ниже выполняются из этого корня; recovery helpers поддерживают произвольный CWD через [единый внешний config](./backup-productionization.md#единый-внешний-config-для-recovery-helpers). Каталог с одними Compose файлами недостаточен:

```yaml
services:
  backend:
    image: ${RELEASE_BACKEND_IMAGE:?immutable backend digest required}
  frontend:
    image: ${RELEASE_FRONTEND_IMAGE:?immutable frontend digest required}
```

Значения — `registry/path@sha256:…`, не mutable tags. Предыдущая пара записана целиком в previous manifest; два ID вручную не подбирать. Локальный qualified override использует полные image IDs, build: !reset null и pull_policy:never; registry режим helper связывает обе repository@digest в один manifest, сбрасывает build и задаёт pull_policy:always; внешний production registry требует отдельной qualification. Production Compose не использует фиксированные container_name. Статические proxy subnet/IP нельзя параллельно повторять на одном host. Исходный docker-compose.yml остаётся legacy/development, не production override; не смешивать эти файлы. При переходе сохранить COMPOSE_PROJECT_NAME и реальные volume names, сверить существующие data mounts; смена project name создаёт пустые volumes, а не переносит данные. Внешний ingress maintenance должен оставаться закрытым даже при старте frontend скриптом restore.

```bash
export HOMECLOUD_ENV_FILE=/secure/homecloud/recovery.env
SCRIPT_DIR="$PWD/scripts"
# Loader экспортирует проверенные settings и обёртку Compose без auto dotenv.
source "$SCRIPT_DIR/recovery-config.sh"
export COMPOSE_FILE="$PWD/docker-compose.production.yml:$PWD/release-images.yml"
export COMPOSE_PROJECT_NAME=homecloud
# release-images.yml генерирует guarded manifest helper; порядок ниже — registry runbook boundary.
# PUBLIC_HOST — lowercase bare hostname; TLS_CERT_DIR содержит fullchain.pem/privkey.pem.
# FRONTEND_URL в production Compose выводится из PUBLIC_HOST как HTTPS origin.
docker compose config --quiet
docker compose pull backend frontend
```

COMPOSE_FILE/PROJECT_NAME сохраняются и для backup/restore, которые вызывают Compose без `-f`. External config, project и volume names должны совпадать с существующей установкой. Перед первой установкой storage volume подготавливается с правами UID 1001; readiness fail закрывает релиз при неверных правах.

## Последовательность и blocking gates

1. Закрыть ingress, завершить активные записи/uploads, остановить backend и frontend. DB остаётся доступной. Это обеспечивает согласованную пару DB/storage; backup сам не гарантирует согласованность при параллельных записях.
2. Сделать backup, проверить выбранную пару и сохранить previous image digests. BACKUP_DIR — приватный каталог с единственным выбранным комплектом `.meta`, DB dump и storage archive для данного checkpoint; restore выбирает последнюю metadata, а не принимает ID.

```bash
docker compose stop frontend backend
BACKUP_DIR="$RELEASE_BACKUP_DIR" BACKEND_IMAGE="$PREVIOUS_BACKEND_IMAGE" bash scripts/backup.sh --yes
BACKUP_DIR="$RELEASE_BACKUP_DIR" BACKEND_IMAGE="$PREVIOUS_BACKEND_IMAGE" bash scripts/restore.sh --validate-only
```

Скрипты используют обязательный внешний recovery config; секреты не передаются аргументами. Backup helper image должен иметь необходимые tar/sh. Успешный validate-only подтверждает integrity и входы, но не заменяет реальный restore drill.

3. Проверить production config новым image, не запуская приложение/DB connect:

```bash
docker compose run --rm --no-deps --entrypoint node backend -e 'require("./dist/common/production-config").validateProductionConfig(process.env)'
```

4. Убедиться, что DB healthy; показать pending migrations новым image и сопоставить точный список с reviewed manifest. Ненулевой CLI exit — стоп. `migration:show` сам по себе не означает отсутствие pending: `[ ]` — ожидающие, `[X]` — применённые.

```bash
docker compose up -d db
docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose run --rm --no-deps --entrypoint node backend node_modules/typeorm/cli.js migration:show -d dist/data-source.js
```

5. Применить только reviewed migrations отдельным job, пока приложения остановлены:

```bash
docker compose run --rm --no-deps --entrypoint node backend node_modules/typeorm/cli.js migration:run -d dist/data-source.js --transaction all
docker compose run --rm --no-deps --entrypoint node backend -e '(async()=>{const d=require("./dist/data-source").default;try{await d.initialize();if(await d.showMigrations())process.exitCode=1}finally{if(d.isInitialized)await d.destroy()}})().catch(()=>{console.error("Migration verification failed");process.exitCode=1})'
```

CLI migration errors могут содержать SQL/data: только защищённый operator log, не public CI. Startup не auto-runs migrations. Transaction all — защита SQL в транзакции, не гарантия обратимости данных или внешних effects. Destructive/schema migrations всегда требуют backup и явного решения о совместимости старого backend после apply.

6. Запустить backend immutable image, без build; проверить live/ready внутри сети, protected/disabled metrics и writable storage через readiness. Нездоровый backend блокирует frontend rollout.

```bash
docker compose up -d --no-build --no-deps backend
docker compose exec -T backend node -e 'fetch("http://localhost:3000/api/v1/health/ready").then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))'
docker compose up -d --no-build --no-deps frontend
# Внешний operator maintenance barrier ещё закрыт; запуск ingress его не заменяет.
docker compose up -d --no-build --no-deps ingress
docker compose exec -T frontend nginx -t
docker compose exec -T ingress nginx -t
```

7. Runtime gate live/ready/metrics выполнять по внутреннему backend HTTP из operator/orchestrator network, а не public ingress (nginx закрывает эти маршруты даже оператору с token). Не публиковать backend port ради gate. Через TLS operator ingress при закрытом public traffic выполнить representative smoke: register/login тестового аккаунта, upload, download exact bytes/checksum, quota/metadata consistency. Зафиксировать cleanup smoke данных. Новый frontend должен корректно обращаться к `/api/v1` и WebSocket. Release acceptance window: минимум 15 минут наблюдения readiness, ошибок, latency и disk; любое подтверждённое отклонение блокирует открытие.
8. Открыть трафик только после всех blocking checks и отдельного go-live допуска TLS/secrets/offsite backup. Сам Architecture & Release checkpoint такого допуска не даёт.

## Что проверяет release-gate.cjs

```bash
NODE_ENV=production node scripts/release-gate.cjs config
node scripts/release-gate.cjs artifact
node scripts/release-gate.cjs migrations
RELEASE_BASE_URL="$INTERNAL_BACKEND_BASE_URL" node scripts/release-gate.cjs runtime
```

| Проверка | Blocking смысл / предел |
|---|---|
| config | Production mode и общая ранняя validation; не доказывает entropy/lifecycle секретов или наличие TLS |
| artifact | Нет tracked diff к HEAD, присутствуют backend/frontend dist и compiled migrations; не доказывает clean build/provenance, игнорирует untracked files |
| migrations | С environment целевой DB нет pending migrations; не проверяет совместимость или backup |
| runtime | live/ready 200; metrics без токена 401 или отключены 404; не проверяет TLS, smoke, backup или authorized metrics scrape |
| Отдельные release evidence | Full suite/build/typecheck/lint, immutable manifest, backup validation, rollback inputs, smoke и monitoring window обязательны независимо от PASS helper |
| Advisory | Прежние lint warnings, process-local metrics/reset; принять письменно или исправлять отдельным блоком |

Gate migrations запускается из окружения с DATABASE_URL, CLI не читает deployment .env автоматически. Для Docker deployment эквивалент — проверка d.showMigrations выше; не переносить live DB credentials в аргументы. Artifact gate исполняется на release build checkout до packaging. Все gate PASS узкие: суммарного автоматического разрешения public traffic нет.

## Rollback и отказ migrations

| Сценарий | Действие |
|---|---|
| Backend regression, схема совместима | Закрыть ingress; остановить backend/frontend; вернуть previous backend digest, сохранить согласованный frontend; redeploy, readiness/smoke; затем acceptance |
| Frontend regression | Вернуть previous frontend digest, только если совместим с текущим API; redeploy без изменения DB/storage; smoke |
| Migration failed до app rollout | Оставить трафик закрытым; проверить transaction/migrations table/schema; не запускать app до решения. При полной отмене SQL допустим previous artifact, иначе corrective migration или paired restore |
| Schema applied и old backend несовместим | Предпочесть reviewed roll-forward. Нельзя просто вернуть image или автоматически migration:revert; down существует не как доказательство безопасного rollback |
| Data/storage corruption suspicion | Остановить записи; сохранить forensic snapshot отдельно; восстановить проверенную парную DB/storage копию в recovery окружении, сверить строки/quota/checksums; согласовать потерю записей после backup |

App/frontend rollback с совместимой схемой:

```bash
docker compose stop frontend backend
# APPLIED_MIGRATIONS — свежий JSON array migrations.name из DB (см. manifest runbook).
node scripts/release-manifest.cjs override --manifest "$PREVIOUS_MANIFEST" --source-root "$PREVIOUS_SOURCE" --source-commit "$PREVIOUS_COMMIT" --compatibility-manifest "$CURRENT_MANIFEST" --applied-migrations "$APPLIED_MIGRATIONS" --output "$RELEASE_IMAGES"
# При nonzero остановиться; stale override не использовать.
export COMPOSE_FILE="$RELEASE_SOURCE/docker-compose.production.yml:$RELEASE_IMAGES"
docker compose config --quiet
docker compose up -d --no-build --no-deps backend
# readiness и smoke backend до следующей команды
docker compose up -d --no-build --no-deps frontend
# runtime gate, frontend smoke и acceptance window; ingress ещё закрыт
```

Qualified rollback возвращает полную manifest pair. Отдельный frontend-only откат требует отдельной compatibility qualification и этим drill не доказан. Не менять DB major version как часть application rollback.

Paired restore выполняется с выбранной предыдущей парой images и выбранным каталогом backup:

```bash
BACKUP_DIR="$RELEASE_BACKUP_DIR" BACKEND_IMAGE="$PREVIOUS_BACKEND_IMAGE" bash scripts/restore.sh --validate-only
BACKUP_DIR="$RELEASE_BACKUP_DIR" BACKEND_IMAGE="$PREVIOUS_BACKEND_IMAGE" bash scripts/restore.sh --yes
```

Restore разрушительно заменяет DB/storage; требуется явный recovery decision. Существующий restore запускает backend ДО migration:run, а некоторые failure ветки вызывают compose up: внешний ingress обязательно закрыт вне зависимости от exit code. После restore вручную проверить migrations, readiness, DB/storage reconciliation и bytes; при failure остановить backend/frontend. Нельзя считать этот restore безопасным для открытого трафика. Релиз не должен удалять volumes; `down -v` в production запрещён.

## Drill и пределы доказательства

`python3 scripts/tests/release-rollback-runtime.py` создаёт отдельный PostgreSQL container, временный storage и production backend с временными credentials. Выполняет CLI show/run до app, отсутствие pending, register/upload/download, остановку приложения и контролируемый процесс exit 42, возврат того же compiled artifact, сравнение DB snapshot и bytes, runtime gate и удаление своего container. JSON evidence печатается с временным путём.

Это recovery drill того же artifact, не доказательство previous-version rollback, frontend rollback, TLS ingress, rollback destructive migration или восстановления backup. Результаты и фактический путь evidence фиксируются отдельно checkpoint; выполнение скрипта требуется для заявления PASS. Failure/Security restore evidence сохраняется отдельным ранее завершённым checkpoint.

## TLS ingress gate

Перед открытием трафика проверить `nginx -t` в frontend/ingress, hostname validation, публичный HTTP308 и HTTPS certificate chain/hostname/expiry, отсутствие HSTS на HTTP, secure headers на HTTPS, private health/metrics и spoofed forwarded headers. Ingress не подключён к backend_proxy, frontend/backend не имеют published ports. Проверенный локальный harness `python3 scripts/tests/tls-proxy-runtime.py` использует disposable self-signed certificate и отдельные ресурсы; точные prerequisites описаны в его docstring. Это не подтверждает public CA provisioning или recovery конечного production узла. Maintenance barrier остаётся отдельным operator input: обычная ingress конфигурация сама его не реализует.

## Backup productionization: follow-up

До go-live: encryption at rest и независимая offsite копия пары DB/storage; ограниченный доступ операторов/backup identity, сохранность ключа и проверяемое recovery ключа; политика retention/RPO/RTO, мониторинг возраста последней успешной копии и alert failure; scheduled backup при согласованном write barrier; регулярный isolated restore с checksums, quota и migration/schema verification. Минимум ежемесячный drill и после изменения backup/restore, с владельцем и журналом результата; окончательные RPO/RTO утверждает владелец.

Incremental backup — отдельный выбор по объёму и RPO, допустимое улучшение после go-live при доказанной достаточности full backup. Локальные retention defaults (7 дней, минимум 2 копии) не являются утверждённой production политикой. Offsite/encryption/secrets lifecycle здесь не реализованы; TLS/proxy baseline реализован отдельным checkpoint, public certificate lifecycle остаётся operator obligation; общий статус production остаётся NOT_READY.

## Secret Lifecycle baseline

Production delivery, generation, custody, maintenance rotation и rollback определены в [secret lifecycle](./secret-lifecycle.md). Использовать только явный external env-file 0600 в каталоге0700, quiet Compose validation и recreate consumers. Runtime environment доступен Docker/root администраторам. JWT planned cutover явно инвалидирует старые tokens; DB env change не изменяет password существующей role. Overall readiness остаётся NOT_READY; public CA lifecycle и encrypted/offsite recovery этим контрактом не закрыты.


Полная локальная immutable-pair qualification выполняется `scripts/tests/release-pair-runtime.py`; контракт, schema guard, exact source checkpoints и честные границы описаны в [manifest runbook](./release-manifest.md). Это дополняет исторический same-artifact drill, не меняет его доказательства. Общий go-live статус остаётся NOT_READY / NO_GO.


Registry rollout/rollback выполняется по [digest contract](./release-manifest.md#registry-digest-contract): сначала `prepare` всей выбранной пары, затем live schema guard/quiet Compose validation, maintenance barrier и app transition с обязательным `docker compose up --pull never --no-build --no-deps` после prepare (backend → readiness → frontend). Повторный сетевой pull после stop запрещён. При failed pull active backend/frontend не останавливать. Credentials вне repo; новая Phase не создаётся.
