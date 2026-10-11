# MS-3B-R1 — Secure Filesystem Adapter: IMPLEMENTED / LOCALLY_VERIFIED / BLOCKED

> Продолжение 2026-10-11: **текущий R1Q_GATE=PASS / R1_GATE=PASS в исходном R1 scope**. Native Linux AMD64 квалификация завершена на домашнем сервере; [актуальный отчёт](../secure-filesystem-adapter-home-server-native-r1q-20261011/report.md). Нижеследующий BLOCKED статус относится к исторической попытке. Production NO_GO, secureOpen=false; R2/MS-4 не начаты.

2026-10-11, Asia/Vladivostok. **R1_GATE=BLOCKED. Production NOT_READY / NO_GO.**
Владелец разрешил начать реализацию на macOS/Docker Desktop, целевой image Linux `amd64`;
ARM64 не обязательная целевая платформа, ARMv7/32-bit исключены. После фактического
`ENOSYS` в Desktop amd64 runtime владелец выбрал сохранить implementation/evidence
и оставить R1 BLOCKED до native amd64 qualification. Настройки эмуляции не исследовались
и не менялись. R2 и MS-4 не начаты.

| Поле | Результат |
|---|---|
| INITIAL_HEAD | Expected=actual `64aef61bb55ddd5f497b14042aa9d797ecdae295`, main; tracked clean, три исходных untracked |
| FILESYSTEM_ADAPTER | Node-API C addon + TypeScript boundary. Module-owned root capability; actual openat2 BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV, descriptor streams, dirfd mkdir/rename/unlink/enumeration/recursive removal. Без runtime dependency, request subprocess, pathname downgrade |
| DOCKER_AMD64_BUILD | PASS: штатный multi-stage `backend/Dockerfile` собирает addon в Linux; runner содержит только native binary и app/deps, USER1001. Final image ID и hashes в [verification-summary.json](verification-summary.json). Не rollout |
| MULTER_INGRESS | Реальный factory/StorageEngine использует adapter. Callback после writer close; abort/interceptor ownership через ingressWritePending; FD cleanup. Missing addon/syscall — fail-closed |
| CHUNK_LIFECYCLE | Session mkdir, ingress validate/hash/adopt, Buffer staging, retry, hydration, fsync, publication, stale/orphan/abort/expiry/recovery cleanup — descriptor boundary. Исходный inode удерживается через hash/fsync/publication; identity сверяется до metadata commit |
| ATTACK_REPRO_BEFORE_AFTER | [Before](attack-before.json): actual прежний compiled production Multer после guard записал5 fixture bytes вне root. [After](adversarial-results.json): actual новый compiled Multer FAIL_CLOSED/ELOOP, outside0. Только disposable tmpfs |
| ADVERSARIAL_CONCURRENCY |2000 native LinuxKit arm64 adapter attempts:616 successes,1384 explicit refusals,11402 ancestor swaps,outside0. Это не2000HTTP uploads. Static traversal/leaf/ancestor symlink, cleanup и настоящий nested-mount EXDEV/source retained без copy fallback подтверждены |
| TESTS/POSTGRES | Targeted10/194 PASS; full69/931 PASS,0skips, включая9 реальных PostgreSQL suites в disposable schemas; final native boundary10/10 PASS. Legacy quota/retry/429/cancel/reload/resume/accounting/MIME/finalizer regressions сохранены |
| LINT/BUILD |0lint errors,15 прежних warnings; typecheck и backend build PASS. Final Docker amd64 build PASS. Новые dependencies/migrations отсутствуют |
| RUNTIME | Docker Desktop/LinuxKit arm64 VERIFIED. [Compiled two-process UploadsService+PG recovery](recovery-results.json): SIGKILL после chunk+directory fsync до metadata insert; rollback, первоначальные inode/bytes сохранены; fresh service retry twice, uploadedCount1,size4,quota4. Production Multer useClass DI shutdown без FD leak. Adapter SIGKILL/restart и100capability cycles без FD leak |
| AMD64_DESKTOP_RUNTIME | [FAIL_CLOSED / ENOSYS](amd64-failclosed-results.json): process.arch=x64, UID1001, LinuxKit6.12.76; отказ при root openat2, до ingress mkdir/write, upload bytes0, fallbackfalse. **Работа на amd64 runtime не доказана.** Точная причина ENOSYS не установлена отдельно |
| REVIEW_STATUS | [COMPLETED_WITH_LIMITATIONS](independent-review.md). Независимый scoped reviewer доступен, safety refusal не было. Все выявленные P1/P2 исправлены; reviewer проверил финальный source/harnesses/logs. Scoped acceptance не является host qualification/production approval |
| HOST_QUALIFICATION | **Native Linux amd64 production host UNQUALIFIED**. Physical FS/mount/seccomp и power-loss durability не проверены. Отсутствие отдельного host не препятствовало разрешённой реализации |
| DATA_INTEGRITY | [Before/after summary](data-integrity.json): hashes всех11 public tables, полный FS inventory и directory inventory равны;21/21legacy bindings;5user files/37021bytes сохранены;22migrations;0chunks;0remaining disposable schemas. Canonical health HTTP200;4исходных services healthy |
| ACTIVATION_STATUS | secureOpen=false; additional workspaces disabled. Canonical services/images/config/storage не обновлялись; bytes не переносились. Production NOT_READY / NO_GO |
| COMMITS | `935c0ce46fc43886665357a4ad15c3cec0895104` — «Добавить дескрипторный адаптер файловой системы Linux и сборку Docker»; `3b32f25f475170649d846fca0a5a7c504a226e32` — «Подключить защищённые дескрипторы к приёму и жизненному циклу загрузок»; отдельный русский evidence commit сообщён после записи |
| FINAL_HEAD / GIT_STATUS | Exact final documentation commit SHA сообщается в итоговом ответе; после него tracked clean и ровно3исходных untracked. Два разрешённых JSON совпадают с прежним checkpoint по SHA256. Audit не читался, не хешировался, не менялся, не staged/committed; исключён из поисков/diff |
| R1_GATE / NEXT_GATE | **BLOCKED**: native amd64 host qualification и работоспособный target runtime отсутствуют. Следующий отдельно санкционированный gate — проверить этот implementation на native Linux amd64 с реальными FS/seccomp, repeat ingress/lifecycle/PG/crash checks и review delta. R2 только после полного R1 PASS и отдельного решения владельца |

## Technical design / threat model / integration points

[Design](design.md) определяет доверенные deployment ancestors/kernel, root acquisition,
фиксированные операции и пределы защиты. Native root acquisition идёт от `/` FD без
symlink traversal; crossing designated root mount допустим только при acquisition.
Далее NO_XDEV обязателен. Native FD root сопоставляется с существующим legacy anchor;
pathname guards остаются admission/diagnostics и не заменяют descriptor I/O.
API/DB paths не выбирают root; retained path bridge и immutable binding проверяются.

Одно открытие недостаточно: ingress FD удерживается до publication; Buffer staging
создаётся исключительно и пишет в исходный FD; retry/hydration size/hash/fsync используют
один inode; post-rename identity сверяется с исходным FD, без новой hash authority по имени.
Finalizer **только читает chunks** через один FD для fstat/hash/read с size limit.
Его finalPath создание, MIME, publication/quota protocol и внешняя StorageService boundary
не переписаны. Cross-FS/copy fallback и MS-4 отсутствуют.

Durable root enrollment между процессами не добавлен. Старый counterexample принятия
заменённого `.tmp` свежим процессом остаётся ограничением прежней legacy authority;
R1 не объявляется решением R2. process-lifetime root identity проверяется sticky.

## Reproduction / provenance

[adversarial.cjs](adversarial.cjs), [amd64-failclosed.cjs](amd64-failclosed.cjs),
[recovery.cjs](recovery.cjs), [run-validation.py](run-validation.py),
[run-recovery-native.py](run-recovery-native.py). Harnesses требуют пустой `/qualified`,
non-root UID1001, disposable tmpfs и отсутствие `/storage`; adversarial также `--network none`.
Никогда не запускать fixture на canonical/user roots.

Test image строится из **backend context**, не всего repository:

```sh
cd backend
docker build --pull=false -f native/Dockerfile.tests -t homecloud-r1-tests:temporary .
docker build --platform linux/amd64 --pull=false -t homecloud-r1-amd64:temporary .
```

После build test container получает read-only только `backend/src` и `backend/bench`,
`/app/dist` — disposable tmpfs. PG URL существующего own preview извлечён в память,
передан environment без вывода/commit; suites/fixture создают собственные schemas,
после проверки их0. Скрипты запуска содержат текущий local root/service names;
при переносе требуется операторский isolated DB/root contract.

Adversarial launch: `--rm --user 1001:1001 --cap-drop ALL --network none`,
`--tmpfs /qualified:uid=1001,gid=1001,mode=0700`, отдельные
`--tmpfs /exdev:uid=1001,gid=1001,mode=0700` и `/exdev/nested` с теми же options;
read-only harness `/probe.cjs`, compiled production sources `/app/dist`, `node /probe.cjs`.
Для amd64 failclosed только `/qualified`, `--platform linux/amd64` и production image.
В runtime нет privileged/root/Docker socket/custom seccomp. Docker socket используется
только host test orchestration и не предоставлен приложению.

[Source hashes/platform/build IDs/validation](verification-summary.json),
[local ignored targeted log](targeted-final.log), [full log](full-checkpoint.log),
[lint/typecheck/build](lint-typecheck-build-final.log), [Docker build](amd64-build-checkpoint.log).
Node20.20.2, native test compiler GCC15.2.0. Base tags и apk registry mutable;
это local build provenance, не воспроизводимая production supply-chain аттестация.
Только собственные temporary images/containers удалены после evidence; canonical4services
не затронуты. Постоянный второй stack, push/tag/release отсутствуют.

## Findings / corrections / limitations

- Первый unit harness зависел от pathname mocks; перенесён на явно test-only boundary.
  Production fallback не вводился. Первый failed run оставил test timer; подтверждённый
  собственный disposable container удалён, постоянные сервисы не затронуты.
- Borrowed read stream закрыл ingress FD и выявил EBADF; hashing заменён на async fs.read
  с explicit offsets, fixed64KiB buffer и expected-byte bound. PG regression после fix PASS.
- Independent reviewer нашёл inode-authority разрыв после ingress→staging и retry opens.
  Исправлено удержанием исходных FD и проверкой publication identity; добавлены bounded
  reads, lifecycle factory и закрытие capability при acquisition error.
- Первый adversarial fixture имел nested mount под production root; registry правильно
  отказал admission. EXDEV mount вынесен в отдельный fixture, protection не ослаблялась.
- Первый amd64 build застал два TS harness errors; после исправления final build PASS.
  Runtime ENOSYS оставлен как настоящий blocker, не заменён pathname/эмуляцией syscall.
- Same-UID arbitrary content rewrite/hardlink/rename-out или trusted root/operator/kernel
  compromise не входят в доказанную модель. FD confinement не обещает confinement к
  текущему pathname после перемещения уже открытого inode вне tree. Post-publication
  unexpected inode сохраняется без DB commit; malicious regular-file substitution может
  оставить orphan, а не исправить чужие bytes автоматически.
- Проверены symlink/ancestor swaps, не исчерпывающая формальная верификация. Metadata
  native operations синхронны; throughput/50GiB/event-loop нагрузка не квалифицированы.
- SIGKILL с PostgreSQL проверяет process crash и rollback; power loss/device durability,
  physical mount loss/remount и persistent root generation — UNQUALIFIED.

Ни web admin/API, storage policies, DR/deploy расширений, migrations,50GiB,
additional workspaces, finalizer publication, R2 или MS-4 не начаты.
