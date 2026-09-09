# Резервное копирование и восстановление HomeCloud

## Обзор

HomeCloud поддерживает автоматическое резервное копирование PostgreSQL базы данных и пользовательских файлов.

## Что backup'ится

| Компонент | Что включено | Что исключено |
|-----------|-------------|---------------|
| PostgreSQL | Все таблицы: пользователи, файлы, папки, shares, upload sessions, refresh tokens | Временные данные Redis |
| Storage | Пользовательские файлы (`/storage/{userId}/`) | Временные upload chunks (`/storage/.tmp/`) |

## Retention

По умолчанию: **7 дней**. Настраивается через переменную `RETENTION_DAYS`.

## Создание backup

### Автоматически (через скрипт)

```bash
./scripts/backup.sh
```

Backup создаётся в директории `./backups/` с именем:
- `homecloud_db_YYYYMMDD_HHMMSS.sql.gz` — дамп PostgreSQL
- `homecloud_storage_YYYYMMDD_HHMMSS.tar.gz` — архив файлов
- `homecloud_YYYYMMDD_HHMMSS.meta` — метаданные backup

### Вручную

```bash
# PostgreSQL
docker compose exec db pg_dump -U homecloud homecloud | gzip > backup.sql.gz

# Storage
tar -czf storage_backup.tar.gz --exclude='.tmp' -C /path/to/storage .
```

## Восстановление

### Автоматически

```bash
./scripts/restore.sh
```

Скрипт запросит подтверждение и выполнит:
1. Остановку сервисов
2. Восстановление PostgreSQL из дампа
3. Восстановление файлов из архива
4. Запуск миграций
5. Запуск сервисов

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

## Проверка backup

```bash
# Проверить дамп PostgreSQL
gunzip -c backups/homecloud_db_YYYYMMDD_HHMMSS.sql.gz | head -20

# Проверить архив файлов
tar -tzf backups/homecloud_storage_YYYYMMDD_HHMMSS.tar.gz | head -20
```

## Ограничения

- Redis данные не backupятся (кэш, rate limiting). После restore они будут пустыми.
- Временные upload chunks не backupятся.
- Remote/offsite backup не реализован в текущей версии.

## Troubleshooting

### Backup не создаётся

- Проверьте, что `.env` содержит корректные `DB_PASSWORD` и `REDIS_PASSWORD`
- Проверьте, что Docker Compose сервисы запущены
- Проверьте права на директорию `backups/`

### Restore падает

- Убедитесь, что backup файлы не повреждены
- Проверьте, что PostgreSQL контейнер запускается
- Проверьте логи: `docker compose logs db`

## Scheduling (опционально)

Для автоматического backup добавьте в crontab:

```bash
# Ежедневный backup в 2:00
0 2 * * * cd /path/to/homecloud && ./scripts/backup.sh >> /var/log/homecloud-backup.log 2>&1
```
