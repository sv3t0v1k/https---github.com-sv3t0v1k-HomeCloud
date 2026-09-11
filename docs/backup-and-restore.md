# Резервное копирование и восстановление HomeCloud

## Обзор

HomeCloud поддерживает резервное копирование PostgreSQL базы данных и пользовательских файлов.
Backup создается в директории `backups/` и содержит три файла:
- `homecloud_db_YYYYMMDD_HHMMSS.sql.gz` — дамп PostgreSQL
- `homecloud_storage_YYYYMMDD_HHMMSS.tar.gz` — архив файлов
- `homecloud_YYYYMMDD_HHMMSS.meta` — метаданные backup

## Что backup'ится

| Компонент | Что включено | Что исключено |
|-----------|-------------|---------------|
| PostgreSQL | Все таблицы: пользователи, файлы, папки, shares, upload sessions, refresh tokens | Временные данные Redis |
| Storage | Пользовательские файлы (`/storage/{userId}/`) | Временные upload chunks (`/storage/.tmp/`, `*.tmp`) |

## Формат backup

Backup формата версии 1. `.meta` файл — валидный JSON:
- `format_version` — версия формата (строка `"1"`)
- `timestamp` — метка времени backup
- `db_dump`, `storage_archive` — имена файлов
- `db_dump_size`, `storage_archive_size` — размеры в байтах
- `db_dump_sha256`, `storage_archive_sha256` — SHA256 checksum (обязательны, nullable=no)
- `storage_file_count` — количество файлов в архиве (только regular files)
- `retention_days` — настройка retention

Backup файлы имеют права `600` для предотвращения несанкционированного доступа.

## Проверка целостности

### Phase A: Pre-validation (READ-ONLY, fail-closed)

Перед любыми разрушительными операциями restore.sh выполняет проверки **только для чтения**.
Если любая проверка не проходит, restore прерывается с ненулевым exit code, и данные не изменяются.

#### Проверяемые свойства:

1. **format_version**: .meta должен содержать `format_version: "1"`. Поддерживается только версия 1.
   Неизвестные версии вызывают немедленный failure.
2. **.meta JSON parsing**: .meta парсится через Python JSON parser. Некорректный JSON = failure.
3. **Обязательные поля**: все поля в .meta обязательны. Отсутствующее или пустое поле = failure.
4. **Проверка существования файлов**: db dump и storage archive должны существовать.
5. **SHA256 checksum** (DB + storage): пустой checksum в .meta = failure (ранее был WARNING + skip).
6. **Размер файла**: сверяется с `db_dump_size` / `storage_archive_size` в .meta.
7. **gzip integrity**: `gzip -t` на db dump.
8. **SQL structure**: проверка наличия `CREATE TABLE` в дампе.
9. **tar integrity**: `tar -tzf` на storage archive.
10. **File count**: количество файлов в архиве должно совпадать с `storage_file_count` в .meta.
    - 0 файлов = валидный пустой backup (если meta говорит 0).
    - Несоответствие = failure (коррупция или неполный backup).
11. **Security scan**: проверка архива на:
    - Абсолютные пути (`/etc/passwd`)
    - Path traversal (`../`)
    - Символические/жёсткие ссылки, уходящие за пределы staging
    - Device files (char/block), FIFO, socket
12. **Disk space**: требуется минимум 2× размер storage archive свободного места.
    При невозможности определить (macOS/Docker VM) — SKIPPED с WARNING.
13. **Docker volume**: storage volume должен быть валидным named volume.
14. **Backend image**: Docker image должен существовать.

## Создание backup

### Автоматически

```bash
./scripts/backup.sh
```

Переменные окружения:
- `BACKUP_DIR` — папка для backup (по умолчанию `./backups`)
- `RETENTION_DAYS` — retention в днях (по умолчанию 7)
- `DB_NAME`, `DB_USER`, `STORAGE_PATH` — загружаются из `.env`

### Флаги

```bash
./scripts/restore.sh --yes          # пропустить подтверждение
./scripts/restore.sh --validate-only # только Phase A (pre-validation), без удаления данных
```

## Восстановление

### Автоматически

```bash
./scripts/restore.sh --yes
```

Скрипт выполняет следующие фазы:

#### Phase A: Pre-validation (READ-ONLY)
1. Находит последний backup по `.meta`.
2. Парсит `.meta` через JSON parser.
3. Проверяет `format_version` (только `"1"`).
4. Проверяет существование db dump и storage archive.
5. Верифицирует SHA256 checksum обоих файлов (fail-closed: пустой = failure).
6. Проверяет размеры.
7. Проверяет gzip integrity db dump.
8. Проверяет SQL structure (CREATE TABLE).
9. Проверяет tar integrity storage archive.
10. Сравнивает file count в архиве с `storage_file_count` в `.meta`.
11. Security scan архива (path traversal, symlinks, device files, FIFO).
12. Проверяет дисковое пространство (2× storage archive).
13. Разрешает и валидирует Docker storage volume.
14. Проверяет существование backend image.

#### Phase B: Confirmation
- Запрашивает подтверждение ("yes").
- `--yes` пропускает подтержку.

#### Phase C: Destructive restore

**DB restore (fail-closed):**
1. `docker compose down` — остановка сервисов.
2. Запуск `db` контейнера, ожидание `pg_isready`.
3. `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — чистый слой.
4. `gunzip -c dump.sql.gz | psql -v ON_ERROR_STOP=1` — restore с немедленной остановкой при ошибке.
5. Пост-валидация:
   - 7 таблиц (users, files, folders, share_links, upload_sessions, refresh_tokens, migrations)
   - Ключевые колонки (первичные ключи)
   - Row count таблицы users

**Storage restore (safe rename-swap):**
1. Извлекает archive в `.restore-staging` (внутри Docker volume).
2. Проверяет file count staging dir.
3. Нормализует права (chmod 644 для файлов, 755 для директорий).
4. `mv` старого содержимого в `.restore-swap` (atomic rename на том же FS).
5. `mv` staging contents в root (atomic rename).
6. Проверяет file count в root.
7. **Если проверка провалена**: rollback — `mv .restore-swap` обратно в root.
8. Если проверка пройдена: удаляет `.restore-swap`.
9. `chown` к nextjs (uid 1001) — Docker volumes root-owned.
10. Создаёт `.tmp` директорию.

**Migration:**
- `npm run migration:run` — failure = abort (ранее был WARNING + continue).

**Reconciliation:**
- `python3 scripts/reconcile.py` — проверяет DB↔storage согласованность.
- CRITICAL (exit 1): dangling rows (DB → нет файла), size mismatch.
- WARNING (продолжает): orphan files (файл → нет DB записи), storage usage drift, broken share links, stale upload sessions.

**Health check:**
- HTTP probe к `/api/v1/health` с capture response body.
- Проверка наличия `"ok"` в ответе.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Restore completed successfully (все фазы пройдены) |
| 1 | Любая failure Phase A, C, или reconciliation |
| 2 | Invalid arguments |

### Manual

```bash
# 1. Остановить сервисы
docker compose down

# 2. Восстановить PostgreSQL
gunzip -c backups/homecloud_db_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud

# 3. Восстановить файлы
#    (safe approach: extract to staging, rename-swap)
STAGE=$(docker run --rm -v storage_data:/storage homecloud-backend mktemp -d)
tar -xzf backups/homecloud_storage_YYYYMMDD_HHMMSS.tar.gz -C "$STAGE"
# ... verify, rename-swap ...
```

## Reconciliation

После восстановления `reconcile.py` сравнивает DB записи с физическими файлами:

| Check | Level | Description |
|-------|-------|-------------|
| Dangling rows | CRITICAL | DB row со storagePath но без физического файла |
| Size mismatch | CRITICAL | DB size != actual file size |
| Orphan files | WARNING | Физический файл без DB записи |
| Storage usage drift | WARNING | users.storageUsed != сумма файлов |
| Broken share links | WARNING | share_links → несуществующий файл |
| Stale upload sessions | WARNING | upload_sessions со статусом != completed |

**Important:** reconciliation не удаляет автоматически orphan files или DB records.
Найденные несоответствия требуют ручного вмешательства.

## Свойства безопасности restore

1. **Старые данные не удаляются до подтверждения**: старый storage перемещается в `.restore-swap` (не удаляется), и удаляется только после успешного переключения.
2. **Atomic switch**: `mv` (rename) на том же filesystem — не требует копирования данных.
3. **Rollback возможен**: если пост-switch проверка провалена, `.restore-swap` перемещается обратно.
4. **DB fail-closed**: `ON_ERROR_STOP=1` прерывает psql при первой SQL ошибке.
5. **Schema wipe**: `DROP SCHEMA CASCADE` перед restore гарантирует чистое состояние.
6. **Security scan**: запускается ПЕРЕД извлечением, блокирует malicious архивы.
7. **Fail-closed для checksum**: пустой или недопустимый checksum = немедленный failure.
8. **No false success**: health endpoint не является единственным доказательством —
   требуется также reconciliation и DB validation.

## Тестирование

```bash
# Phase A validation tests (без Docker)
./scripts/tests/test-restore-safety.sh --skip-integration

# Full test suite (с Docker)
./scripts/tests/test-restore-safety.sh

# Isolated restore test
./scripts/test-restore.sh
```

## Retention

По умолчанию: **7 дней**. Настраивается через `RETENTION_DAYS`.
Старые backup удаляются вместе с соответствующими `.meta` файлами.
Текущий backup не удаляется.

## Ограничения

### Консистентность
- Backup PostgreSQL и storage **не атомарны**. `pg_dump` и `tar` выполняются последовательно.
- Возможное окно неконсистентности: если upload происходит между созданием дампа и архива.
- DB dump может содержать metadata без соответствующего физического файла, или наоборот.
- Для полной согласованности рекомендуется использовать окно с низкой активности пользователей.

### Redis
- Redis данные не backupятся (кэш, rate limiting). После restore они будут пустыми.

### Локальный backup
- Локальный backup не защищает от потери самого сервера.
- Для production необходим offsite backup.

### Шифрование
- Backup хранится в открытом виде.
- Для production рекомендуется шифрование backup'ов.
- Backup имеет права `600`.

### Disk space check
- Проверка свободного места использует `df -P $BACKUP_DIR` на хосте.
- На macOS с Docker Desktop хостовая файловая система отличается от Docker volume.
- При невозможности определить свободное место — check SKIPPED с WARNING.

### .meta integrity
- `.meta` файл не имеет собственного checksum (только SHA256 архивов внутри него).
- Для защиты от подмены .meta рекомендуется использовать подпись или внешний checksum.
- Это известный technical debt (см. раздел ниже).

### Docker volume permissions
- Docker named volumes по умолчанию owned by root.
- Extraction container запускается с `--user root`, затем `chown` к nextjs.
- Security scan предотвращает создание device files на этапах извлечения.

## Technical Debt (Technical Debt)

| # | Description | Impact |
|---|-------------|--------|
| TD-1 | `.meta` имеет собственный checksum — нельзя обнаружить подмену .meta | Средний |
| TD-2 | pg_dump без `--clean --if-exists` в некоторых сценариях | Низкий (DROP SCHEMA покрывает) |
| TD-3 | Cross-platform disk space check неточен на macOS | Средний |
| TD-4 | Health endpoint возвращает ok без проверки DB/Redis | Средний (compensated by reconciliation) |
| TD-5 | Storage archive extraction не использует `--no-same-owner` и т.д. (busybox tar) | Низкий (post-extraction chmod) |
| TD-6 | Нет атомарного swap volume (двухтомный подход) | Средний (rename-swap is reliable on same FS) |

## Безопасность

- Backup не должен попадать в Git (исключён через `.gitignore`)
- `.meta` не содержит секретов
- Backup находится с правами `600`
- Restore проверяет отсутствие path traversal путей в архиве
- Restore отклоняет device files, FIFO, sockets в архиве
- Restore не экспортирует secrets в environment (без `set -a` для .env)

## Планирование

Для автоматического backup добавьте в crontab:
```bash
# Ежедневный backup в 2:00
0 2 * * * cd /path/to/homecloud && ./scripts/backup.sh >> /var/log/homecloud-backup.log 2>&1
```

## Troubleshooting

### Backup не создаётся
- Проверьте, что `.env` содержит корректные `DB_PASSWORD` и `REDIS_PASSWORD`
- Проверьте, что Docker Compose сервисы запущены
- Проверьте права на директорию `backups/`
- Проверьте, что `STORAGE_PATH` существует

### Restore падает на этапе валидации
- Проверьте, что `.meta` является корректным JSON
- Проверьте SHA256 checksum: `sha256sum <file>`
- Проверьте, что все три файла backup присутствуют
- Запустите с `--validate-only` чтобы увидеть подробную ошибку

### Restore падает на этапе DB
- Проверьте логи: `docker compose logs db`
- Убедитесь, что PostgreSQL контейнер запускается
- DB restore использует `ON_ERROR_STOP=1` — любая SQL ошибка прерывает restore

### Restore падает на этапе хранилища
- Проверьте, что Docker volume существует: `docker volume ls`
- Проверьте права на volume (должен быть root или nextjs)
- Старые данные сохраняются в `.restore-swap` (если switch провален)

### Restore оставляет систему в частичном состоянии
- Restore останавливает сервисы перед изменением данных
- При ошибке DB restore попытается запустить сервисы для recovery
- При ошибке storage restore сервисы запускаются без изменений storage
- Проверьте health endpoint после restore: `curl http://localhost:3000/api/v1/health`
- Проверьте reconciliation report для выявления несоответствий
