# Независимый review хранения и безопасности HomeCloud

Дата повторной фиксации: 2026-10-05, Asia/Vladivostok.

**STORAGE_SECURITY_REVIEW: ACCEPT.** Нерешённых замечаний CRITICAL/HIGH в проверенном scope нет.

## Идентификация и границы

- Репозиторий: `/Users/aleksejkozemakin/Desktop/HomeCloud`.
- Проверенный committed HEAD: `8818f92a63281d23d062f1001c94e719ab98933b`.
- База сравнения: `9fc738463e344599b2dcb6d54aa0776bf3f052fe`.
- Review выполнен отдельным агентом `/root/storage_security_review`, который не писал реализацию и не участвовал в её коммитах.
- Проверены изменения uploads service/controller, генерации storage path, заголовков оригинального скачивания, границы владельца в API client/tokenStorage и безопасного сохранения метаданных upload queue. Смежные существующие проверки ownership, quota, integrity, preview и downloads прочитаны для оценки регрессий.
- Запрещённый файл `scripts/tests/PHASE-5.3.1-TEST-AUDIT.md` не читался и не изменялся. Реализация, Git, контейнеры, fixtures и исходные untracked-файлы этим review не изменялись. Создан только данный отчёт в зеркале проекта.

## Конкретные проверки

1. **Произвольное содержимое.** Удалено использование `ALLOWED_UPLOAD_MIME_TYPES` для admission. В `uploads.service.ts:768–788` MIME определяется после сборки как метаданные; неизвестная или усечённая сигнатура и ошибка детектора дают `application/octet-stream`. Ни ветка определения MIME, ни fallback не преобразуют сохраняемые байты. Логическое имя из `session.filename` сохраняется в `FileEntity.name` (`:790–800`).
2. **Имя и путь.** `validateFilename` (`uploads.service.ts:869–885`) отвергает пустые имена, `.`/`..`, разделители, C0/C1 и превышение установленного размера имени до создания reservation. Валидный `parentId` проверяется как положительное safe integer; папка ищется по `{id, userId}` (`:189–205`). Физический путь строится из серверного upload UUID в каталоге владельца и проходит `ensureWithinStorageRoot`.
3. **Длинные имена.** В `storage.service.ts:68–80` только физический компонент, превышающий 255 UTF-8 байт после добавления UUID, заменяется детерминированным `${uploadId}.upload`. Обычные пути сохраняют прежний алгоритм, логическое имя и регистр расширения остаются в БД. Проверка root containment сохранена. Прочитаны новые тесты реального filesystem на границе 255 байт и длинного Unicode-расширения и соответствующие PostgreSQL cases.
4. **Доступ.** Контроллер uploads сохраняет общий `JwtGuard`. Поиск и изменения сессий выполняются с `{uploadId, userId}`; новые reconciliation и discovery не принимают владельца от клиента. Reconciliation блокирует строку сессии транзакционным `pessimistic_write`; completed file ищется по `{uploadId, userId}`.
5. **Квота и размеры.** Сохраняются safe-integer проверки total/chunk size, max file/chunk/count limits, блокировка строки пользователя, суммирование активных reservations и authoritative quota enforcement. Снятие MIME-политики не изменяет accounting и не даёт обходить эти границы.
6. **Целостность и cleanup.** Сохраняются точный ожидаемый размер каждого чанка, SHA-256 сравнение при idempotent duplicate, проверка final assembly size/hash, fsync и транзакционные переходы. Abort остаётся owner-scoped; удаляет записи чанков и temp state своей сессии. TTL cleanup не отменяется функцией Pause. В прочитанных новых PostgreSQL tests есть ownership, cleanup reservations и изоляция отмены от sibling.
7. **Ответы session API.** `toSessionMetadata` (`uploads.service.ts:887–900`) исключает tempPath, userId и ORM relationships из create/chunk/list responses. Reconciliation (`:902–964`) отдаёт только нужные chunk index/byteSize/SHA-256, а completed file — явную проекцию id/name/size/mimeType/parentId/uploadId. Нельзя получить чужие session/chunk hashes через новый API.
8. **Скачивание и Unicode.** `files.controller.ts:383–416` сохраняет ASCII fallback и добавляет RFC 5987 `filename*`. C0/C1 и непарные surrogates очищаются; UTF-8, кавычки, апострофы и специальные символы percent-encoded. Точное допустимое Unicode-имя и регистр расширения сохраняются при скачивании. `attachment`, MIME grammar check, `nosniff`, owner lookup, storage-root/realpath/O_NOFOLLOW checks не ослаблены. Прочитаны HTTP regressions на кириллицу, японский текст/emoji, кавычки, apostrophe/()* и legacy CR/LF injection.
9. **Граница аккаунта.** `tokenStorage` увеличивает ownerGeneration при explicit set/clear, но сохраняет её при обычной refresh rotation. `apiRequest` синхронно фиксирует ownerGeneration до асинхронных Axios interceptors (`client.ts:91–97`). Interceptor и 401 handler не допускают повтор под новым владельцем (`:38–43`, `:61–62`); поздний refresh 400/401 очищает только исходный epoch (`:123–126`). Прочитаны три regressions: старый 401 после смены владельца; смена владельца между вызовом apiRequest и первым interceptor без ожидания (adapter calls = 0); поздний отказ старого refresh после нового входа.
10. **Браузерное сохранение.** Queue localStorage key привязан к ownerId; payload (`uploadQueue.ts:448–460`) содержит только имя/размер/target/uploadId/progress/sample fingerprint/lastModified/backoff/cancellation intent. JWT, refresh tokens, share passwords и raw bytes туда не попадают. Restore валидирует метаданные, не читает локальные файлы и не запускает chunk requests; требуется повторный выбор файла. Удаление truncation первых 200 локальных записей не меняет concurrency: pump остаётся ограниченным двумя файлами и одним chunk request на файл. Прочитаны sample fingerprint и проверки SHA-256 уже принятых сервером чанков перед докачкой. Пользовательские имена отображаются React как текст.
11. **Preview отдельно от admission.** Неизвестные типы получают unsupported preview; существующее отображение текста через React/pre и изображения через img не добавляет исполнение произвольного загруженного HTML. Расширение списка сохраняемых типов не снимает download attachment/header boundaries.

## Замечания и их состояние

| Замечание | Состояние | Нерешённая severity |
| --- | --- | --- |
| Потеря Unicode и специальных символов имени при оригинальном скачивании | Закрыто безопасным UTF-8 filename* и HTTP regressions | Нет |
| Отправка/401 replay старого upload request под новым аккаунтом | Закрыто ownerGeneration, синхронным захватом и regressions | Нет |
| Поздний refresh 401 очищает новый login | Закрыто проверкой refresh epoch и regression | Нет |
| ENAMETOOLONG для допустимого логического имени после добавления UUID | Закрыто bounded physical filename и filesystem/PostgreSQL regressions | Нет |

Нерешённых CRITICAL/HIGH/MEDIUM findings в изменениях данного scope нет.

**Существующее замечание LOW, вне внесённого изменения:** ответ `/uploads/session/:uploadId/complete` по-прежнему возвращает raw `FileEntity`, в котором может быть `storagePath`. Это owner-authorized disclosure внутреннего пути; оно существовало до checkpoint. Новые session responses и completed reconciliation такой путь не раскрывают. Изменение этого прежнего контракта не требуется для ACCEPT проверенного diff.

## Границы доказательств

Этот файл фиксирует независимый **code review**, включая чтение regression test code. Reviewer самостоятельно не запускал тестовые наборы, не наблюдал браузерные acceptance scenarios и не подтверждал runtime cleanup. Числа PASS/FAIL тестов, Safari/Chromium UX, download hashes и состояние контейнеров должны подтверждаться отдельными доказательствами основного исполнителя; они не выводятся из этого ACCEPT.

50 GiB fixture/E2E этим reviewer не создавались и не запускались. Статус отдельной квалификации остаётся **FAIL / REQUALIFICATION_REQUIRED**.
