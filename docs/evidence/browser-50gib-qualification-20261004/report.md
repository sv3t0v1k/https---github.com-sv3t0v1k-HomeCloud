# FULL 50 GiB Browser E2E Qualification — preflight 4 октября 2026

**50_GIB_BROWSER_E2E_STATUS = BLOCKED**

Владелец сообщил 190 ГБ свободного места. Владелец уточнил: это Finder / настройки macOS. Системные измерения фактически свободных байтов показывают меньший объём. Показатель available может включать очищаемые кэши: [официальное руководство Apple](https://support.apple.com/guide/mac-help/find-and-delete-files-on-your-mac-syspf5a64aa6/mac). Это возможное объяснение расхождения, точный состав разницы не измерен. Очищаемые/потенциально освобождаемые байты к free не добавлялись.

| Поле | Результат |
|---|---|
| `INITIAL_STATE` | HEAD 7052f62c46868ca6353380b3054ddfbd381fb54a; main ahead/behind 7/0. Исходные commits сохранены. |
| `STACK_IDENTITY` | Существующий homecloud-preview; backend 2e96f568af14, frontend 45daae40e2da, PostgreSQL dc54838e53d4, ingress e07d40f4e248. Backend/frontend/DB healthy, ingress running; backend ready 200, OOM=false, restarts 0. Нового stack нет, unrelated containers не затронуты. |
| `DISK_PREFLIGHT` | BLOCKED. Снимок host statvfs 180,251,762,688 байт=167.872535706 ГиБ; требуется 182536110080 байт=170 ГиБ; дефицит 2,284,347,392 байт=2.127464294 ГиБ. APFS /dev/disk3s5; repo/source temporary directory/Downloads на одном диске. Timestamp 2026-10-04T08:53:49Z. |
| `FIXTURE` | НЕ СОЗДАН. Целевой логический размер 53687091200 байт; apparent/physical size, sparse semantics, source hash не измерялись. |
| `BROWSER` | До выбора qualification browser не дошли: обязательный disk gate остановил preflight. Предыдущий 128 МиБ IAB/Safari proof не используется как 50 ГиБ evidence. |
| `UPLOAD_CONFIGURATION` | Runtime maxFile 1099511627776, maxActive 2199023255552, maxChunks 100000, chunk 10485760, maxChunk 52428800 байт. Frontend выбирает 10 МиБ: ожидается 5120 чанков. Test user 3 quota 107374182400, used 37021, active reserved 0, effective available 107374145379 байт; quota не менялась. |
| `UPLOAD_UI_RESULT` | НЕ НАЧАТ |
| `UPLOAD_ELAPSED` | N/A |
| `UPLOAD_THROUGHPUT` | N/A |
| `UPLOAD_RESOURCE_PROFILE` | Только baseline: backend Docker memory 51.69 МиБ/CPU 0%; RSS 106132 КиБ; HWM 149596 КиБ исторический, не 50 ГиБ peak. PostgreSQL33.38 МиБ/CPU 0%. Host RAM 25769803776 байт. Storage 76 КиБ, temp 8 КиБ. |
| `CHUNK_LATENCY_EARLY` | НЕ ИЗМЕРЯЛАСЬ |
| `CHUNK_LATENCY_MIDDLE` | НЕ ИЗМЕРЯЛАСЬ |
| `CHUNK_LATENCY_LATE` | НЕ ИЗМЕРЯЛАСЬ |
| `LATE_EARLY_RATIO` | N/A |
| `SCALING_RESULT` | 50 ГиБ runtime scaling не проверен; remediation synthetic test не подменяет его. |
| `SERVER_METADATA_SIZE` | N/A — qualification object отсутствует |
| `STORED_SIZE` | N/A |
| `SOURCE_HASH` | N/A |
| `STORED_HASH` | N/A |
| `UPLOAD_INTEGRITY` | НЕ ПРОВЕРЕНА |
| `DOWNLOAD_UI_RESULT` | НЕ НАЧАТ |
| `DOWNLOAD_ELAPSED` | N/A |
| `DOWNLOAD_THROUGHPUT` | N/A |
| `DOWNLOAD_RESOURCE_PROFILE` | N/A — transfer не начат |
| `BROWSER_MEMORY_EVIDENCE` | НЕ ПОЛУЧЕНА для 50 ГиБ; прежний gap остаётся |
| `DOWNLOADED_SIZE` | N/A |
| `DOWNLOADED_HASH` | N/A |
| `FINAL_INTEGRITY` | НЕ ПРОВЕРЕНА |
| `UI_CONSOLE_NETWORK` | Qualification UI/console/network observations не выполнялись; никакой API/curl transfer substitution. |
| `TEMP_SESSION_STATE` | Qualification session не создана. User3 active reserves0; прежние completed history records сохранены, baseline count7. Temp8 КиБ. |
| `CLEANUP` | Qualification test data не создавались; удаление не требовалось и не выполнялось. Quota/config/user data не изменены. |
| `DISK_AFTER_CLEANUP` | Cleanup отсутствует; свободный объём в сохранённом снимке 180251762688 байт. |
| `BACKEND_TESTS` | НЕ ЗАПУСКАЛИСЬ в этом checkpoint: transfer не начат, product code не менялся. |
| `POSTGRES_INTEGRATION` | НЕ ЗАПУСКАЛИСЬ; preflight использовал только SELECT, без тестовых mutations. |
| `FRONTEND_TESTS` | НЕ ЗАПУСКАЛИСЬ по той же причине. |
| `LINT_TYPECHECK_BUILD` | НЕ ЗАПУСКАЛИСЬ; только documentation diff-check. |
| `INDEPENDENT_REVIEW` | Независимый read-only review подтвердил обязательный disk gate BLOCKED. Это не review успешной передачи. |
| `DOCS_EVIDENCE` | Этот report и preflight.json; никаких fixtures/giant logs/secrets. |
| `COMMIT` | Один docs-only commit BLOCKED результата; hash сообщён в финальном ответе. |
| `FINAL_HEAD` | Сообщён в финальном ответе после commit. |
| `GIT_STATUS` | Ожидаются только три исходных untracked; hashes двух JSON сохранены. Forbidden audit не читался/изменялся/staged. Push/tag не выполняются. |
| `50_GIB_BROWSER_E2E_STATUS` | BLOCKED |
| `REMAINING_GAPS` | Disk gate и все stages полного 50 ГиБ browser E2E: fixture/transfer/integrity/resource/scaling/cleanup. |
| `NEXT_STEP` | Довести фактический свободный объём до ≥170 ГиБ с дополнительным запасом для overhead; повторить preflight. До этого fixture/transfer запрещены. Docker Consolidation не начинать. |

## Расчёт до передачи

Планируемая sparse source ещё не создана и не проверена. Conservative host budget: chunks 50 ГиБ + assembly 50 ГиБ + downloaded copy 50 ГиБ =150 ГиБ payload, учитывая отсутствие гарантии немедленного Docker VM reclaim, плюс 20 ГиБ reserve. Source extents, ingress (обычно 10 МиБ), filesystem metadata и прочие temp должны оставаться в отдельно проверенном запасе. При allocated source добавится ещё 50 ГиБ:≥220 ГиБ с тем же reserve. Даже при прохождении 170 ГиБ gate footprint нужно пересчитать по фактическому fixture/размещению.

Внутри Docker VM свободно 417132312 КиБ (~397.81 ГиБ), но VM backing расположен на host; эта цифра не отменяет host gate. Initial statvfs показывал 180224000000 байт (167.84668 ГиБ); повторный APFS/container measurement 180256247808 байт, host statvfs 180256223232 байт; последний timestamped host measurement приведён в таблице. Изменения нескольких мегабайт между наблюдениями не пересекают порог.

Данные предыдущего remediation PASS остаются историей отдельного checkpoint и не используются как доказательство 50 ГиБ qualification. Полный 50 ГиБ прогон не выполнялся.

Финальная проверка09:05:33UTC (19:05:33Asia/Vladivostok),4октября2026: free=f_bavail180240629760байт, порог182536110080байт, дефицит2295480320байт. Disk gate по-прежнемуBLOCKED.

## Продолжение: APFS и реальная попытка

Новая системная проверка Foundation important capacity показала178,38 GiB: disk gate PASS с сохранённым порогом170 GiB. Реальный Safari upload затем завершился429 после98/5120chunks: **50_GIB_BROWSER_E2E_STATUS = FAIL**. Исторический disk-only BLOCKED выше сохранён. Полные доказательства и cleanup: [full-attempt/report.md](full-attempt/report.md).
