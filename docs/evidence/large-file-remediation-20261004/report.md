# Исправление архитектуры передачи больших файлов — 4 октября 2026

`LARGE_FILE_REMEDIATION_STATUS = PASS`

`50_GIB_QUALIFICATION_STATUS = BLOCKED / UNQUALIFIED`

Исходный HEAD `e30ac482144d0c9f210a43a245f1a089d5cd4446`, main ahead/behind 4/0. Документированный BLOCKED checkpoint сохранён. Полный файл 53 687 091 200 байт не создавался и не передавался. Это remediation перед отдельной квалификацией, без новой numbered Phase.

## Аудит и исправление upload

До изменения браузер уже передавал File.slice последовательно с ограниченной памятью. Backend после каждого чанка обходил весь диапазон totalChunks, проверял накопленные файлы и переписывал растущий JSONB. При N=5120 полный диапазон означал минимум 26 214 400 файловых probes за загрузку: статическая квадратичная работа, а не измерение времени реального 50 ГиБ transfer. Ошибка complete также могла удалить чанки при откате DB.

Теперь durable metadata имеет unique identity `(sessionId, chunkIndex)`, размер и SHA-256. Session lock и транзакционные uploadedSize/uploadedCount обеспечивают idempotency. Проверяется только целевой chunk; файл и каталог fsync выполняются перед DB commit. Retry с совпадающими байтами восстанавливает отсутствующий файл без повторного учёта; конфликтующие bytes отклоняются. Старая JSONB сохранена миграцией, скрыта от обычных SELECT и больше не переписывается. Старые pending sessions гидратируются один раз под lock.

Число запросов/файловых проверок на новый chunk постоянно; DB index lookup технически O(log N). Память upload O(chunk size), трафик ответа не растёт с числом чанков. Synthetic 5120 independently PASS: 5120 target probes и indexed metadata операций, ≤3 probes на запрос. Уже первый запрос старого кода требовал минимум 5120 и проваливал бы этот критерий.

Finalization делает один O(N) проход чанков с проверкой размера/hash и streaming assembly, не whole-file readFile. MIME classifier может потребовать дополнительный линейный streaming pass текстовых bytes. Итоговый byte count точный; file/quota/completion публикуются атомарно после fsync. Ошибка удаляет только неопубликованную сборку под lock, сохраняя retryable chunks. Cancel/stale recheck выполняются под lock, startup очищает terminal disk debris.

Ограничения: сборка удерживает DB transaction/session lock, делает O(N) DB round trips. Серверный диск достигает примерно 2S плюс concurrent ingress; source/download и Docker VM backing нужно бюджетировать отдельно. Default session TTL абсолютный 24 часа, cleanup использует синхронный rmSync. Эти ограничения требуют наблюдения в будущем 50 ГиБ прогоне.

## Лимиты и точность

Default policy: MAX_FILE_SIZE=1099511627776 (1 ТиБ), MAX_TOTAL_SIZE=2199023255552 (2 ТиБ активных session reserves пользователя), MAX_UPLOAD_CHUNKS=100000. Это настраиваемые operator limits, не hard maximum50 ГиБ. Explicit0 убирает отдельный file/aggregate cap, но не quota; storageQuota0 означает нулевую ёмкость. Quota учитывает used+active reservations+incoming, aggregate только активные uploads. Backend authoritative; `/uploads/limits` возвращает effective limit для UI.

53 687 091 200 представляется точно safe integer/BIGINT transformer и даёт 5120 чанков по 10 МиБ. Client адаптирует chunk к maxChunks в пределах maxChunkBytes. MAX_CHUNK_SIZE ограничен DB signed integer capacity; nginx51m соответствует default50 МиБ, при изменении chunk policy нужно согласовать proxy body limit.

## Native download и security

Прежние owner Axios Blob/objectURL и public Uint8Array→Blob требовали O(S) JS memory; owner дополнительно блокировал >100 МиБ. Теперь только малый JSON prepare проходит через JS. Bearer POST prepare проверяет owner/resource и выдаёт 256-bit opaque capability в HttpOnly/SameSiteStrict/host-only cookie с exact resource path, Secure в production. DB хранит лишь SHA-256; TTL 120 секунд ограничивает начало запроса. Atomic DELETE RETURNING делает GET одноразовым; HEAD не расходует capability. Авторизация ресурса повторяется, включая active owner/deleted/folder checks. Scoped issuance bounded:8 на пользователя,10000 globally.

Native GET → confined storage stream → HTTP → browser download manager → disk. JWT/password/capability отсутствуют в URL. Реальный path/root/O_NOFOLLOW, Content-Length, безопасный Content-Disposition, single Range206/416 и disconnect cleanup сохранены. Range допустим на первом GET; interrupted resume требует fresh prepare. Frontend/API должны иметь один origin; production требует доверенный HTTPS. UI сообщает передачу браузеру, не притворяется, что JS знает окончание native save.

Public downloads используют native form POST; password находится в body. Существующие public admission/subtree/expiry checks сохранены. ZIP content streaming сохранён, активен максимум один member fd, disconnect abort освобождает stream; Accept-Ranges=none. ZIP central directory остаётся O(member metadata).

На двух proxy отключены response buffering/temp files только для streaming download и upload complete. Read idle timeout3600s допускает тихую сборку, send/client idle300s ограничивают зависшие клиенты; это не общий deadline. Request body caps/authorization сохраняются. Proxy log только status/bytes/duration, backend route templates без secret payload.

## Умеренный real-browser proof

Использован существующий `homecloud-preview`, URL `http://localhost:8080/files`. Browser: Codex IAB Chromium (точная Chromium version через этот интерфейс не раскрыта), Safari27.0. Production Secure cookie policy сохранена и реально работала на localhost в обоих браузерах. Existing HTTPS certificate untrusted; bypass не выполнялся. Public trusted HTTPS остаётся эксплуатационным условием.

Fixture allocated deterministic ASCII:134217728 bytes (128 МиБ), physical allocation134217728, generator/hash buffer≤1 МиБ. Исходный SHA-256:

`19f026c0276c3e95d8cb0f4cb050710991d6a79a24c153fc6b3a50b9d54a80f4`

Оба браузера выбрали источник настоящим file picker и запустили обычный upload UI. Созданы только files11/12 пользователя 3; каждый completed13/13, metadata и actual storage size134217728, stored SHA совпал. Квота 100 ГиБ существовала до теста и не менялась. UI128 МБ/effective quota отображались корректно; progress15% наблюдался, completion лишь после complete200. IAB console warnings/errors0; Safari console инструментально не снималась, UI ошибок не показал.

Оба native downloads инициированы меню «Скачать», без API-transfer substitution. По backend request completion IAB download3.774475s (~33.91 МиБ/s), Safari0.580481s (~220.51 МиБ/s); frontend proxy full-response 3.813/0.613s, bytes134217728/status 200. IAB saved event3.956s. Browser observation upper bounds upload8.706s/IAB и 30.944s/Safari включают паузы инструментального наблюдения и не выдаются за точную скорость transfer. Сопоставление UI click timestamp и backend complete timestamp даёт 1.915s/IAB и 1.917s/Safari (~66.84/66.77 МиБ/s); это длительность до server completion. Exact start/end и route timings в evidence.json. Safari сохранил по тому же disposable Downloads пути; IAB copy была хеширована до его повторного использования, Safari copy после. Все четыре server/browser hashes совпали с source.

Backend chunk latency (ms): IAB early102.979/89.883/93.306, middle91.735/84.415/97.111, late full98.401/91.566/94.143, last8 МиБ 72.906. Safari early98.429/91.061/97.347, middle87.627/89.661/88.650, late87.168/84.039/89.423, last8 МиБ 68.621. Late/early means0.993 и 0.909: систематического роста в этих 13 chunk сериях нет. Нельзя экстраполировать измеренные timings на 50 ГиБ без следующего полного прогона.

Lightweight180 samples: backend memory46.92→64.53 МиБ, sampled peak 81.9 МиБ, sampled CPU peak56.97%; PostgreSQL sampled peak36.51 МиБ/1.94%. Backend RSS после теста~110 МиБ, HWM149596KiB (~146.09 МиБ), OOM=false/restarts0/healthy. Browser heap/RSS и краткие resource spikes не измерены; bounded transport подтверждён кодом и tests, не invented memory figures. В transfer HTTP нет 5xx/abort/retry. Один diagnostic cleanup request через системный forward proxy вернул 502; прямой loopback cleanup затем успешен, этот запрос не участвовал в E2E transfer.

## Cleanup, gates, reviews

Files11/12 перемещены в Trash через фактический UI; isDeleted=true проверено. Затем supported DELETE /files/:id/permanent удалил только эти ID (не empty-trash). storageUsed вернулся 37021, quota unchanged107374182400. Chunk rows0/temp files0, .tmp8KiB — только каталоги. Completed upload session records остаются по текущей history semantics; active reservation отсутствует. Source и saved copy удалены после hash verification. Новый stack не создан, DB volume сохранён, unrelated containers не затронуты. Две additive migrations и новая runtime сборка остаются на существующем preview как итог исправления.

Full backend 61 suites/757 PASS/0 skipped; реальные PostgreSQL integration paths выполнены через временный loopback transport к существующей DB с отдельными schemas и cleanup. Последний native PG rerun9PASS после добавления explicit assertions. Full frontend 18 suites/176PASS. Backend/frontend lint/typecheck/production build, bench compile, diff-checkPASS; только 15 прежних backend lint warnings. Focused upload/native/public/ZIP/scalability suitesPASS. Docker Hub build первоначально не получил base metadata из-за TLS network timeout; runtime image собран из существующего local image+проверенный dist, новый dependency tree не требовался.

Independent performance/storage review APPROVE и security review APPROVE, CRITICAL/HIGH0. Synthetic5120 reviewer выполнил независимо. Reviews не подменяют full50 ГиБ proof.

Следующий отдельный шаг после решения владельца: обеспечить достаточный host/VM disk budget, повторить preflight и полный 50 ГиБ browser upload+download с нуля, hashes, ресурсными/latency samples и cleanup. Настоящий 50 ГиБ test пока запрещён текущим scope.
