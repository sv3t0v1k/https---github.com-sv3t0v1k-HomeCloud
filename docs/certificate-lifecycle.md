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
