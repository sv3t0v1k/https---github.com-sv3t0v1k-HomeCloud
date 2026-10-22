# Public Folder Sharing v1.0 — контракт этапа 1

Статус: **контракт и metadata schema; публичных write routes нет**. Этот документ не разрешает включать upload на сервере. Действующие public read/download и owner upload API сохраняются.

## Права и привязка

- `share_links.allowUpload` — `boolean NOT NULL DEFAULT false`; `true` допустимо только для folder share. Существующие записи и новые ссылки старого owner API остаются read-only. В v1 право задаётся только при создании ссылки; изменение права — отзыв и новая ссылка. Флаг сам по себе не авторизует запрос.
- Public upload session имеет неизменяемый `origin='public'`, `shareLinkId`, `shareRootFolderId`, `userId` и `parentId`. `shareRootFolderId` — **`files.folderId` корневого mirror**, не `share_links.fileId`. Для owner session `origin='owner'`, оба share ID равны `NULL`. При удалении ссылки или корня FK обнуляет binding; `origin` остаётся `public`, и все public операции должны отказать. Owner routes обязаны выбирать только `origin='owner'`; public routes — точный share ID и origin. Нельзя использовать owner session discovery для посетителей.
- При создании публичной сессии БД требует живую активную upload-enabled folder share того же владельца, живой mirror, правильный корень и `parentId` внутри живого дерева. Каждое последующее обращение **повторно** проверяет активность, срок, `allowUpload`, пароль/proof, владельца, корень, живые ancestors и target; проверка до multipart повторяется перед публикацией. Проверка при создании не заменяет эту повторную проверку.
- Право на запись не меняет право на чтение/скачивание. Ссылки на отдельные файлы всегда read-only. Посетитель не удаляет, не переименовывает и не перемещает чужие или свои опубликованные объекты.

## API для следующих этапов (пока не реализован)

Префикс: `/api/v1/sharing/public/:token`. Все запросы принимают только HTTPS. `:token` выбирает ссылку; client `userId`, root ID, workspace, storage path/placement игнорируются или отклоняются. Ответы public API не раскрывают owner user ID, host paths, другие сессии и внутренние ошибки. Существующие `GET /public/:token`, `POST /verify`, `GET /children`, `POST /download` остаются прежними. При добавлении owner `allowUpload` в `POST /api/v1/sharing` и owner list поле включается явно; старый клиент, не передающий поле, получает `false`.

| Действие | Запрос | Успех / результат |
|---|---|---|
| Получить write proof | `POST /:token/upload-authorizations`, body `{password?: string}` | `200`, короткоживущий proof для **одной** ссылки/корня. Пароль остаётся только в теле запроса. Для ссылки без пароля proof также выдаётся после live admission. |
| Создать папку | `POST /:token/folders`, `X-Share-Upload-Proof`, `Idempotency-Key: UUID`, body `{parentId: integer, name: string}` | `201`, `{id, parentId, name}` с фактическим именем. Folder и mirror, receipt и проверка scope в одной транзакции. |
| Начать файл | `POST /:token/uploads/session`, те же proof/key, body `{parentId, filename, totalSize, chunkSize, expectedSha256?}` | `201`, безопасная проекция `{uploadId, filename, totalSize, chunkSize, totalChunks, status}`. Binding, quota reservation и receipt атомарны. `totalSize>0`; ограничения размеров/chunks из существующего upload core. |
| Передать chunk | `POST /:token/uploads/session/:uploadId/chunk` с существующим multipart `chunk` и `chunkIndex` | `200`, scoped metadata. Совпадающий индекс+hash допускает retry; отличающиеся bytes для индекса — ошибка. Ingress cleanup сохраняется. |
| Сверить/завершить/отменить | `GET /:token/uploads/session/:uploadId`, `POST /:token/uploads/session/:uploadId/complete`, `DELETE /:token/uploads/session/:uploadId` | Scoped status/complete/abort; `complete` идемпотентен. Ни один route не принимает произвольный owner upload ID. |

Все write routes требуют `allowUpload=true` и proof в заголовке. Proof — подписанная capability, не личность посетителя: audience `public-upload`, share ID, owner ID, root folder ID, срок не больше 5 минут и срока ссылки. Его не пишут в URL, persistent storage или логи. Сервер проверяет подпись **и живое состояние ссылки на каждом запросе**; revoke/expiry немедленно останавливают новые операции и complete. Проверка пароля выполняется один раз на выдачу proof под существующим rate limit/lockout; каждый chunk не вызывает bcrypt/счётчик неудачных паролей. Подписание и ротация ключа — design gate следующего этапа; owner JWT не используется как public proof.

Ошибки: `400` — неверные имена/параметры/manifest; `401/403` — отсутствующий или неверный proof/пароль/право записи; `404` — отсутствующая, истёкшая, отозванная ссылка или объект вне живого дерева (без раскрытия существования объекта); `409` — тот же idempotency key с другим запросом или неопределённый replay после TTL; `429` — ограничение частоты. Existing public download form redirect и JSON-семантика API не меняются.

## Повтор, имена и дерево

- Каждый `mkdir` и create-session требует UUID `Idempotency-Key`. Сервер нормализует и хеширует существенные поля (`kind`, share/root/parent, name/filename, size/chunkSize/checksum) и сохраняет immutable receipt с result ID в той же транзакции, что создаёт результат. UNIQUE `(shareLinkId, kind, key)` сериализует конкурентный replay. Тот же key/payload возвращает тот же результат без новой квоты; другой payload — `409`. Перед replay снова выполняются live authorization и проверка, что результат всё ещё внутри дерева. При удалении ссылки/корня/результата receipt становится недоступным; он не позволяет восстановить доступ. Receipt хранится не менее 24 часов, затем удаляется bounded cleanup; после TTL клиент не делает автоматический повтор неопределённой операции с новым ключом.
- Имя нормализуется в NFC, 1–255 символов; `.`/`..`, slash, backslash, NUL/control и пустое имя отклоняются. Общее живое namespace файлов и folder mirrors внутри parent. Коллизия создаёт отдельное имя `name (1)`, `name (2)` (для файла — перед расширением), с безопасным усечением до 255 символов; существующий объект никогда не перезаписывается или не merge-ится. Выбор имени и публикация проходят под общей сериализацией metadata владельца. Физический storage key генерируется независимо от имени.
- Передача дерева — **протокол из существующих примитивов**, отдельного endpoint для ZIP/manifest нет: клиент строит bounded manifest (до 1000 записей, глубина до 32, путь до 4096 UTF-8 bytes), создаёт папки сверху вниз и сохраняет отображение исходного пути в возвращённые folder IDs; затем создаёт отдельные file sessions. Для каждого узла отдельный ключ и receipt. Partial success показывается явно; автоматического destructive rollback дерева нет. Неподдерживаемые пустые файлы (`totalSize=0`) и не обнаруженные браузером пустые папки не помечаются как загруженные.

## Конкуренция, квота, удаление

- Byte quota списывается и резервируется **у владельца**, с существующим user lock и upload core; public facade не создаёт вторую систему учёта. Отдельные IP/token/proof rate limits и ограничения на число объектов/receipt/temp bytes нужны против metadata flooding: byte quota одна этого не покрывает.
- Owner move/delete/restore/rename, public mkdir/complete и revoke могут пересекаться. Перед следующими этапами нужен единый порядок коротких metadata locks, проверка дерева в той же транзакции и fencing для assembly вне lock. Не держать lock на потоковой передаче. Старый complete берёт session lock и затем quota/user lock; менять порядок без PostgreSQL race/deadlock tests нельзя. При revoke/expiry/move-out до commit публикации нет, а staging очищается по TTL. Уже опубликованный файл остаётся у владельца после revoke.
- FK `ON DELETE SET NULL` не блокируют owner hard-delete. Orphan public session не превращается в owner session; cleanup работает по origin и освобождает pending temp/quota без живой ссылки. Receipt с NULL binding/result не возвращает успешный replay. Down migration намеренно отказывает, если появились новые public данные или upload-enabled ссылки.

## Gate этапа 1

Миграции проверяются в disposable PostgreSQL: старые ссылки `allowUpload=false`, старые сессии `origin=owner`, новые ограничения/каскады и безопасный down. На домашнем сервере миграции не выполняются. Публичная запись остаётся недоступной до отдельных этапов endpoint, proof, concurrency и браузерного QA.
