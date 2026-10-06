# Production Readiness — Secret Lifecycle

Owner-approved ненумерованный блок, 2026-09-30. Vendor-neutral baseline: внешние operator-owned файлы и runtime environment. Не является разрешением go-live. OVERALL_PRODUCTION_READINESS: NOT_READY.

## Инвентарь

Владелец deployment material — оператор узла; application credentials — пользователь и backend.

| Материал / классификация | Назначение / компонент | Передача | Ротация / риск раскрытия |
|---|---|---|---|
| JWT_SECRET / REQUIRED | Access JWT, backend | external env → Compose → ConfigService | recreate backend, старые access недействительны; inspect/environment |
| JWT_REFRESH_SECRET / REQUIRED | Refresh JWT, backend | external env → Compose → ConfigService | recreate backend, старые refresh недействительны; inspect/environment |
| PostgreSQL password / REQUIRED | DB authentication | DB_PASSWORD → POSTGRES_PASSWORD и DATABASE_URL | SQL ALTER ROLE + recreate backend; URL/inspect/SQL diagnostics |
| DATABASE_URL / DERIVED, секретный носитель | backend и migration CLI | Compose конструирует URL; CLI получает environment | те же риски, что у пароля; percent-encode при ручной сборке URL |
| DB_PASSWORD / REQUIRED в Compose, OPTIONAL auxiliary в backend | проверка совпадения с URL | external env | URL-password обязателен даже без auxiliary |
| METRICS_TOKEN / OPTIONAL | private metrics Bearer | external env | один текущий token; пустой/отсутствующий выключает endpoint |
| REDIS_PASSWORD / OPTIONAL | optional Redis profile, backend не использует Redis | env → private temporary redis config | recreate Redis; требует 64+ hex, argv без пароля; inspect/environment/config file |
| REDIS_URL / DERIVED | credential carrier, сейчас backend не использует | Compose env | не выводить resolved config |
| privkey.pem / REQUIRED для ingress | TLS private key | TLS_CERT_DIR read-only mount | matching key/cert replacement + nginx reload; filesystem/root доступ |
| fullchain.pem / DERIVED, публичный | TLS chain | тот же mount | не секрет; должен соответствовать key |
| DB_USER, DB_NAME, PUBLIC_HOST, TLS_CERT_DIR / не секреты | identifiers/paths | external deployment settings | paths не заменяют защиты файлов |
| user passwords, refresh JWT, share password/token / DERIVED | application auth/sharing | API → existing hash/token storage | existing password/revocation rules; не deployment keys |
| .env.example, synthetic smoke credentials / LOCAL-DEV-ONLY | примеры/tests | fixtures | запрещено переносить в production |

Age backup encryption реализовано в [backup productionization](./backup-productionization.md). Private identity и public recipients имеют отдельный lifecycle; custody, redundancy, rotation и emergency access определены в [recovery objectives](./recovery-objectives.md). Реальная организационная custody ещё NOT_QUALIFIED. Не найден static bootstrap admin secret. TLS public provisioning/renewal остаётся отдельным блокером.

## Генерация и хранение

Каждый новый deployment secret: независимые 32 bytes из OS CSPRNG, hex64. Генератор использует Node crypto.randomBytes, не собственную криптографию. Validator принимает совместимые существующие JWT/metrics >=32 chars, DB >=16 chars, но проверка длины/разнообразия/placeholder не доказывает энтропию. Production требует CSPRNG generation независимо от прохождения validator. Access/refresh обязаны различаться. Backend rejects missing/empty required values до TypeORM, weak/default/predictable values и malformed optional values; сообщения содержат только имена. Optional empty metrics означает disabled, whitespace не принимается.

Из корня checkout, без shell tracing/recording:

```sh
umask 077
mkdir -p /secure/homecloud
chmod 700 /secure/homecloud
node scripts/generate-production-secrets.cjs /secure/homecloud/deployment.env
chmod 600 /secure/homecloud/deployment.env
```

`/secure/homecloud` — выбранный оператором каталог вне checkout; owner — deployment operator. Генератор отказывается создавать файл внутри repo (также через symlink parent), перезаписывать существующий файл или печатать значения. Добавить несекретные PUBLIC_HOST/TLS_CERT_DIR и при необходимости DB_NAME/DB_USER в private editor. Не использовать секреты в shell argv/history, clipboard sync, tickets или отчётах. Ротацию отдельного параметра делать новой CSPRNG величиной, не заменять остальные ключи случайно. Хранить предыдущую approved revision отдельно 0600 только на короткое rollback window; после закрытия окна удалить по storage policy. Удаление файла не гарантирует forensic erase на SSD. Recovery custody: оператор обеспечивает независимый защищённый доступ к действующей revision, доступ проверяется перед cutover; encrypted/offsite implementation здесь не выполняется.

## Runtime injection

```sh
docker compose --env-file /secure/homecloud/deployment.env -f docker-compose.production.yml config --quiet
docker compose --env-file /secure/homecloud/deployment.env -f docker-compose.production.yml up -d --force-recreate backend
```

Не выполнять `config` без `--quiet`, `docker inspect`, `env`, `printenv`, диагностический dump или `set -x` в записываемый вывод. Compose shell environment имеет приоритет над env-file: перед deployment удалить старые exports секретов из operator shell, использовать отдельную чистую session. Текущий canonical local baseline и production используют явный external env-file с полным набором settings; runtime `.env` в checkout не использовать. Исторические local-dev примеры не являются каноническим запуском. Runtime environment виден Docker/root администраторам и через process diagnostics: это явный tradeoff текущей модели, не secret-manager isolation. Docker socket/root доступ приравнен к доступу ко всем credentials. File/parent permissions проверяет оператор; Compose не обеспечивает 0600 автоматически. Backend/frontend `.dockerignore` исключают env и private keys из build context; реальные значения не используются в build args/images. Никогда не помещать TLS material в build directories.

TLS каталог private 0700, key 0600; учесть UID читателя nginx и права traverse. Bind read-only предотвращает запись контейнером, но не чтение администратором. Проверить nginx config перед reload. Certificate generation/renewal не реализованы этим блоком.

## JWT maintenance cutover

Policy: один текущий signing/verification key для access и refresh, без previous window/kid. Это сознательная операционная процедура с downtime и повторным login. Плановая access-only ротация инвалидирует access сразу; refresh остаётся действительным и может получить новый access. Refresh-only ротация инвалидирует refresh сразу; старый access остаётся до собственного TTL (default15m). Одновременная ротация обоих инвалидирует оба типа. Actual runtime: invalid access403 по существующему guard, invalid refresh401. Продуктовый UX/семантика не менялись.

1. Оператор согласует maintenance barrier и повторный login, закрывает traffic и останавливает backend (все instances/workers). Проверяет custody предыдущей revision.
2. Создаёт новые независимые JWT keys, сохраняет private revision вне repo. Не выводит их.
3. Recreate backend с новой revision; private readiness200, login, access и refresh smoke; старые токены отвергаются согласно выбранным changed keys. Снять barrier после успешных проверок.
4. При неудаче stop backend, восстановить прежнюю revision, recreate и проверить readiness. Возврат старого ключа снова делает старые JWT криптографически допустимыми, если они не expired/revoked; поэтому rollback не применяется при компрометации. Новые JWT при таком rollback перестают проверяться.

Refresh one-time rotation, hash comparison, reuse family revocation и logout invariants сохраняются. Смена signing key сама не удаляет stored refresh hashes; при compromised refresh key отдельно отозвать persisted sessions по существующему operational/session policy, не рассчитывать на безопасное возвращение ключа. Не обещается автоматическая ротация или отсутствие массовой инвалидизации. Для emergency compromise fresh keys + session revocation + rollout всех instances, без восстановления compromised material.

## DB password maintenance cutover и rollback

Compose использует одну role (по умолчанию initialization superuser); least-privilege role redesign вне scope. Окно обслуживания обязательно. Изменение POSTGRES_PASSWORD в env не меняет пароль существующего volume.

1. Подготовить новую private revision, оставить прежнюю для ограниченного rollback. Закрыть traffic, остановить backend/всех consumers, сохранить admin access через локальный psql socket.
2. В interactive psql внутри DB выполнить `\password homecloud` (или actual DB_USER). Psql запрашивает пароль скрыто и не кладёт plaintext SQL в history. Не применять `ALTER ROLE ... PASSWORD 'literal'` через argv, shell history или recorded transcript. Для автоматизации SQL stdin допустим только при отключённом statement/audit logging и закрытом transcript; runtime smoke использует этот ограниченный disposable вариант.
3. Обновить DB_PASSWORD в active external revision; recreate backend. До снятия barrier проверить новый TCP login, readiness200 и application login/refresh. Отдельной новой TCP connection подтвердить отказ старого пароля. Старые pool connections могли оставаться авторизованными: именно поэтому consumers остановлены до изменения.
4. При отказе нового credential stop backend; через сохранённый local/admin доступ вернуть прежний пароль `\password`; вернуть external revision; recreate backend; проверить TCP/readiness/login. Ошибка подключения не должна печатать credential URL.
5. После acceptance закрыть rollback window; убрать старую revision. DB container recreate с новой env revision обновляет initialization metadata, не роль; делать только в согласованное DB maintenance окно с проверкой recovery. Не удалять volumes.

Smoke проверяет actual password cutover, отказ старой новой TCP connection, readiness и обратный rollback с отказом нового пароля. Создание новой role/overlap не заявляется; эта baseline допускает downtime.

## Metrics и optional Redis

Metrics: согласовать краткий scrape gap, stop/recreate backend с новым METRICS_TOKEN, обновить private scraper credential, подтвердить old401/new200 и readiness. Dual-token overlap отсутствует. Rollback — previous token + recreate + scraper revision, только если token не compromised. Пустой token даёт404, не открытый endpoint. Токен не передавать как аргумент curl в recorded diagnostics; secret-aware client получает его из private env/file.

Redis profile выключен по умолчанию и не участвует в backend readiness. Если активирован: maintenance stop Redis/consumers, новое hex64 значение, recreate, private authenticated PING и old-auth rejection; rollback прежней revision/recreate при non-compromise. Production command пишет private config (umask077), пароль не находится в redis-server или healthcheck argv. Runtime DB/JWT/metrics smoke Redis не проверяет; optional profile нужно проверить отдельно перед production включением. Дополнительный isolated Redis smoke проверил authenticated PONG, unauthenticated отказ, config0600 и отсутствие generated secret в logs/process argv; это не Redis credential-rotation drill. Legacy dev Compose не является production contract.

## Leakage и политика проверок

TypeORM logging false; HTTP logs содержат route templates, не query/headers/cookies/body. Raw error/stack исключены structured logger, но arbitrary future event fields не автоматически redacted: review новых log calls обязателен. HTTP error response отражает request.url; не заявляется universal redaction произвольного user input. Нельзя записывать responses с share tokens в public diagnostics. Regression config tests проверяют parameter-only errors; isolated runtime сканирует backend/PostgreSQL logs на все generated keys/passwords/access/refresh токены. TLS private bytes в smoke не создаются (проверены context exclusions, external mount contract).

Повторение: focused production/auth/observability tests → full backend с HOMECLOUD_TEST_DATABASE_URL отдельной DB → lint → build/typecheck → `python3 scripts/tests/secret-lifecycle-runtime.py`. Генератор: `node --test scripts/tests/secret-generation.test.cjs`. Compose validation всегда quiet с synthetic external file. Не использовать preview или пользовательские данные.
