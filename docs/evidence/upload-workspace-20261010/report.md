# MS-3A — Upload Workspace Architecture & Session Binding

Дата: 2026-10-10, Asia/Vladivostok. **MS-3A технически COMPLETE** в ограниченном legacy
профиле. Production **NOT_READY / NO_GO**. Работа остановлена после MS-3A; MS-3B не начат.
Есть процессное отклонение от запрета чтения audit: одна matching строка попала в поиск
одного агента. Подробности ниже; без этого замечания заявление о полном соблюдении
инструкций было бы неверным.

| Поле | Фактический результат |
|---|---|
| INITIAL_HEAD | `51703415ae2a054932ab9fab0601cb78f04fa6e5`, exact match; main |
| CODE_HEAD | `6af2b1a150e26b84c263a8e110e8dc288a27a7cc`; final docs HEAD сообщается в финальном ответе |
| SCHEMA | 11 таблиц, 22 migrations; `upload_workspaces` и `upload_sessions.workspaceId` NOT NULL, FK RESTRICT, index и immutable triggers; synchronize=false |
| LEGACY_WORKSPACE | UUID `87798389-88af-4ea5-a3e7-8e69a3c7bb01`, machineKey `legacy-upload-workspace`, approved mountKey `legacy-storage`, type `local_filesystem`; root `/storage/.tmp` |
| SESSION_BINDING | Workspace выбирается по FK сессии и операторской allowlist. Immutable `(workspaceId,uploadId,tempPath)`; retained absolute tempPath — exact bridge, не path authority |
| BACKFILL | 21/21 исходных session, все статусы/IDs/upload IDs/старые поля/counters/JSON/expiry/accounting сохраняются. Canonical chunk rows0; exact PG fixture содержит подтверждённую часть и реальные bytes, доказывает их сохранение |
| LIFECYCLE | create/ingest/status/list/reconcile/hydrate/finalize/retry/cancel/expiry/recovery/cleanup используют session binding. До Multer byte creation — owned session admission |
| FAIL_CLOSED | Null/missing/unknown/mismatched DB identity, wrong bridge, missing/swapped/symlink root блокируют операции. Fallback отсутствует; production missing `.tmp` не создаётся; root failure sticky в процессе |
| MIGRATION_SAFETY | Verified fenced backup + private `.tmp` supplement; isolated old dump restore→migration→down refusal→new dump restore→old restore PASS. Canonical writer stopped; ACCESS EXCLUSIVE/transaction, readonly FS preflight |
| INVARIANTS | Canonical migration: все9 исходных data tables exact equal после исключения только нового session FK; migrations21→22, workspaces0→1. 5 исходных files/37021 bytes, SHA/dev/ino/size/mode/uid/gid/mtime и directory inventory exact equal |
| INGEST_COLOCATION | `/storage/.tmp/multipart-ingress` и session chunks на той же legacy FS; runtime dev65025 для root/workspace/ingress. Rename adoption и fsync прежние; EXDEV прекращает операцию, copy fallback нет |
| FINALIZER | Existing legacy assembly/File placement сохранён; cross-FS SSD→HDD не реализован |
| FILE_BYTES_MOVED | **0 исходных пользовательских bytes**; создавались и удалялись только небольшие isolated/runtime fixtures и backup copies |
| BACKEND | Full Linux **68 suites / 917 PASS / 0 skips**; targeted8 suites/179 PASS; lint0 errors/15 прежних warnings, typecheck/build/bench typecheck/image build PASS |
| POSTGRES | Девять real PostgreSQL suites PASS в отдельных schemas существующего preview DB; новая exact migration suite11 cases, включая preservation/FK/immutability/rollback/nonUUID/down refusal |
| RESTORE_GATE | Только необходимая exact 11-table generation. Gate11 PASS; cleanup1 PASS; release-manifest26/release-gate6 PASS; bash syntax/diff check PASS |
| RUNTIME | UID/EUID1001, Linux Node20.20.2, backend healthy; pause→fresh auth/reload/status→resume/finalize, HTTP429 Retry-After, quota/cancel, expiry/orphan recovery, download/share/ZIP/preview/file operations PASS |
| ROLLOUT | Только backend image `homecloud-preview-backend:workspace-checkpoint`; env/mount/user/network equality PASS; DB/frontend/ingress IDs прежние |
| REVIEWS | Независимые scoped DB integrity, filesystem/ingress, lifecycle ACCEPT; максимум2 correction rounds, primary проверил фактические diff/tests/evidence |
| DOCS | Architecture/ROADMAP обновлены без numbered Phase, добавлен operator contract, этот evidence и JSON summaries |
| COMMITS | `e5fe91d14d89c110651e8e7b83d52ca483b777b4` — schema/backfill/restore gate; `6af2b1a150e26b84c263a8e110e8dc288a27a7cc` — resolver/lifecycle/fixtures; отдельный русский docs/evidence commit |
| GIT_STATUS | После docs commit ожидаются только3 исходных untracked, не staged/committed; final actual status сообщается в ответе |
| LIMITATIONS | secureOpen=false, trusted legacy pathname TOCTOU; `.tmp` physical anchor только lifetime процесса, нет межперезапускной provenance/physical host/remote FS/power-loss qualification |
| NEXT_CHECKPOINT | MS-3B Secure Workspace Activation, только отдельное разрешение владельца и необходимые secure-open/identity gates. Не начинается автоматически |

## Migration и данные

Штатный verified backup ID `20261010_091050_0e789ae1` сохранён в ignored private
`backups/workspace-checkpoint-20261010`. Обычный payload исключает `.tmp`; при остановленном
writer отдельно сохранён `workspace-fenced.tar.gz` (143 bytes, в canonical chunk rows0).
SHA/tree этого supplement проверены. Это не новая ordinary backup policy.

До canonical migration dump восстановлен в disposable PostgreSQL DB; migration выполнялась
с original `/storage` **read-only**, а не на копии нового диска. Сверены исходные table
counts/digests и FS inventory; down refusal оставил new schema неизменной. Новый dump
восстановлен и совпал с migrated state; повторно восстановленный старый dump exact equal
baseline. Disposable DB удалена. Дополнительная isolated extraction storage+`.tmp` archives
в scratch после rollout подтвердила SHA/size всех5 original files и workspace tree; scratch
удалён. Full destructive Compose restore/power-loss qualification не заявляются.

Все текущие session paths соответствовали exact `/storage/.tmp/<UUID>`. Missing session
directory допускается для terminal/crashed row, но missing workspace запрещён. DB guards
запечатывают root bridge; remap требует отдельного квалифицированного изменения. Старый
binary не может создавать sessions без FK; down/drop binding не являются rollback.

**После runtime есть одно объяснённое отличие от migration snapshot:** AuthService на startup
в `2026-10-10T13:19:19.020Z` (23:19:19 Asia/Vladivostok) штатно удалил12 expired refresh
rows,55→43. Isolated restore backup доказал: все12 были expired до startup, оставшиеся43
rows exact equal. AuthService не менялся. Все исходные sessions/chunks/users/File/folders/
shares/placement/quota и физические files остались неизменны. Не заявляется ложное
«все таблицы exact equal после runtime».

## Проверки и воспроизведение

[Validation summary](validation-summary.json), [pre-migration safety](pre-migration-safety.json),
[isolated migration/restore](isolated-migration-summary.json), [isolated storage extraction](isolated-storage-restore.json),
[canonical migration](canonical-migration-summary.json), [runtime identity](runtime-identity.json),
[runtime smoke](runtime-smoke.json), [rollout](rollout-summary.json),
[post-smoke safety](post-smoke-safety.json), [refresh expiry proof](refresh-token-expiry-proof.json).

Reproducible tracked [snapshot](safety-snapshot.cjs) публикует hashes/counts, не DB значения;
[runtime smoke](runtime-smoke.cjs) запускается через `docker exec -i homecloud-preview-backend-1 node`
с кодом на stdin. Smoke сам создаёт/чистит small fixtures, не содержит credentials.
Миграция — штатный `node node_modules/typeorm/cli.js migration:run -d dist/data-source.js`,
только при fenced backend/ingress, verified backup и исходном approved storage.

Targeted→full→lint→typecheck/build выполнены в установленном порядке. Linux test image
`homecloud-ms3a-tests`, UID1001, source/bench read-only mounts; database URL передавался через
память/environment процесса, не записывался на диск. Full: `jest --runInBand --no-cache`.
PG suites используют isolated schemas, canonical user rows не служили fixtures.

Ignored local logs: [targeted PG](targeted-postgres.log), [full PG](backend-full-postgres.log),
[lint](lint.log), [typecheck](typecheck.log), [build](build.log), [bench typecheck](bench-typecheck.log),
[restore gate](restore-schema.log), [restore cleanup](restore-cleanup.log),
[release manifest](release-manifest.log), [release gate](release-gate.log),
[isolated migration](isolated-migration.log), [canonical migration](canonical-migration.log),
[runtime smoke](runtime-smoke.log). Private dumps/row inventories не коммитились.

Новые adversarial cases: DB mountKey substitution и missing/replaced `.tmp` проверяют
status/list/reconcile/chunk/finalize/abort/expiry/orphan/create с503 и без changes rows,
reservations, chunk inode/content и ingress bytes. Resolver tests охватывают unknown/null/
type/mount/path binding, symlink, sticky identity failure, FD anchor и colocation.
Production missing `.tmp` startup regression доказывает отсутствие recreation.
Final targeted2 suites/57 PASS. В fixture явно установлен и восстановлен NODE_ENV:
Jest test env ранее перекрывал ConfigService production value. После исправления повторно
пройден full68 suites/917 PASS и lint/typecheck/build; production код не менялся.
5120 synthetic chunks — только небольшая complexity fixture; **50 GiB run не выполнялся**.

## Reviews и отклонения

[Independent reviews](independent-reviews.md): три узких роли, cross-review production
частей, максимум2 раунда исправлений. Чётко разделены authorship и review области.

Один агент при broad search получил одну строку запрещённого audit. Это нарушение
**чтения**, несмотря на отсутствие full open/edit/stage/commit. Оно сообщено владельцу
и зафиксировано здесь. Все три исходных untracked сохранены. Primary запрещённый файл
не открывал; утверждение «вся команда не читала» не используется.

Автоматический reviewer отклонил попытку сохранить Docker env в файлы из-за credentials.
Операция не выполнена; принят безопасный вариант с memory-only передачей. Первый backup
harness не смог разрешить volume без TLS/hostname Compose variables, остановился без
миграции и восстановил old writer. После исправления операторских non-secret paths backup
PASS и writer fenced. Первый isolated CLI harness обнаружил отсутствие ts-node; метод
заменён штатным compiled CLI. Исправлены test-only ожидание ingress cleanup и точность
mtime, затем targeted/full PASS. Ошибки harness не скрыты и не объявлены production defects.

Второй диск, MS-3B, Docker mount changes, cross-FS finalizer, policies, admin API/UI,
physical user file transfer, push/tag/release и 50GiB run не выполнялись. Production NO_GO
сохранён; дальнейшая работа требует отдельного checkpoint authorization.
