# SSD→HDD: изолированный finalizer, этапы 2.1–2.2, 2026-10-12

Исходный HEAD проверен: `84c6974bf8dfae1884de557f4b73b6cc99b49a14`.
До реализации прочитаны отчёт этапа 1 и актуальный ROADMAP; дерево tracked было чистым.
Сохранены два прежних untracked: `docs/evidence/frontend-functional/closure-checkpoint.json`
и `docs/evidence/frontend-functional/closure-controls.json`.

Implementation/test checkpoint: `daf4c94cfbe5a2d3d938c517f04b26c3f3086437`:
- `56a7e9e` — durable journal и PostgreSQL store;
- `ecc6b85` — потоковая сборка и HDD filesystem capability;
- `daf4c94` — isolated tests.

Документирующий commit следует после этого checkpoint. Его фактический финальный
HEAD/status зафиксирован отдельно в [closure-state.json](/private/tmp/homecloud-stage2-20261012/closure-state.json),
чтобы отчёт не требовал самоссылочного Git hash. Итог также сообщён в чате.

## Реализовано

Добавлены только пять production-файлов и три suite; прежний runtime код, API,
providers/controllers, routing, startup recovery и schedulers не изменены.
Миграция `1746825180000` additive: две journal tables, ограничения и guards только
reserved operations. Старые placement/workspace guards и legacy rows не переписаны.

`SsdCrossFsFinalizer` — явно вызываемый внутренний компонент, отсутствует в Nest
providers. Он принимает userId/uploadId и обязательный ожидаемый whole SHA-256.
Ни ordinary session admission, ни SSD ingress этим методом не включаются.

Последовательность:
1. Проверка approved SSD Workspace, отличающегося device от permanent legacy root
   (целевой HDD по operator contract). FD pins корней, SSD session/HDD user каталогов;
   exact bigint inode/device, service UID, запрет group/world write.
2. Короткое резервирование journal: lock owned complete legacy manifest, проверка
   count/layout/counters/expiry/owner/parent, SQL snapshot chunks INSERT SELECT.
   Snapshot immutable и sealed после reservation transaction; чтение страницами 128.
3. Exclusive temporary `<userId>/.<operationId>.assembling` на HDD, mode 0600.
   Части SSD читаются последовательно блоками ≤64 KiB, generic Writable и pipeline
   обеспечивают backpressure; короткие записи выполняются до конца. Один process
   slot; уникальный active journal также ограничивает все процессы/повторный запуск.
4. Проверка каждой части по manifest, реального размера и chunk SHA-256; одновременно
   проверяется whole SHA-256. На HDD используется тот же exclusive FD до size check
   и fsync, затем FD закрывается. Целый файл не буферизуется в RAM или на SSD.
5. Journal `assembling → verified → publishing`; existing Linux SecureFilesystem
   выполняет `RENAME_NOREPLACE` внутри HDD, fsync parent directory. Имя final:
   `<userId>/<operationId>.ssd-finalized`, отдельно от legacy deterministic assembly.
   Повторная проверка bindings, journal `published`.
6. Короткая PostgreSQL transaction: locks operation/session/user/parent, повторная
   проверка ownership/quota/session snapshot, File insert с legacy placement и whole
   checksum, quota increment, completed session и committed journal. Deferred
   consistency constraint исключает committed без соответствующих File/session.
   Все journal transactions принудительно synchronous_commit=on; fsync=off запрещён.

Payload I/O отсутствует внутри транзакций. Reservation имеет O(chunks) SQL-стоимость;
final commit — фиксированный набор metadata queries. Старый uploadedChunks JSONB
не загружается в Node; PostgreSQL всё ещё сравнивает его при terminal update.

## Изоляция и совместимость

Stage 1 session guard остаётся legacy-only. Новый компонент пока использует
legacy session metadata и отдельный approved SSD source с тем же uploadId для
явных fenced isolated fixtures. Обычные API-сессии остаются полностью legacy.
Это подготовленный внутренний механизм, ещё не production SSD workflow.

DB guards замораживают reserved session/chunks и конкурирующие File writes;
unreserved legacy uploads не используют journal. OLD/NEW session блокируются
детерминированно при перемещении chunk. Штатные legacy методы могут выполнить
свои FS side effects до ошибки DB guard: резервировать обычную live-сессию через
этот unwired компонент нельзя. Перед routing integration нужна сквозная fencing
проверка complete/abort/expiry/cleanup и согласованная SSD session admission.

На успехе и ошибке SSD bytes и manifest/chunks остаются. Ничего не удаляется и
не компенсируется автоматически; reserved sessions/chunks удерживаются журналом,
включая committed. Политика освобождения — будущий recovery/cleanup этап.
Миграция down разрешена только пустому журналу; непустой rollback fail-closed.

## Проверки

- Final targeted: **8 suites / 107 tests PASS**, без skipped, включая 25 actual
  PostgreSQL tests и прежние identity/placement/workspace compatibility suites.
- Full candidate: **69 suites PASS / 6 FAIL; 947 tests PASS / 71 FAIL**.
- Exact исходный HEAD: **66 suites PASS / 6 FAIL; 879 tests PASS / 71 FAIL**.
- Все **950 исходных test instances** сравнены, включая повторяющиеся имена:
  статусы совпадают. 68 новых tests PASS; новых падений в выполненном наборе нет.
- Lint: **0 errors / 15 прежних warnings**; TypeScript noEmit и build PASS.
- Independent scoped review: unresolved MUST_FIX отсутствуют после исправлений;
  [review и границы](review.md). Diff whitespace и соответствие копии тестированным
  файлам проверены перед финальной фиксацией.

Focused coverage: manifest gap/extra/layout/hash/size/counters/expiry, corruption,
slow writes, partial writes, 700 chunks/listeners, one process slot, source/root/user
substitution/symlinks/permissions, exclusive temp/no-overwrite destination retention,
fsync/state/publication/commit faults, DB quota/owner/parent rollback и injected error
после File insert, durable singleton, immutable/sealed journal, populated legacy
migration up/down и прежние guard function bodies, WAL override caller off.
60 GiB fixture проверяет только metadata manifest/pagination — не 60 GiB byte transfer.
Slow-write payload fixture около32 MiB проверяет serial writes с block ≤64 KiB;
это не RSS-квалификация всего процесса/хоста на50+ GiB.

Тесты выполнялись в отдельных копиях backend, на собственных temporary fixtures и
одноразовой PostgreSQL15 через Unix socket без TCP listener. Тестовая БД остановлена.
Full Jest использовал forceExit после записанного результата из-за прежних timers.
Full candidate был выполнен до заключительных test-only lint corrections; после
них повторён весь targeted набор. Production code после full не менялся.
[Машиночитаемые результаты](checks.json); raw logs/JSON — `/private/tmp/homecloud-stage2-20261012/`.

71 FAIL остаётся отдельным риском красного полного набора. В этих шести suite
macOS не предоставляет Linux secure filesystem; последующие HTTP/admission errors
совпали с baseline. Это не доказательство безопасности всех сценариев на Linux и
не замена будущей target-platform regression/qualification.

## Crash windows и пробелы

| Момент сбоя | Что может остаться | Политика сейчас |
|---|---|---|
| После mkdir до journal | Только пустой HDD user dir | Сохранить; cleanup отложен |
| Reservation/assembling | Journal без temporary, partial либо complete temporary | SSD chunks сохранены; новые операции блокируются |
| После fsync до verified | Durable temporary, journal ещё assembling | Не считать published/committed |
| Publishing вокруг rename/fsync | Temporary **или** final; native rename может бросить ошибку после успешного rename | Проверка имён/identity/whole hash нужна в будущем recovery |
| Published до metadata commit/rollback | Durable final без File/quota/session completion | Сохранить target/source; journal удерживает active barrier |
| Потеря ответа на COMMIT | Published либо committed; результат для caller неоднозначен | Никаких повторов, удаления или обратного списания quota |
| После committed до caller response | File/quota/session committed и source chunks retained | Future idempotent read/recovery и cleanup отдельно |

Journal фиксирует намерение и ожидаемые bytes/bindings; dev/inode — наблюдаемая
identity, **не** самостоятельное доказательство диска после reboot/clone/remount.
Future recovery должен повторно подтвердить operator mount/source/marker identity
и байты, fail closed при неоднозначности; никогда не удалять данные по одному state.
Trust model — service-owned каталоги на доверенном личном сервере; same-UID/root
adversary и криптографическая physical identity не заявляются.

Portable filesystem tests явно подменяют native boundary и distinct device.
Production adapter не имеет portable fallback и требует Linux openat2/native addon.
Реальные SSD/HDD, actual EXDEV transfer, Linux FD runtime, power loss, storage fault
injection и process-wide RSS/cgroup pressure на8 GiB host/50+ GiB не квалифицированы.
Однопроцессная bounded payload memory не гарантирует общий RAM бюджет приложения,
PostgreSQL, параллельного legacy ingress и других процессов. Межпроцессное contention
может дать безопасный PostgreSQL deadlock-abort; улучшение admission отложено.
MIME пока application/octet-stream; preview metadata integration тоже до activation.

## Что осталось до безопасного SSD включения

Отдельно согласовать 2.3: recovery при каждом окне, ambiguous commit lookup,
idempotent replay, verified no-overwrite conflict resolution, lifecycle/source/temporary
cleanup и освобождение reserved rows/barrier. Затем согласовать SSD admission и
routing, durable expected whole hash contract, legacy API fencing, quota/admission
capacity, MIME metadata, migration/deployment writer fence и rollback runbook.
В отдельном разрешённом испытании проверить Linux target boundary, actual cross-FS,
mount loss/restart/power-loss сценарии и bounded RSS на50+ GiB/8 GiB RAM.

Live сервер, Docker/VM, реальные диски/данные/volumes не затрагивались.
Запрещённый `scripts/tests/PHASE-5.3.1-TEST-AUDIT.md` не читался, не искался,
не хешировался и не изменялся. Посторонние untracked сохранены.
**COMPLETE не установлен; production NOT_READY / NO_GO сохраняется.**
**2.3, routing switch, recovery/cleanup и физические испытания не начаты. Работа остановлена после2.1–2.2.**
