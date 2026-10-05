# Аудит до изменений — 5 октября 2026

`INITIAL_STATE`: ветка `main`, HEAD `9fc738463e344599b2dcb6d54aa0776bf3f052fe`, ahead/behind `11/0`. Три известных untracked-файла сохранены. Запрещённый audit не читался. Матрица установлена до изменения исходников и записана после уточнения владельцем разрешения на новые tracked-файлы.

| Возможность | Классификация | Доказательство исходного кода или runtime |
|---|---|---|
| Допуск по расширению, MIME и содержимому | PARTIAL | `uploads.service.ts:792–803`: определение MIME и UTF-8 classifier; стандартный список разрешённых MIME проверяется на complete. Расширения не проверяются. |
| `.bin`, `application/octet-stream`, неизвестный MIME | PARTIAL | Стандартный список не содержит `application/octet-stream`. Предыдущий runtime: 256 chunks получили 200, complete — 400, abort — 200. [Предыдущий отчёт](../large-transfer-rate-limit-remediation-20261005/report.md). |
| Файл без расширения или с несовпадением расширения и MIME | PARTIAL | Имя и MIME из picker не определяют допуск. Определённый по содержимому MIME ограничен тем же списком разрешённых типов. |
| Произвольные файлы и множественный выбор в picker | PARTIAL | `FileBrowserPage.tsx:451`: input без `accept` и `multiple`; onChange берёт `files[0]`. |
| Пакетная загрузка нескольких файлов | NOT_SUPPORTED | `UploadControl` хранит один `File` и один `AbortController`. |
| Перетаскивание одного файла, нескольких файлов или папки | NOT_SUPPORTED | У `files-page` отсутствуют обработчики drag/drop. |
| Очередь и параллелизм | PARTIAL | `upload.ts:103`: последовательный цикл slice/chunk; очереди нет. |
| Pause | NOT_SUPPORTED | Есть только `cancelUpload → controller.abort`. |
| Resume в той же странице | BACKEND_ONLY | `upload_chunks` имеет unique(sessionId, chunkIndex), SHA-256, fsync и идемпотентность. Интерфейс всегда создаёт новую сессию через POST. |
| Продолжение после сетевого сбоя | PARTIAL | `upload.ts:147–186`: три попытки для network/5xx/429; после исчерпания catch вызывает `abortSession`. |
| Продолжение после перезагрузки страницы или перезапуска браузера | NOT_SUPPORTED | Нет сохранения метаданных, повторного выбора файла или интерфейса обнаружения сессий. |
| Cancel | SUPPORTED_AND_UI_REACHABLE | «Отменить загрузку» вызывает DELETE сессии и очистку под блокировкой. Подтверждено предыдущим runtime. |
| Сохранение сессий, обнаружение и сверка | PARTIAL | PostgreSQL сохраняет части и сессии. `listUploadSessions` выдаёт только pending; `getUploadSession` внутренний. GET сведений о сессии и принятых частях отсутствует. |
| Подтверждённый прогресс | PARTIAL | Серверный `uploadedSize` отражает принятые байты; интерфейс до ответа показывает клиентский `onUploadProgress.loaded`. 100% только после complete. |
| 429 и Retry-After | SUPPORTED_AND_UI_REACHABLE | Три попытки, максимум 60 с на ожидание и пять минут суммарно. Есть предыдущая реальная UI-проверка контролируемого 429. |
| Устаревшие сессии и резерв квоты | SUPPORTED_AND_UI_REACHABLE | Создание блокирует пользователя и учитывает used + active reserve. Абсолютный TTL — 24 часа; очистка при старте и каждый час. Отмена исключает резерв. |

Свежая проверка baseline: существующие backend, БД и frontend стека `homecloud-preview` доступны. IAB и Safari при открытии `/files` перенаправили на `/login`. Предыдущие runtime-доказательства обозначены как предыдущие; наличие поддержки в коде не выдаётся за новый runtime PASS.

Обычный выбор файла предоставляет браузеру только явно выбранные пользователем файлы. После перезагрузки требуется повторный выбор. `showOpenFilePicker` ограничен совместимостью и разрешениями; он не нужен для корректного обычного picker. Перетаскивание папок требует обхода directory entries и отдельной политики дерева. В этом scope оно остаётся будущей возможностью. Источники: [File API](https://developer.mozilla.org/en-US/docs/Web/API/File), [File System Access](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker), [directory entries](https://developer.mozilla.org/en-US/docs/Web/API/DataTransferItem/webkitGetAsEntry).

`50_GIB_BROWSER_E2E_STATUS = FAIL / REQUALIFICATION_REQUIRED`; 50 GiB Browser E2E здесь не запускается.
