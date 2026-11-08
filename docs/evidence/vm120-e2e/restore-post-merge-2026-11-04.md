# VM 120: полный restore после merge PR #23 — PASS

Проверка завершена 2026-11-04 13:10 UTC (финальная сверка VM: 13:09:27 UTC). Только TEST VM `192.168.3.117`, compose project `homecloud-e2e-120`; production и мини-ПК не затрагивались. Новый TEST apply не выполнялся.

## Код и источник восстановления

- Чистый checkout VM переведён с detached `2668005254863a77ebdc32ed0c2c5c015ee03628` на ветку `test` командой `git merge --ff-only` после сверки `origin/test`. HEAD после операции: `3e31f242eee060dfc4810c547cb3c111cd51d74c`; `git status --porcelain` пуст.
- Установленный `scripts/restore.sh` содержит проверку `success is True`, `data.status == ready`, `data.checks.database/storage == ok`. SHA256 файла: `8d87a4443b21b45a33692ecea65003db3aa2467e9c70494c050e2c21e274a135`.
- Штатный restore выбрал последний существующий backup `20261104_122647_5f43cd44` (`.last-success` содержит timestamp `20261104_122647`). Отдельный `--validate-only` завершился exit 0: sidecar, SHA256 dump/archive, размеры, gzip/tar, безопасность путей, 15 таблиц, 30 миграций и изолированный replay прошли.

## Контролируемое изменение и восстановление

Изменены только `users.id=1`, `email=vm120-a7cb28b545d46e2a4630@example.test`, и физический файл записи `files.id=3` в проверенном TEST bind mount. Перед изменением имя было `VM 120 synthetic E2E`, SHA256 файла и того же объекта в архиве — `98006bff22cfc77a2b7324c97aa2667b60f35fec10458c9f69be8e71487fafd7`. После изменения имя стало `VM 120 restore qualification dirty 20261104`, SHA256 файла — `08c19d3a1ec2c8bad8aaef87da909b9bab4ceaeee024c275d02061d2d76c9e3e`.

Запущен `scripts/restore.sh --yes` с `/etc/homecloud-test/recovery.env`; **exit 0**. В выводе: PostgreSQL restore с `ON_ERROR_STOP`, проверка 15 таблиц, storage restore `files=3`, `No migrations are pending`, reconciliation: 2 записи/2 физических файла, ноль отсутствующих файлов, size mismatch и usage drift. Финальный ответ: `{"success":true,"data":{"status":"ready","checks":{"database":"ok","storage":"ok"}}}`; затем `Backend health: OK` и `Restore completed successfully`.

## Проверки после restore

- `users.id=1` снова имеет имя `VM 120 synthetic E2E`; SHA256 файла `files.id=3` снова `98006bff22cfc77a2b7324c97aa2667b60f35fec10458c9f69be8e71487fafd7`.
- В БД 30 применённых миграций. Контейнеры `db`, `backend`, `frontend`, `ingress` проекта `homecloud-e2e-120` имеют Docker health `healthy`.
- HTTPS `GET /` вернул 200 с проверкой сертификата по тестовому `fullchain.pem`. Вход синтетического пользователя вернул HTTP 200; авторизованный `GET /api/v1/users/me` вернул HTTP 200 и ожидаемые `id=1` и email. Пароль и access token в evidence не записаны.
- Финальная read-only сверка: HEAD VM `3e31f242eee060dfc4810c547cb3c111cd51d74c`, рабочее дерево VM чистое, четыре контейнера healthy.
