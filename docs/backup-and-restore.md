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

Backup формата версии 1. `.meta` файл содержит:
- `format_version` — версия формата
- `timestamp` — метка времени backup
- `db_dump`, `storage_archive` — имена файлов
- `db_dump_size`, `storage_archive_size` — размеры
- `db_dump_sha256`, `storage_archive_sha256` — SHA256 checksum
- `storage_file_count` — количество файлов в архиве
- `retention_days` — настройка retention

## Проверка целостности

### Backup проверяет:
- PostgreSQL dump: существование, размер > 0, gzip integrity, наличие SQL структуры
- Storage archive: существование, tar integrity
- SHA256 checksum для обоих файлов

### Restore проверяет:
- Существование всех backup-файлов
- SHA256 checksum совпадение с metadata
- gzip integrity дампа
- tar integrity архива
- Отсутствие path traversal путей в архиве

## Создание backup

### Автоматически

```bash
./scripts/backup.sh
```

Переменные окружения:
- `BACKUP_DIR` — папка для backup (по умолчанию `./backups`)
- `RETENTION_DAYS` — retention в днях (по умолчанию 7)
- `DB_NAME`, `DB_USER`, `STORAGE_PATH` — загружаются из `.env`

## Восстановление

### Автоматически

```bash
./scripts/restore.sh
```

Скрипт:
1. Проверяет backup (checksum, gzip, tar, path traversal)
2. Запрашивает подтверждение
3. Останавливает сервисы
4. Восстанавливает PostgreSQL
5. Восстанавливает storage
6. Запускает миграции
7. Запускает сервисы
8. Проверяет health endpoint

### Вручную

```bash
# 1. Остановить сервисы
docker compose down

# 2. Восстановить PostgreSQL
gunzip -c backups/homecloud_db_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose exec -T db psql -U homecloud -d homecloud

# 3. Восстановить файлы
rm -rf /path/to/storage/*
tar -xzf backups/homecloud_storage_YYYYMMDD_HHMMSS.tar.gz -C /path/to/storage

# 4. Запустить
docker compose up -d
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
- Для полной согласованности рекомендуется использовать окно с низкой активностью пользователей.

### Redis
- Redis данные не backupятся (кэш, rate limiting). После restore они будут пустыми.

### Локальный backup
- Локальный backup не защищает от потери самого сервера.
- Для production необходим offsite backup.

### Шифрование
- Backup хранится в открытом виде.
- Для production рекомендуется шифрование backup'ов.
- Backup должен храниться с ограниченными правами доступа.

## Безопасность

- Backup не должен попадать в Git (исключён через `.gitignore`)
- `.meta` не содержит секретов
- Backup не находится в web-served директории
- Restore проверяет отсутствие path traversal путей в архиве

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

### Restore падает
- Убедитесь, что backup файлы не повреждены
- Проверьте checksum в `.meta`
- Проверьте, что PostgreSQL контейнер запускается
- Проверьте логи: `docker compose logs db`

### Restore оставляет систему в частичном состоянии
- Restore остановит сервисы перед изменением данных
- При ошибке restore попытается запустить сервисы для восстановления рабочего состояния
- Проверьте health endpoint после restore