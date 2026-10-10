# MS-2 — Storage Registry & Secure Resolver

Дата: 2026-10-10, Asia/Vladivostok. **CHECKPOINT_STATUS: COMPLETE** в явно разрешённом
ограниченном профиле. Production: **NOT_READY / NO_GO**. MS-3 не начинается.

| Поле | Проверенный результат |
|---|---|
| INITIAL_HEAD | `b83a422d039efac68eaf38f53ffb76fa000bd2c5`, проверен, совпал с expected; `main`, три исходных untracked |
| DESIGN_DECISIONS | [Решения до кода](design.md); Node20 без штатного openat2/dirfd, standard Node FD только для marker identity, trusted legacy + blocked extras; без native dependency |
| REGISTRY_MODEL | Immutable operator bindings: UUID/machineKey/mountKey/root/writable/profile/mount+marker requirements; DB/API paths не authority; approved/inspect/assertAccess/close, File resolver отдельно |
| APPROVED_ROOTS | Runtime только `legacy-storage` / UUID `f2f5c4b0-8d57-4c49-9f8c-0d095b344601` / operator `STORAGE_PATH=/storage`; existing named volume `homecloud-preview_storage_data`; additional internal bindings diagnostics-only |
| MOUNT_IDENTITY | Exact Linux namespace mount tuple + root dev/ino/realpath + statfs type + bounded marker/no-follow/nonblock/owner/mode/dev/nlink; immutable process pin с retained marker FD; nested/stacked mounts blocked |
| SECURE_OPEN_PROFILE | **secureOpen=false**, `openSecure` refuses. Legacy trusted exclusive directories; path-based check→open TOCTOU остаётся. NO openat2 claim; new/untrusted byte I/O blocked |
| RESOLVER_CONSUMERS | File owner/native/share/ZIP/preview используют pair/bridge; StorageService read/write/copy/delete/exists/size/usage и generate guarded; Health, mandatory Multer guard, legacy session temp paths/final/cleanup entry rechecks; algorithms сохранены |
| FAIL_CLOSED_BEHAVIOR | Offline/wrong/swapped/missing marker/observed root or mount identity change/read-only/degraded — no write/probe/root mkdir/fallback; cleanup deferred. Startup production non-Linux/UID or EUID0 refused |
| LEGACY_COMPATIBILITY | Все 10 исходных tables counts+hashes совпали: 4 users, 6 File, 1 folder, 6 shares, 21 sessions, 0 chunks, 1 location, 55 refresh tokens, 0 capabilities, 21 migrations. Все original IDs/bridge/shares сохранены |
| FILE_BYTES_MOVED | **0**. Пять original files / 37 021 bytes: SHA/dev/ino/size/mode/uid/gid/mtime exact equality; directory list9 совпал. Добавлен только новый root identity marker, не перемещались user bytes |
| TESTS | Host targeted11 suites/212 PASS (38 PG cases skipped только там); final **Linux backend66 suites/884 PASS, 0 skipped**; marker/FIFO/allowlist/ro/root replacement/symlink/submount/consumer guards и create/upload/download/share/ZIP/copy/move/delete/quota; metadata reconcile2 PASS; lint0 errors/15 прежних warnings, typecheck/build/bench compile/image build PASS |
| POSTGRES | Восемь real PG suites в существующем preview DB, isolated temporary schemas; exact MS-1 migration/constraints suite PASS. User data не использовались как fixtures |
| RUNTIME | New local `homecloud-preview-backend:registry-checkpoint`, Node20.20.2 Linux UID/EUID1001; identity diagnostics + small full API smoke PASS; четыре healthy services; mounts/env/user/network set неизменны, DB/frontend/ingress IDs прежние |
| INDEPENDENT_REVIEWS | [Filesystem ACCEPT WITH LIMITATIONS, mount ACCEPT, legacy consumers ACCEPT](independent-reviews.md); findings и отозванная stat-only гипотеза явно зафиксированы |
| OPEN_LIMITATIONS | Legacy TOCTOU/exclusive namespace assumption; marker clone+restart не attestation; Docker VM не physical Mac disk; NFS/SMB/durability/host disappearance и blocking remote IO требуют qualification; capacity-domain/policy/secure descriptors отсутствуют |
| DOCS | Architecture и ненумерованная ROADMAP обновлены; [operator/bootstrap contract](../../storage-registry-operations.md), design, independent reviews и JSON summaries здесь |
| COMMITS | Implementation: `e034d813214d9213b6f0f74012fa3d22e6bc7ba4` («Добавить реестр разрешённых хранилищ и проверки идентичности основного тома»); отдельный русский docs/evidence commit |
| FINAL_HEAD | SHA итогового docs commit сообщается в финальном отчёте; собственный SHA документа не дублируется |
| GIT_STATUS | Три исходных untracked сохранены и не staged; запрещённый audit не read/edit/stage/commit. Только own MS-2 changes; push/tag/release не выполнялись |
| CHECKPOINT_STATUS | **COMPLETE только MS-2** с explicit portable trusted legacy и blocked new locations, как допускает owner scope |
| BLOCKERS | Для разрешённого MS-2 нет. Production NO_GO; secure-open/host physical/remote FS qualification — blocking перед new/untrusted user storage |
| NEXT_CHECKPOINT | MS-3 Workspace abstraction — только по отдельному запросу. Secure descriptor/host identity qualification обязательна до включения новых locations; не начинается автоматически |

## Проверяемые artifacts

- [Validation summary](validation-summary.json), [safety summary](safety-summary.json).
- [Actual Linux identity](runtime-identity.json), [API smoke](runtime-smoke.json),
  [rollout invariants](rollout-summary.json).
- Reproducible [snapshot](safety-snapshot.cjs), [identity smoke](runtime-identity.cjs),
  [API smoke](runtime-smoke.cjs). Snapshot публикует hashes, не исходные DB значения.
- Local ignored raw logs: [full Linux PG](backend-full-postgres.log), [lint](lint.log),
  [typecheck](typecheck.log), [build](build.log), [bench compile](bench-compile.log).
  Полные private before/after inventories хранятся в ignored
  `backups/registry-checkpoint-20261010`, secrets в evidence/Git отсутствуют.

Новый marker явно enrolled от service UID на заранее проверенном existing exact mount,
с O_EXCL, fsync file+directory; приложение не создаёт его автоматически. Docker rollout
изменил только backend image, без schema/mount/volume changes. Runtime config equality
проверена по Docker inspect, credentials не выводились. Временный test container удалён
через --rm; тестовые schemas очищаются suites. Historical 50 GiB PASS не повторялся и
не используется вместо этой проверки. Внешний production не изменялся.

Существующий backup payload включает marker. Restore старого backup без marker теперь
требует explicit enrollment перед production startup; это fail-closed gate, не redesign DR.
`reconcile.py` минимально распознаёт root marker/probe metadata и не считает их user orphan.
Полный restore/MS-2 power-loss qualification не запускался и не заявляется.
