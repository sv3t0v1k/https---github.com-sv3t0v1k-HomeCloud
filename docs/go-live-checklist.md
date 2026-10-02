# Операторский пакет deploy / rollback / recovery

2026-10-02, Asia/Vladivostok. **PREP; NOT_READY / NO_GO**. Это самостоятельный entry point, не разрешение открывать traffic. [Единственный внешний checklist](./external-input-master-checklist.md) обязателен. Никакая локальная fixture не закрывает реальные inputs. Команды production выполняет назначенный оператор после qualification; этот блок их на реальном host не запускает.

## 1. Prerequisites и STOP

Оператор работает в Bash; доступны Docker/Compose с `!reset`, Node20+, Python3.9+, openssl, age/age-keygen и системные backup tools согласно backup contract. Missing binary/version => STOP. Выбран native Linux Docker host; checkout/scripts доступны независимо от application host для recovery. Provisioning target/data volumes, UID1001 storage, trusted image store, внешний maintenance barrier и доступ оператора — [external checklist](./external-input-master-checklist.md). Для новой установки оператор документирует реальные volume names/initialization; пустая DB не считается backup прежних данных. На существующей установке сохраняются project/volume identities. Repo `.env` не использовать, secrets не печатать, не выполнять `down -v` или DB down migrations.

До любого stop требуется рабочий внешний barrier/drain procedure, удержанный verified recovery point, whole current/previous manifests и qualified source archives. Barrier команду предоставляет target operator: если её нет, **STOP**, а не shell-заглушка. Все nonzero обязательных gate прекращают последовательность; `set -e` не заменяет проверку evidence. При провале deploy barrier остаётся закрытым. При failed prepare работающая пара остаётся работать. Public GO запрещён при любом открытом external/owner пункте.

## 2–3. Входы, release и read-only preflight

В закрытом operator session (`umask 077`) определить абсолютные пути: `OPERATOR_TOOLS_ROOT` — удержанный trusted checkout этого операторского пакета с новым preflight (обычно /opt/homecloud); `RELEASE_SOURCE`/`PREVIOUS_SOURCE` — чистые exact-commit archives; `CURRENT_MANIFEST`/`PREVIOUS_MANIFEST` — удержанные reviewed manifests; `RELEASE_COMMIT`/`PREVIOUS_COMMIT` — их source commits; `RELEASE_IMAGES` — private generated override вне source; `APPLIED_MIGRATIONS` — private temporary JSON; `SCHEDULER_CONFIG` — external scheduler.json; `QUALIFICATION_RECORD` — внешний несекретный record согласно checklist. `HOMECLOUD_ENV_FILE` — external0600 recovery.env в0700 directory. В нём реальные COMPOSE_PROJECT_NAME/COMPOSE_FILE, DB/secrets, PUBLIC_HOST, TLS_CERT_DIR/ACME_WEBROOT_DIR и backup paths (только keys strict loader; ACME account directory задаётся в scheduler cert_args, не как ACME_DIR в recovery.env); writer env содержит public age recipients, **не private recovery identity**. `COMPOSE_FILE` включает retained production source и active override; source нужен на host, не один Compose YAML.

```sh
cd "$RELEASE_SOURCE"
umask 077
export HOMECLOUD_ENV_FILE
SCRIPT_DIR="$RELEASE_SOURCE/scripts"
source "$SCRIPT_DIR/recovery-config.sh"
# Без set -e в этой проверке: сохранить код и прочитать обе категории JSON.
PREFLIGHT_RC=0
python3 "$OPERATOR_TOOLS_ROOT/scripts/operator-preflight.py" --env-file "$HOMECLOUD_ENV_FILE" --manifest "$CURRENT_MANIFEST" --scheduler "$SCHEDULER_CONFIG" --qualification "$QUALIFICATION_RECORD" || PREFLIGHT_RC=$?
case "$PREFLIGHT_RC" in 0|3|4) ;; *) echo 'STOP: invalid local configuration'; exit 2 ;; esac
node scripts/release-manifest.cjs prepare --manifest "$CURRENT_MANIFEST"
node scripts/release-manifest.cjs prepare --manifest "$PREVIOUS_MANIFEST"
node scripts/release-manifest.cjs validate --manifest "$CURRENT_MANIFEST" --source-root "$RELEASE_SOURCE" --source-commit "$RELEASE_COMMIT"
node scripts/release-manifest.cjs validate --manifest "$PREVIOUS_MANIFEST" --source-root "$PREVIOUS_SOURCE" --source-commit "$PREVIOUS_COMMIT"
docker compose config --quiet
```

Exit3/4 разрешает только protected qualification rehearsal после проверки реальных operational prerequisites (host/registry/TLS/barrier/offsite/custody), чтобы выполнить ещё не записанный final acceptance. Это не разрешение public traffic. Missing operational prerequisites => STOP до mutation; финальные owner acceptance/records собираются в ходе rehearsal. Для public GO exit0 и независимый review всех records обязательны.

Aggregator read-only, без Docker/network/credential tests; exit2=missing/invalid local config,3=external qualification open,4=owner approval open,0=presence checks complete, **не GO**. JSON перечисляет обе открытые категории даже при exit2. Paths/secret values не выводятся. External record проверяется на наличие, содержание решения проверяет независимый reviewer. `prepare` реально pulls/checks обе roles, до maintenance/stop; digest distribution и trusted provenance — [manifest contract](./release-manifest.md#registry-digest-contract). Проверить current runtime identity и наличие обеих pulled pairs. Образы между prepare и переходом не удалять.

## 4. Backup и write barrier

Удержанный ранее verified recovery point проверяется до остановки. Новая свежая consistency copy создаётся после drain/stop. При закрытом внешнем traffic/drained writers остановить только application services. Подтвердить независимый offsite target/inventory и custodial recovery access. В существующей установке выполнить production encrypted coordinator с **временным** подтверждением фактического barrier:

```sh
docker compose stop frontend backend
BACKUP_WRITE_BARRIER_CONFIRMED=1 bash scripts/backup-production.sh
```

Проверить completed event, `last-backup-success.json`, offsite_verified и generation, ciphertext/manifest against independent inventory. Custodian выполняет отдельный recovery env с private identity и выбранным generation:

```sh
env -i PATH="$PATH" HOME="$HOME" HOMECLOUD_ENV_FILE="$RECOVERY_ENV_FILE" bash "$RELEASE_SOURCE/scripts/restore-offsite.sh" "$GENERATION" --validate-only
```

`RECOVERY_ENV_FILE` — отдельный external custodian file; identity не возвращается writer/scheduler. Validation не destructive, но не заменяет measured restore drill. Для первой пустой установки backup исходной DB отсутствует: STOP до зафиксированного initial-install decision и successful backup/recovery перед public GO. [Контракт backup](./backup-productionization.md), [custody/recovery](./recovery-objectives.md).

## 5–6. Migration/preflight и deploy пары

На существующей DB получить точный applied list по [schema guard](./release-manifest.md#schema-guard-и-operator-sequence). Сначала guarded override: нельзя применять guessed IDs. Для accepted exact-schema pairs:

```sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT coalesce(json_agg(name ORDER BY name), '\''[]'\''::json) FROM migrations"' > "$APPLIED_MIGRATIONS"
node scripts/release-manifest.cjs override --manifest "$CURRENT_MANIFEST" --source-root "$RELEASE_SOURCE" --source-commit "$RELEASE_COMMIT" --compatibility-manifest "$PREVIOUS_MANIFEST" --applied-migrations "$APPLIED_MIGRATIONS" --output "$RELEASE_IMAGES"
export COMPOSE_FILE="$RELEASE_SOURCE/docker-compose.production.yml:$RELEASE_IMAGES"
docker compose config --quiet
```

Guard nonzero => STOP, stale override не использовать. Изменённая schema/new install не обходят guard: только отдельное reviewed migration/compatibility decision, [точные config/show/run/no-pending commands](./release-and-rollback.md#последовательность-и-blocking-gates); приложение остановлено, barrier закрыт. Qualification здесь доказывает exact-schema переход; evolving-schema совместимость не заявляется.

```sh
docker compose run --rm --no-deps --pull never --entrypoint node backend -e 'require("./dist/common/production-config").validateProductionConfig(process.env)'
docker compose run --rm --no-deps --pull never --entrypoint node backend -e '(async()=>{const d=require("./dist/data-source").default;try{await d.initialize();if(await d.showMigrations())process.exitCode=1}finally{if(d.isInitialized)await d.destroy()}})().catch(()=>process.exit(1))'
docker compose up -d --no-build --no-deps --pull never backend
docker compose exec -T backend node -e 'fetch("http://localhost:3000/api/v1/health/ready").then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))'
docker compose up -d --no-build --no-deps --pull never frontend
docker compose up -d --no-build --no-deps ingress
```

Не повторять сетевой app pull после stop. Сверить container Config.Image с обеими repository@digest, actual Image/RepoDigests с prepared artifacts; способы — [manifest runbook](./release-manifest.md). Не считать sequential start атомарным или zero downtime.

## 7–10. Readiness, ingress, E2E, scheduler

Внутренние live/ready200 и protected/disabled metrics проверить из operator Docker network; backend port не публиковать. `docker compose exec -T frontend nginx -t` и `docker compose exec -T ingress nginx -t`. Через реальный FQDN проверить HTTP308, trusted public certificate chain/SAN/expiry, HTTPS headers/CSP, private health/metrics denial и proxy spoofing. Self-signed local result не квалифицирует public trust.

Закрытый public barrier допускает только operator access: login/session restore, root/nested/create folder, upload/download byte equality, preview, share create/revoke, trash/delete/restore, logout/relogin, desktop+narrow contextual dialogs/routing/no fatal console errors. Удалить disposable smoke data, проверить accounting. Локальный [acceptance evidence index](./evidence/README.md) и harness — regression tools, target acceptance оператор фиксирует отдельно.

До install timers qualified wrapper/offsite/recipient обязательны: Persistent timer способен немедленно запустить job. Выполнить scheduler validate/install/list-timers/result/journal по [scheduler commands](./scheduler-alerting.md#внешняя-конфигурация-и-установка), TEST delivery с human receipt/ack и внешний host watchdog. При cert failure действующий valid cert сохраняется; renewal/recovery — [certificate lifecycle](./certificate-lifecycle.md). `INGRESS_ID=$(docker compose ps -q ingress)` используется как реальный `--container`, не guessed name.

## 11–12. Failed deploy, rollback и recovery

Триггеры: readiness/migration/identity mismatch, data/bytes/accounting loss, fatal UI/console, TLS/CSP/privacy failure, scheduler/alert failure либо наблюдаемая regression. Закрыть barrier, остановить writers. При failed prepare **не останавливать** known-good pair. При подтверждённой exact-schema совместимости подготовить всю previous pair до stop, получить fresh APPLIED_MIGRATIONS и выполнить:

```sh
node scripts/release-manifest.cjs prepare --manifest "$PREVIOUS_MANIFEST"
# После PASS и qualified barrier/drain:
docker compose stop frontend backend
node scripts/release-manifest.cjs override --manifest "$PREVIOUS_MANIFEST" --source-root "$PREVIOUS_SOURCE" --source-commit "$PREVIOUS_COMMIT" --compatibility-manifest "$CURRENT_MANIFEST" --applied-migrations "$APPLIED_MIGRATIONS" --output "$RELEASE_IMAGES"
export COMPOSE_FILE="$PREVIOUS_SOURCE/docker-compose.production.yml:$RELEASE_IMAGES"
docker compose config --quiet
docker compose up -d --no-build --no-deps --pull never backend
# Обязательный internal readiness/no-pending gate из раздела5–6 до frontend.
docker compose up -d --no-build --no-deps --pull never frontend
```

Возвращается вся previous backend/frontend pair. При schema guard failure — STOP, reviewed roll-forward/recovery decision, без down migration. Сверить identity/data/ingress/E2E повторно до открытия barrier. При data corruption сначала forensic snapshot, затем отдельное incident decision на destructive paired restore; [recovery sequence без original host](./recovery-objectives.md#аварийное-восстановление-без-chat-context), `restore-offsite.sh GENERATION --validate-only`, затем только после explicit decision `--yes`. Wrong/missing key/corrupt/unavailable offsite => STOP до mutation; все keys потеряны => unrecoverable. Даже при nonzero restore ingress остаётся закрытым: helper failure path может запустить app.

## 13. Observation и отдельный GO

Минимум15min protected observation readiness/errors/latency/disk, evidence timestamps, smoke cleanup, scheduler/cert/backup freshness и human escalation confirmation. Любая anomaly или открытый пункт единственного checklist => STOP. После полного real host acceptance и owner approval оператор отдельно разрешает public traffic. Локальная подготовка такого решения не выдаёт. После запуска продолжить согласованный мониторинг и recovery drill cadence.

## Воспроизведение локального acceptance

Только disposable machine/daemon с Docker, trusted retained artifacts, Node и установленным Playwright Chromium. Указанные source commits имеют одинаковые application/schema trees; нет qualification разных application generations. `HOMECLOUD_PLAYWRIGHT_MODULE` — module name либо абсолютный path installed Playwright; `NODE_BINARY` — реальный Node executable. Backend port не публикуется, только loopback TLS ingress на случайном порту. Script создаёт свои данные/сети/volumes и удаляет их и synthetic env/keys; qualified image outputs удерживаются. Это не target production smoke и не GO. Browser игнорирует self-signed trust error, проверяет локальные session/routing/upload/dialogs/CSP compatibility; public chain/SAN остаются external gate.

```sh
export HOMECLOUD_PLAYWRIGHT_MODULE
python3 "$OPERATOR_TOOLS_ROOT/scripts/tests/final-production-e2e.py" --repo "$OPERATOR_TOOLS_ROOT" --current 0d766777a41493e237b77df18f5597901d5f080e --previous 647aa7b949698f9b84feee3ce5134cb2a7b542de --node "$NODE_BINARY"
```

Evidence result path печатается script; raw scratch ephemeral/non-authoritative до сохранения sanitized JSON и независимого review. Browser viewports1440×900/390×844; окна auth limiter разделены61seconds, защита не ослабляется. Реальный target/operator acceptance выполняется через approved barrier и остаётся в единственном external checklist.
