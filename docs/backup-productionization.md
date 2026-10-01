# Production Readiness — Backup Productionization

Ненумерованный блок после Secret Lifecycle. Общая готовность: **NOT_READY**.

## Границы доказательства

Production wrapper сохраняет существующий v1 paired backup/restore, включая checksums, metadata sidecar, archive security scan, storage staging/swap, migration/reconciliation. Полные backup зашифрованы age; внешний filesystem target представляет подключённое offsite хранилище. Разный путь на одном диске не создаёт другой failure domain. Оператор обязан проверить внешний mount, доступность, ёмкость, права и аварийный доступ. Disposable drill проверяет transport/recovery contract на изолированном target; потеря реального production-узла этим не моделируется.

## Ключи и зависимости

Нужны Bash, Python3 ≥3.9, age/age-keygen, Docker Compose и зависимости legacy backup/restore. Используется стандартный [age v1](https://age-encryption.org/v1), authenticated encryption, X25519 recipients. Reference implementation: [age](https://github.com/FiloSottile/age). Runtime отсутствие age завершается fail-closed. В проверках использован age v1.2.1 из upstream Go module; на deployment установить поддерживаемый пакет age по процедуре платформы.

Identity генерировать вне checkout и backup roots в закрытом каталоге700, с umask077: `age-keygen -o /secure/recovery/key-v1.txt`; файл должен быть новым, owner-only0600. Public recipient получить `age-keygen -y /secure/recovery/key-v1.txt > /secure/backup/recipients.txt`. Не выводить identity, не помещать ключ в env, Git, image, backup manifest или command-line argument. Writer получает только public recipients; private identity нужна recovery operator. Root/Docker administrators и malware на recovery host остаются доверенной границей.

Rotation: создать независимую новую identity; переключить recipients только после проверки нового encrypted restore. Старые identities хранить до истечения ВСЕХ backup, зашифрованных ими, включая копии вне автоматического retention. Возврат recipients не расшифрует прошлые artifacts новым ключом. Compromise требует отдельного incident plan: rotation не отзывает доступ к уже украденным ciphertext+identity. Emergency custody: отдельный защищённый vault/offline recovery copy identities, inventory key versions, восстановление доступа без исходного production host; проверка доступа минимум при rotation и recovery drill. Не внедряется KMS.

## Консистентность и recovery budgets

DB dump и storage archive последовательны. Перед job остановить приём новых writes, дождаться активных uploads/deletes/moves и остановить backend/writers; DB остаётся доступной pg_dump. Удерживать maintenance barrier до конца job. Public ingress после restore закрыт до migrations, reconciliation, readiness200 и проверки rows/quota/shares/file bytes. Подтверждение barrier в настройках является ответственностью оператора, скрипт не доказывает отсутствие стороннего writer.

Encrypted full backups являются минимальным baseline; incremental engine не добавлен. Исторические 24h RPO и 30min RTO — предложенные цели, а не измеренный production SLA. Для запуска нужны замеры полного объёма: dump+archive+encrypt+network, staging peak disk, decrypt+restore+reconciliation, допустимое maintenance окно. Если full backup не помещается в утверждённые budgets, остановить rollout и запросить owner decision по incremental/snapshot решению. Малый fixture drill не доказывает масштабируемость на production объёме.

## Privacy и остаточные риски

Offsite содержит ciphertext и ограниченный manifest (id, размер/hash ciphertext, время/format); DB counts, user filenames и SQL metadata внутри ciphertext. SHA256 проверяет corruption/transport, не authenticity против замены artifact+manifest атакующим. Age authentication проверяется до target mutation; источник/target ACL и custody остаются обязательными. Удаление plaintext staging — unlink, не гарантированное secure erase SSD/COW/snapshot. Использовать encrypted staging disk; при SIGKILL/host crash могут остаться private staging remnants, нужен контролируемый operator cleanup после проверки отсутствия активного job. Не выполнять автоматическое удаление неизвестных partial artifacts.

## Единый внешний config для recovery helpers

`backup.sh`, `restore.sh`, production wrappers и `reconcile.py` используют общий `scripts/recovery_config.py`. Checkout `.env` никогда не читается ими и не открывается Compose автоматически. Работа из любого CWD поддержана абсолютными Compose manifest paths и собственным script directory.

Основной production режим: `HOMECLOUD_ENV_FILE=/secure/homecloud/recovery.env`. Файл должен находиться вне checkout, иметь абсолютный путь, быть regular/readable, без конечного symlink. Права0600/0640; read-only0400/0440 тоже допустимы. World-readable, group-writable, executable и special-bit modes отклоняются до любых backup/restore операций. Parent directory защищает оператор (предпочтительно0700); ancestor symlinks допустимы для доверенного локального deployment, canonical path не может оказаться внутри checkout. Это ACL контракт доверенного Linux host, не sandbox против root или конкурентного изменения конфигурации администратором.

Формат: отдельные `KEY=value` строки, blank lines и отдельные `#` comments. Крайние одиночные/двойные кавычки снимаются; shell expansion, escape decoding, multiline и inline comments не поддержаны. Файл не исполняется через `source`. Unknown/duplicate keys и malformed quoting отклоняются без вывода значений. Allowlist находится в `KEYS` loader; не включать посторонние application настройки. После обновления config повторить qualification.

Обязательны `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`. DB identifiers: `[A-Za-z_][A-Za-z0-9_]{0,62}`; сложные quoted PostgreSQL identifiers вне контракта. `COMPOSE_FILE` — существующие абсолютные manifest paths, разделённые `:`; первый файл задаёт Compose-relative resources. `COMPOSE_PROJECT_NAME` — явное имя существующего target, иначе новый проект создаст пустые volumes. Compose paths с `:` не поддержаны. Coordinator дополнительно требует backup roots, acknowledgements и соответствующий age key file по контракту ниже; production manifest требует JWT/TLS/host и другие settings из secret/topology runbooks.

Приоритет: уже экспортированное окружение **выше** файла, включая пустое значение (пустой required input вызывает failure). Это сохраняет runtime `BACKUP_DIR` staging override coordinator и явные operator overrides. Перед запуском удалить stale exports; для единственного источника использовать чистое окружение:

```sh
env -i PATH="$PATH" HOME="$HOME" HOMECLOUD_ENV_FILE=/secure/homecloud/recovery.env \
  bash /opt/homecloud/scripts/backup-production.sh
env -i PATH="$PATH" HOME="$HOME" HOMECLOUD_ENV_FILE=/secure/homecloud/recovery.env \
  bash /opt/homecloud/scripts/restore-offsite.sh GENERATION --validate-only
```

Альтернатива для полностью подготовленного exported environment: явно `HOMECLOUD_CONFIG_MODE=environment`, без `HOMECLOUD_ENV_FILE`. Отсутствие file path без этого opt-in — ошибка; оба режима одновременно запрещены. Implicit development fallback отсутствует. Missing/unreadable файл не заменяется окружением.

Все nested Compose вызовы используют `--env-file /dev/null`; loader экспортирует проверенные file settings и запрещает auto dotenv discovery. Поэтому Compose и helper видят одинаковые значения; CLI DB identifiers reconcile обязаны совпадать с конфигурацией. Secrets (`DB_PASSWORD`, JWT/Redis/metrics tokens, age identity contents) не печатаются loader и errors; config path и отсутствующие variable names не являются secrets. Значения доступны child environment/Docker/root по существующей secret-lifecycle модели; это не secret-manager isolation. Shell tracing отключён в helpers. Не включать tracing/diagnostic env dumps в caller и не писать secrets в обычные path/image settings.

Историческая схема: backup читал шесть DB/Redis/JWT ключей checkout `.env` поверх окружения; restore обнулял DB keys и читал только `.env`; coordinator принимал exported settings, но nested helper терял DB input; reconcile имел явные CLI identifiers и CWD-dependent Compose. `STORAGE_PATH`/image/retention/roots — обычная конфигурация; возрастные key-file paths — обычные paths, их содержимое секретно. Текущая схема устраняет эти различия без изменения backup format/encryption/offsite.

## Исполняемый контракт

Все paths абсолютные; локальный и внешний root различаются и не вложены друг в друга. Внешний root provisioned заранее; автоматическое создание потерянного mount недопустимо. Recipient/identity файлы вне repo и обоих backup roots, без symlink, права0600. Структура generation: `hc_YYYYMMDDTHHMMSSZ_<random16>/backup.age` + `manifest.json`. На внешнем root нет plaintext v1 metadata. Незавершённые `.partial_*` не являются restore points.

Настройки backup job (DB/Compose/secrets входят в внешний recovery.env):

```sh
export HOMECLOUD_ENV_FILE=/secure/homecloud/recovery.env
export BACKUP_PRODUCTION_DIR=/var/lib/homecloud/encrypted-backups
export BACKUP_OFFSITE_DIR=/mnt/homecloud-offsite/backups
export BACKUP_AGE_RECIPIENTS_FILE=/secure/backup/recipients.txt
export BACKUP_OFFSITE_CONFIRMED=1
export BACKUP_WRITE_BARRIER_CONFIRMED=1
export BACKUP_RETAIN_COUNT=7
export BACKUP_RETENTION_DAYS=30
bash scripts/backup-production.sh
```

Подтверждения задавать только ПОСЛЕ проверки mount/failure domain и maintenance barrier. Не сохранять `BACKUP_WRITE_BARRIER_CONFIRMED=1` как постоянное обещание, когда writers работают. Legacy `scripts/backup.sh` остаётся plaintext maintenance tool и не production success contract.

Restore использует те же roots и `BACKUP_OFFSITE_CONFIRMED=1`, внешнюю `BACKUP_AGE_IDENTITY_FILE`, явный generation ID:

```sh
export BACKUP_AGE_IDENTITY_FILE=/secure/recovery/key-v1.txt
bash scripts/restore-offsite.sh hc_YYYYMMDDTHHMMSSZ_0123456789abcdef --validate-only
bash scripts/restore-offsite.sh hc_YYYYMMDDTHHMMSSZ_0123456789abcdef --yes
```

Сначала copy+verify, затем authenticated decrypt, безопасный whitelist четырёх regular bundle members, legacy validation. Wrong identity/corrupt artifact не вызывает target mutation. Destructive restore выполняется только в maintenance и выбранном Compose project; legacy DB restore не является общей транзакцией с storage. После успешного decrypt другие ошибки restore требуют существующего recovery runbook; гарантии полного rollback DB+storage нет.

## Retention и сигналы

Консервативный default: сохранять минимум7 verified generations и все моложе30 дней, отдельно на обоих roots. Count override не меньше2. Удаление старших возможно лишь после verified replacement+offsite success. Corrupt/partial наборы не считаются и автоматически не удаляются. Набор убирается из discoverable namespace rename в `.expired_*`, затем удаляется как каталог. Cleanup warning отдельно; уже verified backup остаётся успешным. Replication failure оставляет локальный encrypted restore point, возвращает nonzero и не запускает retention: это failed production job, не degraded success.

Safe JSON events различают configuration, legacy backup (фиксированные DB/storage/checksum reasons), archive, encryption, metadata, offsite replication/verification, decryption, archive validation, legacy restore, retention warning. Сырые child stdout/stderr подавлены: SQL, credentials и keys не попадают в общий job log. Exit codes: configuration2, legacy backup10, archive11, metadata12, encryption13, replication14, verification15, decrypt16, archive-validation17, legacy-restore18, прочие1. Retention warning не меняет successful backup exit0.

Оператор/планировщик обязан ловить nonzero job status, отсутствие `backup_production_completed`, события `retention_warning` и возраст последнего verified offsite success. Начальный alert threshold для daily schedule: >26h без offsite success; утвердить с RPO owner. Журнал scheduler хранить закрытым. DB failure: проверить readiness/disk/DB; storage: mount/permissions/capacity; metadata/checksum: сохранить прошлые restore points, проверить filesystem; encryption: наличие age/recipient permissions; replication: внешний mount/connectivity/capacity; cleanup warning: проверить права и `.expired_*`, не удалять newest points вручную. Повторить job после устранения причины с barrier. Внешняя доставка alerts и фактическое расписание production проверяются оператором; notification service здесь не установлен.

Локальный root должен иметь права0700. Shared `.production.lock` предотвращает параллельные production backup/restore; stale lock автоматически не крадётся. Маркеры `last-backup-success.json` и `last-restore-success.json` разделены; содержат безопасное время/event, backup дополнительно generation/offsite_verified. `--validate-only` пишет отдельный validation marker, не объявляет restore завершённым. Failure markers также разделены по operation.

## Проверка checkpoint

Production focused34PASS; legacy backup safety27PASS; legacy restore validation15PASS (1 destructive integration skipped и заменена real isolated drill). Bash/Python syntax и diff-check PASS. Real final drill evidence `/private/tmp/homecloud-backup-dr.c9ipSH/result.json`: offsite authoritative после удаления local copy, exact DB snapshots/quotas/shares/uploads и SHA256 bytes, readiness200, leakage/own cleanup PASS. Independent review APPROVE после bounded corrections validation signal/retention tie/fixed failure reasons. Реализованный backup checkpoint PASS; OVERALL_PRODUCTION_READINESS NOT_READY.

External-only config qualification: contract11/11, production34/34, safety27/27, restore15 PASS/1 integration SKIP; fresh encrypted paired drill `/private/tmp/homecloud-backup-dr.ldiKuX/result.json` с чистым env, custom DB и actual helpers вне checkout PASS. [Итоговый checkpoint](./final-production-acceptance.md#external-only-backuprestore-config--2026-10-01). Общий NOT_READY.


## Scheduler / delivered alerts — bounded remediation

Расписание, external-only config, maintenance-wrapper, retry/dedup/recovery и delivery boundary: [scheduler-alerting](./scheduler-alerting.md). Backup retention/integrity остаются в existing transaction, cert lifecycle/reload contract сохранён. Production recipient и target host не квалифицированы; общий **NOT_READY / NO_GO**.

## Независимое offsite / custody / measured budgets — 2026-10-02

Ненумерованная bounded remediation: [контракты, operator sequence и recovery objectives](./recovery-objectives.md), [raw qualification](./evidence/offsite-recovery/qualification.json). Local isolated target не является физическим внешним offsite. Раздельные итоговые статусы и фактические измерения фиксируются в qualification; overall **NOT_READY / NO_GO**. REAL_EXTERNAL_OFFSITE и REAL_CUSTODIAN_PROCESS остаются NOT_QUALIFIED, OWNER_APPROVED_RECOVERY_BUDGETS — NOT_AVAILABLE.

Раздельные итоговые статусы: OFFSITE_FAILURE_DOMAIN_MECHANICS=PASS; REAL_EXTERNAL_OFFSITE=NOT_QUALIFIED; RECOVERY_KEY_CUSTODY_MECHANICS=PASS; REAL_CUSTODIAN_PROCESS=NOT_QUALIFIED; MEASURED_RPO_RTO_BASELINE=PASS; OWNER_APPROVED_RECOVERY_BUDGETS=NOT_AVAILABLE; INDEPENDENT_OFFSITE_RECOVERY_DRILL=PASS; INDEPENDENT_REVIEW=APPROVE; PRODUCTION_BLOCKER_OFFSITE_RECOVERY=PARTIALLY_RESOLVED. Два128MiB прогона: verified RTO31.384/31.543s; подробные component timings, gaps и evidence limits — в recovery objectives. Overall NOT_READY / NO_GO.
