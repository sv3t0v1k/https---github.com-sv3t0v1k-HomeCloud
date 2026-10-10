# MS-3B — Secure Workspace Activation

Дата checkpoint: 2026-10-10, Asia/Vladivostok. **MS_3B_STATUS: BLOCKED**.
**ACTIVATION_STATUS: disabled**. Production **NOT_READY / NO_GO**.
Работа остановлена после MS-3B; MS-4 и последующие checkpoints не начаты.

| Поле | Проверенный результат |
|---|---|
| INITIAL_HEAD | `6f73cc53fe882326861d90e7918cf6318b0bb11d`, expected=actual, `main`; tracked clean, три исходных untracked |
| PLATFORM_MATRIX | Linux container Node20.20.2/Linux6.12.76-linuxkit/UID1001 фактически проверен. tmpfs namespace boundary PASS; physical Linux SSD/removal/remount UNQUALIFIED. macOS native, Docker Desktop host SSD, NFS/SMB UNQUALIFIED; все additional activation disabled |
| SECURE_OPEN_IMPLEMENTATION | **secureOpen=false**. Callable fs/promises openat/openat2/renameat/unlinkat и RESOLVE flags отсутствуют. Kernel syscall/seccomp availability UNPROBED. Native dependency/helper не добавлен. Real guard→Multer writer ancestor-symlink interleaving дал escaped 5-byte scratch write: **security FAIL**, подтверждённый blocker |
| MOUNT_IDENTITY | Существующий MS-2 exact Linux mountinfo/root/statfs/marker+retained FD, MS-3A `.tmp` FD lifetime pin сохранены. Actual empty ordinary directory и absent root дают offline без mkdir/probe. Correct marker с новым registry и replacement `.tmp` с новым resolver принимаются: **restart provenance FAIL** |
| APPROVED_WORKSPACES | Только legacy `/storage/.tmp`, UUID `87798389-88af-4ea5-a3e7-8e69a3c7bb01`, mountKey `legacy-storage`. Operator extras отсутствуют. No additional config flag/DB workspace, API/UI или automatic session reassignment. Additional registry fixture blocked read/write даже при correct mount+marker |
| INGRESS_COLOCATION | Legacy workspace/ingress/chunks dev65025; source Multer destination fixed legacy. Actual scratch tmpfs↔container-FS rename EXDEV, source preserved. Отдельный injected EXDEV service PostgreSQL test: rollback accounting, confirmed bytes/inode retained, no copy, request ingress cleaned, retry/finalize PASS. Session-specific secure ingress для extras отсутствует |
| ACTIVATION_STATUS | **disabled**, без обхода secure-open/identity/ingress/DB gates. Pre-approved additional workspace activation config не поставлен, поскольку невозможно безопасно принять его этим runtime/deployment |
| LIFECYCLE | Только legacy. Full regression включает ingest/status/reconcile/reload/resume/finalize/cancel/expiry/recovery/cleanup, concurrency/quota/429/binary. Новый unit+PG тест: empty substituted `.tmp` даёт503/no mutation; возврат сохранённого original directory + explicit service restart сохраняет chunk inode/bytes/binding/counters и позволяет resume/finalize. Это не durable mount identity qualification |
| FAIL_CLOSED_TESTS | Approved UUID/key/type/path guards, traversal/static symlink/missing/replacement, production no recreation, additional UUID rejected across resolver restart, empty actual non-mount root offline, EXDEV no-copy. Existing mountinfo nested/stacked/same-device/ro cases — synthetic parser fixtures. TOCTOU/restart adversarial probes намеренно выявляют **FAIL**, не security PASS |
| BYTES_MOVED | **0 исходных пользовательских bytes**. Five original files/37021bytes + marker metadata and full tree exact equal; 11 public table hashes exact equal, 21/21 sessions bound legacy, chunks0, schema11 tables/22 migrations |
| TESTS | Targeted7 suites/197 PASS; full **68 suites/921 PASS, 0 skips**. Lint0 errors/15 existing warnings, typecheck/build PASS. Добавлены4 meaningful regressions; production source unchanged |
| POSTGRES | Все9 real PostgreSQL suites PASS на existing HomeCloud preview DB в disposable schemas; schemas0 remaining. Service tests synchronize fixtures проверяют lifecycle/accounting; отдельная exact-migration suite проверяет production triggers/FK/immutability. Canonical public rows не fixtures |
| RUNTIME | Read-only canonical registry identity/live HTTP200 + snapshot PASS; четыре preview services healthy. Backend image остаётся `homecloud-preview-backend:workspace-checkpoint`; rollout/restart/mount/env changes не выполнялись. Новый HTTP upload smoke не запускался: production binary/config не затронуты, legacy API runtime smoke MS-3A не переобъявляется новым proof |
| INDEPENDENT_REVIEWS | Four scoped independent READ-ONLY reviews: descriptor security, Docker/Linux mount identity, ingress/lifecycle, DB/session integrity — ACCEPT **только blocked/disabled outcome**; findings и один remediation cycle в [review record](independent-reviews.md) |
| LIMITATIONS/BLOCKERS | Descriptor-safe whole lifecycle unavailable; durable workspace enrollment/provenance unavailable; physical host mount qualification unavailable; fixed legacy ingress; DB bridge admission legacy-only; secure cross-FS publication/recovery not qualified. NFS/SMB durability/bounded IO not tested |
| DOCS | Architecture, ненумерованная ROADMAP, operator contract, threat/platform matrix, reproducible probe, validation/safety summaries и independent reviews обновлены. Без numbered Phases |
| COMMITS | `d29ece5431d58f66c9610eeadc4a9e26c517a58c` — «Проверить блокировку новых рабочих областей и восстановление загрузок без потери данных»; отдельный русский docs/evidence commit, его SHA в итоговом ответе |
| FINAL_HEAD | Actual final docs checkpoint SHA сообщается в итоговом ответе; self-referential SHA в committed report не записывается |
| GIT_STATUS | После docs commit проверяется tracked clean + ровно3 initial untracked. Audit не читался/изменялся/staged/committed; путь непосредственно исключён из search commands, repo root не монтировался test containers |
| MS_3B_STATUS | **BLOCKED**, разрешённая acceptance альтернатива с disabled activation; **не COMPLETE** |
| NEXT_GATE | Отдельно согласованный design+tested/reviewed descriptor adapter и durable operator identity contract; actual target-platform mount removal/remount qualification; secure session ingress и DB admission. Cross-FS finalizer — только отдельный MS-4 scope. Ничего не начинается автоматически |

## Что доказано и что не доказано

| Гарантия | Доказательство | Граница |
|---|---|---|
| Extras нельзя включить row/path/legacy-looking keys | Additional UUID across restart unit; current resolver/DB guards, registry blocked profile | Без operator activation implementation |
| Empty non-mount directory не становится новым storage | Actual Linux mountinfo probe: offline/read=false/write=false; directory empty/no mkdir | Не live-unmount qualified physical SSD |
| Legacy retries после EXDEV не портят committed chunks/quota | Service injected rename EXDEV + real PG snapshot/inode/binary equality + successful ingress retry | Kernel EXDEV отдельно реальный; combined real mount+service adoption не qualified |
| Возврат того же legacy `.tmp` восстанавливает session | Saved fixture returned, explicit service restart, exact accounting and final bytes | Не provenance неизвестного mount после restart |
| Legacy FS guard не TOCTOU-safe | Actual Multer writer deterministic swap между guard и open; escaped5bytes | Только private scratch, нарушение trusted exclusive-directory предположения; original user bytes не затронуты |
| Marker/root FD не durable identity | Replacement marker новым registry accepted; replacement `.tmp` новым resolver accepted | Не cryptographic/host attestation; full kernel process restart/remount не тестирован |
| Canonical state сохранён | [Safety summary](safety-summary.json), 11 public table hashes/full FS metadata exact equal | Read-only snapshots после начала qualification; initial HEAD checked, canonical writer не менялся |

## Воспроизведение

[Threat model/design](design.md), [qualification probe](qualification.cjs),
[actual output](qualification.json), [validation summary](validation-summary.json),
[canonical read-only check](canonical-check.cjs), [independent reviews](independent-reviews.md).

Из repo root, **только disposable non-root scratch**, без `/storage` volume и network:

```sh
docker run --rm -i --network none --user 1001:1001 --cap-drop ALL \
  --tmpfs /qualified:uid=1001,gid=1001,mode=0700 --entrypoint node \
  homecloud-preview-backend:workspace-checkpoint \
  < docs/evidence/secure-workspace-activation-20261010/qualification.cjs
```

Exit0 значит disqualification harness ожидаемо подтвердил blockers, **не secure activation
PASS**. Root/mount/marker/symlink writes происходят только на tmpfs/private scratch; probe
проверяет uid1001, CapEff0, exact tmpfs и отсутствие `/storage`. Он не предназначен для
обычного приложения или оператора на user volume. TMPFS исчезает с `--rm`, scratch удаляется.

Backend validation использовала existing `homecloud-ms3a-tests` Node20 image: `/app/src` и
`/app/bench` read-only bindings из current repo, без доступа к root repo/audit и canonical
storage; UID1001/cap-drop ALL, existing preview network для temporary PG schemas. URL взят
из existing backend только в памяти и передан environment, не сохранён/выведен. Команды:
targeted `node node_modules/jest/bin/jest.js --runInBand --no-cache` с7 existing suite paths,
full то же без paths, `npm run lint`, `tsc --noEmit`, `npm run build`. Build пишет в отдельный
disposable `--tmpfs /app/dist:uid=1001,gid=1001,mode=0700`.

Local ignored logs: [targeted](targeted.log), [full backend](full.log), [lint](lint.log),
[typecheck](typecheck.log), [build](build.log). Private raw canonical snapshots в scratch,
в Git только hashes/counts summary. Sources/project mirror не менялись.

## Ограничения и ошибки harness

Первый probe наследовал image NODE_ENV=production, который ConfigService предпочёл test
value: plain scratch отказал до race. Fixture явно устанавливает test env только для portable
resolver counterexample; production mount probe остаётся actual strict registry. Повтор PASS.
Первый targeted run1 failure из-за namespace-import nonconfigurable copyFileSync spy;
raw module export исправлен, повтор197/197 PASS. Первый build дал EACCES root-owned image
dist; заменён только disposable output tmpfs, повтор PASS. Два неверных guessed health
paths вернули404; затем прочитан actual global prefix/controller, проверен live endpoint200.
Эти harness ошибки не security improvements и не скрываются.

`secureOpen=false`, legacy TOCTOU и restart repinning остались. Native/root helper не добавлен:
один openat2 wrapper не обеспечивает descriptor-safe rename/unlink/cleanup/finalizer и durable
physical identity. Для новой платформы нужен минимальный reviewed adapter contract, hostile
interleavings, real mounts и совместимость containers, а не объявление realpath безопасным.
Linux kernel syscall наличие отдельно не измерено; Node API отсутствие не равно kernel отсутствие.
Physical SSD/NVMe, Docker Desktop host disappearance, NFS/SMB, power-loss и cross-FS finalization
остаются **UNQUALIFIED**. Full legacy suite не заменяет их qualification.

Дополнительных workspace/config/API/UI, permanent StorageLocations, migration/native
dependencies, byte moves, second persistent stack, broad DR changes, MS-4, 50GiB,
push/tag/release не было. Чужие Docker resources не менялись. Работа остановлена на MS-3B.
