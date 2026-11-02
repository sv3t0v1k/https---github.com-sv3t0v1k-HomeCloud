# Phase 3 — host installer bridge: implementation checkpoint

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
