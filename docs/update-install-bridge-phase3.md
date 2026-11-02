# Phase 3 — host installer bridge: implementation checkpoint

## Linux/amd64 квалификация — 3 ноября 2026

[Изолированный GitHub-hosted run 41532937563](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41532937563)
завершился SUCCESS. Временные checkout, worker и verifier имели `root:root 0755`;
root boundary принял путь без ACL и отклонил реально добавленный ACL на worker.
Шесть SHA256 helpers совпали. Из настоящего GitHub получен manifest защищённого
TEST `40f11e2`; `target_sources` **ожидаемо отказал** из-за нового дерева
`deploy` в Phase 3. Установленный worker с `PROVISIONED=False` выдал STOP,
не создав status или `pending.json`. Это подтверждённый fail-closed результат,
**не** live install acceptance. Runner не устанавливал HomeCloud-образы и не
запускал установку. Файлы и контейнеры drill были одноразовыми.

На Linux/amd64 прошли 79 синтетических тестов: bridge/process 4+16,
существующий installer 31, backup qualification 10, root boundary 18.
Реальные дочерние процессы получили SIGTERM/SIGKILL на стадиях VERIFY_TRUST и
INSTALLER; durable `RUNNING` сохранился, повторный запуск отказал, а
синтетический `pending.json` после INSTALLER остался для оператора. Существующий
installer harness проверил десять точек сбоя до/после переключения, отказ
health-check, сохранение `pending.json`, запрет повтора и ручное восстановление.
Потеря сети, повреждённый manifest, подмена request/status и двойной запуск
проверены в синтетических bridge/installer тестах; реального переключения
backend/frontend на runner не было.

Backup drill использовал только одноразовый PostgreSQL из закреплённого
официального образа и синтетические файлы. Синтетические dump, tar и metadata
прошли **настоящий** `test-channel.verify_backup()`, включая восстановление
dump в отдельном network-isolated PostgreSQL tmpfs и проверку миграций.
После восстановления сравнивались строки БД и байты файлов; испорченный архив
был отклонён. Это подтверждает путь **проверки и восстановления** артефактов;
полный `backup.sh` → installer `backup()` → переключение/rollback не выполнялся.

Независимый security review выявил и помог устранить два дефекта CI drill:
запуск PR-кода с root/Docker/GH_TOKEN для fork PR (job теперь допускает только
PR из того же репозитория) и игнорирование ошибки очистки Docker-контейнера
(теперь проваливает drill). Других подтверждённых P1 findings по diff нет.
Точный sudo/systemd provisioning для production не квалифицирован: service
worker не создан, а его код остаётся жёстко выключенным.

Status: **код подготовлен, эксплуатационная установка выключена**.
Новый `deploy/linux/update-install-bridge.py` содержит жёсткий gate
`PROVISIONED = False`. Service/таймер/автоматический запуск не создавались;
`UPDATE_INSTALL_BRIDGE_ENABLED` в TEST Compose остаётся `false`.
Mini-PC, production и данные работающих серверов не менялись.

## Поток одной заявки

1. Существующий admin-only Updates API публикует единственную заявку в inbox.
   Read-only admission проверяет её и сохраняет root-owned `VALIDATION_REQUIRED`.
2. Host worker принимает только этот receipt, берёт отдельную блокировку и
   сначала сохраняет `RUNNING`. Прерванный `RUNNING` не запускается повторно
   автоматически. Идентичность манифеста берётся только из root-owned receipt.
3. Worker восстанавливает точную заявку для **неизменённого** установленного
   `homecloud-update-verify` и требует совпадения его read-only результата с
   receipt. Затем заново получает TEST manifest из GitHub и сверяет commit/hash
   и целевые исходники. Только после этого вызывает существующий
   `test-channel.py apply` с полным manifest через stdin.
   Восстановленная заявка удаляется после verifier только при совпадении inode
   и времени изменения; заменённая заявка остаётся для разбора оператором.
4. Существующий установщик проверяет текущие образы и миграции, preflight,
   закреплённые файлы, делает проверенные backup, ведёт durable `pending.json`,
   запускает только no-build Compose, проверяет образы, миграции, backend и
   публичный HTTPS. Worker публикует `INSTALLED` лишь после точного ответа и
   root-owned installer checkpoint. Любой неопределённый исход после вызова
   установщика означает `MANUAL_RECOVERY_REQUIRED`; pending не очищается worker.

Статусы и `phase` публикуются в существующем формате `current.json`, который
читает admin-only `GET /api/v1/updates/installations/current`. Никакого Docker
socket, SSH или systemd вызова из backend нет.

## Граница доверия и отдельная приёмка

Worker и verifier должны устанавливаться по фиксированным путям вне checkout
только root-оператором. Проверка владельца worker внутри Python начинается после
старта его интерпретации; защита до старта зависит от root-owned provisioning и
фиксированной host-точки входа. Процедура provisioning и service требуют
отдельного review. При изменении дерева `deploy` новый worker **не пройдёт**
Phase 2B tree gate для опубликованного TEST `40f11e2`: нельзя включать worker
пока новая целевая TEST-сборка и anchor не пройдут отдельную Phase 3 квалификацию.

Перед активацией нужны отдельные изолированные host drills для параллельных
заявок, подмены заявки/манифеста, обрыва питания, потери сети, остановки
процесса, больного backend, миграционного конфликта, backup и восстановления.
Результаты Phase 2B подтверждают только read-only verifier, не установку.
BuildKit provenance остаётся `UNSIGNED`.

Синтетические тесты worker проверяют порядок durable статусов, отказ при
подмене/потере сети, cleanup заявки, блокировку, формат receipt и неоднозначный
результат установщика. Они не заменяют реальные host drills, а progress API
опирается на уже существующий backend contract чтения root-owned `current.json`.
