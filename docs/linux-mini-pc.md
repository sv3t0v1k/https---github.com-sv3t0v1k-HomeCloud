# D3: независимый Docker Compose на существующем Linux mini-PC

На 2026-10-13 подготовлен запуск **SSD → PostgreSQL, HDD → /storage**. SSD для
временных загрузок **OFF**: временные chunks остаются на HDD `/storage/.tmp`.
Это применимая конфигурация legacy режима, а не квалификация SSD upload pipeline.
Production **NOT_READY / NO_GO**, COMPLETE не установлен. Все команды ниже — для
будущего оператора на mini-PC; в D3 на Mac они не выполнялись. Mac Compose/данные сохранены.

## Что необходимо подтвердить до запуска

Native Linux x86_64, rootful local Docker без userns remap, Compose >=2.24.4
(`!override`), Python3 для read-only preflight, util-linux (`findmnt`, `lsblk`), установленная RAM
8 GiB. Systemd нужен только при выборе опционального boot-order helper. ARM/32bit/Rosetta/Desktop, LVM/RAID/crypt, NFS/SMB и другие FS требуют отдельной
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
COMPOSE_PROJECT_NAME (отдельный, например homecloud; никогда homecloud-preview),
PUBLIC_BIND_IP, PUBLIC_HTTP_PORT, PUBLIC_HTTPS_PORT, PUBLIC_ORIGIN и обе proxy subnet с exact peer IP,
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
sudo docker compose ls
sudo docker network ls
# Только чтение: убедиться, что выбранные IP/порты свободны.
sudo ss -ltn
sudo docker network inspect <существующие-network-имена> --format '{{json .IPAM.Config}}'
sudo docker compose version
```

Новые обязательные несекретные ключи в external runtime.env (пример, выбрать свободные):

```dotenv
COMPOSE_PROJECT_NAME=homecloud
PUBLIC_BIND_IP=127.0.0.1
PUBLIC_HTTP_PORT=18080
PUBLIC_HTTPS_PORT=18443
PUBLIC_HOST=cloud.example.org
PUBLIC_ORIGIN=https://cloud.example.org:18443
BACKEND_PROXY_SUBNET=172.30.0.0/24
FRONTEND_PROXY_IP=172.30.0.10
INGRESS_SUBNET=172.29.0.0/24
INGRESS_PROXY_IP=172.29.0.10
```

Loopback пример предполагает заранее согласованный routing, не даёт внешнего доступа
сам по себе. Origin/порты/CA qualification должны соответствовать фактическому пути.
Штатный HTTP→HTTPS redirect ingress сохраняет внешний443. Custom host bindings
18080/18443 использовать с подтверждённым routing на внешние80/443; прямой custom
HTTPS URL годится для отдельной пробы, HTTP redirect для него пока не квалифицирован.
Если origin на443, писать `https://cloud.example.org` без `:443` и без trailing slash.

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

Production — отдельный Compose project с project-scoped именами сетей/контейнеров;
fixed/external names отсутствуют. Порты HTTP/HTTPS и две proxy subnet обязательны в
external env. Выбрать свободные значения после проверки существующих приложений и
host/VPN routes; peer IP менять вместе с subnet. Default bind IP — localhost. PUBLIC_ORIGIN — точный browser origin, например
`https://cloud.example.org` для443 либо `https://cloud.example.org:18443` для прямого
custom port, без trailing slash; он задаёт production CORS FRONTEND_URL.
Пример портов18080/18443 — только свободные кандидаты, проверять occupancy.
При прямом публичном TLS использовать свободный host IP:80/443; HTTP01 требует
внешнего port80. Для других портов оператор должен отдельно подтвердить routing/CA
challenge и существующий reverse proxy; чужую конфигурацию эта задача не меняет.

Docker Engine уже установлен: не переустанавливать, не менять daemon.json/docker.service,
не останавливать чужие контейнеры. Все приложения HomeCloud, PostgreSQL и TLS — в Docker.
На host нужны mounts/udev, защищённые config/markers и read-only preflight.

### Gate при каждом старте writer

Production DB/backend имеют entrypoint `deploy/linux/startup-gate.sh` и
`restart: unless-stopped`. **До initdb/chown, migrations/API и штатных Compose run
helpers** gate читает только metadata: udev `/dev/disk/by-uuid`, host mountinfo и
собственный `/proc/self/mountinfo`. Проверяет UUID→major:minor, `/dev` source, exact
host mountpoint, ext4/xfs rw, exact root собственного bind, отсутствие nested mounts,
marker, UID/GID/0700; backend также `.tmp`, DB — pg_wal/tablespaces. Неверный/missing
диск или недоступная metadata => exit1, writer не запускается. Gate ничего не создаёт
и не исправляет. Наличие каталога, скопированный marker и поздний host mount не дают PASS
для bind системного раздела. `create_host_path:false` установлен на всех gate/data binds.

`/dev` подключён readonly под `/run/homecloud/dev` **только для stat/readlink metadata**;
нет privileged, devices или добавленных capabilities. Device cgroup не открывается для
block I/O. На hardened host чтение proc/udev может быть запрещено: STOP, отдельная
qualification без ослабления защиты. UUID/source/marker не криптографическая identity;
root/Docker admin может подменить metadata или `--entrypoint`, это вне модели gate.

Compose не упорядочивает host mounts; Docker daemon restart не выполняет Compose
`depends_on`. Мы обеспечиваем отказ раннего старта, а не ожидание диска. При раннем
отказе policy не гарантирует повторную попытку (в частности, startup <10s); после
монтирования оператор выполняет `hcc up -d --no-build --pull never --wait`. Если bind
был создан до mount, может потребоваться явное пересоздание **только** остановленного
writer после preflight; сначала проверить CID/D1 maintenance contract. Автоматического
fallback/ожидания/пересоздания данных нет. systemd для безопасности старта не обязателен;
`homecloud.service` оставлен опциональным boot-order helper. Его BindsTo может остановить
проект при исчезновении mount unit, но не доказывает fencing зависшего I/O.

Gate — проверка старта, не runtime fencing при physical disk loss/remount. Не выполнять
unmount/substitution живых disks; сначала `hcc stop`. Live I/O failure, reboot и device
re-enumeration требуют проверки на disposable Linux цели. Production остаётся NO_GO.

Источники: [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/),
[bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/),
[mountinfo fields](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html).

## Images, UID/GID, каталоги и marker

Строить images на target Linux или получать проверенные linux/amd64 release images.
Не копировать macOS node_modules или `.node`. Старые :dev images Mac ARM64 не подходят.
Безопасное чтение config — только `config --quiet`; полный config содержит секреты.

```sh
cd /opt/homecloud
hcc() {
  (cd /opt/homecloud && sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    docker compose --env-file /etc/homecloud/runtime.env \
    -f docker-compose.yml -f docker-compose.production.yml "$@")
}
hcpreflight() {
  (cd /opt/homecloud && sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    python3 /opt/homecloud/deploy/linux/preflight.py)
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
# После подготовки gate config/physical markers ниже выполнить hcpreflight.
# Logical marker bootstrap выполняется после enrollment gate ниже.
```

Bootstrap запускается от1001, не создаёт каталог и не перезаписывает marker. Existing
marker проверить штатным backend startup/registry; не заменять и не создавать вручную.
Marker подтверждает logical legacy-storage, host preflight — ожидаемый физический диск.
`.tmp` на HDD; **SSD workspace не создавать/не enroll/не bind-mount** сейчас.
Каталог БД подготовлен отдельно на SSD; backend к нему не имеет volume mapping.

### Первичное enrollment физических markers и gate records

Это **не SSD upload enrollment**. Один раз после ручного подтверждения exact mounts,
UUID/serial, source, owner data directories подготовить два config record root:0644 в
root-owned `/etc/homecloud` (0700 для внешних env, но gate files bind читаются отдельно).
Markers находятся в parent data directory, вне PGDATA/storage и вне D1 data swap;
создавать только отсутствующие, не заменять существующие и не запускать при missing mount.
Запуск ниже повторно проверяет диски и каталоги перед записью, не меняет данные/их права.
Использует фактические inventory UID/GID; markers имеют service-owner/0400.

```sh
cd /opt/homecloud
sudo env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  python3 - <<'PYGATE'
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location('preflight', 'deploy/linux/preflight.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
i = json.loads(Path('/etc/homecloud/host-disks.json').read_text())
ssd = p.check_disk(i['ssd']); hdd = p.check_disk(i['hdd'])
p.require(ssd != hdd and i['ssd']['uuid'] != i['hdd']['uuid'], 'Нужны разные диски')
rows = [('db', i['ssd'], i['postgres_uid'], i['postgres_gid']),
        ('backend', i['hdd'], 1001, 65533)]
for role, disk, uid, gid in rows:
    p.check_data_directory(disk['data'], disk, uid, gid)
    if role == 'backend':
        p.check_data_directory(str(Path(disk['data']) / '.tmp'), disk, uid, gid)
    else:
        p.check_postgres_layout(disk['data'])
    values = (role, disk['uuid'], disk['mount'], disk['data'], str(uid), str(gid))
    p.require(all(v and not any(c.isspace() for c in v) for v in values), 'Пробелы запрещены')
    marker = Path(disk['data']).parent / ('.homecloud-' + role)
    gate = Path('/etc/homecloud/startup-' + role + '.gate')
    # Exclusive create: existing identity не перезаписывается. После partial failure STOP/разбор.
    for path, text, owner, mode in [(marker, f'homecloud-v1 {role} {disk["uuid"]}\n', (uid, gid), 0o400),
                                    (gate, ' '.join(values) + '\n', (0, 0), 0o644)]:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'w') as out:
            os.fchown(out.fileno(), *owner); os.fchmod(out.fileno(), mode)
            out.write(text); out.flush(); os.fsync(out.fileno())
PYGATE
hcpreflight
# Только если штатного logical HDD marker ещё нет:
hcp run --rm --no-deps --pull never backend node dist/storage/bootstrap-storage-identity.js
```

Существующие gate/markers проверить `hcpreflight`, не пересоздавать ради PASS. Host
preflight дополнительно проверяет physical serial, разные диски, capacity, native
Docker/images/config; shell gate проверяет реальные identities при **каждом** start/restart.

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
# Если опциональный unit был установлен/запущен: сначала sudo systemctl stop homecloud.
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

После успешного backup/validate-only/разрешённого restore вернуть проект через
`hcpreflight` и `hcc up -d --no-build --pull never --wait`. Gate DB/backend сохраняется
при D1 helper-started штатных Compose services; отдельные helper с explicit entrypoint
относятся к привилегированным операторским действиям, требуют maintenance/preflight.
Сверить CID/config/image/mount/marker, SQL journal/reconciliation и readiness. При
любом отказе writers оставить остановленными. Existing backend CID до D1 не удалять.

## Запуск, обновление, restart и остановка только HomeCloud

`hcc` фиксирует external env и main+production manifest. Не менять project имя после
создания. `stop` не зависит от PASS и сохраняет CID/data. При обновлении сохранить
проверенную image pair/config и D1 backup; остановить writers до migrations. Env/release
pair менять отдельно в root0600 runtime.env и recovery.env, сохранять DB credentials.

```sh
hcpreflight
hcc up -d --no-build --pull never --wait --wait-timeout 180
hcc ps
hcc exec -T backend node docker/healthcheck.cjs
hcc logs --tail=80 backend ingress
# Внешняя проверка через настоящий DNS/CA, без -k, с выбранным HTTPS port:
curl -fsS <PUBLIC_ORIGIN>/ -o /dev/null
# Restart повторно выполняет per-start gate; config/image не обновляет.
hcpreflight && hcc restart db backend frontend ingress
# После restart зависимости readiness не ожидаются: проверить ps/health, при отказе STOP.
# Обновление только проверенной image pair; не запускать миграцию параллельно API:
hcc stop ingress frontend backend
hcc pull backend frontend
hcpreflight && hcc up -d --no-build --pull never --wait --wait-timeout 180
# Остановка всего и только выбранного project, даже при missing mount:
hcc stop
```

Сначала проверить images после pull и совместимость schema/release. Пример подразумевает
registry release refs; для local Linux build использовать `hcc build backend frontend`
после остановки writers. Runtime gate не квалифицирует release/rollback. Не выполнять
`down -v`, prune, rm данных/чужих ресурсов. При `unhealthy` закрыть writers и разобрать
причину; Docker policy health не мониторит.

### Необязательное упорядочивание загрузки host

`deploy/linux/homecloud.service` можно применять **только по отдельному решению оператора**,
после Linux qualification, если нужен boot-order helper с BindsTo. Unit не обязателен
для Compose management или fail-closed startup. Шаблон предполагает `/opt/homecloud`,
`/etc/homecloud/runtime.env`, `/usr/bin/docker`, `/usr/bin/python3` и exact mount units;
при других путях исправить шаблон, проверить `systemd-analyze verify` до установки.
Не модифицировать общий docker.service/daemon.json. В этой задаче unit не устанавливался.

RAM ceilings: backend4GiB + DB1GiB + frontend256MiB + ingress128MiB =5.375GiB;
optional Redis ещё256MiB. Это пределы, не измеренные RSS. Preflight требует MemTotal>=7GiB
(8GiB installed с reserved memory) и MemAvailable>=2GiB перед стартом; это floor, не
доказательство peak headroom. На target измерить `docker stats --no-stream`, MemAvailable,
OOM/restarts, swap/I/O, 50+GiB upload и выбранную concurrency. Production Redis находится в unqualified-production-redis profile; не включать его
ради этого приложения. Не повышать лимиты без измерений. CPU limits здесь не придуманы.

Rollback приложения: stop writers (и optional unit, если выбран), сохранить точные текущие image IDs/config/env и
backup. Старый image запускать только при доказанной schema compatibility; миграции вниз
не выполнять. Новая schema несовместима/данные изменились → оставить stack остановленным,
отдельный D1 recovery план. Snapshot image не откатывает БД/files.

```sh
# STOP работает даже при missing mount/preflight failure.
# Если выбран optional unit: sudo systemctl stop homecloud.
hcc stop
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
   Проверить Compose restart, прямой docker restart own CID, daemon restart/reboot:
   каждый новый старт повторяет gate; подтвердить отсутствие initdb/API/fallback. Late mount
   после stale bind должен дать STOP. Не перезапускать общий daemon на shared production host
   ради проверки: сначала отдельная disposable Linux цель.
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
