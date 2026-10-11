# MS-3B-R2.1B — отказ первого helper и проверенный ручной recovery/v2

2026-10-11, Asia/Vladivostok. **R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.**
Первый ручной запуск владельцем выполнен и завершился rc1 до первого filesystem
mount. Обнаружен дефект строковой проверки loop identity. Собственный loop8 пока
остаётся связан с образом; cleanup **не завершён**. Исправленные источники прошли
независимый scoped review и загружены, но recovery/v2 ещё **NOT_RUN**.
Production NO_GO, secureOpen=false, additional workspaces disabled. R2.2/MS-4 не начаты.

Исходный HEAD исследования `1fd5c1d0f95d6b75210c9738a8fe2512f41df91e`, main.
HEAD при ручной попытке/начале исправления
`fd07ba29d878e597d4e400efdba1d0201c69ee76`, main. Это предыдущий документальный
checkpoint, а не production изменение. Итоговый SHA нового документального commit
и Git status сообщаются в итоговом ответе и локальном git-checkpoint.json после commit;
собственный SHA нельзя включить в содержимое этого же commit.
Три исходных untracked сохранены; два разрешённых JSON проверены по прежним SHA.
Запрещённый audit не читался, не искался, не хешировался, не изменялся и не stage.

## Фактическая попытка

Exact executed helper SHA
`8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426`.
[Root result](root-run-result.json) и [durable journal](root-run-journal.ndjson)
сохраняют initial/final snapshots и traceback. Привилегированный вход выполнил
владелец вручную; агент не получал пароль и не выполнял root SSH.

Parent host mntns4026531841; child mntns4026533239 отличается, initial userns4026531837
сохранилась. Только после этой проверки child выполнил make-rprivate; полный child
mountinfo содержит83 строки без shared/master/propagate_from. Изоляция propagation
доказана для этой попытки; loop allocations по-прежнему global host resources.

Создан исключительно собственный regular root-owned ext4 image64MiB:
`/mnt/1TB/homecloud-test/r2-1b-20261011-01a12a22/ext4.img`, Linux dev2081(8:33),
inode64225325. mkfs.ext4 на inherited pinned `/proc/self/fd/4` завершился rc0.
Назначен own `/dev/loop8`. Guard name/backing inode прошёл, device-string guard
отказал; тот же guard остановил cleanup, сознательно не отключая непроверенный loop.
Первый ext4 mount не достигнут. XFS image не создавался. Права на physical XFS не расширялись.

Вероятная причина — сравнение padded BACK-MAJ:MIN с буквальным `8:33`.
Primary [util-linux2.37.2 losetup.c](https://raw.githubusercontent.com/util-linux/util-linux/v2.37.2/sys-utils/losetup.c)
формирует эту JSON string через `%8u:%-3u`. Формат padding подтверждён исходником,
но actual root raw row первого запуска не сохранялся; настоящий mismatch пока
окончательно не исключён. Non-root read-only listing даёт null backing inode/device
из-за недоступности metadata; это не подтверждение ownership для detach.

## Матрица результатов

| Проверка | Фактический статус |
|---|---|
| Новая mount namespace, одинаковая initial userns, private propagation | OBSERVED, первая попытка |
| Fresh regular image, pinned-file mkfs ext4 | OBSERVED, первая попытка |
| Own loop backing identity | PARTIAL; device guard отказал; root raw row отсутствует |
| Ext4/XFS process/container recreation и handle continuity | NOT_RUN в R2.1B; прежний R2.1 отдельно |
| Marker copy, directory replacement, inode recycling | NOT_RUN |
| Stacked/nested bind, live mutation, retained FD/NO_XDEV | NOT_RUN |
| rw→ro→rw и чистый unmount/re-mount | NOT_RUN |
| Docker rprivate/supplier namespace и trusted host→container attestation | UNQUALIFIED, design-only |
| Reboot/power loss, FS clone/physical uniqueness | UNQUALIFIED; physical uniqueness не доказывается |
| Own loop8 cleanup | PENDING_OWNER_MANUAL_ROOT |

Полная acceptance-матрица и trust boundary operator approval/runtime identity,
boot/namespace/mount instance/container recreation/host remount остаются в
[предыдущем отчёте](../report.md). Это исторический preflight; его утверждения
«helper ещё не исполнен / allocations0» заменены настоящим follow-up.
Host/kernel/оператор доверенные, privileged host adversary вне модели.
Container view rprivate сам по себе не подтверждает current host mount source.
Приложение не получает privileged, CAP_SYS_ADMIN, docker.sock или seccomp unconfined.

## Исправление и безопасное продолжение

[V2 helper](isolated-helper-v2.py) строго parse полный numeric major/minor pair,
сохраняет raw root row до guard; wrong inode/device/offset/sizelimit, null/malformed
по-прежнему вызывают STOP. Новый RUN exclusive, старые artifacts/image не удаляются.
[Recovery](recover-owned-loop.py) fixed только на записанные old image и loop8.
Pinned regular image dev/inode/size/uid/nlink, actual root loop metadata, отсутствие
old namespace/loop mounts/open block FDs и повторная identity проверяются до detach.
Любой mismatch/reuse/access denial/busy/unknown→STOP. Никаких physical mount/umount,
format devices, detach-all/prune/force или правок действующих Docker сервисов.

Recovery единственной мутацией отключает только подтверждённый own loop8.
Успех проверяется read-only LOOP_GET_STATUS64, принимается только ENXIO;
rc0 detach или null JSON не считаются доказательством. Primary
[Linux6.8 loop.h](https://raw.githubusercontent.com/torvalds/linux/v6.8/include/uapi/linux/loop.h)
задаёт ioctl0x4c05, ABI buffer232 для nativeAMD64; [loop.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/drivers/block/loop.c)
отвергает non-bound status с ENXIO. Это текущий kernel state при trusted quiescent
host; не защита от будущего allocation другим root процессом.

Owner launcher читает оба source pinned FD и проверяет SHA перед первой мутацией.
Только после successful recovery + неизменных26/mountinfo начинается fresh v2
namespace исследование sequential64MiBext4/384MiBXFS. Старый64MiB image сохраняется;
общий preserved logical image budget512MiB, без расширения размера новых FS.
Trusted quiescent hs/root writers обязательны: не менять test trees во время запуска.
SIGKILL/timeout могут оставить own loop; namespace exit не гарантирует global cleanup.
RLIMIT_AS256MiB/nice10/timeouts не hard aggregate resource guarantee.

[Независимый review отказа](failed-run-review.md) принимает только BLOCKED.
[Final recovery/v2 review](final-recovery-v2-review.md):
**SAFE_TO_MANUAL_RUN_WITH_LIMITATIONS** для exact bytes, не qualification PASS.
Это отдельный scoped AI reviewer, не внешний human audit. Review нашёл и закрыл
дополнительный дефект подготовки: explicit-device losetup может вернуть NAME/null
row после detach, поэтому используется kernel ioctl, а не empty-array assumption.

## Сохранность сервера и Git

Root initial/final и последующая [read-only сверка](post-failure-readonly.json):
26 unique running container selected records равны, полный host mountinfo byte-equal,
SHA256 `0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Boot/self namespaces равны. Старые R2.1 fixtures metadata/content совпали с preflight.
Это measured before/after; transient latency/atime/все чужие data bytes не измерялись,
zero-impact не заявляется.

Остались own root-owned DATA tree,64MiB sparse image и loop8 association первого RUN;
собственных FS mounts/новых контейнеров0. Очистка пока не выполнена. Исходный project
с source/results/journal сохраняется. Добавлен только hs-owned0700 v2 source project
`/home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22` и три файла0600.
[Source upload evidence](v2-upload.json) подтверждает exact reviewed SHA и неизменные
26 container records/mountinfo SHA до/после. Recovery/helper во время upload не выполнялись.
Внешние service/config/data не изменялись исполнявшимися командами; физические mounts
не менялись. Actual cleanup/v2 результаты потребуют отдельного read-only сбора.

[Offline verifier](verify-followup.py): **41 checks PASS**, consistency и mocked
guard rejection/acceptance. Device access/root/runtime mount в verifier отсутствуют.
Backend/PG suites/lint/build не запускались: production code/dependencies не менялись;
runtime qualification v2 ждёт owner root entry. [Verification results](followup-verification.json).

Next action — владелец один раз выполняет [проверенный новый launcher](manual-run-v2.md),
затем агент read-only забирает recovery/result/journal, проверяет cleanup/invariants
и независимый scoped review actual evidence. **Старый launcher не повторять**.
До этого оба gates BLOCKED, production NO_GO. Без push/tag/release.
