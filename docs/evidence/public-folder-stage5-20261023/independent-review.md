# Независимый review этапа 5

Результат: **ACCEPT**. Read-only reviewer не является автором реализации.
Review исходного backend использовал актуальный код и ранее завершённые проверки,
без повторного выполнения backend-набора и без подключения к домашнему серверу.

Проверены live subtree/ancestor/mirror scope, exact public session origin/share/root
binding, проверки перед commit, scope download, SHA-256 и идемпотентные receipts.
Серверная защита не зависит от клиентского manifest; backend блокера не обнаружено.

Frontend findings, исправленные перед окончательным ACCEPT:

1. Повтор children listing сбрасывал страницу и терял checkpoint. Отделён listing retry,
   обновления coalesced; panel остаётся смонтированной при ошибке списка.
2. Разные raw implicit parent prefixes могли сливаться после NFC/trim. Добавлена
   проверка provenance каждого нормализованного префикса.
3. Fallback directory input мог стать disabled до открытия picker. Синхронная ветвь
   выбора вызывается до состояния занятости; проверена Chromium filechooser.
4. Empty file навсегда удерживал batch. Добавлен явный выход с partial result и
   предупреждением о потере checkpoint/возможных дубликатах при новом выборе.
5. Completed files пропускались при partial resume. Status replay теперь проверяет
   результат, конфликт исключается из подтверждённых узлов без создания нового job.
6. Status recheck не имел timeout; transport получил default120s с отдельным timeout
   complete. Подтверждение partial discard запрещено во время active.
7. Проверены synchronous batchRef guard, TTL23h, exact payload/key/target, credentials
   memory-only, отсутствие public owner discovery и lifecycle cleanup.

Дополнительный browser regression: смена batch оставляла прежний drop surface до
повторной авторизации. Исправлена синхронным loading при clear и disabled New upload
при active. На этот delta получен отдельный **ACCEPT**; добавлен regression test и
изолированный успешный Chromium сценарий mkdir → New upload → empty directory drop.

Reviewer проверил diff, а не воспроизводил browser tests. Итоговые результаты
browser/component checks приводятся отдельно и не приписываются reviewer.
Известные ограничения: отсутствует public limits projection; generic quota/access403;
checkpoint только в памяти вкладки; Safari acceptance не выполнена.
