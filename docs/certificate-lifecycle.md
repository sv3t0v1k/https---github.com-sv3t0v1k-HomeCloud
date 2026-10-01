# Public Certificate Lifecycle

Дата: 2026-10-01, Asia/Vladivostok. Ненумерованный Production Readiness checkpoint после Backup Productionization. Общая готовность: **NOT_READY**.

## Поддерживаемый контракт

Production deployment contract — native Linux Docker host с coherent whole-directory bind mount. Docker Desktop/macOS host bind mounts не поддерживаются для atomic `current` rotation: реальный smoke выявил stale symlink внутри контейнера после host os.replace; fingerprint probe отклоняет такую активацию. Smoke подтверждает native Linux daemon-side whole-directory bind, но не конечный production host; его qualification обязательна перед go-live.

Стандартный ACME client — Certbot, протокол ACME самостоятельно не реализуется. Host operator устанавливает проверенную версию Certbot и Python3/OpenSSL/Docker CLI; это dependency, не встроенный service. HTTP-01 подходит только при публичном DNS A/AAAA на этот ingress и доступном извне TCP80. CDN/NAT/firewall должны пропускать challenge без authentication/rewrite. Wildcard и недоступный public HTTP требуют DNS-01; автоматизация DNS provider не реализована. Manual DNS renewal не является unattended workflow: оператор выбирает и квалифицирует стандартный plugin отдельно.

`PUBLIC_HOST` — явный production DNS hostname; сертификат должен содержать matching DNS SAN, а не только CN. Шаблоны ниже используют `cloud.example.com` исключительно как заменяемый пример. Issuance error не разрешает install/reload. Install/check проверяют chain через системный OpenSSL trust store; `--ca-file` допускается только для явно доверенной альтернативной CA и isolated harness. Production использует доверенную public CA chain; local/self-signed smoke не подтверждает ни public CA issuance, ни production domain/DNS. Staging state отделяется от production и не активируется на public ingress.

Материал хранится вне repo и images: `ACME_DIR` (account/renewal/live/archive), `TLS_CERT_DIR` (immutable generations и `current`), `ACME_WEBROOT_DIR` (только публичные challenge tokens). Не размещать там env/backup/account/key. Не выводить private key, resolved production env или ACME account в logs. root/Docker administrator остаётся внутри trusted boundary.

## Первая выдача и bootstrap

Основной ingress без cert/key не стартует. Для **первой** выдачи выполнить Certbot standalone на host с остановленным ingress и свободным port80; frontend/backend публиковать не нужно. Нельзя останавливать работающий valid TLS для штатного renewal.

```sh
# Linux Docker host, доверенный оператор; заменить hostname/email/пути.
umask 077
export PUBLIC_HOST=cloud.example.com
export ACME_DIR=/srv/homecloud/acme
export TLS_CERT_DIR=/srv/homecloud/tls
export ACME_WEBROOT_DIR=/srv/homecloud/challenges
install -d -m 700 "$ACME_DIR" "$TLS_CERT_DIR"
install -d -m 755 "$ACME_WEBROOT_DIR" "$ACME_WEBROOT_DIR/.well-known" "$ACME_WEBROOT_DIR/.well-known/acme-challenge"
certbot certonly --standalone --non-interactive --agree-tos --email operator@example.com \
  --cert-name "$PUBLIC_HOST" -d "$PUBLIC_HOST" \
  --config-dir "$ACME_DIR" --work-dir "$ACME_DIR/work" --logs-dir "$ACME_DIR/logs"
python3 scripts/certificate-lifecycle.py install \
  --cert "$ACME_DIR/live/$PUBLIC_HOST/fullchain.pem" --key "$ACME_DIR/live/$PUBLIC_HOST/privkey.pem" \
  --hostname "$PUBLIC_HOST" --state-dir "$TLS_CERT_DIR"
# После success: quiet Compose validation и запуск ingress по release runbook.
```

Если issuance завершилась ошибкой — остановиться, устранить DNS/port/CA проблему, не создавать fallback self-signed для production. Bootstrap install не доказывает live nginx acceptance: после запуска обязательны `nginx -t`, внешний HTTPS chain/SAN check и `/` health. Для DNS-01 предоставить fullchain/key стандартным client и использовать тот же install contract; scheduler зависит от plugin и остаётся operator obligation.

## Runtime injection и migration

Compose монтирует **весь** external `TLS_CERT_DIR` read-only в `/etc/nginx/tls`, nginx читает `current/fullchain.pem` и `current/privkey.pem`. Отдельные file bind mounts не подходят для atomic inode replacement. Каталог state и поколения0700, key0600; nginx root master читает key, worker не требует открытого key. ACME_WEBROOT_DIR отдельный read-only mount, даже DNS-01 deployment задаёт пустой external webroot. Challenge directories должны быть traversable worker, tokens readable (0644); секретов в них нет.

Migration прежнего flat TLS directory: до смены template выполнить bootstrap install из внешней копии текущих fullchain/key в новый lifecycle root, затем сменить `TLS_CERT_DIR`, добавить `ACME_WEBROOT_DIR`, проверить Compose `config --quiet` и recreate ingress в согласованное maintenance window. Старый каталог сохранить для rollback; переход на новый mount сам по себе не zero downtime. После migration обычный renewal не требует recreate.

## Renewal и безопасная активация

Доверенный scheduler запускает следующую команду дважды в сутки (без shell hooks из сертификата):

```sh
python3 scripts/certificate-lifecycle.py renew \
  --acme-dir "$ACME_DIR" --webroot "$ACME_WEBROOT_DIR" --cert-name "$PUBLIC_HOST" \
  --hostname "$PUBLIC_HOST" --state-dir "$TLS_CERT_DIR" \
  --container homecloud-ingress-1 --probe-host 127.0.0.1 --probe-port 443
```

Использовать фактическое имя ingress из `docker compose ... ps -q ingress` либо постоянное имя deployment; пример не обнаруживает container автоматически. Probe адрес — прямой published ingress, без CDN/load balancer. Нужен SNI PUBLIC_HOST и новый TLS handshake. Одновременные операции state сериализуются lock. Certbot return0 может означать «renewal не требуется»; повторный install того же материала должен вернуть unchanged без reload. Webroot options при renewal сохраняют unattended HTTP-01 после первоначального standalone issuance.

Дальнейшая активация выполняет validation, snapshot поколения, atomic current switch, `nginx -t`, graceful reload и сравнение served leaf fingerprint. Failure возвращает nonzero и безопасное JSON событие; предыдущий current восстанавливается. Failed issuance/renewal не заменяет активный материал. Config/reload/probe failures требуют немедленного operator inspection; процесс сигнализации не равен подтверждённому recovery. Не изменять nginx config параллельно certificate activation.

Rollback: повторный `install` из сохранённого предыдущего generation fullchain/key с теми же live container/probe flags. Скрипт снова проверяет validity; expired rollback не разрешён. Предыдущие поколения содержат keys и сохраняются под restricted state directory. Retention/удаление выполняет оператор после подтверждения served fingerprint; не удалять active/rollback generation. При crash проверить current, `nginx -t` и served fingerprint, затем повторить validated install; простой exit0 Certbot не доказывает активный новый certificate.

## Expiry и failure signaling

```sh
python3 scripts/certificate-lifecycle.py check --state-dir "$TLS_CERT_DIR" --hostname "$PUBLIC_HOST" \
  --warning-days 30 --critical-days 7
```

Scheduler должен запускать expiry check ежедневно независимо от renewal и доставлять warning/critical/failure оператору. JSON events и exit codes — vendor-neutral signaling contract: check0=OK,1=warning,2=critical,3=invalid (включая missing/expired); install/renew0=success/unchanged,3=failure. External alert integration не добавлена. Thresholds configurable; invalid/missing/mismatch/expired — failure. Проверка disk state не заменяет внешнюю проверку реально served TLS и доверия chain. Отдельно квалифицировать delivery alerts и emergency recovery до go-live.

## HTTP-01 / HSTS

HTTP challenge exception обслуживает только одноуровневые token filenames `[A-Za-z0-9_-]+`; отсутствующий token404, directory listing выключен, symlink access запрещён. Остальной HTTP возвращает308 на canonical HTTPS. HTTP response не содержит HSTS. HTTPS сохраняет HSTS31536000 без preload/includeSubDomains и прежние security headers. Нельзя включать этот production template для plain HTTP testing или обещать доверенную HTTPS boundary на self-signed сертификате.

## Evidence и пределы

Focused tests: `python3 scripts/tests/test-certificate-lifecycle.py`. Disposable runtime: `python3 scripts/tests/certificate-lifecycle-runtime.py`. Последний использует локально сгенерированные certificates, simulated Certbot client result и настоящий nginx, изолированную сеть/containers/ports и native Linux daemon-side read-only bind; public CA не вызывается. Проверяет served certificate rotation, health sampling, failure retention, config rejection, HTTP01 и HSTS. Старые containers не затрагиваются.

Linux smoke operator container использует Docker socket для fixed nginx commands; это root-equivalent trusted operator, не продуктовый service. Временные keys/account fixtures/containers/volumes удаляются, sanitized evidence сохраняется.

Public staging/domain issuance, production host native bind qualification, production DNS/firewall, CA rate limits, unattended scheduler/alerts на целевом host и final recovery/acceptance остаются operator/release gates. Честный PASS lifecycle mechanics не означает public issuance success или overall READY.

Официальные источники: [Certbot user guide](https://eff-certbot.readthedocs.io/en/stable/using.html), [nginx reload/control](https://nginx.org/en/docs/control.html). Следующий рекомендуемый блок — final acceptance/go-live gate; автоматически не начинается.

## Проверенное evidence

Focused10/10, hostname/syntax/quiet Compose/diff gates PASS. Повторный runtime основного исполнителя: `/private/tmp/hc-cert-runtime-nbsg0jx_/result.json`,17 healthy requests during reload,expiry45→90days,rotation/failure retention/cleanup PASS. Temporary evidence может удалить ОС; harness воспроизводим. Python квалифицирован на3.9.6(host focused) и3.11(Linux smoke), другие версии требуют qualification (ssl.match_hostname API).


## Scheduler / delivered alerts — bounded remediation

Расписание, external-only config, maintenance-wrapper, retry/dedup/recovery и delivery boundary: [scheduler-alerting](./scheduler-alerting.md). Backup retention/integrity остаются в existing transaction, cert lifecycle/reload contract сохранён. Production recipient и target host не квалифицированы; общий **NOT_READY / NO_GO**.

## Реальный Linux / DNS / public CA: входы и qualification — 2026-10-01

Ненумерованный checkpoint после scheduler/alerts. Исходный HEAD `30f13a98a1c312d9e5c11e1811d690c725d04b4d`; исходный status только запрещённый audit, содержимое не открывалось. **PRODUCTION_BLOCKER_LINUX_DNS_CA: DEFERRED_OWNER_INFRASTRUCTURE_INPUT / OPEN; OVERALL: NOT_READY / NO_GO.** По решению владельца target qualification отложена до реальных host/domain inputs; независимые workstreams продолжаются. Для READY с публичным production endpoint критерии остаются обязательными. Реальный target не предоставлен; ниже prerequisites и будущие operator commands, а не результаты production deployment.

### TARGET_INPUT_DISCOVERY / OPERATOR_INPUTS_REQUIRED

| Вход | Результат |
|---|---|
| Реальный Linux host/IP/SSH и deployment login | MISSING |
| Реальный public FQDN и DNS control | MISSING |
| Timezone целевого host | MISSING; Asia/Vladivostok — дата evidence, не выбор production |
| ACME contact/account | MISSING; operator@example.com — пример |
| Фактические external env/TLS/ACME/webroot paths | MISSING; /srv/homecloud и /secure/homecloud — примеры |
| Checkout / scheduler contract | FOUND: /opt/homecloud, root-owned /etc/homecloud/scheduler.json, /var/lib/homecloud/scheduler |
| Published ports / mount contract | FOUND: ingress TCP80/443, whole TLS directory read-only, отдельный challenge webroot |

Минимальные входы оператора:
1. SSH target, авторизованный deployment user и ожидаемые публичные IPv4/IPv6 endpoint(s).
2. Точный FQDN и подтверждение контроля DNS A/AAAA; hostname должен соответствовать SAN. Для текущего HTTP-01 provider/zone credentials не нужны в чате.
3. Timezone production host.
4. Подтверждение прямой топологии ingress и маршрута TCP80/443 через firewall/NAT, без дополнительного CDN/proxy; при иной топологии нужен отдельный пересмотр trust contract. Выбор HTTP-01 и доступность challenge без authentication/rewrite.
5. ACME contact email для документированной первой выдачи либо наличие уже настроенного подходящего account.
6. Фактические абсолютные external deployment env, TLS_CERT_DIR, ACME_DIR, ACME_WEBROOT_DIR paths. Checkout для существующих units — /opt/homecloud. Credentials/account/private keys настраиваются безопасно на target/out-of-band, не в чате/Git.

DNS-01 — не готовая альтернативная scheduler-интеграция: текущий renew явно вызывает Certbot `--webroot`. При выборе DNS-01 нужны provider/zone и отдельно квалифицированный unattended plugin/activation flow; текущую команду renew для него не использовать. Manual DNS renewal не закрывает этот gate.

### Первые команды на выбранном target

Доверенный оператор сначала выполняет read-only аудит; не устанавливать packages, не менять firewall и не останавливать чужие services в рамках этих команд:

```sh
cat /etc/os-release
uname -srm
id
docker version
docker compose version
systemctl --version
timedatectl status
ss -ltnp '( sport = :80 or sport = :443 )'
ip route
ip -6 route
python3 --version
openssl version
certbot --version
```

Сверить поддержку distro/kernel/architecture выбранными Docker и release images; версии записать, универсальный minimum из локального PASS не выводить. Compose должен поддерживать guarded release `!reset` override. Python lifecycle использует ssl.match_hostname: текущие подтверждённые версии3.9/3.11 не доказывают совместимость нового Python. На target повторить focused suite до issuance. Нужны CA trust bundle, Python3, OpenSSL, Docker Engine/Compose CLI, Certbot, systemd; для диагностики curl, dig, ss, findmnt. systemd scope/root runner и Docker operator — привилегированные доверенные роли.

После задания реальных paths (значения не выводить вместе с secrets):

```sh
: "${TLS_CERT_DIR:?}" "${ACME_DIR:?}" "${ACME_WEBROOT_DIR:?}" "${HOMECLOUD_ENV_FILE:?}"
stat -c '%a %U:%G %n' "$TLS_CERT_DIR" "$ACME_DIR" "$ACME_WEBROOT_DIR" "$HOMECLOUD_ENV_FILE"
findmnt -T "$TLS_CERT_DIR"
findmnt -T "$ACME_DIR"
df -h "$TLS_CERT_DIR" "$ACME_DIR" "$ACME_WEBROOT_DIR"
df -i "$TLS_CERT_DIR" "$ACME_DIR" "$ACME_WEBROOT_DIR"
```

Проверить persistence Docker data root и DB/storage volumes отдельно, capacity относительно фактических данных/retention, отсутствие конфликтов172.29.0.0/24 и172.30.0.0/24. Не объявлять диск пригодным по одному наличию свободного места. Host timezone и NTP synchronized обязательны для validity/timers. Owner root для TLS/ACME и scheduler; state/generations0700, key0600, external env0600 в protected0700 parent. Challenge path755/tokens0644 с traversable parent для nginx worker; не делать private ACME/TLS dirs readable для worker. Root master ingress читает ключ через read-only whole-directory bind. На target сверить effective mount type/source с ожидаемым каталогом, readlink current внутри и снаружи после switch; macOS shared bind не поддерживается.

Firewall/NAT: входящие TCP80/443 только к ingress; SSH ограничен утверждёнными operator sources; PostgreSQL5432/backend3000/Redis6379/health/metrics не публикуются. ACME client нужны исходящие DNS и HTTPS443 к CA. HTTP-01 требует80 также для renewal. Существующие listeners не останавливать без отдельного безопасного deployment window.

### DNS / внешний vantage / staging

На host и независимом внешнем узле после получения реального FQDN:

```sh
: "${PUBLIC_HOST:?}"
dig "$PUBLIC_HOST" A +noall +answer
dig "$PUBLIC_HOST" AAAA +noall +answer
dig "$PUBLIC_HOST" CAA +noall +answer
curl -4 --connect-timeout 5 --max-time 15 -I "http://$PUBLIC_HOST/"
curl -4 --connect-timeout 5 --max-time 15 -I "https://$PUBLIC_HOST/"
```

Сверить каждый A/AAAA с выбранными endpoints, TTL и ответы authoritative NS/независимых recursive resolvers; CAA включая наследуемую policy не должна запрещать выбранную CA. При AAAA повторить curl с `-6`, проверить nginx IPv6 listener и весь IPv6 route/firewall/NAT: текущий template не содержит явного `[::]` listen, публикация порта сама не доказывает IPv6. Broken AAAA — FAIL/operator action, не игнорировать. Внешний доступ через каждый опубликованный endpoint проверять отдельно. Если нет независимого внешнего vantage, PUBLIC_REACHABILITY остаётся INCONCLUSIVE.

После bootstrap и старта ingress положить безопасный случайный token0644 только в challenge directory; внешний GET должен вернуть exact bytes200 без redirect/HSTS, затем удалить только этот token. Остальной HTTP должен вернуть308 на canonical HTTPS; HTTP без HSTS. HTTPS /api/v1/health/ready и /api/v1/metrics должны вернуть404, HTTPS / — здоровый frontend. Не использовать auth/metrics tokens для публичной проверки.

Для первого bootstrap с остановленным только HomeCloud ingress и свободным80 сначала выполнить документированный standalone issuance с `--staging` и **отдельным** ACME_STAGING_DIR0700 вместо ACME_DIR. Staging cert не устанавливать в TLS_CERT_DIR. Затем production issuance/install выполнить по первой секции только после DNS/reachability gates. Если уже есть valid ingress, standalone не запускать: staging/dry-run через webroot без остановки TLS.

После наличия production lineage выполнить отдельно Certbot dry-run:

```sh
: "${PUBLIC_HOST:?}" "${ACME_DIR:?}" "${ACME_WEBROOT_DIR:?}"
certbot renew --dry-run --non-interactive --cert-name "$PUBLIC_HOST" \
  --webroot -w "$ACME_WEBROOT_DIR" --config-dir "$ACME_DIR" \
  --work-dir "$ACME_DIR/work" --logs-dir "$ACME_DIR/logs"
```

Это staging validation, не production rotation; deployment hooks не добавлять. Lifecycle CLI не принимает --dry-run/--staging. Actual renew/install по командам выше использует production trust store, без --ca-file staging/local CA. Certbot/account logs хранить защищённо; в evidence только sanitized exit/results и public certificate metadata.

### Native bind / reload / renewal acceptance

Для actual ingress получить ID из правильных explicit Compose project/config/external env по release runbook; не угадывать homecloud-ingress-1. Выполнить nginx -t. Для сохранённого предыдущего и нового **валидного доверенного** поколения recorded expected fingerprint/SAN/expiry. Safe install нового candidate с --container и прямым --probe-host/port должен показать switched readlink и новую served fingerprint; previous valid generation установить тем же guarded install для rollback, затем вернуть новое. Candidate paths вне repo, ключ0600. Если второго валидного candidate нет, fingerprint-change/rollback остаются INCONCLUSIVE; dry-run их не доказывает.

Внешняя проверка без insecure bypass:

```sh
openssl s_client -connect "$PUBLIC_HOST:443" -servername "$PUBLIC_HOST" \
  -verify_hostname "$PUBLIC_HOST" -verify_return_error </dev/null
openssl x509 -in "$TLS_CERT_DIR/current/fullchain.pem" -noout \
  -fingerprint -sha256 -issuer -dates -ext subjectAltName
python3 /opt/homecloud/scripts/certificate-lifecycle.py check \
  --state-dir "$TLS_CERT_DIR" --hostname "$PUBLIC_HOST"
```

Сверить served leaf fingerprint с диском, real public CA chain/trust/SAN, TLS1.2/1.3 и действующие nginx cipher defaults; проверка старых протоколов должна провалиться. Runtime fingerprint probe сам использует unverified TLS, поэтому не заменяет внешний trust/hostname check. Failure drills missing/unreadable/mismatched candidate, invalid nginx config и simulated CA failure сначала выполнять на disposable copy target; не повреждать active config публичного ingress. Проверить nonzero, unchanged current/served cert и восстановление. Реальную CA ошибку не провоцировать ценой rate limits/доступности.

Existing cert services проверить systemd-analyze verify по /opt/homecloud/ops/systemd; focused suites и scheduler --validate повторить на target. Manual cert service execution разрешён только после secure scheduler config/настоящего alert endpoint readiness; запуск timer может немедленно выполнить Persistent job. Target timer/production alert delivery сейчас SKIPPED и не квалифицированы.

### Свежие bounded gates / пределы

Local cert suite10/10; scheduler22 tests,1 SKIP (age integration: local age отсутствует); ingress hostname, Python AST3, ingress sh syntax и isolated fake-input quiet Compose5.1.3 PASS. Disposable runtime raw `/private/tmp/hc-cert-runtime-b35yp793/result.json`: native daemon-side bind,18 healthy requests during reload,45→90days, new served fingerprint, idempotency, mismatch/config/simulated renewal failure retention PASS; isolated resources/private material cleaned. Fixture — self-signed local cert и simulated Certbot, не actual target/CA. OS может удалить temporary evidence, harness воспроизводим. Native target/systemd checks SKIPPED (нет target; macOS не systemd host). App sources не менялись, full app suites не повторялись.

REAL_LINUX_TARGET: NOT_AVAILABLE; PUBLIC_DNS: NOT_AVAILABLE; PUBLIC_REACHABILITY_80_443: INCONCLUSIVE; PUBLIC_CA_ISSUANCE: SKIPPED; NATIVE_CERT_BIND_RELOAD: SKIPPED (production target); REAL_RENEWAL_PATH: SKIPPED. Следующий шаг — только предоставить минимальные inputs; следующий blocker не запускается.

INDEPENDENT_REVIEW: APPROVE — reviewer не автор; final docs diff, raw runtime JSON, focused10/10 log, discovery и действующие source/mount/nginx/systemd contracts проверены. Подтверждённых дефектов нет, correction cycle не потребовался; production blocker OPEN и общий NOT_READY сохранены. git diff --check PASS.
