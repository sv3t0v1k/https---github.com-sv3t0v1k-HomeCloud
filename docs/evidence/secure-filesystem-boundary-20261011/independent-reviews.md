# Независимые reviews MS-3B-R

2026-10-11, Asia/Vladivostok. Два независимых read-only reviewers, не авторы probes.
Они не меняли файлы, не запускали Docker/tests и не читали запрещённый audit.
Primary проверил выводы по source, saved actual results и diff; test numbers не являются
независимым повторным прогоном. Review probes/design выполнен до первого commit; финальные report/docs claims проверены
после него, до второго commit. Уточнён счётчик: 2000 opens при 3000 swap cycles.

| Роль | Область и результат |
|---|---|
| boundary_review | Filesystem descriptor security + ingress lifecycle: **ACCEPT только BLOCKED/disabled**. Просмотрены design, C syscall-probe, runtime/mount probes, results. C реально вызывает openat2 с четырьмя RESOLVE flags, FD read/write/fsync/rename/unlink и kernel EXDEV.2000=385+1615 попыток,outside0 — fixture proof, не production integration. Actual compiled Multer пишет5fixture bytes через swapped ancestor. Whole lifecycle adapter отсутствует |
| identity_review | Mount/restart identity + DB/session compatibility: **ACCEPT только BLOCKED/disabled**. Runtime probe создаёт разные production Node processes; substitute `.tmp` inode4→7 принят. Actual remount повторил обычный dev/root inode/mnt_id/workspace inode tuple; unique mount IDs различились. Marker не authority.11table hashes,5files37021bytes и21/21bindings saved equality согласованы; production/schema diff пустой |

## Findings и один ограниченный corrective cycle

1. Первый design не оговаривал inode generation/reuse достаточно явно. Исправлено:
   `(boot,namespace,mountID,dev,ino)` не durable object identity; требуется FS-specific
   persistent generation либо ограниченная trusted operator attestation. Review принят.
2. Kernel syscall availability не доказывает deployment capability. Design/results/report
   сохраняют `secureOpen=false` и BLOCKED. У C нет вызова из runtime Nest/Multer.
3. Default seccomp EPERM не объявлять kernel невозможностью. Alternate test-only
   unconfined private user/mount namespace разрешил actual mounts; UID0 maps host1001.
4. C fixed-name race не проверяет весь ingress lifecycle, leaf hardlink/content sabotage
   или rename-out закреплённого inode. Граница сохранена в design/report.
5. Tmpfs unmount/SIGKILL не physical disk/power-loss qualification. Сохранено UNQUALIFIED.
6. Launch safety требует disposable `--rm` container, no user volumes, network none,
   own tmpfs/scratch. Runtime probe удаляет fixture `/qualified`; дополнительно введён
   отказ при непустом root. У C уже есть tmpfs/fixture inventory guard.
7. Dockerfile фиксирует Alpine digest, но apk repository и local test image tag mutable.
   Это ограниченная test build, не production addon support/reproducible supply chain.

Новых material harness findings, требующих повторного implementation cycle, нет.
Оба reviewers запрещают claims FIXED/COMPLETE/secureOpen=true/physical qualification.
Неразрешённое — production whole-lifecycle boundary, external authoritative enrollment,
persistent `.tmp` identity и target platform qualification — остаётся blocker.
