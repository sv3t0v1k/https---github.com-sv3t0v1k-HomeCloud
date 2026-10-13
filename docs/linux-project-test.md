# HomeCloud: тест внутри папки проекта на Linux mini-PC

Этот профиль предназначен для `/home/hs/homecloud-test` на существующем сервере с 8 GB RAM и другими приложениями. Он дополняет основной и production Compose третьим файлом `docker-compose.project-test.yml`. Mac Compose и его данные не меняются. Это тестовый запуск, **Production NO_GO** сохраняется; roadmap COMPLETE не устанавливается.

## Размещение и точные identities

| Назначение | Host path | Файловая система |
|---|---|---|
| PostgreSQL | `/home/hs/homecloud-test/data/postgres` | Системный `/`, ext4 на одном SATA SSD через LVM |
| Конфигурация, секреты, gates, TLS, ACME | `/home/hs/homecloud-test/.runtime` | Тот же SSD |
| HDD bind mount | `/home/hs/homecloud-test/data/hdd` | Полный существующий `/mnt/3TB`, ext4 |
| Файлы и временные chunks | `/home/hs/homecloud-test/data/hdd/homecloud-test/storage` и `.tmp` | HDD; SSD uploads OFF/manual |

БД делит место с ОС, Docker и другими приложениями. Отдельная папка не резервирует место. HDD делит физический диск с `/mnt/1TB`, где работает Frigate. USB serial `20170331000D4` дублируется, поэтому project profile дополнительно требует точный WWN обоих физических дисков.

Inventory `.runtime/host-disks.json` для этого сервера:

```json
{
  "project_root": "/home/hs/homecloud-test",
  "config_dir": "/home/hs/homecloud-test/.runtime",
  "ssd": {
    "identity_mode": "system-root-lvm",
    "mount": "/",
    "uuid": "f9ff3a92-1414-4285-bf3e-75e25c104d84",
    "serial": "PEV729R000518S30WX",
    "wwn": "0x53a5a277291c0206",
    "data": "/home/hs/homecloud-test/data/postgres",
    "min_free_bytes": 32212254720,
    "min_free_inodes": 10000
  },
  "hdd": {
    "mount": "/home/hs/homecloud-test/data/hdd",
    "uuid": "ccf122c6-c7a7-4d8e-86bd-06059730ee35",
    "serial": "20170331000D4",
    "wwn": "0x5032303936353475",
    "data": "/home/hs/homecloud-test/data/hdd/homecloud-test/storage",
    "min_free_bytes": 21474836480,
    "min_free_inodes": 10000
  },
  "postgres_uid": 70,
  "postgres_gid": 70
}
```

Проверить PostgreSQL UID/GID внутри выбранного exact image без data mounts до подготовки каталогов. Для `postgres:16-alpine` ожидается `70:70`; при другом результате не угадывать и не обходить проверку.

`system-root-lvm` разрешён только для DB на `/`: root ext4 → один LV → один раздел → один SATA SSD с exact serial/WWN/UUID. Другие LVM, RAID, crypt, multiple PV и nested mounts не квалифицированы. Старый dedicated profile продолжает запрещать системный root. На каждом старте gate проверяет UUID/block identity, host mount, собственный container bind, marker и права до initdb/migrations/API; это не защита от root/Docker admin.

## Подготовка перед запуском

Подготовку выполняет оператор отдельно от wrapper. Не копировать Mac `.env`, данные, `node_modules`, native addon или запрещённый audit. Native backend/frontend images должны быть заново собраны для Linux amd64 и иметь отдельные тестовые tags, например `homecloud-backend:d4-test` / `homecloud-frontend:d4-test`. Wrapper не собирает и не скачивает images.

1. Проверить, что `/mnt/3TB` действительно exact mount нужного UUID и WWN; создать только свой каталог `homecloud-test` на этом диске. Полный существующий filesystem root `/mnt/3TB` bind-монтируется в project `data/hdd`. Не размонтировать `/mnt/3TB` и `/mnt/1TB`, не менять fstab, не менять ownership существующих файлов. Симлинк вместо bind mount не подходит.
2. Создать `.runtime` как root:root `0700`, `runtime.env` и `host-disks.json` как root:root `0600`. `.runtime` и `data` исключены из Git. Для прохода service UID промежуточные project/data и собственный HDD parent должны быть traversable; секреты держать только в `.runtime`.
3. Создать пустой PGDATA как `70:70 0700` и HDD `storage` / `storage/.tmp` как `1001:65533 0700`. Не применять recursive chown/chmod к общему диску. Не создавать PostgreSQL tablespaces или external `pg_wal`.
4. Создать markers вне data roots: `data/.homecloud-db` с `homecloud-v1 db f9ff3a92-1414-4285-bf3e-75e25c104d84` и newline, owner `70:70`, mode `0400`; HDD `data/hdd/homecloud-test/.homecloud-backend` с `homecloud-v1 backend ccf122c6-c7a7-4d8e-86bd-06059730ee35` и newline, owner `1001:65533`, mode `0400`.
5. Создать gates root:root `0644`, каждая одна строка с newline:

```text
# .runtime/startup-db.gate (строку-комментарий в файл не включать)
db f9ff3a92-1414-4285-bf3e-75e25c104d84 / /home/hs/homecloud-test/data/postgres 70 70 system-root-lvm
# .runtime/startup-backend.gate (строку-комментарий в файл не включать)
backend ccf122c6-c7a7-4d8e-86bd-06059730ee35 /home/hs/homecloud-test/data/hdd /home/hs/homecloud-test/data/hdd/homecloud-test/storage 1001 65533
```

В `runtime.env` нужны новые независимые DB/JWT/refresh secrets и hex `REDIS_PASSWORD` для Compose interpolation (Redis не запускается). Не выводить их, `.env`, полный `docker inspect` или rendered config в отчётах. Не использовать project name существующего приложения. Основные несекретные значения:

```dotenv
COMPOSE_PROJECT_NAME=homecloud-d4-test
RELEASE_BACKEND_IMAGE=homecloud-backend:d4-test
RELEASE_FRONTEND_IMAGE=homecloud-frontend:d4-test
SSD_DB_DIR=/home/hs/homecloud-test/data/postgres
HDD_STORAGE_DIR=/home/hs/homecloud-test/data/hdd/homecloud-test/storage
PUBLIC_HOST=192.168.3.44
PUBLIC_BIND_IP=192.168.3.44
PUBLIC_HTTP_PORT=18080
PUBLIC_HTTPS_PORT=18443
PUBLIC_ORIGIN=https://192.168.3.44:18443
TLS_CERT_DIR=/home/hs/homecloud-test/.runtime/tls
ACME_WEBROOT_DIR=/home/hs/homecloud-test/.runtime/acme
BACKEND_PROXY_SUBNET=172.30.0.0/24
FRONTEND_PROXY_IP=172.30.0.10
INGRESS_SUBNET=172.29.0.0/24
INGRESS_PROXY_IP=172.29.0.10
```

Перед подготовкой повторно проверить свободный HTTPS port 18443 и отсутствие subnet conflicts с host/VPN/Docker. `PUBLIC_HTTP_PORT=18080` требуется для interpolation второго Compose файла, но третий override удаляет HTTP binding: 18080 не публикуется. Nginx Proxy Manager, 80/443 и другие приложения не менять. Создать тестовый self-signed сертификат с IP SAN `192.168.3.44`, файлы `.runtime/tls/current/fullchain.pem` и `privkey.pem`; private key root-only, не печатать и не передавать в Git. ACME directory существует, но выпуск публичного сертификата в этом тесте не производится.

## Проверка и управление только этим проектом

```bash
cd /home/hs/homecloud-test
sudo ./deploy/linux/project-test.sh config
sudo ./deploy/linux/project-test.sh preflight
sudo ./deploy/linux/project-test.sh start
sudo ./deploy/linux/project-test.sh status
# Когда требуется остановить только HomeCloud:
sudo ./deploy/linux/project-test.sh stop
```

`config` проверяет Compose без вывода секретов; `preflight` только читает. `start` сначала выполняет preflight, затем запускает только DB/backend/frontend/ingress без build/pull. `stop` останавливает только эти четыре сервиса своего Compose project, без удаления данных. Любые дополнительные аргументы отвергаются. Wrapper очищает caller environment, использует три explicit Compose файла и локальный Docker socket. Глобальные `docker prune/stop/restart` не применять.

Открывать напрямую **https://192.168.3.44:18443**; браузер потребует доверия тестовому сертификату. HTTP port 18080 не опубликован: production redirect на стандартный 443 не используется в тесте. Для теста использовать только прямой HTTPS URL.

## Размер теста, ресурсы и перезагрузка

Потолки: backend 1 GiB с Node heap 512 MiB, DB 512 MiB, frontend 128 MiB, ingress 128 MiB; суммарно 1.75 GiB. Они не являются измеренным потреблением и не гарантируют отсутствие OOM. Начальный тест: один upload за раз, до 256 MiB на файл и до 2 GiB суммарно. Проверить SHA256 upload/download, container restart, сохранность данных и ресурсы других приложений. Порог SSD свободного места 30 GiB — минимальный резерв пробы, а не quota или production budget. До повторного запуска требуется минимум 2 GiB MemAvailable.

Новый HDD bind не прописывается в fstab и после reboot может отсутствовать. Startup gate должен отказать до writers; не обходить gate и не создавать storage на SSD underlay. Оператор повторно проверяет исходный `/mnt/3TB` и exact identity, восстанавливает только свой project bind, запускает preflight и пересоздаёт HomeCloud containers, если они удержали старый underlay bind. Проверка корректного host mount сама по себе не исправляет stale container bind. Никаких reboot/отключений дисков без отдельного согласования.

Этот запуск не подтверждает reboot, физические отказы, backup/restore, долгую нагрузку или production readiness. Дальнейшая квалификация и разрешение на отказные испытания — отдельный этап.
