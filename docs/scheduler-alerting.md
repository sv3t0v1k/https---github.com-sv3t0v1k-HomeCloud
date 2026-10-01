# Планировщик и доставка эксплуатационных уведомлений

Ненумерованный bounded remediation, 2026-10-01 (Asia/Vladivostok). Общий Production Readiness **NOT_READY / NO_GO**. Production hostname, целевой Linux host и получатель не определены. Loopback receiver подтверждает transport, а не уведомление человека.

## Матрица периодических операций

| Задание | Команда и cadence (локальная timezone Linux host) | Внешние inputs | Результат и concurrency |
|---|---|---|---|
| Encrypted backup / replication / verification / retention | `scheduled-operations.py /etc/homecloud/scheduler.json backup`, ежедневно02:00 | owner-only maintenance-wrapper, recovery.env, существующие age recipients/offsite mount | Wrapper вызывает `bash /opt/homecloud/scripts/backup-production.sh`; exit0 + completed JSON + свежий verified marker обязательны. Existing backup codes2,10–18 сохраняются; retention warning alert не меняет exit0. Shared production lock + scheduler flock |
| Backup freshness / cert-check heartbeat | тот же runner, `freshness`, каждый час | backup last-success marker, scheduler state | >26h, отсутствие/повреждение/future marker или offsite_verified!=true → critical stale + exit1; повтор/recovery доставляются |
| Certificate renewal | тот же runner, `cert-renew`,00:00 и12:00 | cert_args: TLS/ACME/webroot/hostname/container/probe | Existing lifecycle renew,0=installed/unchanged,3=failure; same TLS lock и safe nginx path |
| Certificate expiry | тот же runner, `cert-check`, ежедневно06:00 | cert_args state/hostname/CA, thresholds30/7days | Existing check0=ok,1=warning,2=critical,3=invalid.0/1/2 обновляют last-valid-check heartbeat;3 не обновляет |

Integrity validation и retention зашифрованного backup входят в existing backup transaction, отдельного destructive restore timer нет. Authenticated decrypt/paired validation остаётся периодическим operator drill с recovery key и `restore-offsite.sh GENERATION --validate-only`; scheduler не получает private identity и restore workflow. Неизвестные partial plaintext remnants и старые TLS generations автоматически не удаляются.

## Внешняя конфигурация и установка

Checkout должен быть установлен в `/opt/homecloud`; units используют `/usr/bin/python3`, абсолютные paths и WorkingDirectory=/. Provision `/etc/homecloud` и `/var/lib/homecloud/scheduler` с0700, scheduler.json с0600 (0400 допустим), владельцем root. Symlinks в config/state paths запрещены. Предки каталогов защищает оператор. Файл JSON читается как данные, не исполняется. Checkout `.env` и ambient secret environment не используются runner. Recovery helpers продолжают использовать существующий external-only loader.

В scheduler.json обязательны:

- `state_dir`: `/var/lib/homecloud/scheduler`;
- `recovery_env`: абсолютный внешний recovery.env, owner-only; не сохранять там постоянный write-barrier acknowledgement;
- `backup_wrapper`: абсолютный внешний executable0700, принадлежащий root;
- `backup_marker`: абсолютный `BACKUP_PRODUCTION_DIR/last-backup-success.json`;
- `cert_args`: JSON object с `state-dir`, `hostname`, `container`, `acme-dir`, `webroot`, `cert-name`; реальные значения из квалифицированного deployment. Допустимы `ca-file`, `probe-host`, `probe-port`, `warning-days`, `critical-days`;
- `webhook_url`: реальный HTTPS endpoint; `webhook_headers` — optional JSON object для внешнего Authorization. URL/header values не выводятся;
- `identity`: optional безопасный label1–64 `[A-Za-z0-9_.-]`, default `homecloud`.

Дополнительные defaults: cooldown_seconds21600 (повтор persistent failure каждые6h); attempts3, request_timeout5s, retry_seconds1s; job_timeout7200s (максимум7200); backup_max_age/cert_max_age93600s. Numeric bounds проверяются, retries ≤5. Test-only `allow_test_http=true` разрешает HTTP только literal127.0.0.1/::1; production использовать HTTPS. Redirects и ambient proxies запрещены; response body не читается и не журналируется.

Maintenance-wrapper обязан проверить offsite mount и установить фактический write barrier, дождаться writers, вызвать existing backup с `HOMECLOUD_ENV_FILE` и временным `BACKUP_WRITE_BARRIER_CONFIRMED=1`, пропустить безопасный JSON stdout и сохранить exit status. Wrapper снимает barrier после завершения согласно deployment procedure и корректно обрабатывает TERM. Квалификация barrier на реальном host отсутствует: контракт нельзя заменить постоянным acknowledgement. При timeout whole process group завершается TERM, через5s KILL; barrier должен оставаться безопасно закрытым, если cleanup не завершился. Emergency operator procedure восстанавливает writes после проверки состояния. Root получает Docker-equivalent privileges: существующего непривилегированного host operator account в repo нет; least-privilege не заявляется.

На выбранном production Linux host:

```sh
sudo python3 /opt/homecloud/scripts/scheduled-operations.py /etc/homecloud/scheduler.json --validate
sudo python3 /opt/homecloud/scripts/scheduler-install.py
sudo python3 /opt/homecloud/scripts/scheduler-install.py --install
systemctl list-timers 'homecloud-*'
systemctl show homecloud-backup.service -p Result -p ExecMainStatus
journalctl -u homecloud-backup.service -u homecloud-freshness.service
```

Helper сначала выполняет systemd-analyze verify; --install проверяет external inputs, копирует только8 HomeCloud units, daemon-reload и enable --now только4 timer. Не запускался на пользовательском macOS или произвольном production host. Повторная установка заменяет те же units; изменение active timer cadence требует `systemctl restart homecloud-backup.timer homecloud-cert-renew.timer homecloud-cert-check.timer homecloud-freshness.timer`. Первое включение Persistent timer может немедленно запустить пропущенный job; до --install обеспечить рабочий barrier-wrapper и mount.

Persistent=true, AccuracySec=1min, без random delay. Missed calendar events после reboot coalesced systemd, не очередь всех пропусков. Root system scope, UMask0077, journal stdout/stderr. Backup/cert services timeout8400s учитывает job7200s + два bounded delivery budgets; freshness1200s. Journal доступ ограничить root/approved operators по host policy. Runner подавляет raw child stderr, удерживает не более1MiB stdout в памяти и принимает только фиксированные сигналы. Child descendants завершаются после job, wrapper не должен создавать background daemons.

## Failure / dedup / recovery

Payload: event_type (`failure`, `repeat`, `recovery`), severity (`warning`, `critical`, `info`), UTC timestamp, явная безопасная host identity, фиксированный service/reason, случайный run_id. Raw command text, exception details, paths, secrets и child output в payload не входят. Receiver должен преобразовать JSON в operator message; интерфейс не зависит от monitoring provider.

Initial problem доставляется немедленно. Same service/reason до cooldown подавляется; после cooldown повторяется. Изменение severity/reason доставляется сразу. Success после доставленного failure создаёт recovery; healthy initial success не шумит. State хранит только6 bounded service keys с reason/sent_at,0600. Dedup commit только после HTTP2xx; unavailable/timeout/non2xx дают bounded retries, safe attempt log и exit70. Повтор job после delivery failure снова пытается отправить. Corrupt state fail-closed с nonzero70; оператор сохраняет diagnostic copy, восстанавливает last known state или удаляет повреждённый alerts.json при остановленных jobs. Новое состояние повторно отправит текущие failures, возможны дубликаты. Atomic replace+fsync и private state directory; flock предотвращает параллельные runner jobs, busy=75. Existing backup/restore и cert locks остаются.

HTTP2xx подтверждает принятие receiver, не human receipt. Crash после receiver acceptance до state save может привести к повтору; run_id позволяет correlation retries, exactly-once не заявляется. Endpoint response acceptance semantics и acknowledgement квалифицируются отдельно. Polling freshness находится на том же host: полный отказ host/systemd/network не может уведомить сам себя, нужен внешний operator watchdog в финальном deployment acceptance.

## Проверки и evidence

Воспроизводимые focused tests: `python3 scripts/tests/test-scheduled-operations.py`; `HC_SCHEDULER_EVIDENCE=/external/result.json` сохраняет sanitized raw loopback body/headers/status. Секретный sentinel находится только в child stderr/recovery config; не попадает в receiver/log. Cert fixture self-signed только в isolated test с explicit CA; public CA не заявляется. Failure backup fixtures проверяют runner контракт; existing production backup suite отдельно проверяет real age encryption/replication/retention.

Systemd runtime и итоговые gates описаны в [evidence](./evidence/scheduler-alerting/qualification.json). Доставка тестовому приёмнику и production recipient имеют независимые статусы. Общий blocker закрывается полностью только после target-host qualification, deployment maintenance-wrapper и подтверждения TEST alert реальным оператором. Missing operator inputs: выбранный Linux host/timezone; утверждённое maintenance окно/RPO и barrier-wrapper; endpoint/secure auth config; получатель, способ подтверждения получения и escalation owner. Credentials в чат/Git не передавать.


Для воспроизведения systemd drill создать отдельный Linux container из `ops/systemd/disposable.Dockerfile`, с `--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock` (не монтировать Docker socket). Скопировать только scheduler-install.py, scheduled-operations.py, certificate-lifecycle.py, tests/test-scheduled-operations.py, tests/systemd-scheduler-runtime.py, tests/create_fixtures.py и systemd units в `/opt/homecloud`. Внутри выполнить `HOMECLOUD_DISPOSABLE_SYSTEMD=1 python3 /opt/homecloud/scripts/tests/systemd-scheduler-runtime.py`; raw result `/tmp/scheduler-systemd-result.json`. Harness отказывается запускаться без explicit disposable flag, `/.dockerenv` и running systemd. Удалить только собственный container после copy evidence. Unit files production cadence не ускоряются: test override существует только в container. Reboot replay property inspected, настоящий production reboot не выполнялся.
