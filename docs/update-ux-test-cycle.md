# UPDATE UX: автоматическое закрытие успешной TEST-установки

`current.json` остаётся единственным блокирующим статусом. После `INSTALLED/COMPLETE`
root-служба архивирует его в `status/archive/<manifestSha256>.json` только после
сверки `installed.json`, `last-status.json`, `state.json`, отсутствия
`pending.json` и `request.json`, а также работающих backend/frontend контейнеров,
их digest-pinned refs, image IDs, revision labels и состояния health. Проверки
выполняются под тем же `status/install.lock`, что и host installer. Ошибка любого
чтения, проверки, блокировки или синхронизации оставляет новое обновление
заблокированным.

Архивация использует долговечный `archiving.json`, жёсткую ссылку и `fsync`
файла и каталогов. Если питание пропало после удаления `current.json`, маркер
остаётся; backend показывает `UNKNOWN_REQUIRES_REVIEW`, admission отказывает.
Периодическая служба повторно проверяет все свидетельства и завершает переход.
Если обнаружен другой файл в архиве, неподтверждённый статус или дрейф образов,
автоматическая очистка не выполняется. `STOP` и `MANUAL_RECOVERY_REQUIRED`
никогда не архивируются автоматически.

## Условия ввода на VM120 после PR и CI

1. До merge и независимого review не менять VM120, RELEASE или
   `AUTO_UPDATE=false`. Сам PR не устанавливает host-owned скрипт и unit-файлы.
2. Сверить точные байты принятого commit и отдельно переутвердить root-owned
   trust anchor `homecloud-update-verify`: его pinned hash admission изменился.
   Первая установка commit с изменениями `deploy` и `scripts` из текущей версии
   VM120 (`7a8eda9`) не пройдёт существующий `target_sources`, который требует
   идентичное дерево этих каталогов. Нужен отдельный проверенный переход доверия;
   нельзя обходить gate изменением checkout или копированием скриптов без
   квалификации. Пока переход не определён и не проверен, **UI E2E не принят**.
3. После разрешённого перехода установить `update-status-archive.py` как
   `/usr/local/sbin/homecloud-update-archive` (root:root, 0700) и новые
   systemd unit-файлы; проверить пути, ownership и effective sandbox. Включить
   timer восстановления. Отдельно проверить, что `COMPOSE_PROJECT_NAME` из
   защищённого `.runtime/runtime.env` совпадает с реально работающим проектом.
4. Проверить последовательные обновления через UI на TEST: `QUEUED` →
   `RUNNING` → подтверждённый `INSTALLED/COMPLETE` → архив → `NO_JOB`.
   Сверить контейнеры, данные, миграции, backup, HTTPS и отсутствие
   `pending.json`/`request.json`. При любом несовпадении остановить сценарий,
   сохранить файлы и журналы для оператора. `AUTO_UPDATE` остаётся `false`.

Тесты в PR синтетические; они не подтверждают хостовый E2E или переход доверия.
