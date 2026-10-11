# Независимый safety review non-root supplier/Docker probe

2026-10-11. **SAFE_TO_NONROOT_RUN_WITH_LIMITATIONS** для exact rprivate-probe.py
SHA256 `6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696`.
AST source разобран локально; reviewer не выполнял SSH, probe, mounts или Docker
mutations. Это предварительная static safety оценка, не runtime qualification.
Оба research gates остаются BLOCKED; production NO_GO, secureOpen=false.

## Scope и isolation checks

Parent требует uid/euid1000, проверяет directory ancestors без symlink и approved
parents hs0700, fresh26 running containers и exact original host mountinfo SHA
**до** собственных writes. Source project/DATA/source/private directories exclusive.
Записи лишь в своих одобренных trees. Нет sudo/root entry, loops, mkfs или physical
mount operations; существующие контейнеры не start/stop/rm.

Supplier запускается unshare user+mappedroot+mount с unchanged propagation.
UID0→host1000/count1, новый userns и mntns≠capturedhost, child CAP_SYS_ADMIN
проверяются **до первой mount mutation**. Make-rprivate выполняется внутри child;
full mountinfo без shared/master/propagate_from проверяется до tmpfs4MiB.
Последующие tmpfs и A→B bind mounts только над собственными fresh paths в этой
namespace. Cleanup сверяет exact own target и tmpfs fstype; normal unmount только
из child. Host DATA filesystem content outside own tree не изменяется.

Trusted quiescent hs/root writers — существующая обязательная premise. Directory
checks и pathname operations не защищают от hostile same-UID ancestor rename;
root adversary/подмена SOURCE_CODE вне модели. Child_SOURCE_CODE передаётся в памяти,
python -I не перечитывает user-writable probe. Actual executed SHA сохраняется.

## Ограниченные Docker workloads

Exact cached image digest/amd64/no Config.Volumes проверяются, --pull=never.
Только два fixed fresh container names с own run label и полученным full CID;
label, own bind config и отсутствие CID в26original baseline перепроверяются
перед stop/removal. Source только readonly bind своего SOURCE,
cap-dropALL, NNP, readonly rootfs, UID1000:1000, networknone,96MiB memory/swap,
CPU0.1 и pids16. Containers идут sequential, первый кратко стартует повторно.
Node читает marker/proc profile/namespace; recorded capabilities/NNP/seccomp и
bind rprivate/RW=false проверяются. No privileged/CAP_SYS_ADMIN/seccomp-unconfined/
docker.sock внутри containers. No anonymous volumes/download/build/config changes.

При успехе оба own containers removed, supplier exits с cleanup, final selected26
records/full host mountinfo должны равняться initial. Сбой не считается PASS.

## Что эксперимент способен подтвердить

Private supplier A/B в своей namespace может видеть другой FS/object над тем же
pathname, пока Docker daemon bind source остаётся HOST_SOURCE в daemon host namespace.
Container first-start/restart/recreation observations показывают именно этот source
selection case; container config также проверяет default rprivate.

Tmpfs здесь только bounded namespace-mapping fixture. Оно **не** квалифицирует
ext4/XFS persistent handles, их lifecycle в ordinary container, cross-FS binding,
live **host** overmount propagation или stale-container detection при host remount.
Нет actual trusted attestation/freshness/replay/revocation experiment. Подтверждённый
daemon-source mismatch требует корректной supplier/daemon design; он не закрывает
самостоятельно R2.1B gate. Container namespace inode/st_dev/marker не получают
physical/durable uniqueness из этого прогона.

## Безопасные отказы и cleanup limitations

Три обнаруженных reliability shortcomings исправлены перед execution. JSON сначала
dump/fsync в exclusive .part, затем atomic hardlink publish к exclusive final name,
unlink part и fsync directory; handshake не видит half-written final JSON.
Контейнерный plan с exact name/label/source/baselineIDs durably пишется до create.
При hiddenCID после create timeout cleanup queries только exact recorded name+run
label, проверяет full64hex/newCID/own RO rprivate bind и только затем stop/remove.
Никаких broad cleanup selectors. Snapshot exception сохраняется в result,
не препятствуя записи самого result; отсутствие invariants запрещает успех.
Intermediate source SHA e86ea16d…20dd8 больше не является execution target.

Если storage/atomic publish/child termination/inspect/remove не завершены,
нужно сохранить partial own evidence и remote stderr, сверить exact planned
resources и не заявлять cleanup success. Remaining_owned=[] отдельно недостаточно
без final26 equality; поздний daemon create после cleanup query может потребовать
ещё одной exact-name+label inspection. Не повторять existing RUN и не удалять
evidence для bypass collision. Root/physical mount permission не расширяется.

Mount syscall→Python bookkeeping разрыв при timeout может не попасть в mounts list.
Namespace/process exit освобождает только её mounts; descendant lifetime надо проверить
при сбое. Persistent loop allocations отсутствуют. Child terminate с повторным wait
не гарантирует завершения всех descendants при kernel hang; только guarded own
cleanup допускается. Orphan own containers имеют заданные budgets, но требуют cleanup.

Resource/time limits уменьшают нагрузку; они не измеряют host-wide transient latency.
После execution нужен independent raw review initial/final/config/observations,
supplier isolation/cleanup и actual absence of own containers. Только эти данные
могут принять scoped mapping outcome; production/gates остаются BLOCKED.
