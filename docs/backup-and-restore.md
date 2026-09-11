# Резервное копирование и восстановление HomeCloud

## Обзор

HomeCloud поддерживает резервное копирование PostgreSQL базы данных и пользовательских файлов.
Backup создается в директории `backups/` и содержит четыре файла:
- `homecloud_db_YYYYMMDD_HHMMSS_<suffix>.sql.gz` — дамп PostgreSQL
- `homecloud_storage_YYYYMMDD_HHMMSS_<suffix>.tar.gz` — архив файлов
- `homecloud_YYYYMMDD_HHMMSS_<suffix>.meta` — метаданные backup
- `homecloud_YYYYMMDD_HHMMSS_<suffix>.meta.sha256` — SHA-256 точных байтов `.meta`

## Что backup'ится

| Компонент | Что включено | Что исключено |
|-----------|-------------|---------------|
| PostgreSQL | Все таблицы: пользователи, файлы, папки, shares, upload sessions, refresh tokens | Временные данные Redis |
| Storage | Пользовательские файлы (`/storage/{userId}/`) | Временные upload chunks (`/storage/.tmp/`, `*.tmp`) |

## Формат backup

Backup формата версии 1. `.meta` файл — валидный JSON:
- `format_version` — версия формата (строка `"1"`)
- `backup_id` — уникальный ID backup (timestamp + random suffix, например `20260911_055402_a1b2c3d4`)
- `timestamp` — метка времени `YYYYMMDD_HHMMSS`
- `created_at` — ISO 8601 timestamp
- `db_dump`, `storage_archive` — имена файлов
- `db_dump_size`, `storage_archive_size` — размеры в байтах
- `db_dump_sha256`, `storage_archive_sha256` — SHA256 checksum (обязательны, nullable=no)
- `storage_file_count` — количество файлов в архиве (только regular files)
- `retention_days` — настройка retention
- `app_version` — версия backend приложения (из package.json)
- `migration_count` — количество применённых миграций TypeORM
- `postgresql_version` — версия PostgreSQL сервера

Файл `.meta.sha256` содержит SHA-256 точных байтов соответствующего `.meta` в формате
`<hex>  <имя.meta>`. Restore проверяет sidecar до чтения JSON. Старые backup-наборы без
sidecar считаются непроверяемыми и отклоняются fail-closed; для них не создаются фиктивные
sidecar-файлы, а совместимость достигается только созданием нового backup.

Backup files and sidecars have permissions `600` to prevent unauthorized access.

## Проверка целостности

### Phase A: Pre-validation (READ-ONLY, fail-closed)

Перед любыми разрушительными операциями restore.sh выполняет проверки **только для чтения**.
Если любая проверка не проходит, restore прерывается с ненулевым exit code, и данные не изменяются.

#### Проверяемые свойства:

1. **format_version**: .meta должен содержать `format_version: "1"`. Поддерживается только версия 1.
   Неизвестные версии вызывают немедленный failure.
2. **Sidecar .meta.sha256**: sidecar должен существовать, быть regular file с безопасными правами и
   содержать SHA-256 точных байтов `.meta`. Отсутствующий, повреждённый или не соответствующий sidecar
   отклоняется до JSON parsing.
3. **.meta JSON parsing**: после проверки sidecar .meta парсится через Python JSON parser.
   Некорректный JSON = failure.
4. **Обязательные поля**: все поля в .meta обязательны. Отсутствующее или пустое поле = failure.
5. **Проверка существования файлов**: db dump и storage archive должны существовать.
6. **SHA256 checksum** (DB + storage): пустой checksum в .meta = failure (ранее был WARNING + skip).
7. **Размер файла**: сверяется с `db_dump_size` / `storage_archive_size` в .meta.
8. **gzip integrity**: `gzip -t` на db dump.
9. **SQL structure**: проверка наличия `CREATE TABLE` в дампе.
10. **tar integrity**: `tar -tzf` на storage archive.
11. **File count**: количество файлов в архиве должно совпадать с `storage_file_count` в .meta.
    - 0 файлов = валидный пустой backup (если meta говорит 0).
    - Несоответствие = failure (коррупция или неполный backup).
12. **Security scan**: проверка архива на:
    - Абсолютные пути (`/etc/passwd`)
    - Path traversal (`../`)
    - Символические/жёсткие ссылки, уходящие за пределы staging
    - Device files (char/block), FIFO, socket
13. **Disk space**: требуется минимум 2× размер storage archive свободного места.
    Если `df` недоступен или не возвращает usable value, backup завершается fail-closed, а не
   продолжает запись с неизвестным риском.
14. **Docker volume**: storage volume должен быть валидным named volume.
15. **Backend image**: Docker image должен существовать.

## Создание backup

### Жизненный цикл backup

Backup создаётся с гарантией атомарности:

1. **Стейдинг (CREATE)**: все artifacts создаются во временной директории `backups/.staging/<BACKUP_ID>/`.
   Никакие файлы не публикуются в `backups/` напрямую.
2. **Верификация (VERIFY)**: проверка gzip integrity, tar integrity, SHA256, file count, SQL structure
   и точного sidecar-хеша `.meta`. Если любая проверка провалена — staging очищается, `.meta` не
   публикуется, exit code ≠ 0.
3. **Финализация (FINALIZE)**: `mv` из staging в `backups/` (atomic rename на той же файловой системе).
   `.meta` и `.meta.sha256` публикуются ТОЛЬКО после успешной верификации всех artifacts.

Это гарантирует: **частичный или повреждённый backup никогда не появляется в production backup directory.**

### Timestamp с random suffix

Имя backup включает криптографически случайный suffix для предотвращения коллизий:
- `homecloud_db_<YYYYMMDD_HHMMSS>_<suffix>.sql.gz`
- `homecloud_storage_<YYYYMMDD_HHMMSS>_<suffix>.tar.gz`
- `homecloud_<YYYYMMDD_HHMMSS>_<suffix>.meta`

Два backup в одинаковую секунду не перезапишут друг друга.

### Concurrency lock

`backup.sh` использует файловый lock (`backups/.backup.lock/`):
- Если lock захвачен другим процессом — exit code 2.
- Stale lock (PID не существует) автоматически очищается.
- `restore.sh` также захватывает lock перед destructive операциями — backup и restore не могут выполняться одновременно.
- Lock освобождается в trap (EXIT/INT/TERM), включая SIGKILL случаи через stale-lock detection.

```bash
./scripts/backup.sh
```

Переменные окружения:
- `BACKUP_DIR` — папка для backup (по умолчанию `./backups`)
- `RETENTION_DAYS` — retention в днях (по умолчанию 7)
- `BACKEND_IMAGE` — Docker image для доступа к storage (по умолчанию `homecloud-backend`)
- `DB_NAME`, `DB_USER`, `STORAGE_PATH` — загружаются из `.env` (env vars take precedence if .env is absent)

### Флаги

Backup не требует подтверждения и запускается без аргументов. Поддерживаемые flags:
```bash
./scripts/backup.sh          # обычный запуск
./scripts/backup.sh --yes    # non-interactive alias (подтверждение не требуется)
./scripts/backup.sh --help   # help + exit 0
```
Неизвестные аргументы отклоняются с exit code 2.

Restore flags:
```bash
./scripts/restore.sh --yes          # пропустить подтверждение (для автоматизации)
./scripts/restore.sh --validate-only # только Phase A (pre-validation), без изменений
```

## Восстановление

### Автоматически

```bash
./scripts/restore.sh --yes
```

Скрипт выполняет следующие фазы:

#### Phase A: Pre-validation (READ-ONLY)
1. Находит последний backup по `.meta`.
2. Проверяет наличие и целостность соответствующего `.meta.sha256` до чтения JSON.
3. Парсит `.meta` через JSON parser.
4. Проверяет `format_version` (только `"1"`).
5. Проверяет существование db dump и storage archive.
6. Верифицирует SHA256 checksum обоих файлов (fail-closed: пустой = failure).
7. Проверяет размеры.
8. Проверяет gzip integrity db dump.
9. Проверяет SQL structure (CREATE TABLE).
10. Проверяет tar integrity storage archive.
11. Сравнивает file count в архиве с `storage_file_count` в `.meta`.
12. Security scan архива (path traversal, symlinks, device files, FIFO).
13. Проверяет дисковое пространство (2× storage archive).
14. Разрешает и валидирует Docker storage volume.
15. Проверяет существование backend image.

#### Phase B: Confirmation
- Запрашивает подтверждение ("yes").
- `--yes` пропускает подтверждение.

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
- Health check — последняя проверка, запускается ТОЛЬКО после reconciliation.

### Lock acquisition

`restore.sh` захватывает тот же lock (`backups/.backup.lock/`), что и `backup.sh`,
перед destructive операциями (Phase C). Если backup работает — restore блокируется.

### Exit codes

**Restore:**
| Code | Meaning |
|------|---------|
| 0 | Restore completed successfully (все фазы пройдены) |
| 1 | Любая failure Phase A, C, или reconciliation |
| 2 | Invalid arguments |

**Backup:**
| Code | Meaning |
|------|---------|
| 0 | Backup completed successfully |
| 1 | Artifact creation or validation failure |
| 2 | Another backup/restore is already running (lock held) |
| 3 | Insufficient disk space |

### Marker files

| File | Purpose |
|------|---------|
| `backups/.last-success` | Timestamp of last successful backup |
| `backups/.last-failure` | Timestamp + error reason of last failed backup |
| `backups/.backup.lock/` | Concurrency lock (contains LOCK_PID and LOCK_TOKEN) |

## Обработка ошибок backup

При любой ошибке `backup.sh`:
1. Staging directory очищается (trap на EXIT/INT/TERM).
2. Никакие artifacts не публикуются в `backups/`.
3. `.last-failure` marker пишется с причиной ошибки.
4. Exit code ≠ 0.
5. Существующие backup не затрагиваются.

### Recovery после failed backup

1. Проверьте `backups/.last-failure` для причины.
2. Убедитесь, что ошибка устранена.
3. Запустите `backup.sh` снова — stale lock и staging очищаются автоматически.

### Manual

```bash
# 1. Остановить сервисы
docker compose down

# 2. Восстановить PostgreSQL
gunzip -c backups/homecloud_db_YYYYMMDD_HHMMSS_<suffix>.sql.gz | \
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud

# 3. Восстановить файлы
#    (safe approach: extract to staging, rename-swap)
STAGE=$(docker run --rm -v storage_data:/storage homecloud-backend mktemp -d)
tar -xzf backups/homecloud_storage_YYYYMMDD_HHMMSS_<suffix>.tar.gz -C "$STAGE"
# Legacy backup без соответствующего .meta.sha256 не проходит restore.sh validation.
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
8. **Sidecar integrity**: `.meta.sha256` проверяется до чтения `.meta`; старые наборы без sidecar
   отклоняются, а фиктивные sidecar-файлы не создаются.
9. **No false success**: health endpoint не является единственным доказательством —
   требуется также reconciliation и DB validation.

## Тестирование

```bash
# Phase A validation tests (без Docker)
./scripts/tests/test-restore-safety.sh --skip-integration

# Full test suite (с Docker)
./scripts/tests/test-restore-safety.sh

# Backup safety tests (Phase 5.3)
./scripts/tests/test-backup-safety.sh

# Isolated restore test
./scripts/test-restore.sh

# Backend unit tests
cd backend && npm test
```

## Retention

Политика по умолчанию:
- **Максимальный возраст**: 7 дней (`RETENTION_DAYS`, настраивается).
- **Минимальное количество**: 2 backup (жёсткий минимум, даже если все старше 7 дней).
- **Новый backup**: всегда сохраняется, даже если старше окна retention.
- **Ошибки retention**: не swallow-ятся — логируются и exit code ≠ 0.
- **Только после успеха**: retention запускается ТОЛЬКО после успешного создания и финализации backup.
  При failure retention НЕ выполняется — старые backup сохраняются.

Старые backup удаляются вместе с соответствующими `.meta`, `.meta.sha256` и архивами.
Возраст определяется по timestamp/random-suffix в имени backup, а не по filesystem mtime;
`touch` не влияет на retention. Malformed names, `.staging`, incomplete sets, symlinks и служебные
markers игнорируются. Ошибки удаления/проверки retention видимы и не скрываются.

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
- Проверка свободного места использует `df -Pk` и сравнивает значения в KiB, без предположения о
  размере блока `df`.
- Требуемый объём рассчитывается из оценок database/storage и сравнивается с доступным пространством
  в тех же единицах; при реальной нехватке backup завершается с exit code 3.
- На macOS/Docker Desktop результат отражает файловую систему host path, выбранную для `BACKUP_DIR`.
- Если `df` недоступен или не возвращает usable value, backup завершается fail-closed, а не
  продолжает запись с неизвестным риском.

### .meta integrity
- `.meta` защищён отдельным sidecar `.meta.sha256`, который restore проверяет до JSON parsing.
- Старые backup-наборы без sidecar отклоняются fail-closed и не получают фиктивный checksum.
- Внешняя подпись/HMAC для защиты от намеренной подмены остаётся future scope.

### Docker volume permissions
- Docker named volumes по умолчанию owned by root.
- Extraction container запускается с `--user root`, затем `chown` к nextjs.
- Root сохранён намеренно: проверенный fresh named volume root-owned, а backend user без root
  не может создать в нём staging-директорию. Security scan выполняется до извлечения.

## Technical Debt (Technical Debt)

| # | Description | Impact |
|---|-------------|--------|
| TD-1 | `.meta` требует отдельного sidecar `.meta.sha256`; подмена sidecar не защищена подписью | Средний |
| TD-2 | Health endpoint возвращает ok без проверки DB/Redis | Средний (compensated by reconciliation) |
| TD-5 | Storage archive extraction не использует `--no-same-owner` и т.д. (busybox tar) | Низкий (post-extraction chmod) |
| TD-6 | Нет атомарного swap volume (двухтомный подход) | Средний (rename-swap is reliable on same FS) |

## Безопасность

- Backup не должен попадать в Git (исключён через `.gitignore`)
- `.meta` не содержит секретов; его точные байты защищены отдельным `.meta.sha256`
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
- Проверьте, что Docker Compose сервисы запущены
- Проверьте права на директорию `backups/`
- Проверьте, что `STORAGE_PATH` существует или Docker volume доступен
- Проверьте `backups/.last-failure` для деталей ошибки
- Если exit code 2 — другой backup/restore уже запущен (проверьте `backups/.backup.lock/`)
- Если exit code 3 — недостаточно дискового пространства

### Restore падает на этапе валидации
- Проверьте, что `.meta` является корректным JSON
- Проверьте `.meta.sha256`: файл должен содержать SHA-256 точных байтов `.meta`
- Проверьте SHA256 checksum: `sha256sum <file>`
- Проверьте, что все четыре файла backup присутствуют
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
