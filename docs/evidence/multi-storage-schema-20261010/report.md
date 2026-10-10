# Schema & Legacy Compatibility — implementation checkpoint

Дата завершения: 2026-10-10, Asia/Vladivostok. **CHECKPOINT_STATUS: COMPLETE**.
Production: **NOT_READY / NO_GO**. Workstream ненумерованный; новая Phase не создана.
Разрешён и выполнен только первый checkpoint, включая необходимый legacy resolver.

| Поле | Результат |
|---|---|
| INITIAL_HEAD | `187a642ba30dbeb3d73737a582203d557f7de9bb`, `main` ahead 1; локальный `origin/main` — `07d06e10b3987fef26c1c78e6449b05cf5ec6eef` |
| ARCHITECTURE_BASELINE | [Архитектура](../../multi-storage-architecture.md), отдельно утверждённые owner decisions и границы Schema & Legacy Compatibility |
| SCHEMA_CHANGES | `storage_locations`: UUID, уникальные machineKey/mountKey, displayName, local_filesystem, timestamps; File: UUID FK RESTRICT + относительный ключ, UNIQUE pair, physical/folder CHECK и consistency trigger; immutable identity trigger |
| LEGACY_STORAGE_LOCATION | UUID `f2f5c4b0-8d57-4c49-9f8c-0d095b344601`; machineKey = mountKey = `legacy-storage`; имя «Основное хранилище»; deployment binding `STORAGE_PATH`, текущий `/storage` |
| FILE_PLACEMENT_AUTHORITY | `storageLocationId + relativeObjectKey` для физических файлов; у folder mirrors placement NULL |
| COMPATIBILITY_BRIDGE | `storagePath` временно сохранён и обязан точно совпадать с root + key. DB trigger блокирует неполную/расходящуюся запись; resolver не использует fallback на absolute path |
| MIGRATION_BACKFILL | 6 File → те же 6 File; 5 физических → 5 logical placements; 1 folder без placement; 20 → 21 migrations |
| MIGRATION_SAFETY | Writer остановлен; исходные counts/row hashes и полный FS inventory зафиксированы; штатный recoverable backup проверен, восстановлен и мигрирован в disposable DB; затем применён к canonical preview |
| PATH_CONFINEMENT | Единый StorageRegistry: строгая lexical validation, lstat/realpath для root/предков/leaf, запрет symlinks, malformed Unicode, absolute/traversal/ambiguous keys. Portable exclusive-directory profile; race-free openat2 не заявлен |
| EXISTING_UPLOAD_SESSIONS | Все исходные 21 session неизменны: 14 completed, 7 aborted, 0 active; tempPath/chunks и recovery остаются в прежнем контуре `/storage/.tmp` |
| FILE_BYTES_MOVED | **0**; SHA/inode/device/mode/owner/mtime каждого исходного файла и directory inventory совпали до/после миграции и smoke |
| CONSUMER_COMPATIBILITY | Owner/native/share/ZIP/preview, create/copy/finalize и physical delete используют resolver/pair. Rename/move/trash/restore сохраняют placement; quota/reservation semantics проходят tests и smoke |
| BACKUP_RESTORE_SCHEMA_IMPACT | Только legitimate 10-table generation и logical reconciliation; migration выполняется при fenced backend, writers стартуют после reconciliation; broad multi-location DR отложен |
| TESTS | Full backend 65 suites / 858 tests PASS, без skipped; targeted 3/43 PASS; lint 0 errors / 15 прежних warnings; typecheck/build/bench compile PASS; frontend не затронут, проверки не требовались |
| POSTGRES_INTEGRATION | Real PostgreSQL в существующем контейнере, isolated schemas; exact 20-migration baseline, Unicode root, negative ID/trash, unsafe rollback, FK/delete/unique/identity/old-writer rejection PASS |
| RUNTIME_SMOKE | Тот же homecloud-preview: normal/binary/PNG upload + finalize retry, exact owner download, Range, native cookie capability, PNG public share, ZIP exact bytes, text preview/thumbnail, metadata operations, quota и cleanup PASS; четыре healthy контейнера |
| INDEPENDENT_REVIEWS | A DB integrity: ACCEPT; B path confinement: ACCEPT; C consumers: ACCEPT. Один remediation cycle; unresolved findings отсутствуют. Canonical rollout и runtime проверены primary executor |
| DOCS | Architecture + ненумерованная ROADMAP ссылка обновлены; evidence здесь |
| COMMITS | Реализация: `281ae3d69c38f338e458e2e2d55b51c3db27a496` («Добавить логическое размещение файлов и совместимость основного хранилища»); evidence фиксируется отдельным docs commit |
| FINAL_HEAD | Итоговый SHA docs commit и окончательный status сообщаются в финальном отчёте задачи; в документе SHA собственного коммита не дублируется |
| GIT_STATUS | Три исходных untracked сохранены и исключены; запрещённый audit-файл не читался/менялся; push/tag/release не выполнялись |
| CHECKPOINT_STATUS | COMPLETE — только Schema & Legacy Compatibility |
| BLOCKERS | Для этого checkpoint нет. Production NOT_READY / NO_GO и будущие hardware/DR/security qualification gates сохраняются |
| NEXT_RECOMMENDED_CHECKPOINT | Уточнить следующий Registry/resolver checkpoint: approved mount binding/identity и secure descriptor APIs перед несколькими locations; scope отдельно утвердить, workspace/finalizer сейчас не начинать |

## Миграция и доказательство нулевого переноса

Миграция `1746825150000-LegacyStoragePlacement` требует TypeORM transaction и видимый
исходный storage mount. Preflight берёт ACCESS EXCLUSIVE lock на files и проверяет
каждую запись, включая отрицательные integer IDs. Он не чинит и не нормализует плохие
данные молча: отсутствующий файл, size mismatch, duplicate placement, path вне root,
traversal, неоднозначные разделители или symlink прекращают migration с rollback.
Относительный ключ вычисляется SQL substring с явным integer; длина prefix учитывает
Unicode codepoints, не UTF-16 code units. Файловые операции migration — только чтение.

Canonical baseline: 4 users, 6 File, 1 folder, 6 shares, 21 sessions, 55 refresh tokens,
0 chunks и 0 download capabilities. Полные исходные строки этих таблиц, включая IDs,
имена, владельцев и shares, сравнивались по SHA-256; исключены только два новых File поля.
Результаты [safety-summary.json](./safety-summary.json) показывают равенство до/после.
PostgreSQL sequences могли штатно продвинуться при runtime smoke; вручную они не менялись.

Storage: 5 файлов, 37 021 bytes, 8 каталогов. Digest полного inventory:
`537b6b81f09461a255638703b7c7bfb13c1e1cd686c5b7c3e440cb0bc672d19f` до и после.
Проверялись не только contents SHA, но и пути, inode/device, size/mtime, uid/gid/mode.
Временные smoke файлы создавались и удалялись через текущий API; исходные bytes не
перемещались, не переименовывались и не удалялись. Test user был удалён после проверки
нулевой квоты и нулевого числа его File; его пустой физический каталог удалён.

Штатный backup до migration: ID `20261010_080140_9eb10963`, приватный ignored каталог
`backups/schema-legacy-checkpoint-20261010`. Dump и storage archive с checksums/meta
проверены существующим backup mechanism. Dump восстановлен в собственной временной БД;
новый migrator запускался с тем же volume **read-only**. После успешного backfill реальный
TypeORM migration:revert отказал, схема осталась с 21 migration. Scratch DB затем пересоздана
из исходного dump: все старые строки и 20 migrations совпали. Scratch DB удалена.

Backup новой схемы дополнительно создан тем же механизмом в подкаталоге `post-checkpoint`
при остановленном writer; dump успешно восстановлен в отдельную БД: 10 таблиц, 6 File,
5 placements и 21 migration. Временная БД удалена; исходный старый backup сохранён.
Backup payload и приватные migration logs не коммитятся.

## Контракт совместимости и границы

Identity и mount key неизменяемы на уровне БД. Resolver сейчас зарегистрирован только
для deterministic legacy UUID; второй physical location, arbitrary root input и default
policy selection не реализованы. Storage root — deployment config, а не абсолютный путь
в persistent placement. Bridge trigger запечатывает текущий canonical root; его смена
потребует отдельного qualified remap. Существующий `storagePath` остаётся в старых
ответах/внутренних структурах, но consumer не может использовать его вместо logical pair.

`AppModule.synchronize` отключён во всех средах. Новый/обновляемый dev DB должен проходить
явные build + migration:run с заранее существующим canonical root; sync не должен обходить
preflight и triggers. Исходные 20 migrations не изменены. Missing root теперь прекращает
запуск, вместо создания пустого «диска». Root и все canonical каталоги в preview проверены:
service uid/gid 1001, без group/world write и symlinks. Portable Node lstat/realpath требует
trusted exclusive directories и не защищает от adversarial concurrent ancestor replacement.
Существующие realpath/O_NOFOLLOW/fstat guards downloads/ZIP сохранены.

У File logical pair обязательна; old writer inserts и рассогласованный bridge отвергаются
БД. UploadSession.tempPath остаётся absolute compatibility exception этого checkpoint:
workspace registry, chunk bytes, reservation counters, cleanup и recovery не изменены.
Нормальный retry finalize и legacy session continuation проверяются существующими тестами.
Полный final SHA-256 не добавлен; существующие files не подвергались обязательному rehash
для нового product field (inventory hashes — только read-only доказательство сохранности).

`down()` намеренно запрещён. Downgrade требует согласованного pre-checkpoint DB/storage
backup и соответствующего старого binary; отдельный schema drop или старый writer на новой
схеме не являются допустимым rollback. Release schema/manifest gates не ослаблены.
Локальный preview использует собранный `homecloud-preview-backend:schema-checkpoint` и
ignored image-only override `backups/schema-legacy-checkpoint-20261010/preview-image.override.yml`.
Это локальная проверка кода `281ae3d69c38f338e458e2e2d55b51c3db27a496`, не release artifact/provenance qualification.
Mounts/Compose source/topology не изменены; прежний backend image сохранён по ID в safety summary.

## Проверки и независимый review

- [Full backend + real PostgreSQL](./backend-full-postgres.log): 65 suites, 858 tests, 0 skipped.
  Это включает normal/arbitrary binary finalize, quota/reservation, delete/copy failure
  semantics, ownership, native/share/ZIP/preview и exact-baseline migration regressions.
  ERROR/WARN строки в журнале — намеренные failure-injection unit cases; итог suite PASS.
- [Targeted](./targeted.log): 3 suites / 43 PASS после remediation; далее полный PG suite.
- [Lint](./lint.log): 0 errors, 15 прежних warnings в security.config.spec.ts;
  [typecheck](./typecheck.log), [build](./build.log), [bench compile](./bench-typecheck.log) PASS.
  Empty typecheck log означает успешный exit 0, не отсутствие запуска.
- [Restore exact schema gate](./restore-schema.log): 9 PASS, legitimate generations 7/8/9/10;
  unknown/missing/view/failed-query schemas по-прежнему отвергаются.
  [Restore cleanup](./restore-cleanup.log): 1 PASS; bash syntax PASS.
- [Release compatibility gates](./release-schema.log): 26 PASS.
- [Restore safety](./restore-safety.log): 15 PASS, 0 failures; destructive full-stack restore
  integration намеренно skipped 1. Он не заявляется проверенным. Реальные isolated dump
  restore/migration/refusal/new-schema restore описаны выше.
- [Runtime smoke](./runtime-smoke.log) PASS; [reproducer](./runtime-smoke.cjs) запускается
  внутри backend контейнера (pg/sharp dependencies и DATABASE_URL доступны там, секреты
  не выводятся). Это internal HTTP API smoke, не повторение IAB/TLS acceptance.
- Первый smoke attempt получил ожидаемый существующий 400 на public share неизвестного
  MIME. Fixture cleanup прошёл; повторный smoke использовал разрешённый PNG для share,
  arbitrary binary — для owner download и ZIP. Share MIME allowlist не изменён.
- [Canonical reconciliation](./reconcile.log): OK, 0 dangling/orphans/size/quota/share drift.
  Warning: 7 прежних aborted sessions, неизменных с baseline; новый активный upload не оставлен.
- A DB reviewer обнаружил omission negative IDs и Unicode substring overload. Исправлены
  nullable keyset cursor, codepoint prefix и явный integer; точные PG fixtures добавлены.
  Итог **ACCEPT**. B reviewer обнаружил unpaired surrogate ambiguity; helper отклоняет
  malformed key/root/absolute, сохраняет валидные emoji; итог **ACCEPT**.
  C reviewer запросил narrow real resolver/native/consumer regressions; добавлены;
  итог **ACCEPT**. Один remediation cycle выполнен, unresolved findings отсутствуют.
  Reviewers read-only; canonical migration/backup/runtime acceptance выполнены primary.

В конце остались только четыре healthy контейнера homecloud-preview. Второй stack не
создавался; scratch DB и временный test image удалены. Frontend исходники не изменены.
Исторический 50 GiB IAB PASS сохраняется; новый 50 GiB прогон не запускался.
True SSD→HDD 50 GiB qualification обязательна позже перед общим multi-storage acceptance.
