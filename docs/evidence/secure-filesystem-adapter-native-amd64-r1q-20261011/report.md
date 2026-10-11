# MS-3B-R1Q — Native AMD64 Qualification / ENOSYS diagnosis

> Продолжение 2026-10-11: **текущий R1Q_GATE=PASS / R1_GATE=PASS в исходном R1 scope**. Native Linux AMD64 квалификация завершена на домашнем сервере; [актуальный отчёт](../secure-filesystem-adapter-home-server-native-r1q-20261011/report.md). Нижеследующий BLOCKED статус относится к исторической попытке. Production NO_GO, secureOpen=false; R2/MS-4 не начаты.

2026-10-11, Asia/Vladivostok. **R1Q_GATE=BLOCKED / BLOCKED_ENVIRONMENT. R1_GATE=BLOCKED.**
Локальный ENOSYS локализован в пути трансляции Rosetta, до host `openat2`.
Настоящий native Linux x86_64 Docker runtime в проверенных доступных средах отсутствует.
Production **NOT_READY / NO_GO**, `secureOpen=false`, дополнительные workspace выключены.
R2 и MS-4 не начаты. Production adapter, dependencies, Docker/Compose и canonical stack не изменены.

| Поле | Результат |
|---|---|
| INITIAL_HEAD | Expected=actual `f18aa3c0f8fa1c8b0263b3ebfddc5f9d2231affc`; tracked clean; три известных untracked |
| HOST_AND_CONTAINER_ARCH | macOS Darwin27 ARM64; Docker Desktop4.71.0/Engine29.4.1, LinuxKit6.12.76 ARM64/aarch64. AMD64 guest сообщает uname x86_64/process.arch=x64, но `/proc/self/maps` содержит `/run/rosetta/rosetta`. ARM64 native probe сообщает aarch64, без Rosetta maps |
| ENOSYS_ROOT_CAUSE_EVIDENCE | Raw x86 `syscall`437 и libc `syscall(SYS_openat2)` одинаково возвращают ENOSYS для valid/full resolve, bad pointer и size0. В том же контейнере ARM64 `svc`437 успешно работает, invalid size→EINVAL, bad pointer→EFAULT. Дополнительный inherited filter deny437→EACCES меняет ARM64 результат на EACCES, AMD64 остаётся ENOSYS. Отказ до host openat2 в Rosetta translation path; внутренний defect/config/version Rosetta не установлены |
| SYSCALL_SECCOMP_ABI | Штатный builder: SYS_openat2=437, SYS_renameat2=316; open_how24bytes, offsets0/8/16. Node/addon ELF64 little-endian machine62 (x86-64), addon загружается; Node20.20.2, NAPI9. Native ARM ELF machine183. Seccomp mode2/filter1, capabilities0, UID1001, NoNewPrivs1; sentinel добавляет второй фильтр, ничего не разрешая сверх builtin. Глобальный seccomp не менялся |
| NATIVE_AMD64_ENVIRONMENT | **UNAVAILABLE / UNQUALIFIED**: Docker contexts только default и desktop-linux, оба local sockets; текущий daemon ARM64. Доступные local VM CLI multipass/limactl/virsh/tart/prlctl/VBoxManage не найдены. Не проверяет существование неизвестных удалённых hosts. Новые VM/services не устанавливались, секреты не запрашивались |
| DOCKER_BUILD | Fresh штатный backend multi-stage `--platform linux/amd64 --pull=false` PASS. Runner USER nextjs/UID1001; gcc/headers остаются builder. [Image IDs](build-images.json), [build](amd64-build.txt), [compiler ABI](amd64-compiler-abi.txt), [ELF/hash/runtime](amd64-artifact.txt). Успешная сборка не является operational PASS |
| SECURITY_ADVERSARIAL | Fresh real compiled production Multer StorageEngine на isolated fixture **FAIL_CLOSED**, ingress directory не создана, upload bytes0, fallbackfalse: [log](amd64-multer.txt). Это отказ на отсутствующем syscall, не успешная AMD64 adversarial qualification. 2000 attempts/ancestor races/EXDEV/crash-PG из R1 — исторические LinuxKit ARM64 evidence, заново за AMD64 PASS не выдаются |
| REGRESSIONS / POSTGRES / LINT / BUILD / RUNTIME | Fresh native ARM64 boundary targeted **1suite/10tests PASS**: [log](targeted-arm64.txt); fresh Docker AMD64 backend TS build PASS. Full backend69/931,9PG suites, lint0/15warnings,typecheck и recovery из R1 — исторический baseline. Новые full suites/PG/lint/standalone typecheck/HTTP app smoke/2000/crash/EXDEV не запускались: native AMD64 отсутствует, production код не менялся. AMD64 addon+Multer diagnostic smoke завершён ожидаемым отказом |
| REVIEW | Независимый read-only scoped review diagnostics и итоговых документов: [verdict](independent-review.md). Не заменяет native qualification; reviewer не запускал Docker/DB/tests |
| DATA_INTEGRITY | [11 table hashes/counts, full FS/directory aggregate digests](data-integrity.json) до/после равны, включая identity marker и workspaceId/binding digest;21/21 bindings,5user files/37021bytes,0disposable schemas. [Canonical IDs/images/start times unchanged](canonical-after.json),4healthy services,readiness200. User bytes не перемещались |
| R1Q_GATE | **BLOCKED**, точная причина **BLOCKED_ENVIRONMENT: нет доступного native Linux AMD64 Docker runtime**. Diagnosis выполнен, target qualification не выполнена |
| R1_GATE | **BLOCKED**, native AMD64 host UNQUALIFIED; предыдущие R1 ограничения сохраняются |
| ACTIVATION_STATUS | secureOpen=false; extra workspace activation disabled; production NOT_READY / NO_GO; R2/MS-4 NOT_STARTED; push/Git tag/release отсутствуют |
| LIMITATIONS | Нет native AMD64 host-vs-container сравнения, target physical FS/mount/seccomp, power-loss/device durability, native ingress/lifecycle/PG/full regressions. Точная внутренняя Rosetta причина и её версия не доказаны. Same-UID sabotage/durable root enrollment/finalizer output ограничения R1 не изменились |
| COMMITS | Один отдельный русский docs/evidence checkpoint: «Зафиксировать диагностику ENOSYS Rosetta и блокировку квалификации AMD64»; SHA сообщён в итоговом ответе |
| FINAL_HEAD / GIT_STATUS | FINAL_HEAD — commit этого report, определяется `git log -1 --format=%H -- docs/evidence/secure-filesystem-adapter-native-amd64-r1q-20261011/report.md`; точный SHA и финальный status сообщены в ответе. Самоссылочный SHA не помещается в commit. Ожидается tracked clean и ровно3 исходных untracked; два разрешённых JSON проверены SHA256. Запрещённый audit не читался/хешировался/менялся/staged/committed |
| NEXT_OWNER_ACTION | Предоставить разрешённый доступ к существующему native Linux x86_64 host/VM на x86-64 CPU с Docker и disposable storage/PG. Требования и порядок ниже. Остановиться после R1Q; R2 требует отдельного решения после полного R1 PASS |

## Экспериментальная локализация

1. [Standalone x86 probe](amd64-direct.txt) не загружает Node/addon; использует native headers,
   static musl и прямую x86 инструкцию `syscall`. Оба способа вызова437 дают38/ENOSYS,
   даже без resolve flags. Поэтому ошибка не требует TS boundary/Multer или libc wrapper.
2. [Paired experiment](amd64-paired.txt) исполняет x86 и AArch64 static binaries внутри
   **одного** AMD64-image container: те же mount/user/kernel/seccomp, но ARM probe работает.
   Значение guest uname x86_64 не доказывает архитектуру host kernel.
3. [ARM sentinel](arm64-restrictive-sentinel.txt) через PR_SET_NO_NEW_PRIVS/PR_SET_SECCOMP
   добавляет process-only BPF filter: native syscall437→EACCES, все остальные операции
   сохраняют исходные Docker ограничения. [ARM parent→AMD exec](arm64-restrictive-exec-amd64.txt)
   наследует второй filter (Seccomp_filters2) и всё равно получает ENOSYS из guest syscall437.
   Следовательно, ENOSYS не является результатом исполнения host openat2 или этого фильтра.
4. Native `openat2` в том же LinuxKit работает и проверяет ABI/args; [ARM addon](arm64-artifact.txt)
   root PASS, x86 addon ELF/Node arch верны, root ENOSYS. `renameat2` возвращает ожидаемый
   ENOENT для отсутствующего source на обеих архитектурах; все syscalls не сломаны.
5. Rosetta положительно установлена maps. Пробный QEMU_STRACE1 [log](amd64-qemu-trace.txt)
   не добавил trace; само отсутствие trace **не доказывает** отсутствие QEMU во всех слоях.
   Версия Rosetta не извлекалась. Settings-store чтение ограничено macOS privacy;
   менять настройки/перезапускать Desktop для диагноза не потребовалось.

Вывод: **наблюдаемый локальный ENOSYS возникает в Rosetta guest→host syscall path до
native openat2**. Это доказательство слоя отказа, не исходного кода или универсальной
несовместимости всех версий Rosetta и не доказательство работоспособности на native x86.
Подтверждённого дефекта production adapter не найдено; исправление/fallback не внесены.
Новые build invocations использовали Docker cache; это не clean/no-cache rebuild.
Image architecture и actual Node/addon ELF/hash проверены в запущенных containers.

Документационные первичные источники проверены11.10.2026:
[Docker Rosetta setting](https://docs.docker.com/desktop/settings-and-maintenance/settings/),
[Docker multi-platform/emulation](https://docs.docker.com/build/building/multi-platform/),
[Linux6.12 x86 syscall table](https://github.com/torvalds/linux/blob/v6.12/arch/x86/entry/syscalls/syscall_64.tbl),
[Moby builtin seccomp source](https://github.com/moby/profiles/blob/main/seccomp/default.json),
[Linux man-pages openat2](https://www.man7.org/linux/man-pages/man2/openat2.2.html).
Online seccomp source содержит openat2, но не выдается за dump фактического daemon BPF;
вывод о данном runtime основан на экспериментах, а не на mutable upstream profile.

## Воспроизведение без canonical roots

Сохранены [probe source](syscall-probe.c), [ELF/addon probe](artifact-probe.cjs),
[orchestrator](reproduce.py). Запуск на этой macOS/Docker Desktop ARM среде:

```sh
python3 docs/evidence/secure-filesystem-adapter-native-amd64-r1q-20261011/reproduce.py \
  --repo /Users/aleksejkozemakin/Desktop/HomeCloud \
  --output /tmp/homecloud-r1q-next-reproduction
```

Output должен быть пустым. Harness проверяет Desktop ARM, использует существующий
`homecloud-ms3a-tests:latest` как test-image base (не публикует/обновляет его), штатный
backend-only build context и local temporary tags с UUID; cleanup только собственных
tags в finally. Требуются cached base/images или доступ к используемым package registries.
Процесс build использует root исключительно в image-builder; все diagnostic processes
UID1001/cap-dropALL/no-new-privileges/networknone/read-only rootfs; `/qualified` tmpfs.
Нет `/storage`, Docker socket внутри container, canonical DB/volume, privileged,
seccomp-unconfined или custom relaxed profile. Единственный custom filter — добавленный
process-only deny437. Compiler output `/tmp` одноразовый. No bind-write в repo/storage.

Exit0 probe — **эксперимент завершился**, не openat2 PASS. Смотреть syscall errno,
ADDON_ROOT и HCRESULT. Сохраняемый orchestrator дополнительно проверяет ожидаемые
Rosetta/ENOSYS/sentinel строки; отличается от первых ручных запусков assertions и
портативными output paths. Его отдельный прогон отражён в verification summary.
Он не предназначен для native host qualification и отказывается на другом daemon profile.

[Hash-only canonical checker](safety-hashes.cjs) используется отдельно только в существующем
backend с его текущим environment: credentials не печатаются и не сохраняются. Внутри
процесса читаются строки11таблиц и файлы, наружу уходят только counts/digests. Первичный
локальный инвентарь содержал hashes/metadata/paths, без DB rows/токенов; в Git его нет.
Повторный host orchestration export автоматически отклонён из-за риска чувствительного
инвентаря. Сверка завершена более узким hash-only checker без обхода отклонения.

## Минимальный контракт следующего native qualification

- Существующий разрешённый Linux x86_64 host или VM с аппаратной x86-64 виртуализацией
  на x86 CPU; Docker daemon OSlinux/Archamd64. User-mode Rosetta/QEMU и x86 guest на ARM
  не подходят. Записать host uname/lscpu/kernel и container uname/ELF, Docker engine/runtime,
  наличие emulation handlers. Host `openat2` появился в Linux5.6; один номер версии kernel
  не заменяет host и non-root container raw syscall probe с полной resolve mask.
- Docker по штатной seccomp policy; openat2/renameat2 должны работать без privileged,
  app root или relaxed security. Если syscall blocked — изолированно установить причину
  и не обходить fail-closed. Host probe запускается без root на собственном fixture.
- Пустой disposable local Linux FS root, ownedUID1001, read-write/fdatasync/fsync/rename,
  отдельный nested mount для EXDEV (готовит оператор средствами host, приложение без
  mount capabilities). Точный production FS/mount профиль записать отдельно; tmpfs-only
  PASS не квалифицирует persistent durability. Пользовательские roots не подключать.
- Disposable PostgreSQL16 DB/schema с согласованным доступом; environment доставляет
  оператор, credentials не коммитятся/печатаются. Capacity достаточно для package build
  и малых fixtures; 50GiB/canonical bytes/migrations/activation не требуются.
- Повторить штатный AMD64 build/ELF/addon check, host-vs-container syscalls, настоящий
  production Multer/upload lifecycle symlink/ancestor races,2000concurrent attempts,
  EXDEV/source retention, cleanup и process SIGKILL/restart/recovery+PostgreSQL.
  Затем targeted→full backend suites (без skipped PG)→lint→typecheck/build→Docker smoke;
  сверить canonical baseline отдельно, независимый scoped review evidence/delta.
  До выполнения всех acceptance criteria R1Q/R1 остаются BLOCKED и production NO_GO.

Anti-loop: настройки эмулятора не переключались, разрешения не повышались для приложения.
Первый direct-probe запуск отказал из-за отсутствующего executable bit на exported binary;
исправлен только bit в `/tmp`. Ошибка отсутствующего optional image Config.User обработана
как пустой default, не runtime root. Заблокированный export заменён безопасной hash-only
сверкой; запреты не обходились. Повторяемый orchestrator — отдельная проверка воспроизводимости.

Scope stop: **после R1Q**. R2/MS-4/workspace activation/50GiB/push/tag/release не выполнялись.

## Продолжение: домашний native AMD64 host, 2026-10-11

SSH hs@192.168.3.44 подтверждён; native x86_64/N100 и Docker linux/amd64 доступны.
Preflight остановлен до изменений: hs не может создать `/mnt/1TB/homecloud-test`,
а sudo без пароля недоступен. **R1Q_GATE=BLOCKED_STORAGE_PERMISSION / R1_GATE=BLOCKED**;
qualification NOT_RUN, production NO_GO. Прежняя диагностика Rosetta остаётся исторической.
[Новый baseline, полный отчёт и безопасный следующий шаг владельца](../secure-filesystem-adapter-home-server-r1q-20261011/report.md).
