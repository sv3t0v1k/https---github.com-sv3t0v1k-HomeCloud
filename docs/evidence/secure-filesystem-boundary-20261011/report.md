# MS-3B-R — Secure Filesystem Boundary

Дата: **2026-10-11**, Asia/Vladivostok. **CHECKPOINT_STATUS: BLOCKED**.
**ACTIVATION_STATUS: disabled**, **secureOpen=false**. Production **NOT_READY / NO_GO**.
**Оба production-блокера остаются: ingress race unresolved; restart substitution unresolved.**
Это исследование, qualification и конкретный design следующей реализации; remediation
в runtime не внедрена. MS-3B не COMPLETE, MS-4 не начат. Работа остановлена после MS-3B-R.

| Поле | Фактический результат |
|---|---|
| INITIAL_HEAD | `36216688e48d4d4b526bcd95498ac0e49fe0b858`, expected=actual; `main`; tracked clean,3 известных untracked |
| THREAT_MODEL | [Design перед probe](design.md): API/DB path недоверен, ancestor symlink swap, restart replacement, mount disappearance, cloneable marker, concurrent lifecycle. Trusted kernel/operator; same-UID content/hardlink/rename-out sabotage не решается одним openat2. Уточнение inode generation по independent review |
| DESCRIPTOR_BOUNDARY | Actual Linux6.12.76-linuxkit/arm64/Node20.20.2: standalone C syscall-probe прошёл openat2 BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV, statx FD ordinary и unique mount ID, create/read/fsync/renameat2/unlinkat. Это **не Node adapter**, runtime его не вызывает. Публичного Node dirfd API нет; production capability остаётся false |
| INGRESS_ENFORCEMENT | **НЕ исправлено**. Actual compiled production Multer/resolver, non-root UID1001/CapEff0/default seccomp, deterministic swap после реального guard:5fixture bytes записаны в outside scratch. staging/chunk/cleanup/rename/hash/hydrate/orphan операции остаются pathname-based. Интеграция whole lifecycle отсутствует |
| RESTART_MOUNT_IDENTITY | **НЕ исправлено**. Два разных production Node processes: initial `.tmp` inode4, replacement inode7; новый процесс принял замену. Original5fixture bytes сохранены. Нет external trusted enrollment; marker labels cloneable. Actual remount повторил весь обычный tuple, включая root/workspace dev/ino и mnt_id. Unique mount ID различился, но не physical provenance и не object generation `.tmp` |
| PLATFORM_QUALIFICATION | Linux Docker VM tmpfs: syscall/namespace primitives и реальные private mount tests проверены. Default seccomp unshare EPERM; test-only unconfined private user/mount namespace UID0→host UID1001 позволил normal unmount/remount. Production policy не изменена. Physical Linux SSD/NVMe, macOS native, Docker Desktop host disk, NFS/SMB **UNQUALIFIED** |
| ADVERSARIAL_TESTS | C: traversal/static ancestor symlink/magic-link refusal, nested actual mount NO_XDEV, pinned-parent read/write/rename/unlink, actual kernel EXDEV source retained/no copy,2000 concurrent opens385 successes+1615 explicit refusals,outside0. Runtime: absent/plain copied-marker root и missing `.tmp` refused/no mkdir; ingress/restart counterexamples **security FAIL**. Mount: actual absent/empty/substituted root, substitution workspace, process restart, normal unmount/remount и SIGKILL fixture. Ни один counterexample не скрыт aggregate PASS |
| LEGACY_REGRESSION | Targeted7/178, full68/921 без skips,9 real PG suites. Existing quota, immutable binding, pause/status/reload/resume/429/cancel/expiry/recovery, chunks/finalize/shares/download regressions PASS. Новые backend unit tests не добавлены; qualification probes воспроизводимы отдельно |
| DATA_INTEGRITY | [Before/after summary](safety-summary.json): hashes всех11 public tables equal; full captured FS inventory (paths/bytes SHA/dev/ino/mode/uid/gid/mtime), directory names equal.5 исходных files/37021bytes;21/21 sessions bound legacy;0 chunks;22 migrations;source bytes moved0. Canonical writer не изменялся, backup/migration/deploy не требовались |
| TESTS/POSTGRES/RUNTIME | Full68 suites/921 tests PASS,0skips;9PG suites в disposable schemas, remaining0. Lint0errors/15existing warnings;typecheck/build PASS. Read-only canonical legacy identity/live HTTP200 before/after;4preview services healthy. Production-profile scratch probes вызывают actual compiled boundary. Нового canonical HTTP upload/finalize smoke и rollout не было |
| INDEPENDENT_REVIEWS | [Два независимых scoped reviewers](independent-reviews.md): filesystem+ingress lifecycle и mount identity+DB/session compatibility — ACCEPT **только BLOCKED/disabled outcome**. Один design correction: inode reuse/generation. Tests не повторялись reviewers; primary проверил source/results/diff |
| LIMITATIONS | Нет реально используемого descriptor-safe Node boundary, trusted external enrollment или persistent `.tmp` identity. Positive C primitive proof не переносится на приложение. Tmpfs crash fixture — SIGKILL после file+directory fsync, не power loss/DB recovery. Нет physical target tests и production remount qualification. Test compiler/local image provenance ограничены environment record |
| ACTIVATION_STATUS | **disabled**; только legacy workspace UUID87798389-88af-4ea5-a3e7-8e69a3c7bb01. Дополнительный config/env flag/location/workspace не добавлен. read/write extras fail closed;secureOpen=false |
| DOCS | Architecture, ROADMAP, upload operator contract, этот report, narrow design, independent reviews, standalone probes и sanitized JSON evidence. Config/bootstrap **не изменены**; external enrollment contract остаётся design-only |
| COMMITS | `bd9057ae56da5182b72b66ab821690a1ccb08896` — «Исследовать границу файловой системы и воспроизвести блокеры рабочих областей»; второй русский docs/evidence commit и его SHA сообщаются в итоговом ответе |
| FINAL_HEAD | Фактический SHA второго commit проверяется и сообщается в итоговом ответе; self-referential SHA не записывается в committed report |
| GIT_STATUS | После final commit tracked clean; ровно3 исходных untracked. Их содержимое не менялось; audit не читался/изменялся/staged/committed, путь исключался непосредственно из repo search/diff команд; stage только explicit own paths |
| CHECKPOINT_STATUS | **MS-3B-R BLOCKED**; acceptance alternative с activation disabled. **Не COMPLETE и не repaired**. MS-3B остаётся BLOCKED, Production NOT_READY/NO_GO |
| NEXT_GATE | Реализовать reviewed Linux Node-API capability boundary для всей карты ingress/lifecycle; external enrollment с FD-based verification, unique mount context и qualified workspace object identity; actual target physical platform tests. Никакой автоматической активации. MS-4 требует отдельного scope |

## Новое доказательство: обычная mount identity переиспользуется

В реальном private namespace произведены normal unmount и новый tmpfs mount на том же
пустом underlying directory. Два разных filesystem instances дали одинаковые:

```text
original:  dev=72 rootIno=1 mnt_id=200 workspaceDev=72 workspaceIno=2
remounted: dev=72 rootIno=1 mnt_id=200 workspaceDev=72 workspaceIno=2
unique original=2147807279; unique remounted=2147807280
```

Публичный marker label также повторён. Это actual counterexample для proposed enrollment,
основанного только на обычном mount ID/dev/ino даже при том же boot/namespace.
STATX_MNT_ID_UNIQUE способен различить эти mount instances и фактически доступен здесь.
Он не удостоверяет физический диск, не сохраняет identity при reboot и не решает
reuse inode `.tmp` внутри того же mount. Bootstrap/operator contract должен иметь
внешнюю доверенную authority; runtime first-seen enrollment недопустим.

Для next implementation предпочтён separately reviewed Node-API addon с module-owned
FD capabilities, фиксированными operation flags и validated relative keys, без root,
shell/subprocess на запросах и третьих runtime dependencies. Его минимальная карта
включает не только open: mkdir/readdir/stat, hash/read, rename/unlink, abort/expiry/orphan
cleanup и finalizer **чтение** chunks. Main finalizer publication/MS-4 вне текущего scope.
Добавление одного open wrapper не являлось бы исправлением acceptance.

## Воспроизведение qualification

**Только disposable containers без пользовательских volumes, DB и network.** Не запускать
probes на canonical storage или вручную provisioned user root. Runtime probe удаляет всё
содержимое fixture `/qualified`; его launch требует fresh пустой tmpfs, assertion это проверяет.
C guard требует tmpfs и root inventory только с `nested`. Container `--rm` удаляет scratch
при аварийном выходе; mount probe также normal-unmount в finally.

Build context — только эта evidence directory, не root repository:

```sh
docker build --pull=false -f docs/evidence/secure-filesystem-boundary-20261011/Dockerfile.probe \
  -t homecloud-ms3br-probe:temporary docs/evidence/secure-filesystem-boundary-20261011

docker run --rm --network none --user 1001:1001 --cap-drop ALL \
  --tmpfs /qualified:uid=1001,gid=1001,mode=0700 \
  --tmpfs /qualified/nested:uid=1001,gid=1001,mode=0700 \
  --entrypoint /usr/local/bin/homecloud-ms3br-kernel-probe homecloud-ms3br-probe:temporary

docker run --rm -i --network none --user 1001:1001 --cap-drop ALL \
  --tmpfs /qualified:uid=1001,gid=1001,mode=0700 --entrypoint node \
  homecloud-preview-backend:workspace-checkpoint \
  < docs/evidence/secure-filesystem-boundary-20261011/runtime-probe.cjs

docker run --rm -i --network none --user 1001:1001 --cap-drop ALL \
  --security-opt seccomp=unconfined --security-opt no-new-privileges=true \
  --entrypoint unshare homecloud-ms3br-probe:temporary -Urnm node \
  < docs/evidence/secure-filesystem-boundary-20261011/mount-probe.cjs

docker image rm homecloud-ms3br-probe:temporary
```

Exit0 kernel probe означает PASS только syscall fixture. Exit0 runtime probe означает,
что два **небезопасных** production counterexample воспроизведены как ожидалось: security
FAIL/BLOCKED. Exit0 mount probe означает actual namespace observations, не application
mount enforcement. Temporary probe image удалён после работы; build cache не pruned,
чужие Docker resources, canonical services/images/volumes/config не менялись.

[Environment, image IDs, compiler versions, source hashes](environment.json),
[kernel results](kernel-results.json), [runtime failures](runtime-results.json),
[mount observations](mount-results.json), [validation](validation-summary.json).
Alpine base закреплён по digest; apk repositories и local test image tag mutable.
GCC15.2.0/musl-dev1.2.6/linux-headers7.0 — только isolated build stage. Runtime tests C
UID1001/CapEff0/seccomp2; namespace root в mount fixture maps только host UID1001.
Нет privileged Docker container, host root/mount capability или production helper.

## Backend и безопасность исходных данных

Tests выполнены в existing `homecloud-ms3a-tests` с read-only bind только backend/src
и bench; root repo/audit и canonical storage не предоставлялись. URL existing preview
PostgreSQL извлечён в память, передан environment без вывода/сохранения. Каждый PG suite
создаёт собственную disposable schema; before/after canonical snapshot обнаружил0remaining
schemas и точное equality public rows. Existing compiled runtime/source equality для пяти
filesystem/ingress модулей проверена отдельно, без rollout: [parity](runtime-parity.json).

Порядок: targeted → full → lint → typecheck → build. В каждом test container:

```text
targeted: node node_modules/jest/bin/jest.js --runInBand --no-cache
  src/uploads/upload-workspace.spec.ts src/uploads/upload-workspace.postgres.spec.ts
  src/uploads/uploads.service.spec.ts src/uploads/uploads.service.postgres.spec.ts
  src/storage/storage-mount-registry.spec.ts src/uploads/chunk-ingress.spec.ts
  src/uploads/upload-rate-limit.postgres.spec.ts
full: node node_modules/jest/bin/jest.js --runInBand --no-cache
lint: npm run lint
typecheck: node node_modules/typescript/bin/tsc --noEmit
build: npm run build
```

Build output в disposable tmpfs `/app/dist`, non-root UID1001/cap-drop ALL. Canonical
read-only snapshot использует существующий [MS-3B canonical checker](../secure-workspace-activation-20261010/canonical-check.cjs);
raw row/FS snapshots остались private scratch, в Git только summary/digests.
Local ignored validation logs: [targeted](targeted.log), [full](full.log), [lint](lint.log),
[typecheck](typecheck.log), [build](build.log). Никакой новый small mutating canonical
HTTP smoke не запускался: runtime binary/config не менялись, regression проверена в scratch/PG.

## Ошибки harness и границы вывода

- Initial native build включил linux/stat.h вместе с новым musl sys/stat.h и получил
  redefinition statx; удалён дублирующий kernel header, следующий build PASS с Werror.
- Default seccomp unshare дал EPERM. Вместо объявления mount tests невозможными проверен
  отдельный test-only unconfined namespace; actual mounts безопасно выполнены и удалены.
- Первое предположение harness о смене **обычного** mnt_id на remount оказалось неверным.
  Assertion упал; finally unmounted fixture. Перешли к записи реального reuse и проверке
  unique mount ID, не объявили обычный ID durable. Повтор показал full tuple reuse.
- Iterations добавляли unique-ID observer и guards только в qualification harness;
  production source/tests/config/schema не изменялись. Нет неограниченного remediation loop.

Подтверждённые runtime уязвимости не устранены; `secureOpen=false` и additional activation
disabled сохранены. Qualified physical target/enrollment boundary сейчас отсутствуют.
MS-3B-R BLOCKED — честный результат, а не успешная реализация remediation.
Не выполнялись byte moves, новые permanent locations, migrations, UI/API/policies,
основной finalizer/MS-4, deploy/DR,50GiB, push/tag/release. Sources project mirror не менялись.
