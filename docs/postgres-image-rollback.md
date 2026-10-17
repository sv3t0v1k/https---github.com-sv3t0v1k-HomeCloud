# Возврат собственного PostgreSQL image на официальный — проект процедуры

D5.1.12, 18.10.2026 Владивосток. **Не выполнено; production recovery UNQUALIFIED.**
Процедура для будущего согласованного окна; здесь нет команд, автоматически
подключающихся к host, останавливающих сервисы или перезаписывающих реальные данные.
Production NO_GO. Действующий production Compose не изменяется этой подготовкой.

Цель возврата — pinned official PostgreSQL **16.15 Linux/amd64**:
`docker.io/library/postgres:16.15-alpine@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`.
Это штатная конфигурация возврата, а не security-approved image: исторические
1 Critical / 24 High не устранены этим runbook. Его эксплуатация также требует
отдельного решения в рамках действующей policy; возврат не даёт production GO.
Не использовать floating `postgres:16-alpine` из Mac Compose и не понижать major.

## Подготовка и точка возврата — до будущего переключения

1. Назначить владельца операции и независимого проверяющего. Согласовать downtime,
   RPO/RTO и триггеры возврата: admission/startup failure, corruption indicators,
   migrations/schema mismatch, failed restore или regression. Не совмещать image
   switch с изменением backend/schema/PG major/extensions/collation. Сохранить
   effective Compose, release/config hashes, image manifest/config, storage mapping,
   mount UUID/marker и UID/GID/modes; без secrets в Git/evidence.
2. Подтвердить topology: production DB — существующий SSD bind `SSD_DB_DIR` к
   `/var/lib/postgresql/data`, owner 70:70 mode0700. Marker лежит рядом, вне PGDATA;
   UUID/mount admission обязателен при каждом старте. Storage — отдельный HDD bind.
   На Mac — named volume с именем, вычисленным project; его нельзя принимать за
   production bind. Проверять реальный источник из согласованного inventory.
3. Проверить свободное место для исходного PGDATA, полной cold copy, отдельного
   восстановленного PGDATA, dumps/WAL и согласованного запаса; учитывать размер
   HDD backup и время копирования. При недостатке места/неподтверждённой identity STOP.
4. Закрыть admission новых загрузок/записей; штатно завершить активные uploads,
   остановить backend и все writers, включая helpers/cron/admin clients, исключить
   автоматический restart. Записать завершённые upload sessions и DB/storage
   consistency point. Простая остановка frontend не доказывает отсутствие writers.
5. При ещё работающей БД снять `pg_dump -Fc -Z6` всех нужных БД и отдельно
   `pg_dumpall --globals-only` (roles/ownership; файл может содержать секреты).
   Проверить exit codes, размеры, SHA-256; хранить с ограничением доступа вне Git.
   До переключения подтвердить restore dump/globals в **отдельном synthetic/isolated
   PGDATA** на exact official 16.15: roles, ownership, extensions, constraints,
   migration rows, marker/counts/hashes, readiness и read-only app smoke.
   Bootstrap role conflicts обработать согласованным явным SQL plan, не игнорировать
   ошибки. Restore globals — `psql -X -v ON_ERROR_STOP=1`, custom dump —
   `pg_restore --exit-on-error`; одно только `pg_restore --list` не доказывает recovery.
6. Штатно остановить PostgreSQL, подтвердить exit0 и clean shutdown по logs/control
   metadata; отсутствие container не равно clean shutdown. Исключить restart;
   не использовать SIGKILL как нормальную процедуру. Снять **полную cold copy** всего
   cluster, включая WAL, permissions, ownership и конфигурацию, без выборочного
   копирования таблиц. External tablespaces/WAL symlinks текущим gate запрещены;
   обнаружены — STOP. Снять согласованную с DB точкой копию HDD storage с metadata
   и незавершёнными workspace/session состояниями либо подтвердить отсутствие их
   записей. Не копировать живой PGDATA обычным tar/cp.
7. Проверить hashes/copy completion и возможность восстановления; originals и
   резервные копии сохранить отдельно и защитить от записи. Две копии на одном
   диске не защищают от его отказа. Не считать DB dump резервной копией файлов HDD.
   Образ official и candidate bytes доступны offline с проверенными digests, expiry
   artifacts учтён. Пока любой шаг не подтверждён — переключение запрещено.

## Откат образа без отката данных

1. Снова закрыть запись и остановить всех writers; штатно остановить candidate БД.
   Зафиксировать последние подтверждённые записи. Сделать диагностическую полную
   cold copy текущего PGDATA, не трогая исходную pre-switch backup. Определить,
   успел ли candidate принимать новые записи; неизвестно — считать, что успел.
2. Проверить точные PostgreSQL version/architecture/config/extensions и отсутствие
   schema/app changes. На **копии** текущего PGDATA в изолированном окружении без
   внешних clients проверить official 16.15 и read-only integrity checks. Старый
   synthetic `previous→candidate→previous` PASS относился к предыдущему производному
   образу, не к прямому current→official под production startup gate. Сам по себе
   он этот шаг не закрывает; нужен отдельный прямой synthetic drill до интеграции.
3. Если copy drill PASS и нет corruption/schema mismatch: в будущем отдельном
   approved Compose change выбрать pinned official, сохранив тот же project,
   SSD bind, env, startup gate и HDD storage. Не выполнять `down -v`, prune,
   initdb поверх непустого каталога, migrations rollback или рекурсивный chown
   на непроверенном пути. Не отключать marker/mount checks и restart safeguards.
4. Запустить сначала только БД с прежним gate. Проверить digest/config, clean
   recovery, `pg_isready`, version, migration table и контрольные counts/hashes.
   Backend не запускать автоматически: его entrypoint выполняет migrations.
   При любой ошибке остановиться, сохранить logs; не запускать второй writer.
5. После подтверждения той же schema и code version выполнить read-only smoke;
   затем отдельное разрешение на снятие write freeze. Это сохраняет принятые
   записи лишь если целостность current PGDATA подтверждена; нулевой RPO не обещается.

## Recovery из backup, если текущие данные повреждены или несовместимы

1. Оставить writers остановленными, текущее PGDATA и HDD сохранить для расследования.
   Восстановить **в новый пустой отдельный каталог/volume**, никогда поверх original.
   Путь заранее проверен, owner/mode и marker подготовлены безопасно; для проверки
   startup gate нужен отдельный разрешённый fixture inventory, не обход admission.
2. Предпочтительный fast recovery — полная проверенная pre-switch cold copy и
   соответствующий HDD snapshot. Альтернатива — initdb нового isolated PGDATA на
   official, восстановление globals и custom dumps с остановкой на ошибке,
   затем соответствующий storage backup. Проверить extensions, ownership, schema,
   migration rows, file references/bytes и отсутствие missing files/orphan bindings.
3. Нельзя сочетать старую DB с произвольным новым HDD состоянием: rollback БД может
   потерять ссылки на новые файлы или вернуть ссылки на удалённые. Восстанавливать
   согласованную DB+storage точку. Если candidate принимал записи после backup,
   возврат к ней теряет эти изменения; требуется **явное решение владельца о потере
   данных**, оценка дельты и согласованное восстановление/сверка. Не обещать PITR:
   непрерывное WAL archive/PITR этим пакетом не настроено и не доказано.
4. После isolated restore и read-only app checks независимый проверяющий подтверждает
   результаты и фактические RPO/RTO; владелец разрешает переключение на новый путь
   отдельным reviewed config change. При смене SSD_DB_DIR обновление mount/marker
   inventory согласовать, gate не выключать. Originals/backup не удалять до окончания
   согласованного retention window. Не начинать следующую Phase автоматически.

## Что проверено и что остаётся

Для exact OCI повторно использованы synthetic 26 migrations/no-op, compressed
schema/marker restore и previous↔candidate PGDATA. Новые проверки D5.1.12 — offline
identity/evidence, negative context checks и статический Compose runtime contract.
Прямой candidate↔official под production gate, полный Compose CLI merge, backup
реальных данных, DB+HDD disaster recovery и измерения RPO/RTO **не выполнялись**.
Следующий допустимый шаг — отдельный isolated synthetic drill, без mini-PC/Mac
Docker/реальных данных. Успешные уже выполненные tests не повторять без новой причины.

Основа требований: [PostgreSQL 16 SQL dump/globals/restore](https://www.postgresql.org/docs/16/backup-dump.html),
[полная остановка и cluster copy для filesystem backup](https://www.postgresql.org/docs/16/backup-file.html).
