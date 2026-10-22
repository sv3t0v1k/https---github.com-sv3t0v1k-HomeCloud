# Public Folder Sharing — загрузка одного файла, этап 3

Локальная backend-реализация, без frontend, импорта дерева и rollout. Домашний сервер
не обновлялся; Production NO_GO, Multi-Storage DEFERRED. Утверждённый контракт
`public-folder-sharing-v1-contract.md` сохранён; пустые файлы отклоняются.

## API

База: `/api/v1/sharing/public/:token`. Новые upload routes требуют HTTPS и заголовок
`X-Share-Upload-Proof`. JWT посетителя не нужен. Proof выдаёт существующий
`POST /upload-authorizations` после проверки ссылки и пароля; хранить его следует
только в памяти клиента. Срок proof — до пяти минут и не дольше срока ссылки.
Пароль не проверяется заново на каждом chunk.

| Метод и путь относительно базы | Вход | Ответ |
|---|---|---|
| `POST /uploads/session` | `Idempotency-Key: UUID`, JSON `parentId,filename,totalSize,chunkSize,expectedSha256?` | 201, безопасные сведения о сессии |
| `POST /uploads/session/:uploadId/chunk` | multipart `chunkIndex` + один `chunk` | 200, progress сессии |
| `GET /uploads/session/:uploadId` | proof | progress, принятые chunk index/size/SHA-256; для completed — безопасные сведения о файле |
| `POST /uploads/session/:uploadId/complete` | proof | id, фактическое имя, parentId, size, MIME, SHA-256, uploadId |
| `DELETE /uploads/session/:uploadId` | proof | `{status:"aborted"}`; повтор отмены безопасен |

`parentId` обязателен и обозначает корень ссылки или живого потомка; `null`, чужой
каталог и owner root не выбираются автоматически. Имя приводится к NFC и проверяется
существующим core. `totalSize=0` и превышение существующих размеров/chunk bounds
отклоняются. Согласно контракту этапа 1 `expectedSha256` необязателен; при наличии
сравнивается с вычисленным значением. Для public файла whole SHA-256 вычисляется
и сохраняется всегда. Клиент не задаёт owner, root binding, workspace или placement.

Ответы и ошибки — no-store, без ORM сущностей, owner IDs, внутренних путей и stack.
Ошибки: 400 параметры/размер/hash; 403 proof/HTTPS; 404 недоступная ссылка, сессия или
объект вне дерева; 409 конфликт payload/сборки/receipt; 429 ограничение с Retry-After;
503 недоступный legacy workspace. Внутренние ошибки имеют обобщённое сообщение.
Опубликованный файл не удаляется отменой сессии.

## Общий upload core и авторизация

Нового механизма записи нет. `UploadsService` принимает только внутреннюю capability
от Sharing: exact user/share/root binding и callback живой policy. Owner selectors
остаются `origin=owner`; public selectors требуют `origin=public` и точные share/root.
Публичного discovery/list sessions нет. Ссылка B не управляет сессией A даже у одного
владельца или общего корня. Осиротевшая сессия никогда не становится owner session.

Создание сессии, quota reservation и receipt фиксируются одной транзакцией под user
lock. Тот же ключ и payload возвращают ту же сессию; другой payload — 409. Replay
снова проверяет ссылку, дерево и существование результата; completed replay проверяет,
что File ещё жив и остаётся в дереве. После истечения receipt клиент не должен
автоматически повторять неопределённую операцию с новым ключом.

Перед Multer выполняются proof/live/session admission и owner concurrency admission.
Существующие secure Multer options, abortable disk storage и ingress cleanup используются
повторно; `req.user` для посетителя не подделывается. Chunk/status/abort не приобретают
user/share/path row locks после session lock. Публикация использует короткий порядок
user → share → ancestors/mirrors → session, согласованный с mkdir и owner mutations.
После сборки и fsync повторно проверяются proof, link expiry по clock_timestamp,
allowUpload, владелец, целевая папка, ancestors, session binding/TTL и квота.
Revoke/move-out/delete до финальной проверки запрещают публикацию с откатом quota.
Уже опубликованный файл остаётся у владельца.

Сохранены stage3.0 fencing, уникальные assembly attempts, exclusive hard link,
SHA-256, namespace allocator и атомарное преобразование reservation в storageUsed.
Невостребованные chunks/assembly очищаются существующим retry/abort/TTL/startup
lifecycle независимо от живой ссылки. Неопределённый COMMIT не удаляет опубликованные
байты и не приводит к повторному списанию. Ошибка создания workspace оставляет
атомарный receipt/reservation для безопасного повтора того же ключа или TTL cleanup.

## Ограничения ресурсов и хранилища

- Public create ограничен 128 pending/uploading sessions владельца (включая owner
  и все ссылки) и 1000 receipts ссылки. Byte/file/chunk limits берутся из общего core;
  точное использование квоты владельца наружу не выдаётся.
- Expired receipts удаляются отдельной ограниченной пачкой до 1000 в минуту через
  SKIP LOCKED; live receipts сохраняются не менее 24 часов. После TTL сервер не
  сохраняет бессрочный tombstone ключа: клиент соблюдает правило неопределённого replay.
- Проверенные exact public chunk/abort routes используют отдельные bounded IP/share
  buckets и общий owner/global upload budget. Только живой proof/session допускает
  обход обычного API/public request budget; JWT не заменяет public authorization.
- Legacy completions владельцев и посетителей используют общий process-local admission
  для DataSource: не более min(2,pool.max−2), с совместимостью owner pool=1. Public
  complete при pool<3 возвращает 429 до получения соединения. Никакой неограниченной
  очереди новых сборок нет; освобождение слота проверено и при connect failure.
- Dedicated connection занято на всю сборку. Лимиты одного процесса не являются
  распределённым admission нескольких реплик. Текущий runtime pool=20 оставляет
  ресурс для обычных запросов и отзыва ссылки при двух сборках.
- Public API работает только с текущим legacy workspace/default placement. При
  включённом несовместимом SSD режиме public writes закрыты; активация storage не меняется.
- До сборки проверяется одинаковый device workspace и destination. Реальный hard link
  проверен в Linux на тестовом legacy storage. EXDEV отклоняется, chunks сохраняются;
  copy/fallback между файловыми системами отсутствует. Домашний mount, NAS и физический
  диск этим локальным прогоном не квалифицированы.
- Истёкший во время сборки proof запрещает публикацию. Для повтора нужен новый proof;
  успешность сборок длительнее пятиминутного proof не заявляется. Максимальный размер
  из конфигурации не является квалификацией времени завершения или нагрузки 1 ТиБ.

## Исправление FK invalidation

Аддитивная `1746825230000-PublicUploadParentInvalidation` не переносит данные и не
меняет FK/model. Она исправляет конфликт старого immutable guard с существующим
parent FK SET NULL: parentId может стать NULL только в nested FK trigger, когда
старой папки уже нет. Прямые SQL NULL/rebind по-прежнему отклоняются. Target/root
hard-delete завершается, binding теряет доступ, quota/temp освобождаются TTL cleanup.
Проверены up/down/up на disposable PostgreSQL; откат возвращает прежний строгий guard.
Миграция применялась исключительно к одноразовым тестовым БД.

Приёмка, независимый review и checkpoint фиксируются в ROADMAP. Следующий этап
и frontend автоматически не начинаются.
