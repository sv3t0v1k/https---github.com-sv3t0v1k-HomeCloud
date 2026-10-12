# SSD→HDD: ограниченная API Integration и legacy cleanup race — 2026-10-12

База точно совпала с `dcd6986bdd8a519243d5edbf4d5b9e4fa9cbf66d`. Проверены единственный `docs/ROADMAP.md`, полный отчёт 2.3 и фактические session/ingress/journal/storage/preview/download interfaces. Implementation HEAD: `71cdc886f33952226ca79d003ca1bb78820ac1ba`; последующий documentation commit указан в итоговом сообщении.

**Реализация и ограниченный Docker API gate подтверждены. SSD OFF по умолчанию; COMPLETE не установлен. Mini-PC/production activation не выполнялись.**

## Реально подключённые маршруты

Все ниже под `/api/v1`, с прежним JWT и обычным HTTP сценарием.

| Маршрут | Фактическое поведение |
|---|---|
| GET `/uploads/limits` | При ON сообщает `storageMode=ssd`, `wholeSha256Required=true`; прежние quota/size/chunk limits сохраняются |
| POST `/uploads/session` | OFF — legacy; ON — только SSD с обязательным lowercase64 whole `expectedSha256`, immutable durable session/root binding; admission quota/capacity |
| POST `/uploads/session/:uploadId/chunk` | Immutable workspace выбирает legacy либо SSD до Multer; ingress и chunks на том же SSD; bounded hash, descriptor rename/fsync, short manifest/accounting transaction |
| POST `/uploads/session/:uploadId/complete` | Старые sessions — legacy; SSD — finalizer либо одна authoritative recovery attempt. Whole SHA из session; File/quota один раз; verified inode → HDD publication → metadata commit → owned cleanup |
| DELETE `/uploads/session/:uploadId` | Отдельный SSD fence до любых side effects; pending journal →503; completed → отказ; только verified manifest chunks удаляются; неизвестные bytes/директории сохраняются |
| GET `/uploads/session/:uploadId` | SSD manifest/reconciliation; completed результат читается из DB без SSD; owner проверяется до receipt |
| GET `/uploads/sessions` | При ON совместный список immutable workspace; OFF скрывает parked SSD sessions и сохраняет legacy список |
| GET `/files/:id/download`, Range и previews | Прежний permanent placement resolver; новые File на HDD, checksum+MIME из verified target и durable journal. Text/PNG/thumbnail и exact200/206 проверены |

Nest DI регистрирует production SSD store в явном режиме `ssd`, сервис и factories свежего filesystem capability/finalizer/recovery. `isolated` store mode используется прежними отдельными fixtures; он не является runtime routing. Новые и legacy sessions не смешиваются и не конвертируются.

`UPLOAD_SSD_ENABLED` отсутствует или false → OFF. `UPLOAD_SSD_RECOVERY_MODE=manual` по умолчанию; явно заданный `once` при ON выполняет один startup pass максимум128 pending operations, по одной попытке; без retry loops. OFF не запускает SSD recovery или acquisition. Legacy hourly expiry вызывает SSD expiry только при ON; candidate expiry ограничен128 rows за вызов.

## Durable contract, fencing и сохранность

Новая additive migration520 сохраняет legacy NULL hashes. New SSD hash обязателен; hash/path/workspace/uploadId immutable. Checksummed layout нельзя менять. SSD root берётся только из явного операторского mapping, записанного при migration; API не enroll/upsert roots. Неверный legacy root rollback до изменения guard; old migrations не переписывались. Down запрещён при hashes или retained MIME checkpoints.

Короткие DB phases сериализуют quota/admission/manifest/commit и используют durable PostgreSQL settings. SSD payload hashing/copy/fsync вне DB transactions; потоковые блоки64КиБ, без whole-file buffering. Kernel nonblocking root flock разделяют multipart, chunk, admission, cancel, expiry и finalizer/recovery. При teardown pending writer/handler удерживает fence до фактического close/finally. Busy возвращается503 без retry. Это глобальная сериализация SSD writers: медленный ingress блокирует остальные SSD mutators; throughput не квалифицирован.

Quota reservations учитывают active sessions под owner lock. SSD capacity учитывает оставшиеся SSD bytes + chunk headroom; HDD — active declared totals + headroom, с повторной проверкой перед finalization. Это cooperative backpressure, не физическая резервация диска против внешних writers, Files copy или старого backend. Capacity outage сохраняет bytes/barriers; фактическое заполнение диска не испытано.

MIME определяется через readonly pinned target FD вне transaction. MIME checkpoint immutable/write-once перед publishing; recovery уже записанный MIME не вычисляет повторно. Detector failures дают binary fallback; valid bytes не отвергаются по типу. Предпросмотр подтверждён для text и PNG.

Legacy pending historical journals удерживаются fail-closed, включая flag OFF: guards до chunk/complete/cancel/expiry FS и до Multer, orphan cleanup сохраняет referenced terminal sessions. Runtime store не присваивает им SSD identity/hash автоматически. Unknown artifacts, create→identity checkpoint window, ambiguous/missing/corrupt copies и mount mismatch по-прежнему требуют operator inspection. Cancel/expiry сохраняют terminal rows/directories и удаляют только проверенные known chunks; unknown/modified payload не удаляется рекурсивно.

Отдельный commit `baaf67b` исправляет legacy async `createWriteStream` open-after-error race: cleanup ждёт actual close, прежде чем удалить destination и освободить session lock. Детерминированный delayed-open test падает на exact baseline, проходит после fix; retry chunks и quota сохраняются.

## Фактические доказательства Docker

Новый непривилегированный native ARM64 контейнер, собственная PostgreSQL16/tmpfs/random schemas и сеть; новый ext4 volume SSD (`st_dev=65025`, exact `/dev/vda1` source/root/marker), HDD overlay контейнера (`st_dev=74`). Без privileged mounts, host filesystem/mount mutations, existing preview volumes или пользовательских данных. API harness воспроизводит compiled Nest main middleware, JWT, validation, filters, interceptors и Multer; флаг ON только в этом disposable процессе. Executed harness байтово совпал с доставляемым `backend/test/ssd-upload-api.cjs`.

**15/15 checkpoints PASS**: OFF legacy partial → ON legacy complete/download; missing/invalid whole hash400; SSD multipart/duplicate/text MIME/preview/complete/repeated complete/quota/download/Range; PNG MIME/preview/thumbnail; cancel повторно и expiry owned cleanup с сохранением unknown; отдельные SSD и HDD pressure503 (обе ветки исполнены, новых sessions0); commit response loss500 → repeat200 с одним File/quota; startup assembling recovery до API replay → committed+cleaned; реальный HTTP disconnect, cancel503 до/после close пока digest paused → cancel200 после handler settled без File/quota; wrong whole hash сохраняет SSD и partial HDD, pending barrier.

Файлы маленькие. Restart — новый Nest app/providers в том же Node process, не process kill/OS reboot. Capacity — bounded statfs fault injection, не заполнение диска. [Actual JSON](api-e2e.json); raw API log и полный source snapshots в каталоге raw evidence из checks.json. Owned mismatch fixtures после evidence уничтожаются при удалении только созданных test containers/volume/DB; автоматическое разрешение неизвестной live операции не выполнялось.

## Проверки и baseline

1. Stage23 Mac full baseline:1026PASS/71FAIL из отчёта; здесь Mac full не повторялся. Эти71 platform failures не объявляются исправленными на macOS.
2. Fresh exact HEAD native Linux baseline: **1097/1097PASS**,76 suites,0 skipped.
3. Final native candidate: **1148/1148PASS**,79 suites,0 skipped. Все1097 исходных instances сохранили PASS,51 новых PASS. Ключ сравнения учитывает повторяющиеся parameterized names. [Comparison](baseline-comparison.json).
4. Final targeted fixes: service24, PG13, recovery49 →86/86; final legacy87+benchmark17 →104/104. Предшествующий focused gate11 suites291/291 сохранён; прогоны пересекаются, не суммируются.
5. Full lint0errors/15 прежних warnings; TypeScript noEmit и Nest build PASS.
6. Independent review ACCEPT, unresolved MUST_FIX0. [Review](review.md), [Checks](checks.json).

Сохранены неуспешные прогоны: первый amd64 эмулируемый/root baseline997PASS/100FAIL (ENOSYS openat2, profile UID failures, two timeouts), не acceptance baseline; первый candidate full1130 PASS assertions/0 failed assertions, но1 compile-failed suite из-за отсутствующего nullable field в benchmark fixture. Fixture исправлена, targeted17PASS, затем final full1148PASS. Initial API fixture quota0 дала403; в новой owned schema задана явная test quota и API прошёл. Ошибки не скрыты и не классифицированы как application regressions без сравнения.

## Граница остановки и следующий отдельно согласуемый шаг

- Постоянная конфигурация и preview stack не менялись; flag OFF. Миграции не запускались на existing DB. Мини-ПК не использовался; deployment не выполнялся.
- Перед activation нужен клиент, вычисляющий expected whole SHA256 до admission без полного буфера. Текущий frontend uploader этим этапом не изменён/не квалифицирован; существующий клиент при ON может получить400.
- Нужны target Linux/mini-PC writer fencing и native rebuild/release/migration/rollback preflight; остановка старых writers обязательна. Schema520 фиксирует операторский SSD root только при её выполнении: migration без UPLOAD_SSD_PATH оставляет DB guard legacy-only; последующее включение одного flag не enroll SSD.
- Исторические pending journals и unknown artifacts — отдельная operator reconciliation без угадывания identity. Global writer serialization, busy503 и квоты/headroom требуют operational budget.
- Реальные SSD/HDD, EXDEV на целевых дисках, mount outage/remount, SIGKILL/reboot/power loss,50+ГиБ и общий RSS/cgroup на8ГБ mini-PC остаются UNQUALIFIED и требуют отдельного согласования.
- Tracked проверка исключает запрещённый файл; он не читался, не искался, не хешировался и не менялся. Два прежних untracked `closure-checkpoint.json`/`closure-controls.json` сохранены. Synced sources не изменялись.

**COMPLETE не установлен. Остановиться после этого ограниченного checkpoint; ждать согласования следующего шага.**
