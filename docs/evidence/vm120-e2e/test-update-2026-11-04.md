# Реальный TEST apply VM 120 — 2026-11-04

## Результат

**TEST apply PASS; полная квалификация BLOCKER из-за финального health gate штатного restore.**

VM оставлена работающей на новой паре `test-2668005254863a77ebdc32ed0c2c5c015ee03628`, четыре контейнера healthy. HTTPS, авторизация, папки, скачивание двух файлов и SHA256 после обновления прошли. Исправление restore находится в этом PR; на VM неизменённый защищённый контракт. Полный restore с исправлением на VM пока не повторён.

## Checkpoint и CI

- Операционный Git HEAD до/после: `2668005254863a77ebdc32ed0c2c5c015ee03628`. Исходные фактические OCI revisions backend/frontend были `31c57823e04c405decc1fe03d58bb6e8b20aed67`, поэтому это реальное переключение образов, несмотря на неизменный Git HEAD.
- Создан отсутствовавший root:0700 каталог журнала. Начальный checkpoint принят по повторному штатному baseline-inspect, фактическим container refs/IDs и точному совпадению 30 исходных/применённых миграций. Состояние: [update-initial-checkpoint.json](update-initial-checkpoint.json). Начальный `manifest=null` сохранён; история не подделывалась.
- Origin VM приведён к каноническому lowercase URL манифеста; прежний `HomeCloud.git` не совпадал с точной проверкой установщика. Код для обхода проверки не менялся.
- Стандартный защищённый push run [41657969507, попытка 2](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41657969507/attempts/2) перезапущен без изменения test/main и merge. Все 9 jobs PASS, включая публикацию обоих образов и проверку remote provenance. Новый [манифест](update-ci-attempt2.json) прошёл source/manifest check на точном checkout VM.
- Manifest SHA256: `9de2cf09f56e26bd21b7018812dafcfa54f7840220632d7a962851fbe26da05c`.
- Установленные backend/frontend digest: `sha256:d3119a98efe4ff2d645a89b0030993b337a8c1255aaaac093ea349aa19f03301` / `sha256:016090a92ca3cf72e462867dc55bbef78b55133e83d26494697378cf7ee343cd`. Platform/provenance digests записаны в манифесте; live refs/IDs — в [финальном state](update-final-state.json).

## Реальные сценарии

| Сценарий | Наблюдение |
| --- | --- |
| Нет recovery.env перед apply | PREBACKUP отказ; штатное восстановление подготовки записало `ROLLED_BACK`, pending сохранён. Старые образы, миграции, HTTPS и SHA256 подтверждены. [Журнал](update-prebackup-failure.json). |
| Повтор apply при pending | Exit 1; повторная транзакция запрещена. После сверки данных/образов оператор архивировал только свой журнал под install lock. |
| SIGKILL после STOP_SERVICES | Apply process group убита при первой фазе BACKUP; durable pending и prebackup ID сохранились. Recovery-inspect: MANUAL_RECOVERY_REQUIRED, automatic_rollback=false. [Журнал](update-sigkill-backup.json). |
| Реальный restore после SIGKILL | Перед restore изменены только имя synthetic user id=1 и байты его контрольного файла. Из backup `20261104_122231_8b80e04e` штатный restore вернул исходную строку и SHA256 файла, выполнил migrations и reconciliation. Финальный health gate ошибочно вернул exit 1 и fenced writers. [Ответ/ошибка](update-restore-health-failure.txt). После проверки оператор запустил стенд штатным launcher; повторный пользовательский E2E PASS. |
| Финальный apply | Полный launcher test-apply: verified prebackup `20261104_122623_ca6c7080`, offline backup `20261104_122647_5f43cd44`, переключение образов, четыре healthy сервиса, HTTPS smoke, INSTALLED. [Status](update-final-status.json), pending отсутствует. Recovery image pins синхронизированы с новой парой. |
| Повтор точного target | `SKIP: exact TEST source already installed`; новая транзакция не создаётся. |
| Повреждённый manifest_sha256 | Exit 1 до транзакции. INSTALLED/state сохранены, pending отсутствует. |
| Rollback к настоящему manifest 31c57823 | Штатный отказ: начальный checkpoint не имеет квалифицированного manifest в history; дополнительно deploy/scripts старой версии отличаются. Version rollback PASS не заявляется. |

После восстановления и после финального apply скачанные файлы id=3/4 сохранили SHA256 `98006bff22cfc77a2b7324c97aa2667b60f35fec10458c9f69be8e71487fafd7` / `0539a363e178de824da4f8d4750d101603e06e95bea627090cf8a0a461af08b9`. Набор 30 миграций совпал по именам и source hashes.

## Исправление и границы

Restore ожидал корневые status/checks, а реальный глобальный API interceptor возвращает `{success:true,data:{status,checks}}`. Изменена только финальная проверка: строгое `success is True`, объекты data/checks, ready и обе зависимости ok. HTTP 200, deadline и ограничение размера сохранены. Bare response, false/nonboolean success и malformed envelope отклоняются.

Регрессии: test-restore-health — 11 PASS, включая реальный envelope и ошибочные формы; qa fixture — 7 PASS; restore-schema — 20 PASS; restore-preflight — 13 PASS; restore-cleanup — 1 PASS. Installer tests — 31 PASS; recovery-config — 12 PASS; recovery-storage — 22 PASS, 3 исторических сценария skipped. Исправленный health gate отдельно принял настоящий HTTP 200 ответ работающей VM; новый frontend HTML/JS вернули HTTP 200. Это повтор финального gate, не полного исправленного restore. Bash syntax и diff whitespace PASS. Полные backend/frontend tests, lint/build выполнены стандартной CI-попыткой 2; для изменённого PR результат CI сообщается отдельно.

Независимый reviewer `/root/update_review` проверил финальный diff и самостоятельно выполнил 11 health tests и bash syntax: APPROVE, замечаний нет. Проверки fail-closed и root boundary не ослаблены.

Для полного PASS требуется опубликованная защищённая сборка с исправленным restore и повтор полного restore на VM. Самостоятельный merge запрещён владельцем; локальный патч не подменял закреплённый root helper на VM. Также успешный version rollback требует второй квалифицированной версии с совместимыми helper trees. Автоматический rollback после начала target не заявляется.
