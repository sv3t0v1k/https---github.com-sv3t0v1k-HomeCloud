# SSD→HDD: только этап 2.3 — Recovery + Cleanup, 2026-10-12

База: `70c6887777e8a41b253373de42b846b336add828`, совпала с отчётом 2.1–2.2.
Перед реализацией проверены HEAD/status, `docs/ROADMAP.md`, полный отчёт этапа2 и crash windows.
Tracked status проверяется с исключением запрещённого пути; два прежних untracked сохранены:
`docs/evidence/frontend-functional/closure-checkpoint.json` и `closure-controls.json`.

Implementation/test HEAD: `8612f0d` (полный hash в checks.json).
Коммиты: `a14bebf` — filesystem/fencing; `f13d995` — journal/release guards;
`8612f0d` — потоковое восстановление и fault/restart regression.
Все новые сообщения Git по-русски. Финальный documentation HEAD/status записан
после commit в `/private/tmp/homecloud-stage23-20261012/closure-state.json` и сообщён в чате.

## Реализовано и границы вызова

`SsdFinalizationRecovery.recover(operationId)` и последовательный paginated
`recoverPendingSsdFinalizations` — внутренние явно вызываемые точки восстановления.
Они не подключены к Nest providers, API, startup или scheduler. Обычные uploads/session
admission остаются legacy; SSD ingress/routing не включён. Нет автоматических retry loops.
На каждый pending operation выполняется одна попытка; неоднозначность удерживает barrier.

Новая additive migration `1746825190000` добавляет immutable target dev/inode checkpoint
и `cleanupState`; прежняя migration не изменена. Внутренний finalizer записывает
identity исключительно созданного HDD temporary до payload I/O. Primary PostgreSQL
lookup под короткой transaction проверяет journal, согласованную session и точный File
(id/owner/upload/parent/size/whole checksum/placement, отсутствие soft-delete/folder).
Commit replay возвращает существующий результат и не повторяет File/quota.
`commit-unknown` — неопределённость ответа caller, а не новая durable state: истина в DB
остаётся `published` либо `committed`; после ошибки нет немедленного повтора/компенсации.

Повторно проверяются operator-approved roots/mount source/markers и exact journal
bindings через существующие StorageService/PreparedSsdWorkspace, затем dev/inode,
owned single-link regular file, size и whole SHA-256. Dev/inode не заменяют mount approval.
Новый native nonblocking `flock` удерживается на независимом pinned SSD-root descriptor
до close: живой stale worker, в том числе потерявший DB, не вытесняется. Выход процесса
освобождает lock; leases/timeouts/steal не используются. Все isolated workers используют
тот же fence; native runtime на этой macOS не квалифицирован.

Payload assembly и verification вне DB transactions; manifest/journal читаются страницами128,
чанки последовательно, блоки≤64КиБ, Writable/pipeline обеспечивают backpressure и drain
pending write перед close. Общий process slot и pending DB singleton удерживаются до cleaned.
Размер файла не определяет размер payload buffer. Это структурная bounded-memory гарантия;
измерение общего RSS приложения/DB/legacy traffic на8ГБ host с50+ГБ файлами не выполнялось.

## Crash windows: закрытые и удерживаемые

| Окно | Поведение после новой попытки |
|---|---|
| mkdir до journal | Пустой неизвестный HDD directory сохраняется; его автоматическая очистка не заявляется |
| Reservation/assembling, temporary отсутствует и checkpoint отсутствует | Проверить полный owned SSD manifest; exclusive create, durable identity checkpoint, bounded assembly |
| assembling, owned partial temporary | Проверить все SSD chunks до reset; повторить assembly в том же inode. При missing/corrupt source partial не обнуляется |
| После HDD fsync до verified, complete temporary | Проверить whole size/hash и inode; использовать пригодную HDD-копию без reset. SSD отсутствующие chunks допускаются лишь на committed cleanup; corrupt source удерживает cleanup |
| После exclusive create до identity checkpoint | Unknown/unrecorded temporary сохраняется; fail-closed, нужна отдельная reconciliation. Потеря ответа на успешно записанный checkpoint разрешается DB lookup |
| verified | Проверить owned temporary, whole bytes/durability; записать publishing intent перед rename |
| publishing вокруг rename/fsync | Ровно temporary либо final того же recorded inode; проверить bytes и повторить fsync. Rename response loss обнаруживается по final. Оба/ни одного/другая identity — fail-closed |
| published до metadata transaction или rollback | Проверить durable final; атомарно File/quota/session/journal. Ошибка owner/quota/metadata сохраняет HDD/SSD/barrier |
| COMMIT response loss | Authoritative primary lookup: published→один commit; committed→получить receipt без повторного File/quota |
| committed до caller response/начала cleanup | Повторно проверить DB receipt, exact final whole bytes и fsync; сначала preflight всех известных source chunks |
| Cleanup прерван до/после single unlink/fsync | Удалить только manifest-owned chunks после повторной streaming проверки hash/size/identity; ENOENT повторяем. Unknown имена и directory сохраняются |
| Cleanup durable, ответ/DB release потерян | Повторить безопасную cleanup; short transaction cleaned+delete upload_chunk rows, без повторного quota/File |
| cleaned, затем обычное удаление File/session | Replay no-op по сохранённому receipt; не требует появления удалённого File/session и не трогает FS |

Перед удалением проверяется весь manifest, затем каждый chunk повторно открывается,
проверяется streaming SHA/size/dev/inode и owned/private mode; native `removeOwned`
проверяет descriptor identity непосредственно перед одним `unlinkat` и fsync parent.
Никакого recursive delete/list неизвестных артефактов в recovery нет. HDD target никогда
не удаляется recovery. Полный journal+sealed manifest сохраняются как commit receipt.
После synced cleanup `finishCleanup` атомарно удаляет reserved upload_chunk rows,
снимает pending singleton/lifecycle guards. Completed session остаётся, но штатное
последующее удаление разрешено. До cleaned File UPDATE/DELETE (OLD/NEW bindings),
reserved session cancel/expiry и chunk mutation блокируются DB guards.

Это cooperative isolated fencing. До routing остаётся обязательной проверка полного
API filesystem lifecycle: legacy методы могут выполнить FS side effects до DB rejection.
Резервировать обычную live-сессию через isolated finalizer по-прежнему запрещено.
Trust model не включает злонамеренный same-UID/root; криптографическая аттестация не добавлялась.

## Проверки и честная классификация ошибок

Все проверки в отдельных копиях backend, только temporary fixtures и собственная
PostgreSQL15 UTF8 через Unix socket, без TCP listener. Миграции запускались лишь в
одноразовых test schemas. PostgreSQL остановлена после проверок. ForceExit сохраняет
Jest результат и обходится с существующими timers; никаких live сервисов не запускалось.

1. Final targeted: **9 suites, 186/186 PASS, 0 skipped**, включая **42/42 actual PostgreSQL**
   journal/recovery tests и прежние placement/workspace совместимости.
2. Exact base full: **947 PASS /71FAIL**, 69 suites PASS/6FAIL, 1018 instances.
3. First candidate full: **1025 PASS /72FAIL**, 69 suites PASS/7FAIL. 79 новых tests PASS;
   один дополнительный FAIL у существующего legacy `uploads.service.spec.ts`:
   `should reject when actual size does not match declared totalSize`, finalPath unexpectedly exists.
4. Этот extra FAIL не скрыт. Legacy service+suite bytewise совпадают с base, новых lock/removeOwned
   calls в их mocked workspace нет. Baseline и candidate отдельные suites **85/85PASS**.
   Дополнительная диагностическая копия исходного baseline с delayed fs.open50ms и проверкой
   после100ms воспроизводит **1FAIL**: позднее asynchronous createWriteStream open создаёт
   file после error cleanup. Диагностический test не добавлен в repository и не входит
   в final counts. Это существующая timing race legacy, не исправленная вне scope2.3.
5. Final candidate full (один обоснованный повтор неизменённого candidate): **1026 PASS /71FAIL**,
   70 suites PASS/6FAIL. Статусы всех1018 исходных instances совпали с base;79новых PASS,
   новых failures0. Первые72FAIL и diagnostic reproduction отдельно сохранены в checks/raw.
6. Затем full lint: **0 errors /15 прежних warnings**; TypeScript noEmit и Nest build **PASS**.
7. Independent review: два correctness MUST_FIX и FD leak исправлены и повторно проверены;
   unresolved MUST_FIX для isolated2.3 нет. Reviewer независимо выполнил portable
   recovery/filesystem **83/83PASS**;actual PG42/42 выполнены автором и основным исполнителем.

71baselineFAIL: uploads.service.postgres32;upload-rate-limit13;
upload-rate-limit.postgres1;upload-workspace11;ingress-file-cleanup4;secure-filesystem10.
Общая причина baseline — отсутствие Linux native filesystem на macOS и производные
admission/HTTP ошибки, совпадающие с base. Красный полный набор остаётся риском.
Первый ошибочный SQL_ASCII setup тестовой DB дал ещё один Unicode migration FAIL;
после пересоздания одноразовой DB сUTF8 baseline947/71 подтверждён. Этот диагностический
setup-run не используется как acceptance baseline.

Coverage: saved states/restart fresh runner+store, every transition/rename/commit fault,
commit/checkpoint/cleanup response loss, mount/mapping/marker outage, corruption/missing
copies, immutable checkpoint, partial-copy preservation, unknown artifacts, preflight,
repeated cleanup, quota/idempotence, active barrier/release, cancel/expiry/File guards,
migration up/down/populated legacy, slow/partial writes and bounded64KiB buffers.
Native source-shape checks не равны Linux runtime tests. Restart означает новый runner/store
по persisted DB/filesystem fixtures; реальный OS reboot/SIGKILL/power-loss не квалифицирован.
[Машиночитаемые результаты](checks.json), [независимый review](review.md).
Raw JSON/logs/source snapshots: `/private/tmp/homecloud-stage23-20261012/`.

## Оставшиеся условия до SSD activation

- Historical stage2 operations без target inode checkpoint не auto-adopt: fail-closed.
  Несколько retained committed operations блокируют новый pending singleton при migration;
  нужна отдельно согласованная operator reconciliation, без угадывания identity.
- Unknown/unrecorded artifacts, mount mismatch/outage, missing/corrupt target/source и
  противоречивая metadata удерживают data/barriers; ручное разрешение не выполнялось.
- Нужны SSD session admission/routing, durable expected whole-hash contract и сквозное
  complete/cancel/expiry/cleanup fencing API, capacity/quota admission, MIME/preview integration,
  writer fence при deployment/native rebuild и rollback/reconciliation runbook.
- В отдельно разрешённой среде нужны Linux native kernel checks, настоящие SSD/HDD/EXDEV,
  reboot/power loss/mount outages,50+ГБ transfer и общий RSS/cgroup budget на8ГБ host.
- 71 существующих full FAIL и дополнительно подтверждённая legacy async-open cleanup race
  требуют отдельного решения; их наличие не объявляется зелёным production baseline.

Live Docker/VM/сервер, физические диски, пользовательские данные и persistent volumes
не затрагивались. Файлы sources локального ChatGPT mirror не изменялись.
`scripts/tests/PHASE-5.3.1-TEST-AUDIT.md` не читался, не искался, не хешировался и не изменялся;
Git commit --only ограничен явными собственными paths, forbidden staging не включался.
**COMPLETE не установлен; SSD activation/production NO_GO сохраняется.**
**Работа остановлена после2.3. Следующий этап не начат; требуется согласование владельца.**
