# Квалификация 50 ГиБ через браузер: preflight BLOCKED

Дата: 3 октября 2026, Asia/Vladivostok. Исходный HEAD: `8e90dcafda7f7aa3433a5156e3b411ed4161b69d`, main ahead/behind 3/0. Новая numbered Phase не создавалась. [Подробные измерения](./preflight.json).

**50_GIB_BROWSER_E2E_STATUS = BLOCKED.** Полная передача не запускалась: обязательный preflight не пройден. Ни успешной загрузки, ни скачивания, ни целостности файла 53 687 091 200 байт, ни приемлемой производительности здесь не доказано.

## Подтверждённые барьеры

1. Действующий `homecloud-preview-backend-1`: `MAX_FILE_SIZE=1073741824` (1 ГиБ), `MAX_TOTAL_SIZE=10737418240` (10 ГиБ), `MAX_CHUNK_SIZE=52428800`. `createUploadSession` отвергает превышение до создания сессии. Конфигурация не менялась.
2. `frontend/src/files/download.ts` ограничивает обычное UI-скачивание 104 857 600 байтами (100 МиБ) до запроса; авторизованный запрос использует Axios Blob. Удаление одного guard не является решением безопасности памяти. HTML/JS/CSS действующего frontend совпали с локальным dist, включая актуальный JS `index-DGlC_Rmp.js`, SHA256 `d85ffdf197f2918d48573c28e8193626af249891080152a3e78e23a2d8c21bd9`. Строка ошибки guard есть в runtime bundle. Отдельный product scope нужен для authenticated browser streaming download; разрешённая здесь upload-only remediation этого не покрывает.
3. macOS доступно **133 120 000 000 байт = 123,98 ГиБ**. Assembly создаёт отдельный полный файл до удаления чанков: минимум 100 ГиБ для серверной части. Возврат удалённых блоков sparse Docker VM на host не доказан. Консервативный бюджет при sparse source — 100 ГиБ VM allocation + 50 ГиБ скачивание = **161 061 273 600 байт**, дефицит **27 941 273 600 байт** ещё без запаса. С выбранным резервом 20 ГиБ нужно **182 536 110 080 байт**, дефицит **49 416 110 080 байт**. Это worst-case host allocation при недоказанном reclaim, не одновременно живые chunk/final/download файлы; после cleanup живые серверные файлы уменьшаются до 50 ГиБ. Полностью allocated source добавит ещё 50 ГиБ. Резерв20ГиБ — явное плановое допущение, а не измеренная потребность продукта. VM сообщает около398ГиБ свободного, но host остаётся ограничивающим диском. По обязательному правилу диска выполнен STOP.

## Что проверено

Использован существующий Compose project `homecloud-preview`, backend `fd496a65fc75`, frontend `45daae40e2da`, DB `dc54838e53d4`, ingress `e07d40f4e248`, volume `homecloud-preview_storage_data`. Дополнительного стека/контейнеров не создано. Никакие контейнеры не изменялись; контейнеры `29c17227fd0a` и `983714f1deaa` не выбирались для операций.

Browser preflight: Codex In-app Browser открыл `http://localhost:8080/files`, получен настоящий экран входа `/login`. Версия IAB не получена: navigator недоступен в read-only scope. Установленный Safari 27.0 наблюдался на `localhost:5187/files`; это прежний mocked fixture, исключённый из qualification evidence. Авторизация и file picker не запускались. UI-инициация обоих направлений **NOT_RUN**.

Фронтенд использует 10 МиБ чанки: для 50 ГиБ ожидается 5120 запросов. По коду temp находится в `/storage/.tmp`, ingress — в `multipart-ingress`, assembly потоковый; completed session сохраняется, chunks удаляются после успешного DB commit. Storage baseline 76 КиБ, temp 8 КиБ. Существующие sessions: uploading1/18432байт, aborted3/97503423байт, completed5/37021байт. Эти данные не принадлежат checkpoint и оставлены нетронутыми.

RAM macOS 24 ГиБ, memory_pressure reported free 56%; VM MemAvailable 15047608 КиБ. Docker working-set baseline backend 54,73 МиБ/CPU 0%, PostgreSQL 27,64 МиБ/CPU 0,01%. Отдельный `/proc/1/status`: backend RSS 112296 КиБ, исторический HWM 128560 КиБ. Эти виды учёта различаются; HWM не является пиком передачи этого checkpoint. Backend restarts 0, OOM=false; readiness database/storage=ok.

User 3: quota 107374182400, used 37021, active_reserved 0; per-user quota достаточно. Users 1/2: quota 0 (по коду без per-user ограничения), у User 2 резерв 18432. Global runtime limits всё равно блокируют50ГиБ. UI user не выбран; никто не логинился, квоты не увеличивались.

## Границы вывода

В `uploadChunk` каждый запрос сканирует все `totalChunks`, затем проверяет накопленные chunks и их размеры. Это статический риск суммарной квадратичной работы. EARLY/MIDDLE/LATE latency, ratios, throughput, responsiveness и ресурсный пик 50 ГиБ не измерялись. Подтверждённой серьёзной runtime-деградации 50 ГиБ здесь нет; product fix не выполнялся.

Историческая Phase12 квалифицировала 30 ГиБ HTTP/backend (615 chunks) с runtime-only overrides, без browser workflow. Этот результат не подтверждает 30/50 ГиБ браузерную передачу. Значение formatter для 50 ГиБ выводится как 50 ГБ по коду; настоящий UI файла такого размера не проверялся.

## Integrity, cleanup и gates

Fixture не создан: apparent/physical размер, чтение sparse extents через File API, source/stored/downloaded SHA256, DB/storage size и полный UI upload/download — **NOT_RUN**. Нет API/curl подмены браузерной передачи. Test-data cleanup не требуется: checkpoint не создал файл, сессию, source/download, quota/config override или Docker resources. Существующие temp/session данные не удалены. Trash semantics и отсутствие orphan после 50 ГиБ не квалифицированы.

Существующие focused frontend tests upload/download/formatBytes: **3 suites, 39 tests PASS**; тест download подтверждает отказ выше 100 МиБ до network request. Код продукта не изменён; full frontend/backend, PostgreSQL integration, lint/typecheck/build не запускались и не объявляются PASS. Для docs/evidence выполняются JSON validation и `git diff --check`.

Три исходных untracked файла сохранены; два разрешённых JSON имеют исходные SHA256 в evidence. Запрещённый audit не читался, не изменялся и не индексировался. Push/tag не выполнялись.

Независимое финальное ревью report/JSON: **APPROVE для BLOCKED/preflight-only**, MUST_FIX нет. Ревьюер непосредственно проверил source, HEAD, history и host disk; Docker runtime/UI/test39 результаты сверил по evidence основного агента, поскольку его sandbox не разрешил Docker socket. JSON validation и `git diff --check`: PASS; staged diff повторно проверяется перед commit.

Следующий шаг: обеспечить безопасный disk budget или доказать reclaim; отдельно реализовать безопасное authenticated native browser download; после контролируемой временной настройки upload limits и проверки квоты выполнить полностью новый 50 ГиБ Browser E2E checkpoint со streaming hashes, замерами latency/resources и cleanup. Упрощение критериев PASS недопустимо.
