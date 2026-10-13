# D3: подготовка HomeCloud к Linux mini-PC

На 2026-10-13 подготовлен запуск **SSD → PostgreSQL, HDD → /storage**. SSD для
временных загрузок **OFF**: временные chunks остаются на HDD `/storage/.tmp`.
Это применимая конфигурация legacy режима, а не квалификация SSD upload pipeline.
Production **NOT_READY / NO_GO**, COMPLETE не установлен. Все команды ниже — для
будущего оператора на mini-PC; в D3 на Mac они не выполнялись. Mac Compose/данные сохранены.

## Что необходимо подтвердить до запуска

Native Linux x86_64, rootful local Docker без userns remap, Compose >=2.24.4
(`!override`), Python3, util-linux (`findmnt`, `lsblk`), systemd, установленная RAM
8 GiB. ARM/32bit/Rosetta/Desktop, LVM/RAID/crypt, NFS/SMB и другие FS требуют отдельной
квалификации, этот preflight их отвергает. Использовать ext4 или xfs; наличие ext4/xfs
не заменяет аппаратную проверку. Репозиторий предполагается в `/opt/homecloud`.

Проверить HEAD/status и собственные edits до обновления; сохранять посторонние файлы.
Production env вне checkout, root:root/0600. В `.env.example` заменить project на
`homecloud`, DB credentials — только для **новой** БД; existing credentials сохранять.
TLS_CERT_DIR должен содержать `current/fullchain.pem` и `current/privkey.pem`; заранее
выдать/проверить сертификат настоящего CA и настроить renewal по [TLS lifecycle](certificate-lifecycle.md).
ACME_WEBROOT_DIR должен существовать. Цепочка trust: ingress→frontend→backend,
INGRESS_SUBNET/INGRESS_PROXY_IP и BACKEND_PROXY_SUBNET/FRONTEND_PROXY_IP согласованы;
не заменять exact peer trust на wildcard/CIDR/hop count.

Заполнить PUBLIC_HOST, TLS_CERT_DIR, ACME_WEBROOT_DIR, SSD_DB_DIR, HDD_STORAGE_DIR,
оба RELEASE_*_IMAGE отдельными target tags/digests. В env не добавлять SSD mapping:
UPLOAD_SSD_PATH/MOUNT_SOURCE/MOUNT_ROOT/FS_TYPE должны отсутствовать даже как пустые
значения. Не устанавливать feature ON или recovery once.

`/etc/homecloud/host-disks.json` — копия `deploy/linux/host-disks.example.json`, без
секретов, root:root/0600; записать **реальные** UUID разделов и serial физических
дисков по инвентаризации, не по `/dev/sdX`, размеру или имени каталога. Заполнять
вручную после сравнения с маркировкой/паспортом оборудования. Пример capacity
10 GiB SSD/20 GiB HDD/10000 inodes — только floor для малой пробы, не бюджет 1 TiB upload.
Рассчитать и поднять minima под реальную БД, квоты и объём проверки.

```sh
uname -m
free -h
sudo dmidecode --type memory       # подтвердить установленную RAM; MemTotal меньше 8 GiB
lsblk -o PATH,TYPE,SIZE,FSTYPE,UUID,SERIAL,MOUNTPOINTS
findmnt --target /srv/homecloud-ssd -o TARGET,SOURCE,FSTYPE,UUID,OPTIONS
findmnt --target /srv/homecloud-hdd -o TARGET,SOURCE,FSTYPE,UUID,OPTIONS
# Перед запуском также сверить host/VPN/Docker routes с обеими proxy subnets.
ip route
sudo docker network ls
sudo docker compose version
```

UUID+serial сопоставляют ожидаемые устройства; это не криптографическая identity.
SSD и HDD — разные physical disks и failure domains. Не форматировать существующие
диски в рамках этой инструкции. При неизвестном содержимом или несовпадении — STOP.

## Mounts и отсутствие fallback

Оператор оформляет `/etc/fstab` с проверенными UUID, например (заменить UUID и FS):

```fstab
UUID=<UUID-SSD> /srv/homecloud-ssd ext4 defaults,nofail,x-systemd.device-timeout=15s 0 2
UUID=<UUID-HDD> /srv/homecloud-hdd ext4 defaults,nofail,x-systemd.device-timeout=15s 0 2
```

`nofail` позволяет ОС загрузиться без диска; HomeCloud при этом запускаться не должен.
Для xfs поле fsck pass — 0. Не использовать automount для этих данных. Underlay mount
каталоги на системном диске держать root:root/0700 и пустыми; не создавать в underlay
`postgres`/`storage`. После проверенного монтирования подготовить **дочерние** каталоги
на соответствующих FS. Не менять рекурсивно права существующей БД/files.

Production `restart: "no"` запрещает автоматический Docker restart в обход host gate.
`create_host_path:false` запрещает создание missing source, но каталог может существовать
на системном диске при missing mount. Поэтому перед каждым стартом обязателен host
preflight: exact mountpoint, UUID, physical serial, разные диски, writable FS, отсутствие
symlinks/nested data mounts (включая pg_wal), external PostgreSQL tablespaces, owner/mode, свободное место/inodes, daemon/image arch.

Запуск systemd использует RequiresMountsFor + BindsTo/After exact `.mount` units.
При их переходе в inactive HomeCloud останавливается. Сбой питания/зависший I/O могут
оставить mount unit active: этот шаблон не доказывает автоматическое fencing таких
отказов. Прямые `docker start/restart`, вторые writers и remount во время работы запрещены
операторским контрактом. Root/Docker admin может обойти gate; это не security sandbox.

Источники: [Docker restart/bind](https://docs.docker.com/reference/compose-file/services/),
[systemd BindsTo/After](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml).

## Images, UID/GID, каталоги и marker

Строить images на target Linux или получать проверенные linux/amd64 release images.
Не копировать macOS node_modules или `.node`. Старые :dev images Mac ARM64 не подходят.
Безопасное чтение config — только `config --quiet`; полный config содержит секреты.

```sh
cd /opt/homecloud
hcc() {
  sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    docker compose --env-file /etc/homecloud/runtime.env \
    -f docker-compose.yml -f docker-compose.production.yml "$@"
}
hcpreflight() {
  sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    python3 deploy/linux/preflight.py
}
hcp() { hcpreflight && hcc "$@"; }  # запуск/oneoff только после PASS
hcc config --quiet
# BUILD не запускает сервисы и не подключает bind data; сначала собрать target images.
hcc build backend frontend
# При использовании release registry: hcc pull db backend frontend ingress.
# При local build получить только инфраструктурные images:
hcc pull db ingress
```

Записать локальные image IDs и архитектуры всех четырёх images в закрытые evidence;
для реального release нужны проверенная immutable пара и отдельный release gate.
Для image inspection передать **literal exact** references из runtime.env:

```sh
sudo docker image inspect <backend-image> <frontend-image> postgres:16-alpine nginx:1.28-alpine \
  --format '{{.Id}} {{.Os}}/{{.Architecture}} {{.Config.User}}'
sudo docker run --rm --network none --read-only --cap-drop ALL --entrypoint id postgres:16-alpine postgres
sudo docker run --rm --network none --read-only --cap-drop ALL --user 1001:65533 \
  --entrypoint id <backend-image>
# Реальный openat2 под обычным Docker seccomp, только чтение image /storage БЕЗ data bind:
sudo docker run --rm --network none --read-only --cap-drop ALL --user 1001:65533 \
  --entrypoint node <backend-image> -e \
  'const fs=require("fs"),n=require("./native/secure-fs.node"); const r=n.root("/storage"); const fd=n.directory(r,"."); fs.closeSync(fd); n.close(r); console.log(process.platform,process.arch,"native read PASS")'
```

ENOSYS/EACCES/addon load error — STOP, не добавлять privileged/seccomp=unconfined и не
вводить syscall fallback. Этот read probe не квалифицирует write/rename/recovery.
Production backend явно `1001:65533`, как фактический nextjs и D1 restore ownership;
на target дополнительно сверить `id nextjs` exact image. GID не предполагать1001. Mac runtime не меняется. PostgreSQL UID/GID проверить
через exact image (16-alpine обычно70:70), затем записать в inventory.

После **ручного подтверждения mounts/UUID/serial** для НОВЫХ пустых data directories:

```sh
# Указать фактически проверенный PG UID/GID, не UID backend.
sudo install -d -m 0700 -o <PG-UID> -g <PG-GID> /srv/homecloud-ssd/postgres
sudo install -d -m 0700 -o 1001 -g 65533 /srv/homecloud-hdd/storage /srv/homecloud-hdd/storage/.tmp
hcpreflight
# Только если HDD marker отсутствует и этот root предназначен именно данному HomeCloud:
hcp run --rm --no-deps --pull never backend node dist/storage/bootstrap-storage-identity.js
```

Bootstrap запускается от1001, не создаёт каталог и не перезаписывает marker. Existing
marker проверить штатным backend startup/registry; не заменять и не создавать вручную.
Marker подтверждает logical legacy-storage, host preflight — ожидаемый физический диск.
`.tmp` на HDD; **SSD workspace не создавать/не enroll/не bind-mount** сейчас.
Каталог БД подготовлен отдельно на SSD; backend к нему не имеет volume mapping.

## БД, 520 и pending journals

Для existing DB/переноса сначала backup/D1 и read-only inventory при fenced writers.
Контейнерный STORAGE_PATH сохранять `/storage`. 520 проверяет ВСЕ existing legacy
session tempPath, включая завершённые: `/storage/.tmp/<uploadId>`; чужой root не лечить
ручным UPDATE. EntryPoint запускает migration transaction-all до API, ошибка = STOP.
Не запускать параллельно миграцию и API.

После миграции/на уже актуальной БД выполнить:

```sh
# DB уже healthy; frontend/backend/ingress остановлены, CID backend сохраняется.
hcp exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < deploy/linux/check-database.sql
```

Нужны applied520, canonical legacy clause `/storage/.tmp` в guard, ожидаемые workspace
rows и fsync/full_page_writes/synchronous_commit=on. Unknown schema/function — STOP.
При fresh DB SQL выполняется после первого штатного startup, затем writers остановить
на время фиксации результата. Не выводить env, payload или журнал binding целиком.

**Если 520 уже применена legacy-only:** env+ON и повторный migration:run не enroll’ят
SSD. Forward migration/procedure в этом HEAD отсутствует. Единственный допустимый
будущий путь — отдельная reviewed additive forward migration с maintenance barrier,
DB+HDD backup, проверенными SSD roots/identity; сохранить legacy clause, immutable
workspaceId/tempPath/uploadId/expectedSha256 и hash constraints. Не удалять запись из
migrations, не повторять up520, не выполнять down520/rollback, не изменять guards вручную.
Такая миграция не входит в подготовку D3 и до её реализации SSD включать нельзя.

Любая operation с state!=committed или cleanupState!=cleaned, active SSD/nonlegacy session,
исторический journal без cleanup proof — STOP перед переносом/D1. OFF не очищает journals;
manual не делает startup sweep. `once` — лишь один проход до128 pending с сохранением
ошибок, не доказательство восстановления. Операторского recovery CLI нет. Replay completion
API требует отдельно разрешённого ON и valid binding. Перенос pending payload на новую
FS меняет dev/inode/root identity: не переписывать binding и не удалять journal. Нужен
отдельный reviewed recovery path, включая historical legacy-linked journals.

## DB+HDD backup/restore D1

Создать `/etc/homecloud/recovery.env` root0600 из runtime.env: те же Compose knobs,
absolute COMPOSE_FILE, project и image identity. Новые ключи записывать literal, без
shell `$VAR` interpolation, существующие не дублировать:

```dotenv
COMPOSE_FILE=/opt/homecloud/docker-compose.yml:/opt/homecloud/docker-compose.production.yml
COMPOSE_PROJECT_NAME=homecloud
STORAGE_PATH=/storage
BACKEND_IMAGE=<тот же literal image reference что RELEASE_BACKEND_IMAGE>
```

Добавить required age/offsite/key/staging параметры по
[production backup](backup-productionization.md). Не хранить постоянно
BACKUP_WRITE_BARRIER_CONFIRMED=1. D1 сверяет existing backend CID/config-hash/local image
ID и canonical bind source; fresh project без backend CID не является restore target.
Config-only подготовка не доказывает destructive restore. `--validate-only` создаёт
свои scratch DB/migration контейнеры (512MiB/1CPU/128PID/1GiB tmpfs) и может отвергнуть
большую БД по лимитам. Совместимость Linux bind topology подготовлена; target round-trip
не проверен. [D1 контракт](backup-and-restore.md#d1--усиленный-контракт-backuprestore-2026-10-13).

```sh
# Сначала остановить systemd, чтобы он не оставался active после maintenance.
sudo systemctl stop homecloud
# Дополнительное fencing на случай неполного stop; DB оставить/поднять отдельно.
hcc stop ingress frontend backend
hcpreflight
hcc up -d --no-build --pull never --wait db
# Существующий backend CID НЕ удалять; down/rm запрещены.
sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  HOMECLOUD_ENV_FILE=/etc/homecloud/recovery.env BACKUP_WRITE_BARRIER_CONFIRMED=1 \
  bash scripts/backup-production.sh
# Проверка выбранного offsite set по контракту wrapper, target данные не переключает:
sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  HOMECLOUD_ENV_FILE=/etc/homecloud/recovery.env \
  bash scripts/restore-offsite.sh <GENERATION> --validate-only
```

GENERATION взять из verified offsite набора по `backup-production.sh` и manifest, формат
`hc_YYYYMMDDTHHMMSSZ_<16hex>`; не `.partial` и не произвольный local timestamp.

Destructive restore выполняется отдельно по утверждённому плану на disposable цели,
с теми же image/config/mount checks, maintenance и explicit barrier. Не восстанавливать
Mac/единственную target копию ради теста. D1 архивирует DB+постоянный HDD storage,
исключает `.tmp`/`*.tmp` и SSD workspace. Resume legacy pending chunks после restore не
гарантируется. Backup dump/tar последовательны: stop всех writers обязателен.

Capacity до backup/restore: HDD free для **uncompressed** staging и overhead, пока старая
копия сохранена; SSD free для DB restore/WAL/миграций; независимый local staging для
plaintext+bundle+ciphertext/publish, offsite capacity. Проверка helper по compressed archive
и BACKUP_DIR не доказывает свободное место HDD target. В legacy upload chunk+assembled
file могут одновременно занимать примерно2×F; учесть concurrency/квоты/previews/reserve.
MAX_FILE_SIZE=1TiB из Mac шаблона не обещает место; ограничить target env под budget.

При restore failure не делать up: stop writers, сохранить `.restore-staging/.restore-swap`,
DB/WAL и логи; ручной разбор. Полного атомарного rollback DB+files в D1 нет. Не удалять
retained artifacts и не повторять restore вслепую. Проверить checksum/metadata sidecars,
reconciliation, exact download hash, image ID/config-hash/mount marker, readiness; измерить
RPO/RTO и offsite recovery отдельно. Пока аппаратного D1 round-trip нет — NO_GO.

После успешного backup/validate-only вернуть сервис только через host preflight и
`sudo systemctl start homecloud`. Важно: destructive D1 restore сам запускает сервисы
для завершающих checks, когда unit ещё inactive. В это окно BindsTo fencing отсутствует;
на всё время recovery исключить remount/substitution и сторонний autostart. После
успешного restore закрыть ingress/writers (`hcc stop ingress frontend backend`), выполнить
host preflight, fenced SQL/проверку journal/reconciliation evidence и затем
`sudo systemctl start homecloud`. Проверить unit active и health всех сервисов. При
любом отказе не запускать unit. Не считать helper-started stack управляемым systemd.

## Запуск, health, RAM и остановка

Шаблон `deploy/linux/homecloud.service` требует `/opt/homecloud`, `/etc/homecloud/runtime.env`
и exact mountpoints выше. При иных paths изменить WorkingDirectory, RequiresMountsFor,
BindsTo/After unit names одновременно. Не включать unit до проверок marker/native/DB. Сверить `command -v docker` и
`command -v python3`: unit предполагает `/usr/bin/docker` и `/usr/bin/python3`; при иных
путях исправить все соответствующие Exec строки до установки. `/opt/homecloud` и
systemd unit должен менять только доверенный оператор/root.

```sh
systemd-escape --path --suffix=mount /srv/homecloud-ssd
systemd-escape --path --suffix=mount /srv/homecloud-hdd
sudo install -m 0644 deploy/linux/homecloud.service /etc/systemd/system/homecloud.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/homecloud.service
hcpreflight
sudo systemctl start homecloud
hcc ps
hcc exec -T backend node docker/healthcheck.cjs
# Приватная readiness: DB SELECT1, root/.tmp. Не доказывает serial/SSD recovery.
hcc logs --tail=80 backend ingress
# Внешне через настоящий DNS/CA, без -k:
curl -fsS https://<PUBLIC_HOST>/ -o /dev/null
# После аппаратных boot/missing-mount тестов можно разрешить автозапуск:
# sudo systemctl enable homecloud
```

При ExecStart failure ExecStopPost останавливает в том числе частично запущенные сервисы,
сохраняет volumes/CID. Unit oneshot active не мониторит health постоянно; `unhealthy`
сам по себе не перезапускает контейнер. Проверять health и логи, затем stop/разбор;
автоматический restart намеренно отключён до аппаратной qualification.

RAM ceilings: backend4GiB + DB1GiB + frontend256MiB + ingress128MiB =5.375GiB;
optional Redis ещё256MiB. Это пределы, не измеренные RSS. Preflight требует MemTotal>=7GiB
(8GiB installed с reserved memory) и MemAvailable>=2GiB перед стартом; это floor, не
доказательство peak headroom. На target измерить `docker stats --no-stream`, MemAvailable,
OOM/restarts, swap/I/O, 50+GiB upload и выбранную concurrency. Не включать optional Redis
ради этого приложения. Не повышать лимиты без измерений. CPU limits здесь не придуманы.

Rollback приложения: stop unit/writers, сохранить точные текущие image IDs/config/env и
backup. Старый image запускать только при доказанной schema compatibility; миграции вниз
не выполнять. Новая schema несовместима/данные изменились → оставить stack остановленным,
отдельный D1 recovery план. Snapshot image не откатывает БД/files.

```sh
# STOP работает даже при missing mount/preflight failure.
sudo systemctl stop homecloud
hcc stop ingress frontend backend db
```

## Вечером на mini-PC: последовательность и стоп-критерии

1. Сверить аппаратную inventory, serial/UUID, содержимое дисков, RAM8GiB, native amd64,
   local rootful Docker, subnets/ports. Подготовить mounts/env/target images.
2. Проверить UID/GID, owner0700/.tmp, свободное место/inodes с capacity plan, native probe,
   HDD marker; host preflight PASS. Начать с SSD upload OFF/manual.
3. Запустить штатные migrations/legacy режим, fenced SQL520/journals, внутреннюю readiness,
   настоящий TLS/DNS; маленький API/UI upload/download/Range с точным SHA256.
4. Проверить persistence после service restart/reboot. Missing mount/wrong UUID/wrong serial
   испытывать **на отдельной disposable цели**, без remount/unplug живого PGDATA/HDD.
   Подтвердить отказ старта и отсутствие fallback; systemd enable — только после этого.
5. D1 paired encrypted backup/offsite/validate-only и разрешённый disposable restore
   DB+HDD, reconciliation/hash/readiness, failure fencing/retained artifacts/RPO/RTO.
6. Отдельный будущий SSD gate: reviewed forward enrollment520, native roots/identity,
   journals/recovery, реальные SSD→HDD, SIGKILL/powerloss/missing mount, 50+GiB/RSS на8GiB.
   Этот пункт перечислен как prerequisite, запуск/реализация не входят в D3 preparation.

STOP: отсутствующий/другой mount или serial/UUID, изменённая identity, недостаток capacity/
RAM/inodes, неверные права/marker/native architecture/syscall, migration failure/unknown
root guard, pending SSD journal/cleanup, несогласованный TLS/proxy, unhealthy/OOM/hash
mismatch, restore failure или попытка включить SSD без forward path. Сначала закрыть
ingress и writers, сохранить логи/данные/артефакты; не reset/prune/down-v и не rollback520.
Пока эти target gates не проверены, production остаётся NO_GO.
